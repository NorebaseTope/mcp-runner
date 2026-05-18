// Local environment check. Mirrors the shape of the server's DoctorResult
// (lib/api-spec) so the dashboard's DoctorOutput component can render either.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ADAPTER_VERSION, readConfig } from "./config.js";
import { detectAllKnownHosts } from "./installer.js";
import {
  CursorAgentAdapter,
  probeCursorAgentSync,
  resolveBinOnPath,
  spawnSyncCompat,
} from "./coached/coding-agent.js";
import { isRunnerOutdated } from "@workspace/mcp-runner-version/compare";
import { RUNNABLE_LANGUAGES } from "@workspace/api-zod";
import type { SamApi } from "./api.js";
import {
  mostRecentInstallEntry,
  mostRecentInstalledHostId,
} from "./install-history.js";
import {
  scanSandboxCache,
  cleanSandboxCache,
  formatBytes,
} from "./sandbox/cache-cleanup.js";

// Task #1197 — language catalog resolution mirrors the standing-frames
// pattern (API → on-disk cache → baked-in default) so doctor reports
// the catalog the api-server currently considers authoritative even
// when the local runner build is older than the active catalog. The
// cache file lives next to the standing-frame caches so air-gapped
// installs only need a single `~/.prepsavant/` directory.
const SUPPORTED_LANGUAGES_CACHE_FILE = path.join(
  os.homedir(),
  ".prepsavant",
  "supported-languages.json",
);

export interface RunnableLanguage {
  id: string;
  label: string;
  // Matches `LanguageStatus` in `@workspace/api-zod`. The runner only
  // probes `published` / `beta`; `blocked` rows are filtered out at
  // resolver-time.
  status: "published" | "beta" | "blocked";
  runtimeRequirement: string;
  installHint?: string;
}

interface CachedLanguageCatalog {
  fetchedAt: string;
  items: RunnableLanguage[];
}

async function readCachedLanguageCatalog(): Promise<RunnableLanguage[] | null> {
  try {
    const raw = await fsp.readFile(SUPPORTED_LANGUAGES_CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw) as CachedLanguageCatalog;
    if (Array.isArray(parsed?.items) && parsed.items.length > 0) {
      return parsed.items;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeCachedLanguageCatalog(
  items: RunnableLanguage[],
): Promise<void> {
  try {
    await fsp.mkdir(path.dirname(SUPPORTED_LANGUAGES_CACHE_FILE), {
      recursive: true,
    });
    await fsp.writeFile(
      SUPPORTED_LANGUAGES_CACHE_FILE,
      JSON.stringify(
        { fetchedAt: new Date().toISOString(), items } satisfies CachedLanguageCatalog,
        null,
        2,
      ),
      "utf8",
    );
  } catch {
    // Best-effort cache write — failure must not break doctor.
  }
}

// Resolve the runnable-language list for doctor probes:
//   1. API: GET /api/setup/languages — refresh the cache when it
//      succeeds so subsequent offline runs still see the latest catalog.
//   2. Cache: ~/.prepsavant/supported-languages.json — falls through
//      when the runner has previously synced even if the network is
//      unreachable now.
//   3. Default: the `RUNNABLE_LANGUAGES` array baked in at build time
//      via `@workspace/api-zod` so a brand-new install on an air-gapped
//      machine still gets a useful doctor report.
//
// All three paths return the runnable subset (status `ga` or `beta` —
// `blocked` rows are excluded since they have no toolchain to probe).
export async function resolveRunnableLanguages(
  api: SamApi | null,
): Promise<{
  items: RunnableLanguage[];
  source: "api" | "cache" | "default";
}> {
  // Build an id-keyed lookup of locally-baked entries so we can
  // rehydrate runner-only metadata (`installHint`) onto the API rows.
  // The /setup/languages contract is intentionally trimmed via
  // `toApiLanguage` and does not carry `installHint` over the wire,
  // so a pure API-only resolution would leave doctor unable to emit
  // an actionable `fixCommand` when a runtime is missing. Merging
  // by id preserves the API as the source of truth for membership /
  // status / label while letting the runner contribute its bundled
  // install hints. Unknown ids (catalog rows the runner doesn't yet
  // know about) flow through with `installHint` undefined — doctor
  // already handles that case (warn row without fixCommand).
  const hintLookup = new Map(
    RUNNABLE_LANGUAGES.map((l) => [l.id, l.installHint]),
  );
  const rehydrate = (
    items: RunnableLanguage[],
  ): RunnableLanguage[] =>
    items.map((l) => {
      if (l.installHint) return l;
      const baked = hintLookup.get(l.id);
      return baked ? { ...l, installHint: baked } : l;
    });

  if (api) {
    const fresh = await api.fetchSupportedLanguages();
    if (fresh && Array.isArray(fresh.items) && fresh.items.length > 0) {
      const runnable = rehydrate(
        fresh.items.filter(
          (l) => l.status === "published" || l.status === "beta",
        ),
      );
      await writeCachedLanguageCatalog(runnable);
      return { items: runnable, source: "api" };
    }
  }
  const cached = await readCachedLanguageCatalog();
  if (cached) return { items: cached, source: "cache" };
  return { items: [...RUNNABLE_LANGUAGES], source: "default" };
}

export type DoctorCheckStatus = "pass" | "fail" | "warn" | "skipped";

// Typed classifier for the actionable hint a renderer should show next to
// a warn-state quickstart tile. Mirrors the `hintKind` enum in
// lib/api-spec/openapi.yaml so the dashboard's resolveTileHint and the
// CLI's renderTile can branch on a stable value instead of regex-sniffing
// free-form `detail` copy. When the runner reword detail strings, the
// renderers stay correct because they only look at this field. Set ONLY
// on warn-state quickstart checks; pass/skipped/fail render the pass-hint
// or raw detail directly so they don't need a kind.
export type DoctorHintKind = "auth" | "install-host" | "upgrade-plan";

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorCheckStatus;
  detail?: string;
  fixCommand?: string;
  version?: string;
  hintKind?: DoctorHintKind;
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
  sandboxCache: DoctorCheck[];
  aiAssisted?: DoctorCheck[];
}

function which(cmd: string): { ok: boolean; version?: string } {
  // Task #1477 — On Windows, spawnSync doesn't honour PATHEXT, so a
  // `.cmd` / `.bat` shim returns ENOENT even though the same command
  // works in PowerShell. Resolve through the shared helper so doctor
  // and `prepsavant start` agree on whether a binary is installed.
  const resolved = resolveBinOnPath(cmd) ?? cmd;
  const r = spawnSyncCompat(resolved, ["--version"], { encoding: "utf-8" });
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
  // Task #1197 — pre-resolved runnable-language catalog (API → cache →
  // default chain handled by `resolveRunnableLanguages`). When omitted,
  // doctor falls back to the baked-in `RUNNABLE_LANGUAGES` so callers
  // (existing tests) that don't need the network round-trip keep working.
  runnableLanguages?: RunnableLanguage[];
  // Where the runnableLanguages came from, for telemetry / debug output.
  runnableLanguagesSource?: "api" | "cache" | "default";
  // Task #1259 — when true (default), `runDoctor` silently removes
  // stale-hash sandbox-cache dirs (hash mismatch only — never the
  // active dir, never age-evicted dirs) and reports "freed N MB" in
  // the [sandbox-cache] section. Pass `false` to inspect first via
  // `prepsavant clean-sandbox-cache --dry-run`. The CLI surfaces this
  // as `prepsavant doctor --no-auto-prune`.
  autoPruneSandboxCache?: boolean;
  // Task #1259 — test-only override for the sandbox-cache root dir.
  // When set, the [sandbox-cache] scan + auto-prune use this path
  // instead of the home-relative `SANDBOX_CACHE_DIR` so unit tests can
  // exercise the full doctor flow without writing to ~/.prepsavant.
  sandboxCacheRootDir?: string;
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

  // Tool version detection. Task #1194 (M8 runtime) — Cursor is the
  // sole supported AI-Assisted host; the Claude Code and Codex CLI
  // adapters were retired alongside the hook surfaces.
  const toolChecks: Array<{ id: string; label: string; cmd: string }> = [
    { id: "ai.tool.cursor", label: "Cursor", cmd: "cursor" },
  ];
  for (const t of toolChecks) {
    // Task #1477 — Route through PATHEXT-aware resolver on Windows.
    const resolved = resolveBinOnPath(t.cmd) ?? t.cmd;
    // Task #1477 follow-up #2 — Node 22 (CVE-2024-27980) needs shell:true to
    // spawn `.cmd` / `.bat` shims; otherwise we get `{ status: null }` and
    // falsely report Cursor missing on a working install.
    const r = spawnSyncCompat(resolved, ["--version"], { encoding: "utf-8" });
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

  // AI-Assisted in-process Cursor hook config + stale-hook detection
  // were retired in @prepsavant/mcp@2.0.0 (Task #1193). The
  // Cursor-export pipeline replaces live hook capture, so doctor no
  // longer probes Cursor's hooks.json or scans for stale handlers.

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
  const hosts = detectAllKnownHosts().map<DoctorCheck>((h) => ({
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
      opts.plan === "lifetime" ? "$299 plan" : opts.plan === "pro" ? "Pro" : "Free";
    const planStatus: DoctorCheckStatus = opts.plan === "free" ? "warn" : "pass";
    license.push({
      id: "license.plan",
      label: "Plan",
      status: planStatus,
      detail: opts.plan === "free"
        ? `Free — AI-Assisted sessions need the $299 plan ("until you're hired"). Upgrade at: ${upgradeUrl}`
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

  // `manifest.study_mode` retired in 1.8.0 alongside `prepsavant study`.
  const hasAuthorizedToken = !!cfg.token;
  const anyHostInstalled = hosts.some((h) => h.status === "pass");

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
      "No AI chat host config found — install Cursor (the sole supported host as of v1) then re-run `prepsavant install`.",
    );
  if (coachedDetailParts.length === 0) {
    coachedDetailParts.push(
      "`prepsavant start` ready — coached sessions available.",
    );
  }
  const coachedHintKind: DoctorHintKind | undefined =
    coachedStatus === "warn"
      ? !hasAuthorizedToken
        ? "auth"
        : "install-host"
      : undefined;
  manifest.push({
    id: "manifest.coached_mode",
    label: "Coached mode (`prepsavant start`)",
    status: coachedStatus,
    detail: coachedDetailParts.join(" "),
    fixCommand: hasAuthorizedToken ? undefined : "prepsavant auth",
    ...(coachedHintKind ? { hintKind: coachedHintKind } : {}),
  });

  // AI-Assisted mode (task-567) — captures and grades real coding sessions
  // by installing hooks into a hook-capable host. Pass requires a paid
  // plan (Pro or Lifetime) AND a hook-capable host installed. Task #1194
  // (M8 runtime) — Cursor is now the sole supported AI-Assisted host;
  // Claude Code and Codex CLI hook adapters were retired. When the
  // runner could not fetch a plan tier (offline / unauthenticated) we
  // don't fail the plan side — the warn would just be misleading — and
  // let the host side drive the tile.
  const hookCapableHostsInstalled = hosts.some(
    (h) => h.status === "pass" && h.id === "host.cursor",
  );
  let aiAssistedStatus: DoctorCheckStatus;
  let aiAssistedDetail: string;
  let aiAssistedFix: string | undefined;
  let aiAssistedHintKind: DoctorHintKind | undefined;
  if (opts.plan === "free") {
    aiAssistedStatus = "warn";
    aiAssistedDetail = `Free plan — AI-Assisted needs the $299 plan ("until you're hired"). Upgrade at: ${upgradeUrl}`;
    aiAssistedFix = upgradeUrl;
    aiAssistedHintKind = "upgrade-plan";
  } else if (!hookCapableHostsInstalled) {
    aiAssistedStatus = "warn";
    aiAssistedDetail =
      "No hook-capable host installed — install Cursor (the sole supported AI-Assisted host as of v1) then run `prepsavant install --host cursor`.";
    aiAssistedHintKind = "install-host";
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
    ...(aiAssistedHintKind ? { hintKind: aiAssistedHintKind } : {}),
  });

  // task-827 — surface the local upgrade-history file. The most recent
  // install entry tells us three useful things at a glance:
  //   1. Was the last install attempt actually applied, or was it refused
  //      because a runner was live? A refused attempt is a hard fail —
  //      until the user quits the open MCP host and re-runs install, the
  //      runner version on disk is whatever the previous run wrote.
  //   2. Did the most recent install do any cleanup (stale `sam-*`
  //      aliases, pinned-version specs)? That's the "yes, the upgrade
  //      tool worked" signal we want to highlight.
  //   3. Is there any install record at all? "No history yet" is fine for
  //      brand-new installs and shouldn't fail the check — it just means
  //      the user hasn't run `prepsavant install` from this version yet.
  const lastInstall = mostRecentInstallEntry();
  // Task #1382 — recommended install command for the dashboard mirror
  // and any UI affordance that surfaces "re-run install". Stamped as
  // `fixCommand` on the install_history check so downstream readers
  // (the api-server's `/setup/doctor` splice in particular) don't have
  // to re-derive the host from scratch.
  const installedHostId = mostRecentInstalledHostId();
  const installCmd = recommendedInstallCommand(installedHostId);
  if (lastInstall) {
    const refused = lastInstall.hosts.some(
      (h) => h.status === "refused-live-runner",
    );
    const cleanedTotal = lastInstall.hosts.reduce(
      (n, h) => n + h.cleanedKeys.length,
      0,
    );
    const versionStanza = lastInstall.previousVersion
      ? `v${lastInstall.previousVersion} → v${lastInstall.newVersion}`
      : `fresh install of v${lastInstall.newVersion}`;
    if (refused) {
      manifest.push({
        id: "manifest.install_history",
        label: "Last install attempt",
        status: "fail",
        detail:
          `Last install (${lastInstall.ts}) was refused because a Sam runner ` +
          `was active. Quit the host that's running sam, then re-run \`prepsavant install\`.`,
        // Task #1382 — surface the host-aware install command so the
        // dashboard's "Re-run install" affordance copies the right
        // `--host <id>` flag instead of the bare command.
        fixCommand: installCmd,
      });
    } else {
      const cleanupNote =
        cleanedTotal > 0
          ? `cleaned up ${cleanedTotal} stale entr${cleanedTotal === 1 ? "y" : "ies"}`
          : `no stale entries to clean`;
      // Task #1205 — surface the auto-killed pid (if any) on the same
      // pass row so users can see, after the fact, which runner the
      // installer stopped before patching. We pull from any host on
      // this entry because the installer stamps the same pid on every
      // host (one auto-kill per `prepsavant install` invocation).
      const autoKilledPid = lastInstall.hosts
        .map((h) => h.autoKilledRunnerPid)
        .find((p): p is number => typeof p === "number" && p > 0);
      const autoKillNote = autoKilledPid
        ? ` Stopped previous runner (pid ${autoKilledPid}) before patching.`
        : "";
      manifest.push({
        id: "manifest.install_history",
        label: "Last install",
        status: "pass",
        detail:
          `${versionStanza} on ${lastInstall.ts} — ${cleanupNote}.` +
          autoKillNote,
        version: lastInstall.newVersion,
        // Task #1382 — even on the happy path we stamp the
        // host-aware install command so the api-server's
        // `runner_outdated` splice has a real `--host <id>` to
        // forward to the dashboard. Without this the dashboard tile
        // falls back to the bare `npx -y @prepsavant/mcp install`
        // even though the runner DOES know which host the user
        // last installed against.
        fixCommand: installCmd,
      });
    }
  } else {
    manifest.push({
      id: "manifest.install_history",
      label: "Install history",
      status: "skipped",
      detail:
        "No prior install recorded on this machine. Run `prepsavant install` to register one.",
      // Task #1382 — fresh-install case has no recorded host yet, so
      // `installCmd` is the bare command. We still stamp it so
      // downstream readers always have a copy-pasteable command and
      // never have to re-derive one.
      fixCommand: installCmd,
    });
  }

  // Task #1197 — language probes are driven by the shared catalog
  // (`@workspace/api-zod` → `RUNNABLE_LANGUAGES`). Adding a language to
  // the catalog automatically surfaces a doctor row; if the runner does
  // not yet know how to probe its runtime, the row is reported as `warn`
  // with the catalog-supplied install hint so users get an actionable
  // pointer instead of a missing entry.
  //
  // `python` and `typescript` keep their bespoke detection (python3 vs
  // python, tsx-via-npx) because their probes are not a single
  // `--version` invocation; everything else uses the generic `which()`
  // probe against the runtime binary keyed by language id.
  const npx = which("npx");
  const LANG_PROBE: Record<
    string,
    {
      probe: () => { ok: boolean; version?: string };
      label?: string;
      passDetail?: string;
      warnDetail?: string;
    }
  > = {
    python: {
      probe: () => (which("python3").ok ? which("python3") : which("python")),
      warnDetail: "Python is required to grade Python attempts.",
    },
    javascript: {
      probe: () => ({ ok: true, version: process.version }),
      label: "Node sandbox",
    },
    typescript: {
      probe: () => ({ ok: npx.ok, version: npx.version }),
      label: "TypeScript (via tsx)",
      passDetail: "tsx will be invoked on demand via npx.",
      // Task #1382 — `npx` ships with Node, so a missing `npx` after
      // `node -v` succeeds almost always means a broken / partial Node
      // install or a PATH issue (e.g. an old nvm shim still on PATH
      // pointing at a Node that was uninstalled). The original copy
      // ("npx is required to grade TypeScript attempts.") sent users
      // hunting for a non-existent "install npx" step. Name the real
      // cause and point at the canonical fix.
      warnDetail:
        "Node is installed but `npx` was not found on PATH — reinstall Node.js LTS from https://nodejs.org and reopen your terminal.",
    },
    java: { probe: () => which("java") },
    cpp: { probe: () => (which("g++").ok ? which("g++") : which("clang++")) },
    csharp: { probe: () => which("dotnet") },
    go: { probe: () => which("go") },
    rust: { probe: () => which("rustc") },
    php: { probe: () => which("php") },
    // Task #1200 — kotlin promoted from `blocked` to `beta`. The grader
    // (`packages/mcp-runner/src/sandbox/kotlin.ts`) shells out to
    // `kotlinc -include-runtime -d sandbox.jar` and then `java -jar`, so
    // doctor reports kotlinc availability as the probe; the bundled
    // jvm runtime is already covered by the `java` probe above.
    kotlin: { probe: () => which("kotlinc") },
  };

  const languages: DoctorCheck[] = [];
  const runnable = opts.runnableLanguages ?? [...RUNNABLE_LANGUAGES];
  for (const lang of runnable) {
    const probeCfg = LANG_PROBE[lang.id];
    if (!probeCfg) {
      // Catalog has a new language the runner does not yet know how to
      // probe. Report it as warn with the install hint so the user has
      // an actionable next step instead of a silently-missing row.
      const check: DoctorCheck = {
        id: `lang.${lang.id}`,
        label: lang.label,
        status: "warn",
        detail: `Runner does not yet probe for ${lang.label}; runtime: ${lang.runtimeRequirement}.`,
      };
      if (lang.installHint) check.fixCommand = lang.installHint;
      languages.push(check);
      continue;
    }
    const result = probeCfg.probe();
    const check: DoctorCheck = {
      id: `lang.${lang.id}`,
      label: probeCfg.label ?? lang.label,
      status: result.ok ? "pass" : "warn",
    };
    if (result.version) check.version = result.version;
    if (result.ok) {
      if (probeCfg.passDetail) check.detail = probeCfg.passDetail;
    } else {
      check.detail =
        probeCfg.warnDetail ??
        `${lang.label} runtime not detected — required to grade ${lang.label} attempts.`;
      if (lang.installHint) check.fixCommand = lang.installHint;
    }
    languages.push(check);
  }

  // Task #1230 — surface the long-lived sandbox build cache
  // (`~/.prepsavant/sandbox-cache/<lang>/<hash>/`) so users can see at
  // a glance how much disk it's holding and whether any stale hash
  // dirs are eligible for `prepsavant clean-sandbox-cache`.
  // Task #1259 — when `autoPruneSandboxCache` is true (default), also
  // silently remove stale-hash dirs in the same pass and report the
  // freed bytes inline. Active-hash dirs are NEVER touched here — age
  // eviction still requires the explicit `clean-sandbox-cache
  // --stale-age-days <n>` invocation.
  const sandboxCache: DoctorCheck[] = [];
  const autoPrune = opts.autoPruneSandboxCache !== false;
  const sandboxRoot = opts.sandboxCacheRootDir;
  try {
    const scan = sandboxRoot ? scanSandboxCache(sandboxRoot) : scanSandboxCache();
    const stale = scan.entries.filter((e) => !e.isActive);
    const staleBytes = stale.reduce((n, e) => n + e.sizeBytes, 0);
    if (scan.entries.length === 0) {
      sandboxCache.push({
        id: "sandbox_cache.size",
        label: "Sandbox build cache",
        status: "pass",
        detail: "No sandbox cache on disk yet — first grader run will populate it.",
      });
    } else if (stale.length === 0) {
      sandboxCache.push({
        id: "sandbox_cache.size",
        label: "Sandbox build cache",
        status: "pass",
        detail: `${formatBytes(scan.totalSizeBytes)} across ${scan.entries.length} dir(s); no stale dirs to clean.`,
      });
    } else if (autoPrune) {
      // Stale-hash-only cleanup: cleanSandboxCache without
      // `staleAgeDays` will not touch active-hash dirs.
      const cleanResult = sandboxRoot
        ? cleanSandboxCache({}, sandboxRoot)
        : cleanSandboxCache({});
      const remainingDirs = scan.entries.length - cleanResult.removed.length;
      sandboxCache.push({
        id: "sandbox_cache.size",
        label: "Sandbox build cache",
        status: "pass",
        detail:
          `Auto-pruned ${cleanResult.removed.length} stale dir(s); ` +
          `freed ${formatBytes(cleanResult.freedBytes)}. ` +
          `${formatBytes(cleanResult.remainingBytes)} kept across ${remainingDirs} dir(s). ` +
          `Pass --no-auto-prune to inspect first.`,
      });
    } else {
      sandboxCache.push({
        id: "sandbox_cache.size",
        label: "Sandbox build cache",
        status: "warn",
        detail:
          `${formatBytes(scan.totalSizeBytes)} across ${scan.entries.length} dir(s); ` +
          `${stale.length} stale (${formatBytes(staleBytes)}) eligible for cleanup.`,
        fixCommand: "prepsavant clean-sandbox-cache",
      });
    }
  } catch {
    // Best-effort — never let a cache-scan failure abort doctor.
  }

  const workspaceDir = opts.workspaceDir ?? process.cwd();
  const aiAssistedChecks = opts.aiAssistedMode
    ? runAiAssistedDoctor(workspaceDir)
    : undefined;

  // Task #1401 — Coached LLM reasoning shells out to `cursor-agent`. The
  // probe is sync-via-spawnSync inside the adapter, but the public API is
  // async, so we kick it off and let the result land on the next doctor
  // tick if it doesn't resolve in time. For the synchronous `runDoctor`
  // call we surface a static "configured" check with the binary the
  // adapter would spawn — operators can run `prepsavant doctor --probe`
  // (added separately) for the full handshake.
  const codingAgentBin = cfg.codingAgent?.binPath ?? "cursor-agent";
  const codingAgentProbe = new CursorAgentAdapter({
    binPath: codingAgentBin,
  });
  void codingAgentProbe; // Reserved for the async `--probe` path.
  // Mirror the hybrid selection rule in `resolveCodingAgent`: SDK when
  // CURSOR_API_KEY is set or explicitly opted in, CLI otherwise.
  const explicitKind = cfg.codingAgent?.kind;
  const apiKeyPresent =
    typeof process.env["CURSOR_API_KEY"] === "string" &&
    process.env["CURSOR_API_KEY"].length > 0;
  const willUseSdk =
    explicitKind === "cursor-sdk" ||
    (explicitKind == null && apiKeyPresent);
  const coachingAgent: DoctorCheck[] = [
    willUseSdk
      ? {
          id: "coaching.cursor_sdk",
          label: "Coding agent (Cursor cloud-agent HTTP API)",
          status: "warn",
          detail:
            "Will call Cursor's cloud-agent HTTPS API directly (CURSOR_API_KEY detected). " +
            "Multi-turn context survives across cadence ticks via a server-side agent id. " +
            "Falls back to the `cursor-agent` CLI if the API rejects the key (401/403). " +
            "Task #1562 — replaces the prior `@cursor/sdk` dependency (whose transitive " +
            "`sqlite3` native module had no prebuild for win32-arm64); install now has no " +
            "native build step on any platform. Run `prepsavant start --mock-agent …` to bypass.",
        }
      : {
          id: "coaching.cursor_agent",
          label: "Coding agent (cursor-agent CLI)",
          status: "warn",
          detail:
            `Will shell out to \`${codingAgentBin}\` for host-reasoning hints (auto-falls-back to ` +
            "`cursor agent` subcommand on Cursor 3.x if the standalone binary isn't on PATH). " +
            "Install Cursor 0.45+ and run `cursor-agent login` (or `cursor agent login` on 3.x) if you haven't. " +
            "Note: each cadence tick spawns a fresh subprocess, so multi-turn context does NOT carry across nudges in CLI mode. " +
            "To get persistent context across the whole session, set CURSOR_API_KEY in your shell — the runner will switch to the cloud-agent HTTPS API automatically. " +
            "Run `prepsavant start --mock-agent …` to bypass for offline testing.",
        },
  ];

  // Task #1562 — the pre-2.3 Windows-ARM64 advisory pointed at the
  // `@cursor/sdk` → `sqlite3` native dep, which is the binding we just
  // removed. The HTTP client has no native deps and works identically
  // on win32-arm64, so the advisory is gone.

  // Task #1538 — Proactively surface the "Cursor editor on PATH but
  // the standalone agent CLI is missing" install layout so users fix
  // it before their first coached session (the same actionable
  // remediation `CursorAgentAdapter.probe()` shows mid-session). We
  // only run this when the CLI adapter is selected; the SDK path uses
  // CURSOR_API_KEY and doesn't shell out to `cursor-agent`. The check
  // is `fail` (not `warn`) so the dashboard's "Run doctor" banner and
  // the CLI's `process.exitCode = 1` both pick it up.
  if (!willUseSdk) {
    const editorProbe = probeCursorAgentSync();
    if (editorProbe.kind === "editor_only") {
      coachingAgent.push({
        id: "coaching.cursor_agent_cli_missing",
        label: "Cursor agent CLI on PATH",
        status: "fail",
        detail: editorProbe.remediation,
        fixCommand: "https://cursor.com",
      });
    }
  }

  // Task #1538 — fold ONLY blocking coaching checks (fail status) into
  // overall status. Pre-existing coachingAgent entries are intentionally
  // informational warns ("will shell out to cursor-agent…", "will use
  // CURSOR_API_KEY…") and were previously excluded from overallStatus
  // aggregation entirely; including them would flip every healthy CLI
  // install to warn. The new `coaching.cursor_agent_cli_missing` check
  // is a genuine remediation signal, so it IS aggregated.
  const blockingCoaching = coachingAgent.filter((c) => c.status === "fail");
  const checks = [
    ...[node],
    ...hosts,
    ...blockingCoaching,
    ...license,
    ...manifest,
    ...languages,
    ...sandboxCache,
    ...(aiAssistedChecks ?? []),
  ];
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
    host: [node, ...hosts, ...coachingAgent],
    license,
    manifest,
    languages,
    sandboxCache,
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
  // Task #1382 — when the runner has a recorded most-recently-installed
  // host, we render the upgrade hint with the exact `--host <id>` flag
  // the user originally installed with. Following the printed command
  // verbatim then produces a working install instead of the bare
  // `prepsavant install` that Sam has to correct mid-chat.
  installedHostId?: string | null,
): string | null {
  // Use the same comparator the server uses so the CLI and dashboard agree
  // on the boundary between "current" and "outdated".
  if (!isRunnerOutdated(installedVersion, latestVersion)) return null;
  const hostFlag =
    installedHostId && installedHostId.trim()
      ? ` --host ${installedHostId.trim()}`
      : "";
  return (
    `! Runner update available\n` +
    `      Runner v${installedVersion} installed; v${latestVersion} available — re-run the install command to update.\n` +
    `      → npx -y @prepsavant/mcp install${hostFlag}\n`
  );
}

// Task #1382 — render the recommended `prepsavant install` command (as
// the user would actually type it), including a `--host <id>` flag when
// the local install-history records one. Shared by the runner-side
// install_history check below and any other surface that needs the same
// copy-pasteable upgrade command. Returns just the command string with
// no trailing newline so callers can wrap it however they want.
export function recommendedInstallCommand(
  installedHostId?: string | null,
): string {
  const id = installedHostId?.trim();
  return id
    ? `npx -y @prepsavant/mcp install --host ${id}`
    : `npx -y @prepsavant/mcp install`;
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
      // Switch on the typed hintKind the runner stamped onto the check.
      // The dashboard's resolveTileHint mirrors this exact branch table —
      // when you change one, change the other (see DoctorOutput.tsx). No
      // regex sniffing of `detail` here on purpose: rewording the detail
      // copy must not silently change which affordance the tile shows.
      switch (check.hintKind) {
        case "auth":
          hint = "run `prepsavant auth` to enable";
          break;
        case "install-host":
          hint = "run `prepsavant install --host cursor` to enable";
          break;
        case "upgrade-plan":
          // Surface the upgrade URL verbatim so the user can click it from
          // their terminal without copy-pasting half the detail line.
          hint = `upgrade at ${check.fixCommand ?? ""}`.trim();
          break;
        default:
          hint = check.detail ?? "";
      }
    } else {
      hint = check.detail ?? "not checked";
    }
    lines.push(`  ${sym(check.status)} ${tileLabel} — ${hint}`);
  };

  const findCheck = (id: string) =>
    result.manifest.find((c) => c.id === id);
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
    "sandbox-cache": result.sandboxCache,
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
