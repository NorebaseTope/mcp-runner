// Lightweight pid-lockfile so `prepsavant install` can refuse to patch
// MCP host configs while a Sam runner process is currently active.
//
// The MCP server (`prepsavant mcp`) writes the lockfile on startup and
// removes it on graceful exit. The installer reads it and aborts if the
// recorded pid is still alive. A stale file (process gone) is removed on
// the next read so a crashed runner doesn't permanently block upgrades.
//
// File location: `~/.prepsavant/runner.lock` — global per-user, mirroring
// where the rest of the runner's config lives. We do NOT lock per-workspace
// because MCP host configs are themselves global; the only thing the
// installer needs to know is "is a Sam runner process holding any of those
// configs open right now".
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

// Resolved lazily so tests can swap `HOME` between runs without resetting
// the module cache. (Mirrors the lazy-resolution pattern in
// install-history.ts — see the comment there for the rationale.)
function configDir(): string {
  return path.join(os.homedir(), ".prepsavant");
}
function runnerLockPath(): string {
  return path.join(configDir(), "runner.lock");
}
function ensureDir(): void {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
}

export interface RunnerLockInfo {
  pid: number;
  startedAt: string;
  // Task #1382 — host id of the process that spawned this runner (e.g.
  // "cursor", "claude-code", "codex"). Detected by inspecting the
  // parent process's command line at lock-acquire time. Optional
  // because (a) older lockfiles on disk don't carry it, (b) the probe
  // is best-effort — when it fails we still write a lockfile, just
  // without the host stamp. The installer uses this to detect the
  // Cursor-relaunch loop and append a "fully quit Cursor" hint to the
  // refusal copy.
  host?: string;
}

// True when the OS reports the pid as a live process. `process.kill(pid, 0)`
// sends no signal but throws ESRCH when the process is gone (and EPERM when
// the process exists but the caller lacks permission — still "alive").
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    return false;
  }
}

// Read the on-disk lock and verify its pid is still alive. A stale file
// (process gone, corrupt JSON, missing pid) is removed in passing so the
// next install isn't permanently blocked by a previous crash.
export function readActiveRunnerLock(
  // Test seam — defaults to the real liveness probe. `stopActiveRunner`
  // forwards its own `isAliveFn` here so a synthetic pid in tests
  // (which the real OS would report as "not alive") still survives the
  // initial liveness check and reaches the verify/kill code path.
  isAliveFnArg: (pid: number) => boolean = isPidAlive,
): RunnerLockInfo | null {
  const lockPath = runnerLockPath();
  if (!fs.existsSync(lockPath)) return null;
  let parsed: Partial<RunnerLockInfo> | null = null;
  try {
    parsed = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as Partial<RunnerLockInfo>;
  } catch {
    parsed = null;
  }
  const pid = typeof parsed?.pid === "number" ? parsed.pid : null;
  if (!pid || !isAliveFnArg(pid)) {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // best-effort; if we can't remove it the next install attempt will
      // also see no live pid and fall into this same branch.
    }
    return null;
  }
  // Task #1382 — preserve the optional `host` stamp so the installer's
  // refused-live-runner branch can append a host-specific quit hint
  // (e.g. "fully quit Cursor" for the Cursor relaunch loop). Older
  // lockfiles written before the host stamp landed simply omit the
  // field; we treat any non-string value as "unknown host".
  const host =
    typeof parsed?.host === "string" && parsed.host.trim()
      ? parsed.host.trim()
      : undefined;
  return {
    pid,
    startedAt: typeof parsed?.startedAt === "string" ? parsed.startedAt : new Date(0).toISOString(),
    ...(host ? { host } : {}),
  };
}

// Acquire the lock for the current process. Idempotent: a stale lockfile
// (recorded pid is gone) is replaced; a live one is overwritten with the
// caller's pid because the MCP server is the canonical writer and the
// only legitimate caller is `runMcpServer`.
//
// Returns a `release()` callback the caller can invoke on graceful exit.
// We also wire `process.on("exit")` so abrupt exits still clear the file
// in the common cases (`process.exit`, normal termination).
// Best-effort removal of the lockfile by absolute path. Used by
// `stopActiveRunner` after it terminates the recorded pid so the next
// install attempt sees no live runner. Swallow ENOENT and any other
// removal failure — a stale lockfile is recovered automatically by
// `readActiveRunnerLock`'s pid-liveness check.
function unlinkRunnerLockFile(): void {
  try {
    fs.unlinkSync(runnerLockPath());
  } catch {
    // best-effort
  }
}

export interface StopRunnerOptions {
  // Test seam — defaults to `process.kill`. Production callers leave this
  // unset.
  killFn?: (pid: number, signal: NodeJS.Signals | number) => void;
  // Test seam — defaults to the module-private liveness probe.
  isAliveFn?: (pid: number) => boolean;
  // Test seam — defaults to a synchronous Atomics.wait sleep so install()
  // can stay synchronous (its callers — installer.ts, the CLI's `install`
  // branch, and every existing test — invoke it as a sync call).
  sleepFn?: (ms: number) => void;
  // Total wall-clock budget granted to SIGTERM before escalation. Default
  // ~2s matches how long Cursor takes to release stdio when `prepsavant
  // mcp` exits gracefully.
  graceMs?: number;
  // Test seam — defaults to `verifyRunnerProcess`, which inspects the
  // OS-reported command line of `pid` and returns true only when it
  // looks like a Sam runner (`prepsavant` / `@prepsavant/mcp`). The
  // installer never signals a pid that fails verification — instead it
  // treats the lockfile as stale and clears it. This is the safety net
  // against PID reuse on long-running boxes where a recycled pid could
  // belong to an unrelated user process.
  verifyFn?: (pid: number) => boolean;
}

export interface StopRunnerResult {
  outcome: "killed" | "already-gone" | "kill-failed";
  pid: number;
  signalUsed?: "SIGTERM" | "SIGKILL";
  error?: string;
}

// Synchronous sleep using Atomics.wait on a SharedArrayBuffer. We need a
// blocking sleep (rather than `setTimeout`) so we can keep the installer
// API synchronous — wiring async into install() would cascade into every
// caller, the CLI, and the existing installer-* tests.
function defaultSyncSleep(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, ms);
}

// Inspect the OS-reported command line of `pid` and decide whether it
// looks like a Sam runner. Returns false (i.e. "not a Sam runner — do
// NOT signal this pid") in the safe direction whenever:
//   - the platform-specific probe fails or returns nothing
//   - the recovered command line does not mention `prepsavant` or
//     `@prepsavant/mcp`
//
// This is the PID-reuse safety net the installer leans on before sending
// SIGTERM/SIGKILL. Without it, a stale `runner.lock` whose pid had been
// recycled by the kernel could lead `prepsavant install` to terminate an
// unrelated user process. We deliberately fail-closed: an empty / errored
// probe is treated as "not a Sam runner" so we never kill on doubt.
//
// The `prepsavant` / `@prepsavant/mcp` markers cover both install
// styles: `npx -y @prepsavant/mcp` (what the installer writes into MCP
// host configs) and a direct `prepsavant mcp` invocation (what the CLI
// shim resolves to once npm has materialised the bin shim).
const RUNNER_PROCESS_MARKER = /(?:prepsavant|@prepsavant\/mcp)/i;
export function verifyRunnerProcess(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  let cmdline = "";
  try {
    if (process.platform === "win32") {
      // PowerShell's CIM is the only stdlib-only way to recover the full
      // command line on modern Windows (wmic is deprecated and missing
      // on newer SKUs). We pass `-NoProfile` to keep startup fast and
      // avoid user-profile side effects.
      const r = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object -ExpandProperty CommandLine`,
        ],
        { encoding: "utf8", timeout: 2000 },
      );
      if (r.status === 0 && typeof r.stdout === "string") cmdline = r.stdout;
    } else {
      // POSIX — `ps -p <pid> -o command=` prints the argv-joined command
      // line with no header, identical across macOS and Linux.
      const r = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
        encoding: "utf8",
        timeout: 2000,
      });
      if (r.status === 0 && typeof r.stdout === "string") cmdline = r.stdout;
    }
  } catch {
    return false;
  }
  if (!cmdline.trim()) return false;
  return RUNNER_PROCESS_MARKER.test(cmdline);
}

// Read the active runner lock and terminate the recorded pid. Used by
// `prepsavant install` to make the install path self-healing — without
// this, users who forget to quit Cursor (or a previous `prepsavant mcp`
// shell) hit `refused-live-runner` with no copy-pasteable next step.
//
// SIGTERM first, poll for up to ~`graceMs` for the process to exit, then
// escalate to SIGKILL. The lockfile is unlinked on success so the next
// install attempt sees a clean slate. EPERM (cross-user kill) and
// "process still alive after SIGKILL grace period" both surface as
// `kill-failed`; the caller falls back to today's strict refusal with a
// manual-kill hint.
export function stopActiveRunner(opts: StopRunnerOptions = {}): StopRunnerResult {
  const lock = readActiveRunnerLock(opts.isAliveFn ?? isPidAlive);
  if (!lock) {
    // Either the file was missing or the recorded pid is gone —
    // readActiveRunnerLock unlinked the stale file in passing.
    return { outcome: "already-gone", pid: 0 };
  }
  const pid = lock.pid;
  const killFn = opts.killFn ?? ((p, s) => process.kill(p, s));
  const isAliveFn = opts.isAliveFn ?? isPidAlive;
  const sleepFn = opts.sleepFn ?? defaultSyncSleep;
  const graceMs = opts.graceMs ?? 2000;
  const pollMs = 100;
  const verifyFn = opts.verifyFn ?? verifyRunnerProcess;

  // PID-reuse safety net. If the OS-reported command line at `pid` does
  // NOT look like a Sam runner — either because the lockfile is stale
  // and the kernel has recycled the pid for an unrelated process, or
  // because we couldn't recover the command line at all — refuse to
  // signal it. Treat the lock as stale, unlink, and report
  // `already-gone` so the installer proceeds with a clean slate. This
  // is the deliberate fail-closed branch the code review demanded.
  if (!verifyFn(pid)) {
    unlinkRunnerLockFile();
    return { outcome: "already-gone", pid };
  }

  try {
    killFn(pid, "SIGTERM");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      // Raced with the runner exiting on its own. Clean up and report.
      unlinkRunnerLockFile();
      return { outcome: "already-gone", pid };
    }
    return {
      outcome: "kill-failed",
      pid,
      signalUsed: "SIGTERM",
      error: (err as Error).message,
    };
  }

  const termDeadline = Date.now() + graceMs;
  while (Date.now() < termDeadline) {
    if (!isAliveFn(pid)) {
      unlinkRunnerLockFile();
      return { outcome: "killed", pid, signalUsed: "SIGTERM" };
    }
    sleepFn(pollMs);
  }

  // Escalate. On Windows, `process.kill(pid, "SIGKILL")` is treated like
  // a forced TerminateProcess by libuv, so the same code path works.
  try {
    killFn(pid, "SIGKILL");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      unlinkRunnerLockFile();
      return { outcome: "killed", pid, signalUsed: "SIGTERM" };
    }
    return {
      outcome: "kill-failed",
      pid,
      signalUsed: "SIGKILL",
      error: (err as Error).message,
    };
  }
  const killDeadline = Date.now() + 500;
  while (Date.now() < killDeadline) {
    if (!isAliveFn(pid)) {
      unlinkRunnerLockFile();
      return { outcome: "killed", pid, signalUsed: "SIGKILL" };
    }
    sleepFn(50);
  }
  return {
    outcome: "kill-failed",
    pid,
    signalUsed: "SIGKILL",
    error: "process still alive after SIGKILL grace period",
  };
}

// Task #1382 — best-effort detection of which MCP host launched this
// runner, by inspecting the parent process's command line. Only known
// host markers are returned; unknown parents resolve to `undefined` so
// we never stamp speculative data into the lockfile. Exported for
// tests; the production code path is `acquireRunnerLock` below.
const HOST_PROCESS_MARKERS: Array<{ id: string; pattern: RegExp }> = [
  { id: "cursor", pattern: /(?:^|[\\/])Cursor(?:\.exe)?\b/i },
  { id: "claude-code", pattern: /claude(?:[-_ ])?code/i },
  { id: "codex", pattern: /\bcodex(?:-cli)?\b/i },
  { id: "vscode", pattern: /(?:^|[\\/])(?:Code|code)(?:\.exe)?\b/ },
];
export function detectHostFromParent(
  ppid: number = process.ppid,
): string | undefined {
  if (!Number.isInteger(ppid) || ppid <= 1) return undefined;
  let cmdline = "";
  try {
    if (process.platform === "win32") {
      const r = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `Get-CimInstance Win32_Process -Filter "ProcessId=${ppid}" | Select-Object -ExpandProperty CommandLine`,
        ],
        { encoding: "utf8", timeout: 2000 },
      );
      if (r.status === 0 && typeof r.stdout === "string") cmdline = r.stdout;
    } else {
      const r = spawnSync("ps", ["-p", String(ppid), "-o", "command="], {
        encoding: "utf8",
        timeout: 2000,
      });
      if (r.status === 0 && typeof r.stdout === "string") cmdline = r.stdout;
    }
  } catch {
    return undefined;
  }
  if (!cmdline.trim()) return undefined;
  for (const { id, pattern } of HOST_PROCESS_MARKERS) {
    if (pattern.test(cmdline)) return id;
  }
  return undefined;
}

export function acquireRunnerLock(
  now: () => Date = () => new Date(),
  // Task #1382 — test seam: lets the unit test inject a synthetic host
  // id without spawning real `ps` / PowerShell. Production callers omit
  // this and the lock falls back to `detectHostFromParent`.
  detectHostFn: () => string | undefined = detectHostFromParent,
): () => void {
  ensureDir();
  const host = (() => {
    try {
      return detectHostFn();
    } catch {
      return undefined;
    }
  })();
  const info: RunnerLockInfo = {
    pid: process.pid,
    startedAt: now().toISOString(),
    ...(host ? { host } : {}),
  };
  const lockPath = runnerLockPath();
  fs.writeFileSync(lockPath, JSON.stringify(info, null, 2) + "\n");
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    try {
      const raw = fs.existsSync(lockPath)
        ? fs.readFileSync(lockPath, "utf-8")
        : "";
      if (raw.trim()) {
        const parsed = JSON.parse(raw) as Partial<RunnerLockInfo>;
        if (parsed.pid !== process.pid) return;
      }
      fs.unlinkSync(lockPath);
    } catch {
      // best-effort
    }
  };
  process.on("exit", release);
  return release;
}
