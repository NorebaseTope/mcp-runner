// Task #1205 — `prepsavant install` auto-kills any active Sam runner so
// re-installs / upgrades stop dead-ending on `refused-live-runner`. The
// strict pre-1205 refusal is preserved behind `--no-kill`.
//
// What we lock in here, all on a per-test temp HOME so each scenario
// sees a pristine `~/.prepsavant`:
//   1. Default (autoKill: true) + a live lock → installer stops the
//      runner, prepends a "Stopped active Sam runner" notice to the
//      per-host message, completes the patch, and stamps
//      `autoKilledRunnerPid` on the install-history entry.
//   2. `autoKill: false` + a live lock → preserves today's
//      `refused-live-runner` outcome verbatim. No kill is attempted.
//   3. Default + a live lock that we can't terminate → falls through
//      to `refused-live-runner` with a manual-kill hint
//      (`kill -9 <pid>` on POSIX, `taskkill /F /PID <pid>` on win32)
//      so the user always has a copy-pasteable next step.
//   4. Default + no live lock → no kill is attempted, no notice is
//      added, install behaves exactly as it did pre-1205. Confirms
//      the auto-kill code path is silent on the happy path.

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function withTempHome<T>(fn: (homeDir: string) => Promise<T> | T): Promise<T> {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "prepsavant-autokill-"));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  return Promise.resolve(fn(homeDir)).finally(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    try {
      fs.rmSync(homeDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });
}

function cursorConfigPathFor(homeDir: string): string {
  return path.join(homeDir, ".cursor", "mcp.json");
}

function writeJson(p: string, data: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

function readJson<T = unknown>(p: string): T {
  return JSON.parse(fs.readFileSync(p, "utf-8")) as T;
}

test("install: auto-kills the live runner, prepends a notice, and stamps the pid on history", async () => {
  await withTempHome(async (homeDir) => {
    const cfgPath = cursorConfigPathFor(homeDir);
    writeJson(cfgPath, { mcpServers: {} });

    const { install } = await import("../installer.js");
    const fakePid = 999999; // a pid we'd never actually have
    let stopCalls = 0;
    const results = install({
      host: "cursor",
      // Pretend the runner is holding the lock. We pass the lock
      // explicitly so the installer doesn't have to read the real
      // ~/.prepsavant/runner.lock — the fake `stopActiveRunner` below
      // mimics the lockfile being cleared on kill.
      liveRunnerLock: { pid: fakePid, startedAt: "2026-05-13T12:00:00.000Z" },
      stopActiveRunner: () => {
        stopCalls++;
        return { outcome: "killed", pid: fakePid, signalUsed: "SIGTERM" };
      },
    });

    assert.equal(stopCalls, 1, "stopActiveRunner should be called exactly once");
    assert.equal(results.length, 1);
    const r = results[0]!;
    assert.equal(r.host, "cursor");
    // Patch should have proceeded — we land on the routine `patched` status
    // and the cursor mcp.json is rewritten with the canonical `sam` entry.
    assert.equal(r.status, "patched");
    assert.match(
      r.message,
      /Stopped active Sam runner \(pid 999999\) before patching\./,
      "auto-kill notice should be prepended to the per-host message",
    );
    assert.match(r.message, /Patched .*mcp\.json/);

    const config = readJson<{ mcpServers: Record<string, unknown> }>(cfgPath);
    assert.ok(config.mcpServers.sam, "canonical `sam` entry must be written");

    // Audit trail — the install-history entry stamps `autoKilledRunnerPid`
    // so doctor can mention it on the install-history check.
    const { readInstallHistory } = await import("../install-history.js");
    const history = readInstallHistory();
    assert.equal(history.length, 1);
    const host = history[0]!.hosts[0]!;
    assert.equal(host.status, "patched");
    assert.equal(host.autoKilledRunnerPid, fakePid);
  });
});

test("install: --no-kill preserves the strict refused-live-runner refusal", async () => {
  await withTempHome(async (homeDir) => {
    const cfgPath = cursorConfigPathFor(homeDir);
    writeJson(cfgPath, { mcpServers: {} });

    const { install } = await import("../installer.js");
    const fakePid = 999998;
    let stopCalls = 0;
    const results = install({
      host: "cursor",
      autoKill: false,
      liveRunnerLock: { pid: fakePid, startedAt: "2026-05-13T12:00:00.000Z" },
      stopActiveRunner: () => {
        stopCalls++;
        return { outcome: "killed", pid: fakePid, signalUsed: "SIGTERM" };
      },
    });

    assert.equal(stopCalls, 0, "--no-kill must not call stopActiveRunner");
    const r = results[0]!;
    assert.equal(r.status, "refused-live-runner");
    assert.match(r.message, /Refusing to patch/);
    assert.match(r.message, /pid 999998/);
    // No mcpServers.sam entry should have been written — the patch
    // path was short-circuited before the JSON rewrite.
    const config = readJson<{ mcpServers: Record<string, unknown> }>(cfgPath);
    assert.equal(config.mcpServers.sam, undefined);
  });
});

test("install: kill-failed falls back to refused-live-runner with a manual-kill hint", async () => {
  await withTempHome(async (homeDir) => {
    const cfgPath = cursorConfigPathFor(homeDir);
    writeJson(cfgPath, { mcpServers: {} });

    const { install } = await import("../installer.js");
    const fakePid = 999997;
    const results = install({
      host: "cursor",
      liveRunnerLock: { pid: fakePid, startedAt: "2026-05-13T12:00:00.000Z" },
      stopActiveRunner: () => ({
        outcome: "kill-failed",
        pid: fakePid,
        signalUsed: "SIGKILL",
        error: "operation not permitted",
      }),
    });

    const r = results[0]!;
    assert.equal(r.status, "refused-live-runner");
    // The refusal message should name the kill failure AND give the
    // user a copy-pasteable manual-kill command for their platform.
    assert.match(r.message, /tried to auto-stop/);
    assert.match(r.message, /operation not permitted/);
    // Task #1382 — manual-kill one-liner is OS-correct AND now leads the
    // refusal copy (it appears before the prose) so users can paste it
    // straight away. On Windows we standardize on PowerShell's
    // `Stop-Process -Id <pid> -Force` rather than `taskkill /F /PID` to
    // match the rest of the runner's PowerShell-based probes.
    const expectedManualKill =
      process.platform === "win32"
        ? `Stop-Process -Id ${fakePid} -Force`
        : `kill -9 ${fakePid}`;
    assert.ok(
      r.message.includes(expectedManualKill),
      `refusal message should include "${expectedManualKill}", got: ${r.message}`,
    );
    // The kill command must precede the explanatory prose — it's the
    // first actionable thing the user sees, not buried after a paragraph.
    const killIdx = r.message.indexOf(expectedManualKill);
    const proseIdx = r.message.indexOf("Stop the runner manually");
    assert.ok(killIdx >= 0 && proseIdx >= 0 && killIdx < proseIdx,
      "kill one-liner must appear before the prose explanation");

    // Patch must NOT have proceeded — kill-failed is a hard refusal.
    const config = readJson<{ mcpServers: Record<string, unknown> }>(cfgPath);
    assert.equal(config.mcpServers.sam, undefined);
  });
});

// Task #1205 — PID-reuse safety net. The real `stopActiveRunner` MUST
// verify the OS-reported command line of the locked pid before signalling
// it; if the lockfile is stale and the kernel has recycled the pid for an
// unrelated user process, we must NOT kill that process. This locks in
// the fail-closed branch (verifyFn returns false → unlink lock, return
// `already-gone`, no kill is attempted).
test("stopActiveRunner: foreign-process pid is treated as a stale lock — never signalled", async () => {
  await withTempHome(async (homeDir) => {
    // Hand-write a runner.lock pointing at a pid that "verification" will
    // reject. Using the lockfile path directly (rather than letting the
    // installer write it) keeps the test independent of installer wiring.
    const lockPath = path.join(homeDir, ".prepsavant", "runner.lock");
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999996, startedAt: "2026-05-13T12:00:00.000Z" }),
    );

    const { stopActiveRunner } = await import("../runner-lock.js");
    let killCalls = 0;
    const result = stopActiveRunner({
      // The pid is "alive" from the kernel's perspective, but verifyFn
      // says "not a Sam runner" — the recycled-pid scenario.
      isAliveFn: () => true,
      verifyFn: () => false,
      killFn: () => {
        killCalls++;
      },
    });

    assert.equal(killCalls, 0, "kill MUST NOT be called for a foreign pid");
    assert.equal(result.outcome, "already-gone");
    assert.equal(result.pid, 999996);
    // Lockfile is unlinked so the next install attempt sees a clean slate.
    assert.equal(fs.existsSync(lockPath), false);
  });
});

// Task #1382 — when the user opts out of auto-kill (`--no-kill`) AND the
// lockfile records a Cursor-launched runner, the refusal copy must:
//   1. Lead with the OS-correct kill one-liner (not bury it in prose).
//   2. Show the re-run command directly under the kill line.
//   3. Append a "fully quit Cursor" hint so users who close the Cursor
//      window but leave it in the dock/tray realise that's the loop
//      they're stuck in.
test("install: --no-kill + cursor lock → kill one-liner first, then re-run, then Cursor-quit hint", async () => {
  await withTempHome(async (homeDir) => {
    const cfgPath = cursorConfigPathFor(homeDir);
    writeJson(cfgPath, { mcpServers: {} });

    const { install } = await import("../installer.js");
    const fakePid = 999995;
    const results = install({
      host: "cursor",
      autoKill: false,
      // Lock carries the host stamp the runner now records at acquire time.
      liveRunnerLock: {
        pid: fakePid,
        startedAt: "2026-05-13T12:00:00.000Z",
        host: "cursor",
      },
    });
    const r = results[0]!;
    assert.equal(r.status, "refused-live-runner");

    const expectedManualKill =
      process.platform === "win32"
        ? `Stop-Process -Id ${fakePid} -Force`
        : `kill -9 ${fakePid}`;
    assert.ok(
      r.message.includes(expectedManualKill),
      `refusal must include "${expectedManualKill}", got: ${r.message}`,
    );
    assert.ok(
      r.message.includes("npx -y @prepsavant/mcp install"),
      "refusal must include the re-run command",
    );
    // Ordering: kill → re-run → Cursor hint → prose.
    const killIdx = r.message.indexOf(expectedManualKill);
    const reRunIdx = r.message.indexOf("npx -y @prepsavant/mcp install");
    const cursorHintIdx = r.message.indexOf("fully quit Cursor");
    const proseIdx = r.message.indexOf("Quit the MCP host");
    assert.ok(killIdx >= 0, "kill one-liner missing");
    assert.ok(reRunIdx > killIdx, "re-run command must follow kill one-liner");
    assert.ok(
      cursorHintIdx > killIdx,
      "Cursor-relaunch hint must appear after the kill one-liner",
    );
    assert.ok(
      proseIdx > killIdx,
      "prose must appear after the kill one-liner",
    );
  });
});

// Task #1382 — locks NOT stamped with `host: "cursor"` (older runners,
// or hosts other than Cursor) must NOT surface the "fully quit Cursor"
// hint — that copy would be misleading for non-Cursor hosts.
test("install: --no-kill + non-cursor lock → no Cursor-quit hint", async () => {
  await withTempHome(async (homeDir) => {
    const cfgPath = cursorConfigPathFor(homeDir);
    writeJson(cfgPath, { mcpServers: {} });

    const { install } = await import("../installer.js");
    const results = install({
      host: "cursor",
      autoKill: false,
      // No `host` field — older runner that pre-dates the host-stamp.
      liveRunnerLock: { pid: 999994, startedAt: "2026-05-13T12:00:00.000Z" },
    });
    const r = results[0]!;
    assert.equal(r.status, "refused-live-runner");
    assert.ok(
      !r.message.includes("fully quit Cursor"),
      "Cursor-only hint must not appear when host stamp is absent",
    );
  });
});

// Task #1382 — production-path coverage for the host stamp. The
// installer reads the runner-lock from disk via `readActiveRunnerLock`
// (NOT via the `liveRunnerLock` test seam). Without preserving the
// `host` field across that read, the Cursor-relaunch hint would only
// surface in tests that inject a synthetic lock — exactly what the
// reviewer flagged. We hand-write a lockfile with `host: "cursor"`,
// then verify the installer's refusal copy includes the Cursor-quit
// note.
test("install: refusal reads host stamp from on-disk lockfile (production path)", async () => {
  await withTempHome(async (homeDir) => {
    const cfgPath = cursorConfigPathFor(homeDir);
    writeJson(cfgPath, { mcpServers: {} });
    const lockPath = path.join(homeDir, ".prepsavant", "runner.lock");
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 999993,
        startedAt: "2026-05-13T12:00:00.000Z",
        host: "cursor",
      }),
    );

    const { readActiveRunnerLock } = await import("../runner-lock.js");
    // Sanity check: the lockfile reader preserves `host`.
    const lock = readActiveRunnerLock(() => true);
    assert.ok(lock);
    assert.equal(lock!.host, "cursor");

    const { install } = await import("../installer.js");
    const results = install({
      host: "cursor",
      autoKill: false,
      // Pass the freshly-read lock through so the install code path
      // exercised here is the same one production uses (read the
      // lockfile → branch on host metadata).
      liveRunnerLock: lock,
    });
    const r = results[0]!;
    assert.equal(r.status, "refused-live-runner");
    assert.match(r.message, /fully quit Cursor/);
  });
});

test("install: auto-kill code path is silent when no runner is active", async () => {
  await withTempHome(async (homeDir) => {
    const cfgPath = cursorConfigPathFor(homeDir);
    writeJson(cfgPath, { mcpServers: {} });

    const { install } = await import("../installer.js");
    let stopCalls = 0;
    const results = install({
      host: "cursor",
      // Explicitly tell the installer there is no live runner. This is
      // the standard happy path on a fresh machine — the auto-kill code
      // must not be invoked, and the per-host message must not carry
      // any "Stopped …" / "Cleared …" notice.
      liveRunnerLock: null,
      stopActiveRunner: () => {
        stopCalls++;
        return { outcome: "already-gone", pid: 0 };
      },
    });

    assert.equal(stopCalls, 0, "no live lock → stopActiveRunner must not run");
    const r = results[0]!;
    assert.equal(r.status, "patched");
    assert.doesNotMatch(r.message, /Stopped active Sam runner/);
    assert.doesNotMatch(r.message, /Cleared stale Sam runner lock/);

    const { readInstallHistory } = await import("../install-history.js");
    const host = readInstallHistory()[0]!.hosts[0]!;
    assert.equal(host.autoKilledRunnerPid, undefined);
  });
});
