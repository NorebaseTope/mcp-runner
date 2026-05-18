// Task #1211 — verify the long-lived per-language sandbox build cache:
//   * cache dirs are namespaced by harness-template version so a
//     template bump invalidates the cache automatically
//   * the file-lock helper serializes overlapping callers and breaks a
//     stale lock instead of deadlocking forever
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { __cppCacheInternals } from "../sandbox/cpp.js";
import { __csharpCacheInternals } from "../sandbox/csharp.js";
import { __goCacheInternals } from "../sandbox/go.js";
import { __javaCacheInternals } from "../sandbox/java.js";
import { __kotlinCacheInternals, runKotlinSandbox } from "../sandbox/kotlin.js";
import { __rustCacheInternals } from "../sandbox/rust.js";
import { SandboxLockTimeoutError, withSandboxLock } from "../sandbox/lock.js";
import { Worker } from "node:worker_threads";

describe("sandbox cache dirs", () => {
  it("csharp cache dir is namespaced by harness version", () => {
    const dir = __csharpCacheInternals.cacheDir();
    assert.ok(
      dir.endsWith(path.join("sandbox-cache", "csharp", __csharpCacheInternals.HARNESS_VERSION)),
      `unexpected cache dir: ${dir}`,
    );
    assert.equal(__csharpCacheInternals.HARNESS_VERSION.length, 16);
  });
  it("kotlin cache dir is namespaced by harness version", () => {
    const dir = __kotlinCacheInternals.cacheDir();
    assert.ok(
      dir.endsWith(path.join("sandbox-cache", "kotlin", __kotlinCacheInternals.HARNESS_VERSION)),
      `unexpected cache dir: ${dir}`,
    );
    assert.equal(__kotlinCacheInternals.HARNESS_VERSION.length, 16);
  });
  // Task #1231 — extend the namespacing guard to cpp / java / go / rust.
  // Same contract as csharp / kotlin: cache dir is
  // `<…>/sandbox-cache/<lang>/<HARNESS_VERSION>` and the version is a
  // 16-hex-char sha256 prefix so a harness-template bump invalidates
  // the cache automatically.
  it("cpp cache dir is namespaced by harness version", () => {
    const dir = __cppCacheInternals.cacheDir();
    assert.ok(
      dir.endsWith(path.join("sandbox-cache", "cpp", __cppCacheInternals.HARNESS_VERSION)),
      `unexpected cache dir: ${dir}`,
    );
    assert.equal(__cppCacheInternals.HARNESS_VERSION.length, 16);
  });
  it("java cache dir is namespaced by harness version", () => {
    const dir = __javaCacheInternals.cacheDir();
    assert.ok(
      dir.endsWith(path.join("sandbox-cache", "java", __javaCacheInternals.HARNESS_VERSION)),
      `unexpected cache dir: ${dir}`,
    );
    assert.equal(__javaCacheInternals.HARNESS_VERSION.length, 16);
  });
  it("go cache dir is namespaced by harness version", () => {
    const dir = __goCacheInternals.cacheDir();
    assert.ok(
      dir.endsWith(path.join("sandbox-cache", "go", __goCacheInternals.HARNESS_VERSION)),
      `unexpected cache dir: ${dir}`,
    );
    assert.equal(__goCacheInternals.HARNESS_VERSION.length, 16);
  });
  it("rust cache dir is namespaced by harness version", () => {
    const dir = __rustCacheInternals.cacheDir();
    assert.ok(
      dir.endsWith(path.join("sandbox-cache", "rust", __rustCacheInternals.HARNESS_VERSION)),
      `unexpected cache dir: ${dir}`,
    );
    assert.equal(__rustCacheInternals.HARNESS_VERSION.length, 16);
  });
});

describe("withSandboxLock", () => {
  it("runs the body under an exclusive lock and cleans up the lockfile", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-lock-"));
    const lockPath = path.join(tmp, ".lock");
    try {
      const out = withSandboxLock(lockPath, 5_000, () => {
        assert.ok(fs.existsSync(lockPath), "lockfile should be held during fn");
        return 42;
      });
      assert.equal(out, 42);
      assert.equal(fs.existsSync(lockPath), false, "lockfile should be removed after fn");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  it("serializes overlapping holders and times out via SandboxLockTimeoutError", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-lock-"));
    const lockPath = path.join(tmp, ".lock");
    try {
      // Spawn a worker that grabs the lock and holds it for ~1500ms.
      // The contender uses the helper's effective minimum 1s deadline
      // (`Math.max(timeoutMs, 1000)`) so a 50ms ask will give up at
      // ~1000ms while the worker still holds — proving serialization
      // and surfacing `SandboxLockTimeoutError`.
      const worker = new Worker(
        `const { parentPort, workerData } = require('node:worker_threads');
         const fs = require('node:fs');
         const fd = fs.openSync(workerData.lockPath, 'wx', 0o600);
         parentPort.postMessage('held');
         const buf = new Int32Array(new SharedArrayBuffer(4));
         Atomics.wait(buf, 0, 0, 1500);
         try { fs.closeSync(fd); } catch {}
         try { fs.unlinkSync(workerData.lockPath); } catch {}`,
        { eval: true, workerData: { lockPath } },
      );
      await new Promise<void>((resolve) =>
        worker.once("message", (m) => m === "held" && resolve()),
      );
      let observed: unknown = null;
      try {
        withSandboxLock(lockPath, 50, () => "should-not-acquire");
      } catch (e) {
        observed = e;
      }
      assert.ok(observed instanceof SandboxLockTimeoutError, `unexpected: ${observed}`);
      // After the worker releases, a fresh attempt should succeed.
      await new Promise<void>((resolve) => worker.once("exit", () => resolve()));
      const after = withSandboxLock(lockPath, 5_000, () => "ok");
      assert.equal(after, "ok");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  it("runKotlinSandbox returns a structured timeout when the harness lock is held", async () => {
    // Hold the per-version `.harness.lock` from a worker thread so the
    // grader's `ensureCacheDir(timeoutMs)` cold-start path sees real
    // contention. The helper enforces a 1s minimum deadline, so a
    // short-budget call must surface `outcome: "timeout"` instead of
    // throwing `SandboxLockTimeoutError` out of the grader.
    const dir = __kotlinCacheInternals.cacheDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const harnessJar = path.join(dir, "harness.jar");
    const stamp = path.join(dir, "harness.version");
    // Force the slow path by removing any prebuilt harness artifacts.
    try { fs.rmSync(harnessJar); } catch {}
    try { fs.rmSync(stamp); } catch {}
    const lockPath = path.join(dir, ".harness.lock");
    const worker = new Worker(
      `const { parentPort, workerData } = require('node:worker_threads');
       const fs = require('node:fs');
       const fd = fs.openSync(workerData.lockPath, 'wx', 0o600);
       parentPort.postMessage('held');
       const buf = new Int32Array(new SharedArrayBuffer(4));
       Atomics.wait(buf, 0, 0, 1500);
       try { fs.closeSync(fd); } catch {}
       try { fs.unlinkSync(workerData.lockPath); } catch {}`,
      { eval: true, workerData: { lockPath } },
    );
    try {
      await new Promise<void>((resolve) =>
        worker.once("message", (m) => m === "held" && resolve()),
      );
      const result = runKotlinSandbox("fun noop() {}", "noop", [], 50);
      assert.equal(result.outcome, "timeout", JSON.stringify(result));
      assert.equal(result.timedOut, true);
    } finally {
      await new Promise<void>((resolve) => worker.once("exit", () => resolve()));
    }
  });
  it("breaks a stale lockfile instead of deadlocking", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-lock-"));
    const lockPath = path.join(tmp, ".lock");
    try {
      // Drop a "stale" lockfile whose mtime is well beyond the 5-min
      // staleness threshold the helper enforces.
      fs.writeFileSync(lockPath, "");
      const past = (Date.now() - 10 * 60_000) / 1000;
      fs.utimesSync(lockPath, past, past);
      const out = withSandboxLock(lockPath, 5_000, () => "ok");
      assert.equal(out, "ok");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
