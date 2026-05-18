// Task #1211 — file-based mutex for the long-lived sandbox build cache
// directories. The C#/Kotlin graders share one cache dir per harness
// version across attempts, so concurrent invocations (e.g. a runner
// grading two questions in quick succession) need to be serialized to
// keep MSBuild / kotlinc from racing on Solution.cs / solution.kt and
// the bin / obj outputs.
//
// Implementation is intentionally minimal: O_EXCL lockfile with a
// stale-lock breaker (5 min) and a synchronous busy-wait that piggybacks
// on Atomics.wait so it integrates cleanly with the spawnSync graders
// without pulling in a new dependency.
import * as fs from "node:fs";

const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));
const STALE_LOCK_MS = 5 * 60_000;

function sleep(ms: number): void {
  Atomics.wait(SLEEP_BUF, 0, 0, ms);
}

export class SandboxLockTimeoutError extends Error {
  constructor(public readonly lockPath: string, public readonly timeoutMs: number) {
    super(`sandbox lock at ${lockPath} held longer than ${timeoutMs}ms`);
    this.name = "SandboxLockTimeoutError";
  }
}

export function withSandboxLock<T>(
  lockPath: string,
  timeoutMs: number,
  fn: () => T,
): T {
  const deadline = Date.now() + Math.max(timeoutMs, 1000);
  while (true) {
    let fd: number | null = null;
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        // lock vanished between stat and unlink; just retry
        continue;
      }
      if (Date.now() > deadline) {
        throw new SandboxLockTimeoutError(lockPath, timeoutMs);
      }
      sleep(50);
      continue;
    }
    try {
      return fn();
    } finally {
      try {
        if (fd !== null) fs.closeSync(fd);
      } catch {
        // best-effort
      }
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // best-effort
      }
    }
  }
}
