// Local upgrade-history file written by `prepsavant install` so the
// dashboard, doctor, and a curious user can audit which version was
// installed when, what got cleaned up, and what was newly written.
//
// File location: `~/.prepsavant/install-history.json`. Per-machine state,
// no server-side schema (out of scope per task-827). Capped at the last
// `MAX_HISTORY_ENTRIES` records so it never grows unbounded.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { HostId } from "./installer.js";

// Resolved lazily so tests can swap `HOME` between runs without having to
// reset the module cache. (The `config.ts` `CONFIG_DIR` constant is
// captured at module load time and is shared by other call sites — we
// can't repurpose it without touching every consumer.)
function configDir(): string {
  return path.join(os.homedir(), ".prepsavant");
}
function installHistoryPath(): string {
  return path.join(configDir(), "install-history.json");
}
function ensureDir(): void {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
}
export const MAX_HISTORY_ENTRIES = 10;

export type InstallHistoryStatus =
  | "patched"
  | "already-installed"
  | "manual"
  | "skipped"
  | "refused-live-runner";

export interface InstallHistoryHostResult {
  host: HostId;
  status: InstallHistoryStatus;
  configPath: string | null;
  // Keys removed from `mcpServers` during reconciliation. Empty for
  // fresh installs that had no prior canonical or aliased entries.
  cleanedKeys: string[];
  // Whatever args spec the canonical `sam` key (or the only matched
  // legacy alias) carried before this install rewrote it. Useful for
  // showing "we rewrote your old @prepsavant/mcp@0.3.x pin to the
  // floating spec." Absent on fresh installs.
  previousSpec?: string;
  // Task #1205 — when present, records the pid of the active Sam runner
  // the installer terminated (or detected as already-gone) before
  // proceeding. Audit-only; doctor uses this to surface "we auto-killed
  // a runner during your last install" without changing the `status`
  // enum. Absent for installs that didn't have to clear a live runner.
  autoKilledRunnerPid?: number;
}

export interface InstallHistoryEntry {
  ts: string;
  // Resolved from the most recent prior install-history entry's
  // `newVersion`. `null` means the installer found no prior record (a
  // fresh install on this machine). Stays null even if MCP host configs
  // already contained a `sam` entry — we can't reliably reverse-engineer
  // the runner version that wrote them.
  previousVersion: string | null;
  newVersion: string;
  hosts: InstallHistoryHostResult[];
}

interface InstallHistoryFile {
  entries: InstallHistoryEntry[];
}

function readFile(): InstallHistoryFile {
  const filePath = installHistoryPath();
  if (!fs.existsSync(filePath)) return { entries: [] };
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    if (!raw.trim()) return { entries: [] };
    const parsed = JSON.parse(raw) as Partial<InstallHistoryFile>;
    if (!Array.isArray(parsed.entries)) return { entries: [] };
    return { entries: parsed.entries as InstallHistoryEntry[] };
  } catch {
    // Corrupt history is non-fatal — we'd rather lose history than block
    // the user's upgrade. The next successful install rewrites the file.
    return { entries: [] };
  }
}

// Most-recent-first list of recorded installs. Caller can take `[0]` for
// "what happened last" or scan further back for trend analysis.
export function readInstallHistory(): InstallHistoryEntry[] {
  return [...readFile().entries].sort((a, b) =>
    a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0,
  );
}

export function mostRecentInstallEntry(): InstallHistoryEntry | null {
  const entries = readInstallHistory();
  return entries[0] ?? null;
}

// Task #1382 — most-recently-installed host id, used to render a
// `--host <hostId>` flag in the upgrade hint. We scan back through the
// history (newest first) and return the first non-refused host that is
// also a *currently supported* host id — legacy values (`claude`,
// `claude_code`, `codex`) appear in old install-history entries but the
// installer no longer accepts them, so emitting `--host claude` from
// the advisory would produce a command that errors out. Returns `null`
// when:
//   - no successful install is on record (fresh machine, or every prior
//     attempt was refused), OR
//   - every recorded host is a retired/unsupported id, OR
//   - the most recent entry's supported hosts disagree (ambiguous).
// In all `null` cases callers fall back to the bare `prepsavant install`
// command rather than guessing.
const SUPPORTED_HOST_IDS = new Set<string>(["cursor"]);
export function mostRecentInstalledHostId(): HostId | null {
  for (const entry of readInstallHistory()) {
    const supported = new Set<string>();
    for (const host of entry.hosts) {
      if (
        (host.status === "patched" ||
          host.status === "already-installed") &&
        typeof host.host === "string" &&
        SUPPORTED_HOST_IDS.has(host.host)
      ) {
        supported.add(host.host);
      }
    }
    if (supported.size === 1) {
      return [...supported][0] as HostId;
    }
    if (supported.size > 1) {
      // Ambiguous — older runner installed against multiple hosts in the
      // same `prepsavant install` call. Fall back to the bare command
      // rather than picking arbitrarily.
      return null;
    }
    // No supported host on this entry — keep scanning back to an older
    // entry that might have one. Stops at the first entry with any
    // supported host (above).
  }
  return null;
}

export function appendInstallHistoryEntry(entry: InstallHistoryEntry): void {
  ensureDir();
  const file = readFile();
  file.entries.push(entry);
  // Sort oldest→newest then trim from the front so the cap is enforced
  // after every write regardless of clock skew between writes.
  file.entries.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  if (file.entries.length > MAX_HISTORY_ENTRIES) {
    file.entries = file.entries.slice(file.entries.length - MAX_HISTORY_ENTRIES);
  }
  fs.writeFileSync(installHistoryPath(), JSON.stringify(file, null, 2) + "\n");
}
