// Local environment check. Mirrors the shape of the server's DoctorResult
// (lib/api-spec) so the dashboard's DoctorOutput component can render either.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ADAPTER_VERSION, readConfig } from "./config.js";
import { detectHosts } from "./installer.js";
import {
  claudeCodeHooksConfigPath,
  cursorHooksConfigPath,
  codexHooksConfigPath,
  detectStaleHooks,
} from "./ai-assisted/hook-installer.js";
import { isRunnerOutdated } from "@workspace/mcp-runner-version/compare";

export type DoctorCheckStatus = "pass" | "fail" | "warn" | "skipped";

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorCheckStatus;
  detail?: string;
  fixCommand?: string;
  version?: string;
}

export interface DoctorResult {
  overallStatus: DoctorCheckStatus;
  generatedAt: string;
  // Resolved plan tier — present when the runner successfully fetched it from
  // GET /runner/me. Absent when offline or unauthenticated. Always "free",
  // "pro", or "lifetime" so scripts can branch on it without parsing detail text.
  plan?: "free" | "pro" | "lifetime";
  host: DoctorCheck[];
  license: DoctorCheck[];
  manifest: DoctorCheck[];
  languages: DoctorCheck[];
  aiAssisted?: DoctorCheck[];
}

function which(cmd: string): { ok: boolean; version?: string } {
  const r = spawnSync(cmd, ["--version"], { encoding: "utf-8" });
  if (r.status === 0) {
    const out = (r.stdout || r.stderr || "").trim().split("\n")[0];
    return { ok: true, version: out };
  }
  return { ok: false };
}

export interface DoctorOptions {
  aiAssistedMode?: boolean;
  workspaceDir?: string;
  // Resolved plan tier from GET /runner/me. When provided it is surfaced in
  // the `license` section so users can verify their entitlement upfront.
  plan?: "free" | "pro" | "lifetime";
}

// ---------------------------------------------------------------------------
// AI-Assisted diagnostics
// ---------------------------------------------------------------------------

// Socket reachability check: purely filesystem-based for synchronous safety.
// Using net.createConnection() here would require async event handling and
// could emit unhandled socket errors. The existence of the socket file is a
// reliable indicator of an active session (the runner deletes it on stop()).
function checkSocketReachable(socketPath: string): "reachable" | "exists_not_reachable" | "not_found" {
  try {
    if (!fs.existsSync(socketPath)) return "not_found";
    const stat = fs.statSync(socketPath);
    // Unix domain sockets have S_IFSOCK (0o140000) in their mode.
    // On Windows, named pipes are files; fs.existsSync is sufficient.
    const isSocket = process.platform === "win32" || ((stat.mode & 0o170000) === 0o140000);
    return isSocket ? "reachable" : "exists_not_reachable";
  } catch {
    return "not_found";
  }
}

function snapshotStoreWritable(workspaceDir: string): boolean {
  const snapshotDir = path.join(
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support", "PrepSavant", "snapshots")
      : process.platform === "win32"
        ? path.join(process.env.LOCALAPPDATA ?? os.homedir(), "PrepSavant", "snapshots")
        : path.join(os.homedir(), ".local", "share", "prepsavant", "snapshots"),
    path.basename(workspaceDir),
  );
  try {
    fs.mkdirSync(snapshotDir, { recursive: true });
    const testFile = path.join(snapshotDir, ".doctor-write-test");
    fs.writeFileSync(testFile, "test");
    fs.unlinkSync(testFile);
    return true;
  } catch {
    return false;
  }
}

function sessionsDir(): string {
  return process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support", "PrepSavant", "sessions")
    : process.platform === "win32"
      ? path.join(process.env.LOCALAPPDATA ?? os.homedir(), "PrepSavant", "sessions")
      : path.join(os.homedir(), ".local", "share", "prepsavant", "sessions");
}

function getRecentSessionIds(n = 5): string[] {
  try {
    const d = sessionsDir();
    if (!fs.existsSync(d)) return [];
    return fs.readdirSync(d).slice(-n).reverse();
  } catch {
    return [];
  }
}

interface SessionIntegrity {
  sessionId: string;
  eventCount: number;
  trustGapCount: number;
  staleCleaned: boolean;
  lastCapabilityManifest?: Record<string, unknown>;
  activeSocketPath?: string;
}

function inspectSessionIntegrity(sessionId: string): SessionIntegrity | null {
  try {
    const eventsPath = path.join(sessionsDir(), sessionId, "events.jsonl");
    if (!fs.existsSync(eventsPath)) return null;
    const content = fs.readFileSync(eventsPath, "utf-8");
    const events = content.split("\n").filter(Boolean).map((l) => {
      try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; }
    }).filter(Boolean) as Record<string, unknown>[];

    const trustGapCount = events.filter((e) => e["kind"] === "trust_gap").length;
    const staleCleaned = events.some((e) => e["kind"] === "stale_hook_cleanup_completed");

    // Extract the capability manifest from the hook_install_completed event
    let lastCapabilityManifest: Record<string, unknown> | undefined;
    for (const e of events) {
      if (e["kind"] === "hook_install_completed") {
        lastCapabilityManifest = e["payload"] as Record<string, unknown>;
      }
    }

    // Check if there is an active IPC socket for this session
    const socketPath = process.platform === "win32"
      ? `\\\\.\\pipe\\prepsavant-${sessionId}`
      : path.join(os.tmpdir(), `prepsavant-${sessionId}.sock`);
    const socketExists = fs.existsSync(socketPath);

    return {
      sessionId,
      eventCount: events.length,
      trustGapCount,
      staleCleaned,
      lastCapabilityManifest,
      ...(socketExists ? { activeSocketPath: socketPath } : {}),
    };
  } catch {
    return null;
  }
}

function runAiAssistedDoctor(workspaceDir: string): DoctorCheck[] {
  const checks: DoctorCheck[] = [];

  // Tool version detection
  const toolChecks: Array<{ id: string; label: string; cmd: string }> = [
    { id: "ai.tool.claude_code", label: "Claude Code", cmd: "claude" },
    { id: "ai.tool.cursor",      label: "Cursor",      cmd: "cursor" },
    { id: "ai.tool.codex",       label: "Codex CLI",   cmd: "codex" },
  ];
  for (const t of toolChecks) {
    const r = spawnSync(t.cmd, ["--version"], { encoding: "utf-8" });
    if (r.status === 0) {
      checks.push({
        id: t.id,
        label: `${t.label} installed`,
        status: "pass",
        version: (r.stdout || r.stderr || "").trim().split("\n")[0],
      });
    } else {
      checks.push({
        id: t.id,
        label: `${t.label} installed`,
        status: "warn",
        detail: `${t.cmd} not found in PATH`,
      });
    }
  }

  // Hook config status per tool
  const hookConfigChecks: Array<{ id: string; label: string; configPath: string }> = [
    {
      id: "ai.hooks.claude_code",
      label: "Claude Code hook config",
      configPath: claudeCodeHooksConfigPath(workspaceDir),
    },
    {
      id: "ai.hooks.cursor",
      label: "Cursor hook config",
      configPath: cursorHooksConfigPath(workspaceDir),
    },
    {
      id: "ai.hooks.codex",
      label: "Codex hook config",
      configPath: codexHooksConfigPath(),
    },
  ];
  for (const hc of hookConfigChecks) {
    if (fs.existsSync(hc.configPath)) {
      try {
        const raw = fs.readFileSync(hc.configPath, "utf-8");
        const parsed = JSON.parse(raw);
        const hasHooks = "hooks" in parsed || Object.keys(parsed).some((k) => k.includes("session") || k.includes("tool"));
        checks.push({
          id: hc.id,
          label: hc.label,
          status: hasHooks ? "pass" : "warn",
          detail: hasHooks
            ? `Config found at ${hc.configPath}`
            : `Config found but no hooks installed at ${hc.configPath}`,
        });
      } catch {
        checks.push({
          id: hc.id,
          label: hc.label,
          status: "warn",
          detail: `Config at ${hc.configPath} is not valid JSON`,
        });
      }
    } else {
      checks.push({
        id: hc.id,
        label: hc.label,
        status: "skipped",
        detail: "No hook config installed (session not active)",
      });
    }
  }

  // Stale hook detection
  const stale = detectStaleHooks(workspaceDir);
  if (stale) {
    checks.push({
      id: "ai.hooks.stale",
      label: "Stale hook cleanup",
      status: "warn",
      detail: `Stale hooks found from session ${stale.sessionId} (tool: ${stale.toolId}) installed at ${stale.installedAt}`,
      fixCommand: "prepsavant start  # runner cleans stale hooks on next launch",
    });
  } else {
    checks.push({
      id: "ai.hooks.stale",
      label: "Stale hook cleanup",
      status: "pass",
      detail: "No stale hooks found",
    });
  }

  // Snapshot store writable
  const snapWritable = snapshotStoreWritable(workspaceDir);
  checks.push({
    id: "ai.snapshot.writable",
    label: "Snapshot store writable",
    status: snapWritable ? "pass" : "fail",
    detail: snapWritable
      ? "Snapshot store directory is writable"
      : "Cannot write to snapshot store — check disk space and permissions",
  });

  // CODEX_HOOKS env var
  const codexHooksEnabled = process.env["CODEX_HOOKS"] === "1";
  checks.push({
    id: "ai.codex.hooks_env",
    label: "CODEX_HOOKS env var",
    status: codexHooksEnabled ? "pass" : "warn",
    detail: codexHooksEnabled
      ? "CODEX_HOOKS=1 is set — Codex interactive hooks are active"
      : "CODEX_HOOKS env var not set — Codex interactive hooks are disabled",
    fixCommand: codexHooksEnabled ? undefined : "export CODEX_HOOKS=1",
  });

  // Recent session IDs + integrity inspection
  const recentSessions = getRecentSessionIds(5);
  checks.push({
    id: "ai.sessions.recent",
    label: "Recent AI-Assisted sessions",
    status: "pass",
    detail: recentSessions.length > 0
      ? `Last ${recentSessions.length}: ${recentSessions.join(", ")}`
      : "No sessions found",
  });

  // Session integrity: inspect the most recent session's event log
  if (recentSessions.length > 0) {
    const mostRecent = recentSessions[0]!;
    const integrity = inspectSessionIntegrity(mostRecent);
    if (integrity) {
      const tgStatus: DoctorCheckStatus =
        integrity.trustGapCount > 10 ? "warn" : "pass";
      checks.push({
        id: "ai.sessions.integrity",
        label: "Last session integrity",
        status: tgStatus,
        detail: [
          `session_id: ${integrity.sessionId}`,
          `events: ${integrity.eventCount}`,
          `trust_gaps: ${integrity.trustGapCount}`,
          `stale_cleanup_ran: ${integrity.staleCleaned}`,
          ...(integrity.lastCapabilityManifest
            ? [`capability: tool=${String(integrity.lastCapabilityManifest["tool"] ?? "?")} ceiling=${String(integrity.lastCapabilityManifest["confidence_ceiling"] ?? "?")}`]
            : []),
        ].join(" | "),
      });

      // Socket reachability for an active session
      if (integrity.activeSocketPath) {
        const socketStatus = checkSocketReachable(integrity.activeSocketPath);
        checks.push({
          id: "ai.sessions.socket",
          label: "Active session IPC socket",
          status: socketStatus === "reachable" ? "pass" : socketStatus === "exists_not_reachable" ? "warn" : "skipped",
          detail: socketStatus === "reachable"
            ? `Socket reachable at ${integrity.activeSocketPath}`
            : socketStatus === "exists_not_reachable"
            ? `Socket file exists but is not accepting connections: ${integrity.activeSocketPath}`
            : "No active session socket",
        });
      } else {
        checks.push({
          id: "ai.sessions.socket",
          label: "Active session IPC socket",
          status: "skipped",
          detail: "No active session found (session already finalized or not started)",
        });
      }

      // Last capability manifest output
      if (integrity.lastCapabilityManifest) {
        const manifest = integrity.lastCapabilityManifest;
        checks.push({
          id: "ai.sessions.manifest",
          label: "Last capability manifest",
          status: "pass",
          detail: JSON.stringify(manifest),
        });
      }

      // Stale-hook cleanup history
      checks.push({
        id: "ai.sessions.stale_cleanup",
        label: "Stale-hook cleanup history (last session)",
        status: integrity.staleCleaned ? "pass" : "skipped",
        detail: integrity.staleCleaned
          ? `Stale hooks were cleaned before session ${integrity.sessionId} started`
          : "No stale-hook cleanup recorded in most recent session",
      });
    } else {
      checks.push({
        id: "ai.sessions.integrity",
        label: "Last session integrity",
        status: "skipped",
        detail: "No event log found for most recent session (session may be in progress or log missing)",
      });
    }
  }

  return checks;
}

export function runDoctor(opts: DoctorOptions = {}): DoctorResult {
  const cfg = readConfig();
  const node: DoctorCheck = {
    id: "host.node",
    label: "Node.js",
    status: "pass",
    version: process.version,
    detail: `${process.platform}-${os.arch()}`,
  };
  const hosts = detectHosts().map<DoctorCheck>((h) => ({
    id: `host.${h.id}`,
    label: h.label,
    status: h.exists ? "pass" : "warn",
    detail: h.configPath
      ? h.exists
        ? `Config detected at ${h.configPath}`
        : `Config not found at ${h.configPath}`
      : "No known config path on this platform",
  }));

  const upgradeUrl = `${cfg.apiBaseUrl.replace(/\/$/, "")}/pricing`;
  const license: DoctorCheck[] = [
    {
      id: "license.token",
      label: "Device token",
      status: cfg.token ? "pass" : "fail",
      detail: cfg.token
        ? `Authorized as ${cfg.label ?? "device"} on ${cfg.authorizedAt ?? "unknown date"}`
        : "No device token found.",
      fixCommand: cfg.token ? undefined : "prepsavant auth",
    },
  ];
  if (opts.plan !== undefined) {
    const planLabel =
      opts.plan === "lifetime" ? "Lifetime" : opts.plan === "pro" ? "Pro" : "Free";
    const planStatus: DoctorCheckStatus = opts.plan === "free" ? "warn" : "pass";
    license.push({
      id: "license.plan",
      label: "Plan",
      status: planStatus,
      detail: opts.plan === "free"
        ? `Free — AI-Assisted sessions require Pro or Lifetime. Upgrade at: ${upgradeUrl}`
        : `PrepSavant ${planLabel} — AI-Assisted sessions available`,
      fixCommand: opts.plan === "free" ? upgradeUrl : undefined,
    });
  }

  const manifest: DoctorCheck[] = [
    {
      id: "manifest.adapter",
      label: "Runner adapter version",
      status: "pass",
      version: ADAPTER_VERSION,
    },
    {
      id: "manifest.api",
      label: "Sam API base URL",
      status: "pass",
      detail: cfg.apiBaseUrl,
    },
  ];

  // Study mode (task-531) — surface that the runner can serve in-IDE study
  // chats. Pass when the device is authorized AND at least one supported
  // host has a config detected (so MCP study_* tools are reachable). Warn
  // when either is missing so the user gets a clear next step. The check is
  // local-only — it does not contact the API.
  const hasAuthorizedToken = !!cfg.token;
  const anyHostInstalled = hosts.some((h) => h.status === "pass");
  const studyStatus: DoctorCheckStatus =
    hasAuthorizedToken && anyHostInstalled ? "pass" : "warn";
  const studyDetailParts: string[] = [];
  if (!hasAuthorizedToken)
    studyDetailParts.push("Run `prepsavant auth` to authorize the device.");
  if (!anyHostInstalled)
    studyDetailParts.push(
      "No AI chat host config found — install Cursor, Claude Desktop, Claude Code, or Codex CLI then re-run `prepsavant install`.",
    );
  if (studyDetailParts.length === 0) {
    studyDetailParts.push(
      "MCP study_* tools are reachable. Try `prepsavant study --help`.",
    );
  }
  manifest.push({
    id: "manifest.study_mode",
    label: "Study mode (in-IDE teaching chat)",
    status: studyStatus,
    detail: studyDetailParts.join(" "),
    fixCommand: hasAuthorizedToken ? undefined : "prepsavant auth",
  });

  // Coached mode (task-567) — runs `prepsavant start` to drive a guided
  // practice session through the runner. Same gating as Study mode (the
  // runner needs a device token AND at least one MCP host installed) but
  // surfaced as its own quickstart tile so first-time users can see all
  // three run modes at a glance instead of having to scan [host] / [license]
  // to figure out whether Coached is reachable.
  const coachedStatus: DoctorCheckStatus =
    hasAuthorizedToken && anyHostInstalled ? "pass" : "warn";
  const coachedDetailParts: string[] = [];
  if (!hasAuthorizedToken)
    coachedDetailParts.push("Run `prepsavant auth` to authorize the device.");
  if (!anyHostInstalled)
    coachedDetailParts.push(
      "No AI chat host config found — install Cursor, Claude Desktop, Claude Code, or Codex CLI then re-run `prepsavant install`.",
    );
  if (coachedDetailParts.length === 0) {
    coachedDetailParts.push(
      "`prepsavant start` ready — coached sessions available.",
    );
  }
  manifest.push({
    id: "manifest.coached_mode",
    label: "Coached mode (`prepsavant start`)",
    status: coachedStatus,
    detail: coachedDetailParts.join(" "),
    fixCommand: hasAuthorizedToken ? undefined : "prepsavant auth",
  });

  // AI-Assisted mode (task-567) — captures and grades real coding sessions
  // by installing hooks into a hook-capable host. Pass requires a paid
  // plan (Pro or Lifetime) AND at least one hook-capable host installed.
  // Hook support today: Claude Code, Cursor, and Codex CLI (Claude Desktop's
  // MCP config does not expose the hook surface AI-Assisted needs — only
  // Claude Code, the CLI sibling, does). When the runner could not fetch a
  // plan tier (offline / unauthenticated) we don't fail the plan side —
  // the warn would just be misleading — and let the host side drive the
  // tile.
  const hookCapableHostsInstalled = hosts.some(
    (h) =>
      h.status === "pass" &&
      (h.id === "host.cursor" ||
        h.id === "host.codex" ||
        h.id === "host.claude_code"),
  );
  let aiAssistedStatus: DoctorCheckStatus;
  let aiAssistedDetail: string;
  let aiAssistedFix: string | undefined;
  if (opts.plan === "free") {
    aiAssistedStatus = "warn";
    aiAssistedDetail = `Free plan — AI-Assisted requires Pro or Lifetime. Upgrade at: ${upgradeUrl}`;
    aiAssistedFix = upgradeUrl;
  } else if (!hookCapableHostsInstalled) {
    aiAssistedStatus = "warn";
    aiAssistedDetail =
      "No hook-capable host installed — install Claude Code, Cursor, or Codex CLI then run `prepsavant install --host cursor`.";
  } else {
    aiAssistedStatus = "pass";
    aiAssistedDetail = "`prepsavant start --ai-assisted` ready to capture sessions.";
  }
  manifest.push({
    id: "manifest.ai_assisted_mode",
    label: "AI-Assisted mode (capture & grade real sessions)",
    status: aiAssistedStatus,
    detail: aiAssistedDetail,
    fixCommand: aiAssistedFix,
  });

  const languages: DoctorCheck[] = [];
  const py = which("python3").ok ? which("python3") : which("python");
  languages.push({
    id: "lang.python",
    label: "Python",
    status: py.ok ? "pass" : "warn",
    version: py.version,
    detail: py.ok ? undefined : "Python is required to grade Python attempts.",
    fixCommand: py.ok ? undefined : "https://www.python.org/downloads/",
  });
  const npx = which("npx");
  languages.push({
    id: "lang.javascript",
    label: "Node sandbox",
    status: "pass",
    version: process.version,
  });
  languages.push({
    id: "lang.typescript",
    label: "TypeScript (via tsx)",
    status: npx.ok ? "pass" : "warn",
    detail: npx.ok
      ? "tsx will be invoked on demand via npx."
      : "npx is required to grade TypeScript attempts.",
  });

  const workspaceDir = opts.workspaceDir ?? process.cwd();
  const aiAssistedChecks = opts.aiAssistedMode
    ? runAiAssistedDoctor(workspaceDir)
    : undefined;

  const checks = [...[node], ...hosts, ...license, ...manifest, ...languages, ...(aiAssistedChecks ?? [])];
  const failed = checks.some((c) => c.status === "fail");
  const warned = checks.some((c) => c.status === "warn");
  const overallStatus: DoctorCheckStatus = failed
    ? "fail"
    : warned
      ? "warn"
      : "pass";

  return {
    overallStatus,
    generatedAt: new Date().toISOString(),
    ...(opts.plan !== undefined ? { plan: opts.plan } : {}),
    host: [node, ...hosts],
    license,
    manifest,
    languages,
    ...(aiAssistedChecks ? { aiAssisted: aiAssistedChecks } : {}),
  };
}

// Render the "runner is out of date" advisory the CLI appends below
// `formatDoctor()` when the API reports a newer published version than the
// locally-installed runner. Returns null when the install is current so the
// caller doesn't need a separate "should we render?" branch.
//
// Copy is kept identical (modulo CLI prefix) to the dashboard advisory in
// artifacts/api-server/src/routes/setup.ts so terminal users and dashboard
// users see the same nudge — see task-464.
export function formatRunnerUpdateAdvisory(
  installedVersion: string,
  latestVersion: string,
): string | null {
  // Use the same comparator the server uses so the CLI and dashboard agree
  // on the boundary between "current" and "outdated".
  if (!isRunnerOutdated(installedVersion, latestVersion)) return null;
  return (
    `! Runner update available\n` +
    `      Runner v${installedVersion} installed; v${latestVersion} available — re-run the install command to update.\n` +
    `      → npx -y @prepsavant/mcp install\n`
  );
}

export function formatDoctor(result: DoctorResult): string {
  const sym = (s: DoctorCheckStatus) =>
    s === "pass" ? "✓" : s === "warn" ? "!" : s === "fail" ? "✗" : "·";
  const lines: string[] = [];
  lines.push(`prepsavant doctor — ${result.overallStatus.toUpperCase()}`);
  lines.push(`generated ${result.generatedAt}`);

  // Quickstart mode tiles (task-557, task-567): surface all three run modes
  // — Study, Coached, AI-Assisted — at the top of the human-facing summary
  // so first-time users notice which ones are reachable without scanning
  // [host] / [license]. The detailed `manifest.*_mode` entries remain in
  // the [manifest] section below for full diagnostic context. Hint copy is
  // derived from each check's status so the tile and the detail line never
  // drift out of sync. Each tile is a single line and stays under the
  // 80-column line-length budget the original Study tile established.
  const renderTile = (
    tileLabel: string,
    check: DoctorCheck | undefined,
    passHint: string,
  ): void => {
    if (!check) return;
    let hint: string;
    if (check.status === "pass") {
      hint = passHint;
    } else if (check.status === "warn") {
      const detail = check.detail ?? "";
      if (check.fixCommand === "prepsavant auth") {
        hint = "run `prepsavant auth` to enable";
      } else if (/AI chat host|hook-capable host/.test(detail)) {
        hint = "run `prepsavant install --host cursor` to enable";
      } else if (/Free plan/.test(detail)) {
        // Surface the upgrade URL verbatim so the user can click it from
        // their terminal without copy-pasting half the detail line.
        hint = `upgrade at ${check.fixCommand ?? ""}`.trim();
      } else {
        hint = detail;
      }
    } else {
      hint = check.detail ?? "not checked";
    }
    lines.push(`  ${sym(check.status)} ${tileLabel} — ${hint}`);
  };

  const findCheck = (id: string) =>
    result.manifest.find((c) => c.id === id);
  renderTile(
    "Study mode",
    findCheck("manifest.study_mode"),
    "`prepsavant study` ready in your IDE",
  );
  renderTile(
    "Coached mode",
    findCheck("manifest.coached_mode"),
    "`prepsavant start` ready to run",
  );
  renderTile(
    "AI-Assisted mode",
    findCheck("manifest.ai_assisted_mode"),
    "`prepsavant start --ai-assisted` ready",
  );

  const sections: Record<string, DoctorCheck[] | undefined> = {
    host: result.host,
    license: result.license,
    manifest: result.manifest,
    languages: result.languages,
    ...(result.aiAssisted ? { "ai-assisted": result.aiAssisted } : {}),
  };
  for (const [section, checks] of Object.entries(sections) as Array<[string, DoctorCheck[]]>) {
    lines.push("");
    lines.push(`[${section}]`);
    for (const c of checks) {
      const v = c.version ? ` (${c.version})` : "";
      lines.push(`  ${sym(c.status)} ${c.label}${v}`);
      if (c.detail) lines.push(`      ${c.detail}`);
      if (c.fixCommand) lines.push(`      → ${c.fixCommand}`);
    }
  }
  return lines.join("\n");
}
