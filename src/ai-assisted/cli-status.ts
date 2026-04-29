// CLI flow for `prepsavant status [<session-id>]`.
//
// Lets users peek at an active AI-Assisted session from a second terminal
// without scrolling back through their primary terminal where the runner is
// streaming events. Calls the same /runner/ai-sessions/:id/status endpoint
// the live polling loop uses, and renders the same hook-channel summary
// plus event count, integrity status, and elapsed time, then exits.
//
// With `--watch` the snapshot is re-rendered in-place every few seconds so
// users get a lightweight live dashboard. `--interval <seconds>` overrides
// the refresh cadence (minimum 1 s, default 5 s).
// `--json` prints the raw status payload as JSON (one-shot mode only).
import { readConfig } from "../config.js";
import { ApiError, SamApi, type AiAssistedSessionStatus } from "../api.js";
import { detectStaleHooks, type StaleHookInfo } from "./hook-installer.js";
import { formatHookChannelsLine, STATUS_POLL_INTERVAL_MS } from "./cli-start.js";

// Minimum watch interval the CLI will honour regardless of --interval value.
export const WATCH_MIN_INTERVAL_MS = 1_000;

// ANSI escape to clear the screen and move the cursor to the top-left.
const ANSI_CLEAR_SCREEN = "\x1b[2J\x1b[H";

// Render an elapsed duration in ms as "HhMMm SSs", "MMm SSs", or "Ss".
// Exported for unit testing.
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// Pure formatter for the `prepsavant status` output. Exported so tests can
// assert layout without spinning up an HTTP client.
export function formatStatusReport(status: AiAssistedSessionStatus): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("  PrepSavant AI-Assisted Session Status");
  lines.push("  ─────────────────────────────────────────────");
  lines.push(`  Session:   ${status.sessionId}`);
  lines.push(`  Tool:      ${status.tool}`);
  lines.push(`  Elapsed:   ${formatElapsed(status.elapsedMs)}`);
  lines.push(`  Events:    ${status.eventCount}`);
  const integrityLine =
    status.integrityStatusDetail && status.integrityStatusDetail.length > 0
      ? `${status.integrityStatus} — ${status.integrityStatusDetail}`
      : status.integrityStatus;
  lines.push(`  Integrity: ${integrityLine}`);
  // Reuse the same Hook channels line shown by the live status poller in
  // cli-start.ts so the two surfaces stay in lockstep.
  lines.push(formatHookChannelsLine(status.hookHealth));
  lines.push("");
  return lines.join("\n");
}

// Dependencies extracted as an injection point so `runStatus` can be unit
// tested without touching the real config file, the network, or the
// workspace marker file. Production callers omit `deps` and get the real
// implementations.
export interface RunStatusDeps {
  readToken: () => string | null;
  resolveActiveSessionId: () => StaleHookInfo | null;
  fetchStatus: (token: string, sessionId: string) => Promise<AiAssistedSessionStatus>;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  setExitCode: (code: number) => void;
  // Watch-mode hooks — optional so existing tests don't need to supply them.
  clearScreen?: () => void;
  sleep?: (ms: number) => Promise<void>;
  // Called after each successful render in watch mode (useful for tests to
  // count ticks without waiting for real timers).
  onWatchTick?: () => void;
}

function defaultDeps(): RunStatusDeps {
  return {
    readToken: () => readConfig().token ?? null,
    resolveActiveSessionId: () => detectStaleHooks(process.cwd()),
    fetchStatus: (_token, sessionId) => {
      // Re-read config inside the call so the SamApi instance picks up the
      // same auth context that readToken validated above.
      return new SamApi(readConfig()).getAiAssistedSessionStatus(sessionId);
    },
    stdout: (s) => { process.stdout.write(s); },
    stderr: (s) => { process.stderr.write(s); },
    setExitCode: (code) => { process.exitCode = code; },
    clearScreen: () => { process.stdout.write(ANSI_CLEAR_SCREEN); },
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  };
}

// Parse the --interval flag value from the flags map. Returns a validated
// interval in milliseconds: at least WATCH_MIN_INTERVAL_MS, defaulting to
// STATUS_POLL_INTERVAL_MS when the flag is absent or invalid.
function parseIntervalMs(flags: Record<string, string | boolean>): number {
  const raw = flags["interval"];
  if (raw === undefined || raw === true) return STATUS_POLL_INTERVAL_MS;
  const secs = parseFloat(String(raw));
  if (!Number.isFinite(secs) || secs <= 0) return STATUS_POLL_INTERVAL_MS;
  return Math.max(WATCH_MIN_INTERVAL_MS, Math.round(secs * 1000));
}

// Fetch the status once and print the formatted report. Used by the watch
// loop (JSON mode does not apply there). Returns true on success, false on a
// fatal error (error message and exit code already applied via deps).
async function fetchAndPrint(
  token: string,
  sessionId: string,
  deps: RunStatusDeps,
): Promise<boolean> {
  let status: AiAssistedSessionStatus;
  try {
    status = await deps.fetchStatus(token, sessionId);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      deps.stderr(`Unknown session id: ${sessionId}\n`);
      deps.setExitCode(1);
      return false;
    }
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      deps.stderr(
        "Not authorized for this session. Run `prepsavant auth` to re-link this device.\n",
      );
      deps.setExitCode(1);
      return false;
    }
    deps.stderr(`Failed to fetch session status: ${(err as Error).message}\n`);
    deps.setExitCode(1);
    return false;
  }
  deps.stdout(formatStatusReport(status));
  return true;
}

export async function runStatus(
  positional: string[],
  flags: Record<string, string | boolean>,
  deps: RunStatusDeps = defaultDeps(),
): Promise<void> {
  const jsonMode = !!flags.json;
  const watchMode = Boolean(flags["watch"]);

  // Route error messages through JSON when --json is active so callers can
  // parse failures the same way as the success payload. In JSON mode we
  // strip trailing whitespace/newlines from the message so scripts don't
  // have to call `.trim()` on the parsed `error` field — the surrounding
  // newline already terminates the JSON line on stderr.
  function stderrError(message: string): void {
    if (jsonMode) {
      deps.stderr(JSON.stringify({ error: message.replace(/\s+$/, "") }) + "\n");
    } else {
      deps.stderr(message);
    }
  }

  const token = deps.readToken();
  if (!token) {
    stderrError("Not authorized. Run `prepsavant auth` first.\n");
    deps.setExitCode(1);
    return;
  }

  // Resolve session id from positional arg or workspace marker.
  let sessionId = positional[0];
  if (!sessionId) {
    const marker = deps.resolveActiveSessionId();
    if (!marker || marker.sessionId === "unknown") {
      stderrError(
        "No active session found in this workspace.\n" +
        "Pass a session id explicitly: prepsavant status <session-id>\n",
      );
      deps.setExitCode(1);
      return;
    }
    sessionId = marker.sessionId;
  }

  if (!watchMode) {
    // ---------------------------------------------------------------------------
    // One-shot path — fetch once, emit output (JSON or formatted), then exit.
    // ---------------------------------------------------------------------------
    let status: AiAssistedSessionStatus;
    try {
      status = await deps.fetchStatus(token, sessionId);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        stderrError(`Unknown session id: ${sessionId}\n`);
        deps.setExitCode(1);
        return;
      }
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        stderrError(
          "Not authorized for this session. Run `prepsavant auth` to re-link this device.\n",
        );
        deps.setExitCode(1);
        return;
      }
      stderrError(`Failed to fetch session status: ${(err as Error).message}\n`);
      deps.setExitCode(1);
      return;
    }
    if (jsonMode) {
      deps.stdout(JSON.stringify(status) + "\n");
    } else {
      deps.stdout(formatStatusReport(status) + "\n");
    }
    return;
  }

  // ---------------------------------------------------------------------------
  // Watch mode — re-render the snapshot in place every `intervalMs` until the
  // user presses Ctrl+C (SIGINT) or the process receives SIGTERM.
  // JSON mode does not apply in watch mode (the screen is cleared each tick).
  // ---------------------------------------------------------------------------
  const intervalMs = parseIntervalMs(flags);
  const intervalSec = Math.round(intervalMs / 1000);

  const clearScreen = deps.clearScreen ?? (() => { process.stdout.write(ANSI_CLEAR_SCREEN); });
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); }));

  let watching = true;
  let abortSleep: (() => void) | null = null;

  const stopWatch = () => {
    watching = false;
    abortSleep?.();
  };

  // Register signal handlers so Ctrl+C exits cleanly with code 0.
  // Use `once` so these don't stack up if runStatus is called multiple times
  // in tests; a real process only calls this once anyway.
  process.once("SIGINT", stopWatch);
  process.once("SIGTERM", stopWatch);

  try {
    while (watching) {
      clearScreen();

      const ok = await fetchAndPrint(token, sessionId, deps);
      if (!ok) {
        // A fatal fetch error (404, auth error, etc.) should stop the watch
        // loop and propagate the exit code that fetchAndPrint already set.
        break;
      }

      deps.stdout(
        `\n  Refreshing every ${intervalSec}s — press Ctrl+C to stop\n`,
      );

      deps.onWatchTick?.();

      if (!watching) break;

      // Interruptible sleep: resolves when the timer fires or when stopWatch()
      // is called (e.g. on SIGINT).
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          abortSleep = null;
          resolve();
        }, intervalMs);
        abortSleep = () => {
          clearTimeout(timer);
          abortSleep = null;
          resolve();
        };
      });
    }
  } finally {
    // Clean up signal listeners if they haven't fired yet.
    process.off("SIGINT", stopWatch);
    process.off("SIGTERM", stopWatch);
  }
}
