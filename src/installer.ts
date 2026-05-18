// Installs the `sam` MCP server entry into Cursor's MCP config file.
//
// Task #1175 (Cursor-first M8) — physical retirement of the Claude Code,
// Codex, and Claude Desktop install paths. Cursor is now the only host
// the runner installer knows how to patch. Older host ids are rejected
// with an upgrade-required error message; users on those hosts who
// already onboarded keep their existing `mcpServers.sam` entry until
// they uninstall manually.
//
// task-827 — `prepsavant install` doubles as an upgrade tool. Each call
// detects prior installs (canonical `sam`, legacy aliases, pinned-version
// specs), reconciles them down to the single canonical `sam` key, refuses
// to patch underneath a live runner, and appends an entry to a local
// upgrade-history file so the dashboard / `prepsavant doctor` can audit
// what changed.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ADAPTER_VERSION } from "./version.js";
import {
  appendInstallHistoryEntry,
  mostRecentInstallEntry,
  type InstallHistoryEntry,
  type InstallHistoryHostResult,
} from "./install-history.js";
import {
  readActiveRunnerLock,
  stopActiveRunner as stopActiveRunnerImpl,
  type RunnerLockInfo,
  type StopRunnerResult,
} from "./runner-lock.js";

export type HostId = "cursor";

// Task #1175 — retired host ids. We surface a clear error rather than a
// silent "Unknown host" so users on the retired install paths see the
// Cursor migration message instead of a generic CLI error.
const RETIRED_HOST_IDS = new Set(["claude", "claude_code", "codex"]);

export interface HostTarget {
  id: HostId;
  label: string;
  configPath: string | null; // null = no known config file → manual snippet
  exists: boolean;
}

function home(...p: string[]): string {
  return path.join(os.homedir(), ...p);
}

function cursorConfigPath(): string | null {
  // Cursor 0.45+ supports a global mcp.json under the user config directory.
  // Older Cursor versions only allow MCP via Settings UI; we fall back to a
  // manual snippet in that case.
  if (process.platform === "darwin" || process.platform === "linux") {
    return home(".cursor", "mcp.json");
  }
  if (process.platform === "win32") {
    return home(".cursor", "mcp.json");
  }
  return null;
}

export function detectHosts(): HostTarget[] {
  const items: Array<{ id: HostId; label: string; configPath: string | null }> = [
    { id: "cursor", label: "Cursor", configPath: cursorConfigPath() },
  ];
  return items.map((it) => ({
    ...it,
    exists: it.configPath ? fs.existsSync(it.configPath) : false,
  }));
}

// Task #1175 — separate from `detectHosts` (which now drives the
// installer and is Cursor-only). The doctor still needs to *report*
// on legacy host installs so users who already have Claude Code,
// Codex, or Claude Desktop wired up can see their AI-Assisted gate
// pass on the basis of those hosts (AI-Assisted tool support for
// Claude Code / Codex CLI is intentionally out of scope for the M8
// retirement). The strings here are display-only — no install
// reconciliation runs against these paths anymore.
type LegacyDoctorHostId = "claude_code" | "codex" | "claude";

export type DoctorHostId = HostId | LegacyDoctorHostId;

export interface DoctorHostTarget {
  id: DoctorHostId;
  label: string;
  configPath: string | null;
  exists: boolean;
}

function claudeCodeConfigPathForDoctor(): string {
  // Claude Code (the CLI sibling of Claude Desktop) writes its
  // user-level config to `~/.claude.json` on every supported
  // platform.
  return home(".claude.json");
}

function codexConfigPathForDoctor(): string {
  return home(".codex", "config.toml");
}

function claudeDesktopConfigPathForDoctor(): string | null {
  if (process.platform === "darwin") {
    return home("Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA;
    if (!appdata) return null;
    return path.join(appdata, "Claude", "claude_desktop_config.json");
  }
  return home(".config", "Claude", "claude_desktop_config.json");
}

export function detectAllKnownHosts(): DoctorHostTarget[] {
  const items: Array<{ id: DoctorHostId; label: string; configPath: string | null }> = [
    { id: "cursor", label: "Cursor", configPath: cursorConfigPath() },
    { id: "claude_code", label: "Claude Code", configPath: claudeCodeConfigPathForDoctor() },
    { id: "codex", label: "Codex", configPath: codexConfigPathForDoctor() },
    { id: "claude", label: "Claude Desktop", configPath: claudeDesktopConfigPathForDoctor() },
  ];
  return items.map((it) => ({
    ...it,
    exists: it.configPath ? fs.existsSync(it.configPath) : false,
  }));
}

export interface InstallOptions {
  host?: HostId | string;
  dryRun?: boolean;
  packageSpec?: string; // override for local testing
  // Hook for tests: pretend a different process holds the runner lock.
  // Production callers leave this unset and hit the real lockfile.
  liveRunnerLock?: RunnerLockInfo | null;
  // Task #1205 — when true (the default), the installer terminates any
  // active Sam runner before patching so re-installs / upgrades don't
  // dead-end on `refused-live-runner`. Power users / CI set this to
  // `false` (via `--no-kill`) to preserve the strict pre-1205 behavior.
  autoKill?: boolean;
  // Test seam — defaults to the real `stopActiveRunner` from
  // runner-lock.ts. Tests inject a fake to drive the killed /
  // already-gone / kill-failed branches without spawning a real process.
  stopActiveRunner?: () => StopRunnerResult;
}

const DEFAULT_PACKAGE_SPEC = "@prepsavant/mcp";

// Recognises every key shape we have ever shipped (or seen users land on
// after manual edits) for the Sam runner. We collapse all matches to the
// single canonical `sam` key so a host doesn't end up with two MCP servers
// competing for the same tool names after an upgrade.
//
// Anything matching by command/args spec is also treated as a candidate
// regardless of key name, so a user-renamed entry like
// `"sam-experiment": { command: "npx", args: ["-y", "@prepsavant/mcp@0.3.0"] }`
// gets cleaned up too.
const CANONICAL_KEY = "sam";
const ALIAS_KEY_PATTERN = /^sam(?:[-_].*)?$/i;
const EXTRA_LITERAL_ALIASES = new Set([
  "prepsavant",
  "prepsavant-mcp",
  "prepsavant_mcp",
]);
const PACKAGE_NAME = "@prepsavant/mcp";

interface ServerEntry {
  command?: unknown;
  args?: unknown;
}

// True when the entry's command/args clearly point at our published package
// — even under a non-standard key. We deliberately tolerate a version pin
// (`@prepsavant/mcp@0.3.x`), a `--yes` instead of `-y`, or extra trailing
// args; the only thing we require is that the package name appears.
function looksLikeSamRunner(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as ServerEntry;
  const cmd = typeof e.command === "string" ? e.command : "";
  const args = Array.isArray(e.args) ? e.args : [];
  if (cmd !== "npx" && cmd !== "npx.cmd") return false;
  return args.some(
    (a) =>
      typeof a === "string" &&
      (a === PACKAGE_NAME || a.startsWith(`${PACKAGE_NAME}@`)),
  );
}

function isCandidateKey(key: string): boolean {
  return ALIAS_KEY_PATTERN.test(key) || EXTRA_LITERAL_ALIASES.has(key.toLowerCase());
}

// Pretty-prints whatever spec the entry was carrying so we can surface it
// in the upgrade summary. Falls back to JSON when the args shape is exotic.
function specOf(entry: unknown): string | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const e = entry as ServerEntry;
  const args = Array.isArray(e.args) ? e.args.filter((a) => typeof a === "string") : [];
  if (args.length === 0) return undefined;
  return (args as string[]).join(" ");
}

interface ReconcileResult {
  status: InstallResult["status"];
  cleanedKeys: string[];
  previousSpec?: string;
}

// Pure config-mutation step. Reads the file, removes every Sam-runner
// candidate (canonical or aliased), and writes back the single canonical
// `sam` entry. Returns metadata so the caller can render a per-host
// summary instead of just "Patched /path/to/config.json".
function patchJsonConfig(
  configPath: string,
  packageSpec: string,
  dryRun: boolean,
): ReconcileResult {
  let parsed: { mcpServers?: Record<string, unknown> } = {};
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, "utf-8");
    if (raw.trim()) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(
          `Could not parse JSON at ${configPath}. Refusing to overwrite an unreadable file.`,
        );
      }
    }
  }
  parsed.mcpServers = parsed.mcpServers ?? {};
  const servers = parsed.mcpServers as Record<string, unknown>;

  // Identify every Sam-runner-shaped entry, by key name OR by command/args.
  const candidateKeys: string[] = [];
  for (const [key, value] of Object.entries(servers)) {
    if (isCandidateKey(key) || looksLikeSamRunner(value)) {
      candidateKeys.push(key);
    }
  }

  const desired = {
    command: "npx",
    args: ["-y", packageSpec],
  };

  // Capture the spec we are about to overwrite, preferring the canonical
  // `sam` key (so an upgrade reports what `sam` was before), but falling
  // back to any aliased candidate so a user who only had `sam-old` still
  // sees the rewrite reported.
  let previousSpec = specOf(servers[CANONICAL_KEY]);
  if (!previousSpec) {
    for (const key of candidateKeys) {
      if (key === CANONICAL_KEY) continue;
      const s = specOf(servers[key]);
      if (s) {
        previousSpec = s;
        break;
      }
    }
  }

  // Fast-path "already installed": the canonical key matches the desired
  // spec exactly AND there are no other Sam-runner candidates to clean up.
  const existingCanonical = servers[CANONICAL_KEY];
  const onlyCanonical =
    candidateKeys.length === 0 ||
    (candidateKeys.length === 1 && candidateKeys[0] === CANONICAL_KEY);
  if (
    onlyCanonical &&
    existingCanonical &&
    typeof existingCanonical === "object" &&
    JSON.stringify(existingCanonical) === JSON.stringify(desired)
  ) {
    return { status: "already-installed", cleanedKeys: [] };
  }

  // Reconcile: remove every candidate, then write the canonical entry. We
  // record removed keys EXCEPT the canonical one when we're just rewriting
  // its spec — that's an upgrade, not a cleanup, and is reported via
  // `previousSpec` instead.
  const cleanedKeys: string[] = [];
  for (const key of candidateKeys) {
    delete servers[key];
    if (key !== CANONICAL_KEY) cleanedKeys.push(key);
  }
  servers[CANONICAL_KEY] = desired;

  if (!dryRun) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(parsed, null, 2) + "\n");
  }

  const result: ReconcileResult = { status: "patched", cleanedKeys };
  if (previousSpec) result.previousSpec = previousSpec;
  return result;
}

export interface InstallResult {
  host: HostId;
  status:
    | "patched"
    | "already-installed"
    | "manual"
    | "skipped"
    | "refused-live-runner";
  configPath: string | null;
  message: string;
  // Stale `mcpServers` keys removed during reconciliation. Empty for
  // fresh installs, manual hosts, and the already-installed fast path.
  cleanedKeys: string[];
  // The spec the canonical (or sole aliased) entry carried before this
  // install rewrote it, when one was found. Lets the CLI summary report
  // "rewrote @prepsavant/mcp@0.3.0 → @prepsavant/mcp".
  previousSpec?: string;
}

// Public installer entry point. Detects the host config(s), refuses to
// patch under a live runner, reconciles each host's config, writes an
// upgrade-history entry, and returns a result-per-host array for the CLI
// (or another consumer) to render.
export function install(opts: InstallOptions = {}): InstallResult[] {
  const pkg = opts.packageSpec ?? DEFAULT_PACKAGE_SPEC;

  // Task #1175 — emit the migration message for users who pass a retired
  // host id (claude, claude_code, codex). They are no longer supported by
  // the installer; existing installs continue to work but new installs
  // and upgrades must use Cursor.
  if (opts.host && RETIRED_HOST_IDS.has(opts.host)) {
    throw new Error(
      `--host ${opts.host} is no longer supported. Cursor is the only ` +
        `host the PrepSavant runner installs into. If you previously ` +
        `installed sam under ${opts.host}, your existing entry will keep ` +
        `working until you remove it manually. New installs and upgrades ` +
        `must use \`prepsavant install --host cursor\`.`,
    );
  }

  const all = detectHosts();
  const targets = opts.host
    ? all.filter((t) => t.id === (opts.host as HostId))
    : all;
  if (opts.host && targets.length === 0) {
    throw new Error(`Unknown host "${opts.host}". Use: cursor.`);
  }

  // Live-runner guard. We never want to rewrite an MCP host config while a
  // Sam runner process has it open — the host could re-read mid-upgrade and
  // end up with a half-written `mcpServers` block. Tests inject the lock
  // info; production callers fall through to the real lockfile reader.
  const lock =
    opts.liveRunnerLock !== undefined
      ? opts.liveRunnerLock
      : readActiveRunnerLock();
  // Task #1205 — by default, terminate the live runner before patching so
  // users don't dead-end on `refused-live-runner` with no copy-pasteable
  // next step. `--no-kill` preserves the strict pre-1205 refusal.
  const autoKill = opts.autoKill !== false;
  let autoKillResult: StopRunnerResult | null = null;
  let autoKillNotice: string | null = null;
  if (lock && autoKill) {
    const stopFn = opts.stopActiveRunner ?? stopActiveRunnerImpl;
    autoKillResult = stopFn();
    if (
      autoKillResult.outcome === "killed" ||
      autoKillResult.outcome === "already-gone"
    ) {
      // Happy path — the lock is gone, fall through into the normal patch
      // flow as if no live runner had been detected. The notice gets
      // prepended to each per-host `message` so the CLI prints a single
      // line above the routine `✓ patched …` output.
      autoKillNotice =
        autoKillResult.outcome === "killed"
          ? `Stopped active Sam runner (pid ${autoKillResult.pid}) before patching.`
          : `Cleared stale Sam runner lock (pid ${lock.pid}) before patching.`;
    }
    // kill-failed → fall through to the refusal branch below with the
    // manual-kill hint appended.
  }
  const stillBlocked =
    !!lock &&
    (!autoKill ||
      (autoKillResult !== null && autoKillResult.outcome === "kill-failed"));
  if (stillBlocked && lock) {
    // Task #1382 — OS-correct one-liner the user can paste verbatim to
    // unblock themselves. PowerShell's `Stop-Process -Force` matches
    // every other Windows-side guidance we hand out (taskkill works
    // too, but `Stop-Process` is the modern PowerShell-first idiom and
    // composes with the rest of the runner's PowerShell-based probes
    // on win32). On POSIX `kill -9` is the canonical SIGKILL form.
    const manualKill =
      process.platform === "win32"
        ? `Stop-Process -Id ${lock.pid} -Force`
        : `kill -9 ${lock.pid}`;
    // Task #1382 — when the locked runner was launched by Cursor, the
    // common failure mode is that the user "closes the Cursor window"
    // but Cursor stays resident in the dock/tray and immediately
    // respawns the MCP server, so the kill above looks like it does
    // nothing. Add a follow-up line pointing at the real fix. We trust
    // the lockfile's host stamp first; older lockfiles without it just
    // skip the note.
    const cursorRelaunchNote =
      lock.host === "cursor"
        ? `\n  (Cursor relaunches MCP servers on window-close — fully quit Cursor from the dock/tray first.)`
        : "";
    // Primary refusal: lead with the kill command + re-run, then prose
    // explaining why. This ordering matters — the original message
    // buried the actionable command three sentences in, so users
    // skimmed past it and pinged support instead of pasting and
    // moving on.
    let refusedMessage =
      `Refusing to patch: a Sam runner is currently active (pid ${lock.pid}, ` +
      `started ${lock.startedAt}).\n` +
      `  → ${manualKill}\n` +
      `  → npx -y @prepsavant/mcp install${cursorRelaunchNote}\n` +
      `  Quit the MCP host (or stop \`prepsavant mcp\`) so the runner releases its lock.`;
    if (autoKillResult && autoKillResult.outcome === "kill-failed") {
      const reason = autoKillResult.error
        ? ` (${autoKillResult.error})`
        : "";
      refusedMessage =
        `Refusing to patch: tried to auto-stop the active Sam runner ` +
        `(pid ${lock.pid}, started ${lock.startedAt}) but the kill failed${reason}.\n` +
        `  → ${manualKill}\n` +
        `  → npx -y @prepsavant/mcp install${cursorRelaunchNote}\n` +
        `  Stop the runner manually with the command above, then re-run install.`;
    }
    const results: InstallResult[] = targets.map((t) => ({
      host: t.id,
      status: "refused-live-runner",
      configPath: t.configPath,
      message: refusedMessage,
      cleanedKeys: [],
    }));
    // Persist the refusal so `prepsavant doctor` can surface it as a fail.
    if (!opts.dryRun) {
      const previous = mostRecentInstallEntry();
      const entry: InstallHistoryEntry = {
        ts: new Date().toISOString(),
        previousVersion: previous?.newVersion ?? null,
        newVersion: ADAPTER_VERSION,
        hosts: results.map((r) => ({
          host: r.host,
          status: "refused-live-runner",
          configPath: r.configPath,
          cleanedKeys: [],
        })),
      };
      try {
        appendInstallHistoryEntry(entry);
      } catch {
        // History is best-effort; the refusal message is the primary signal.
      }
    }
    return results;
  }

  const results: InstallResult[] = [];
  for (const t of targets) {
    if (!t.configPath) {
      results.push({
        host: t.id,
        status: "skipped",
        configPath: null,
        message: `No known config path on ${process.platform}.`,
        cleanedKeys: [],
      });
      continue;
    }
    try {
      const reconciled = patchJsonConfig(t.configPath, pkg, !!opts.dryRun);
      const baseMessage = formatHostMessage({
        configPath: t.configPath,
        status: reconciled.status,
        cleanedKeys: reconciled.cleanedKeys,
        previousSpec: reconciled.previousSpec,
        newSpec: pkg,
        dryRun: !!opts.dryRun,
      });
      // Task #1205 — surface the auto-kill notice on the same host line so
      // users see "Stopped active Sam runner (pid 12345) … ✓ patched".
      const message = autoKillNotice
        ? `${autoKillNotice}\n${baseMessage}`
        : baseMessage;
      results.push({
        host: t.id,
        status: reconciled.status,
        configPath: t.configPath,
        message,
        cleanedKeys: reconciled.cleanedKeys,
        ...(reconciled.previousSpec ? { previousSpec: reconciled.previousSpec } : {}),
      });
    } catch (err) {
      results.push({
        host: t.id,
        status: "skipped",
        configPath: t.configPath,
        message: (err as Error).message,
        cleanedKeys: [],
      });
    }
  }

  // Write the upgrade history entry.
  if (!opts.dryRun) {
    const previous = mostRecentInstallEntry();
    const entry: InstallHistoryEntry = {
      ts: new Date().toISOString(),
      previousVersion: previous?.newVersion ?? null,
      newVersion: ADAPTER_VERSION,
      hosts: results.map((r): InstallHistoryHostResult => {
        const h: InstallHistoryHostResult = {
          host: r.host,
          status: r.status,
          configPath: r.configPath,
          cleanedKeys: r.cleanedKeys,
        };
        if (r.previousSpec) h.previousSpec = r.previousSpec;
        // Task #1205 — stamp the auto-killed pid on every host entry of
        // this install. Audit-only; doctor reads it to surface the kill
        // in the install-history check without changing the status enum.
        if (autoKillResult && autoKillResult.pid > 0 &&
            (autoKillResult.outcome === "killed" ||
             autoKillResult.outcome === "already-gone")) {
          h.autoKilledRunnerPid = autoKillResult.pid;
        }
        return h;
      }),
    };
    try {
      appendInstallHistoryEntry(entry);
    } catch {
      // History write failures must not block the upgrade itself.
    }
  }

  return results;
}

// Build the per-host human message printed by the CLI. Kept here (not in
// cli.ts) so other consumers — and the test suite — see the same wording
// without re-implementing it. The format intentionally mentions cleanup
// inline so users immediately see why an upgrade differed from "Patched".
function formatHostMessage(args: {
  configPath: string;
  status: ReconcileResult["status"];
  cleanedKeys: string[];
  previousSpec?: string;
  newSpec: string;
  dryRun: boolean;
}): string {
  if (args.status === "already-installed") {
    return `Already installed at ${args.configPath}.`;
  }
  const verb = args.dryRun ? "Would patch" : "Patched";
  const lines: string[] = [`${verb} ${args.configPath}.`];
  if (args.previousSpec) {
    const newSpecArgs = `-y ${args.newSpec}`;
    if (args.previousSpec === newSpecArgs) {
      lines.push(`  · canonical \`sam\` entry already up to date.`);
    } else {
      lines.push(
        `  · rewrote \`sam\` spec: \`${args.previousSpec}\` → \`${newSpecArgs}\`.`,
      );
    }
  }
  if (args.cleanedKeys.length > 0) {
    lines.push(
      `  · removed stale ${args.cleanedKeys.length === 1 ? "entry" : "entries"}: ${args.cleanedKeys
        .map((k) => `\`${k}\``)
        .join(", ")}.`,
    );
  }
  return lines.join("\n");
}
