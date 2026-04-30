// Stall-detection tests for the Coached session file watcher.
//
// Covers the wiring fixed by task-535: `startCoachedSession` now defaults the
// watch directory to `process.cwd()` so a session begun without an explicit
// `workspaceDir` still gets live file-watching, and `coached_check_in` reads
// `lastEditAt` to surface an `isStalled` flag downstream.
//
// We avoid spinning up the full MCP server here — the contract under test is
// in session.ts. The `coached_check_in` consumer is exercised indirectly by
// asserting the same predicate (`isStalled`) the server uses.
//
// Stall-detection tests for the Coached session file watcher (task #535).
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  startCoachedSession,
  endCoachedSession,
  getCoachedSession,
  isStalled,
  shouldIgnoreWatchedPath,
  stalledSeconds,
  STALL_WINDOW_MS,
} from "../coached/session.js";
import {
  buildCheckInPayload,
  escalateForStall,
  isStallEscalation,
  resolveCoachedWorkDir,
  STALL_ESCALATION_REASON,
} from "../coached/check-in.js";
import type { CheckInDirective } from "../api.js";
import { STALL_PROBE_LINE } from "../persona-cache.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "coached-stall-"));
}

// fs.watch fires async on every platform, so poll instead of sleep.
async function waitForEditTick(
  sessionId: string,
  baseline: number,
  timeoutMs = 1000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = getCoachedSession(sessionId);
    if (s && s.lastEditAt > baseline) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

const QUIET: CheckInDirective = {
  action: "stay_quiet",
  samVoiceLine: null,
  reason: "test",
};

test("startCoachedSession defaults workspaceDir to process.cwd()", () => {
  const sessionId = "sess-default-cwd";
  const state = startCoachedSession({
    sessionId,
    questionId: "q1",
    questionTitle: "Two Sum",
    questionPrompt: "...",
  });
  try {
    assert.equal(state.workspaceDir, process.cwd());
    assert.ok(state.watcher != null, "watcher should be started by default");
  } finally {
    endCoachedSession(sessionId);
  }
});

test("file edits in the watched directory bump lastEditAt", async () => {
  const dir = makeTempDir();
  const sessionId = "sess-edit-bump";
  const state = startCoachedSession({
    sessionId,
    questionId: "q1",
    questionTitle: "Two Sum",
    questionPrompt: "...",
    workspaceDir: dir,
  });
  try {
    assert.ok(state.watcher != null);
    state.lastEditAt = Date.now() - 10_000;
    const before = state.lastEditAt;

    fs.writeFileSync(path.join(dir, "solution.ts"), "export const x = 1;\n");

    assert.ok(await waitForEditTick(sessionId, before));
    assert.ok(!isStalled(state));
  } finally {
    endCoachedSession(sessionId);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("isStalled flips true once lastEditAt is older than STALL_WINDOW_MS", () => {
  const dir = makeTempDir();
  const sessionId = "sess-stall";
  const state = startCoachedSession({
    sessionId,
    questionId: "q1",
    questionTitle: "Two Sum",
    questionPrompt: "...",
    workspaceDir: dir,
  });
  try {
    state.lastEditAt = Date.now() - (STALL_WINDOW_MS + 1_000);
    assert.equal(isStalled(state), true);
    assert.ok(stalledSeconds(state) >= STALL_WINDOW_MS / 1000);

    state.lastEditAt = Date.now();
    assert.equal(isStalled(state), false);
  } finally {
    endCoachedSession(sessionId);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveCoachedWorkDir prefers workDir over workspaceDir alias", () => {
  assert.equal(resolveCoachedWorkDir({ workDir: "/a" }), "/a");
  assert.equal(resolveCoachedWorkDir({ workspaceDir: "/b" }), "/b");
  assert.equal(
    resolveCoachedWorkDir({ workDir: "/a", workspaceDir: "/b" }),
    "/a",
  );
  assert.equal(resolveCoachedWorkDir({}), undefined);
});

test("buildCheckInPayload omits stall fields when there is no in-memory session", () => {
  const payload = buildCheckInPayload(QUIET, null);
  assert.equal(payload["action"], "stay_quiet");
  assert.ok(!("isStalled" in payload));
  assert.ok(!("stallSeconds" in payload));
});

test("buildCheckInPayload reports isStalled:false on a fresh session", () => {
  const dir = makeTempDir();
  const sessionId = "sess-payload-fresh";
  const state = startCoachedSession({
    sessionId,
    questionId: "q1",
    questionTitle: "Two Sum",
    questionPrompt: "...",
    workspaceDir: dir,
  });
  try {
    state.lastEditAt = Date.now();
    const payload = buildCheckInPayload(QUIET, state);
    assert.equal(payload["isStalled"], false);
    assert.ok(!("stallSeconds" in payload));
  } finally {
    endCoachedSession(sessionId);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("buildCheckInPayload reports isStalled:true and stallSeconds when idle past the window", () => {
  const dir = makeTempDir();
  const sessionId = "sess-payload-stalled";
  const state = startCoachedSession({
    sessionId,
    questionId: "q1",
    questionTitle: "Two Sum",
    questionPrompt: "...",
    workspaceDir: dir,
  });
  try {
    state.lastEditAt = Date.now() - (STALL_WINDOW_MS + 5_000);
    const payload = buildCheckInPayload(QUIET, state);
    assert.equal(payload["isStalled"], true);
    assert.ok(typeof payload["stallSeconds"] === "number");
    assert.ok((payload["stallSeconds"] as number) >= STALL_WINDOW_MS / 1000);
    // Backward-compat alias kept for one release window.
    assert.equal(payload["stallDetected"], true);
  } finally {
    endCoachedSession(sessionId);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("end-to-end: file edit clears the stall flag observed via buildCheckInPayload", async () => {
  const dir = makeTempDir();
  const sessionId = "sess-e2e";
  const state = startCoachedSession({
    sessionId,
    questionId: "q1",
    questionTitle: "Two Sum",
    questionPrompt: "...",
    workspaceDir: resolveCoachedWorkDir({ workDir: dir }),
  });
  try {
    state.lastEditAt = Date.now() - (STALL_WINDOW_MS + 5_000);
    let payload = buildCheckInPayload(QUIET, getCoachedSession(sessionId));
    assert.equal(payload["isStalled"], true);

    const before = state.lastEditAt;
    fs.writeFileSync(path.join(dir, "solution.ts"), "export const x = 1;\n");
    assert.ok(await waitForEditTick(sessionId, before));

    payload = buildCheckInPayload(QUIET, getCoachedSession(sessionId));
    assert.equal(payload["isStalled"], false);
    assert.ok(!("stallSeconds" in payload));
  } finally {
    endCoachedSession(sessionId);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Stall escalation: turn a stay_quiet server directive into a Sam-voice probe
// when the runner sees the user has stopped editing files (task #548).
// ---------------------------------------------------------------------------

test("escalateForStall upgrades stay_quiet to a Sam-voice probe when stalled", () => {
  const dir = makeTempDir();
  const sessionId = "sess-escalate-quiet";
  const state = startCoachedSession({
    sessionId,
    questionId: "q1",
    questionTitle: "Two Sum",
    questionPrompt: "...",
    workspaceDir: dir,
  });
  try {
    state.lastEditAt = Date.now() - (STALL_WINDOW_MS + 5_000);
    const upgraded = escalateForStall(QUIET, state);
    assert.equal(upgraded.action, "probe");
    assert.equal(upgraded.samVoiceLine, STALL_PROBE_LINE);
    assert.equal(upgraded.reason, STALL_ESCALATION_REASON);
  } finally {
    endCoachedSession(sessionId);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("escalateForStall passes stay_quiet through when not stalled", () => {
  const dir = makeTempDir();
  const sessionId = "sess-escalate-fresh";
  const state = startCoachedSession({
    sessionId,
    questionId: "q1",
    questionTitle: "Two Sum",
    questionPrompt: "...",
    workspaceDir: dir,
  });
  try {
    state.lastEditAt = Date.now();
    const result = escalateForStall(QUIET, state);
    assert.equal(result, QUIET);
  } finally {
    endCoachedSession(sessionId);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("escalateForStall is a no-op when there is no in-memory session", () => {
  assert.equal(escalateForStall(QUIET, null), QUIET);
});

test("isStallEscalation returns true exactly when escalateForStall upgrades stay_quiet", () => {
  const dir = makeTempDir();
  const sessionId = "sess-is-stall-escalation";
  const state = startCoachedSession({
    sessionId,
    questionId: "q1",
    questionTitle: "Two Sum",
    questionPrompt: "...",
    workspaceDir: dir,
  });
  try {
    // Stalled + stay_quiet → escalation.
    state.lastEditAt = Date.now() - (STALL_WINDOW_MS + 5_000);
    assert.equal(isStallEscalation(QUIET, state), true);

    // Not stalled → no escalation.
    state.lastEditAt = Date.now();
    assert.equal(isStallEscalation(QUIET, state), false);

    // No state → no escalation.
    assert.equal(isStallEscalation(QUIET, null), false);

    // Stalled but server already chose probe → not an escalation
    // (server-driven, not runner-driven).
    state.lastEditAt = Date.now() - (STALL_WINDOW_MS + 5_000);
    const serverProbe: CheckInDirective = {
      action: "probe",
      samVoiceLine: "Tell me what you're thinking.",
      reason: "server_decided",
    };
    assert.equal(isStallEscalation(serverProbe, state), false);
  } finally {
    endCoachedSession(sessionId);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("escalateForStall does not downgrade or alter a non-quiet directive", () => {
  const dir = makeTempDir();
  const sessionId = "sess-escalate-respects-ladder";
  const state = startCoachedSession({
    sessionId,
    questionId: "q1",
    questionTitle: "Two Sum",
    questionPrompt: "...",
    workspaceDir: dir,
  });
  try {
    // Even when stalled, an existing non-quiet server directive must be
    // left alone — that's the hint-ladder respect: the runner never
    // skips ahead of (or rewrites) what the server already decided.
    state.lastEditAt = Date.now() - (STALL_WINDOW_MS + 5_000);
    const hintOffer: CheckInDirective = {
      action: "hint_offer",
      samVoiceLine: "I have a hint ready.",
      reason: "server_decided",
    };
    const probe: CheckInDirective = {
      action: "probe",
      samVoiceLine: "Walk me through it.",
      reason: "server_decided",
    };
    assert.equal(escalateForStall(hintOffer, state), hintOffer);
    assert.equal(escalateForStall(probe, state), probe);
  } finally {
    endCoachedSession(sessionId);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("buildCheckInPayload upgrades stay_quiet directive when stalled (server timer hasn't tripped)", () => {
  const dir = makeTempDir();
  const sessionId = "sess-payload-stall-upgrade";
  const state = startCoachedSession({
    sessionId,
    questionId: "q1",
    questionTitle: "Two Sum",
    questionPrompt: "...",
    workspaceDir: dir,
  });
  try {
    state.lastEditAt = Date.now() - (STALL_WINDOW_MS + 5_000);
    const payload = buildCheckInPayload(QUIET, state);
    // Directive is now a Sam-voice probe instead of stay_quiet ...
    assert.equal(payload["action"], "probe");
    assert.equal(payload["samVoiceLine"], STALL_PROBE_LINE);
    assert.equal(payload["reason"], STALL_ESCALATION_REASON);
    // ... and the existing stall-flag fields keep working so hosts that
    // already key off them don't regress.
    assert.equal(payload["isStalled"], true);
    assert.equal(payload["stallDetected"], true);
    assert.ok(typeof payload["stallSeconds"] === "number");
  } finally {
    endCoachedSession(sessionId);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("escalateForStall fires the probe once per idle window and re-arms on a file edit", async () => {
  const dir = makeTempDir();
  const sessionId = "sess-stall-dedup";
  const state = startCoachedSession({
    sessionId,
    questionId: "q1",
    questionTitle: "Two Sum",
    questionPrompt: "...",
    workspaceDir: dir,
  });
  try {
    // First check-in inside the stall window: probe fires.
    state.lastEditAt = Date.now() - (STALL_WINDOW_MS + 5_000);
    const first = escalateForStall(QUIET, state);
    assert.equal(first.action, "probe");
    assert.equal(first.reason, STALL_ESCALATION_REASON);

    // Second check-in inside the SAME idle window: stay quiet.
    const second = escalateForStall(QUIET, state);
    assert.equal(second, QUIET);
    // And the user-visible payload reports stay_quiet too — the host
    // should not see a probe on the second call.
    const secondPayload = buildCheckInPayload(QUIET, state);
    assert.equal(secondPayload["action"], "stay_quiet");
    assert.equal(secondPayload["samVoiceLine"], null);
    // Stall flags still surface so existing host UX (e.g. status badge)
    // doesn't regress.
    assert.equal(secondPayload["isStalled"], true);

    // A file edit re-arms the nudge for the next stall window.
    const before = state.lastEditAt;
    fs.writeFileSync(path.join(dir, "solution.ts"), "export const x = 1;\n");
    assert.ok(await waitForEditTick(sessionId, before));
    const live = getCoachedSession(sessionId);
    assert.ok(live != null);
    // Force the post-edit session back into the stall window without
    // un-doing the file-edit re-arm.
    live.lastEditAt = Date.now() - (STALL_WINDOW_MS + 5_000);
    const third = escalateForStall(QUIET, live);
    assert.equal(third.action, "probe");
    assert.equal(third.reason, STALL_ESCALATION_REASON);
  } finally {
    endCoachedSession(sessionId);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test(".git/ writes do not reset the stall timer", async () => {
  const dir = makeTempDir();
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  const sessionId = "sess-git-ignored";
  const state = startCoachedSession({
    sessionId,
    questionId: "q1",
    questionTitle: "Two Sum",
    questionPrompt: "...",
    workspaceDir: dir,
  });
  try {
    state.lastEditAt = Date.now() - (STALL_WINDOW_MS + 1_000);
    const before = state.lastEditAt;

    fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");

    await new Promise((r) => setTimeout(r, 200));
    const after = getCoachedSession(sessionId)?.lastEditAt ?? 0;
    assert.equal(after, before);
    assert.equal(isStalled(state), true);
  } finally {
    endCoachedSession(sessionId);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("shouldIgnoreWatchedPath filters build/cache noise but keeps real source files", () => {
  // Noise that must NOT bump lastEditAt.
  for (const noisy of [
    "node_modules/foo/index.js",
    "node_modules/.pnpm/foo@1.0.0/node_modules/foo/index.js",
    "dist/bundle.js",
    "build/output.css",
    ".next/cache/webpack/client.pack",
    ".turbo/cache/abc123",
    ".cache/eslint/cache.json",
    "coverage/lcov-report/index.html",
    ".git/HEAD",
    ".eslintcache",
    ".DS_Store",
    "src/.vscode/settings.json",
    "packages/foo/node_modules/bar/index.js",
    null,
    "",
  ]) {
    assert.equal(
      shouldIgnoreWatchedPath(noisy),
      true,
      `expected to ignore ${JSON.stringify(noisy)}`,
    );
  }

  // Real source files that must continue to count as edits.
  for (const real of [
    "solution.ts",
    "src/index.ts",
    "packages/foo/src/index.ts",
    "coverage.ts", // exact-segment match: a real file, not the coverage/ dir
    "src/build.ts", // ditto for `build`
    "lib/dist-utils.ts", // partial match in name only
    "README.md",
  ]) {
    assert.equal(
      shouldIgnoreWatchedPath(real),
      false,
      `expected to keep ${JSON.stringify(real)}`,
    );
  }
});

test("writes inside node_modules/ do not advance lastEditAt while real source writes do", async () => {
  const dir = makeTempDir();
  fs.mkdirSync(path.join(dir, "node_modules", "left-pad"), { recursive: true });
  const sessionId = "sess-noise-vs-real";
  const state = startCoachedSession({
    sessionId,
    questionId: "q1",
    questionTitle: "Two Sum",
    questionPrompt: "...",
    workspaceDir: dir,
  });
  try {
    // Backdate so the session is firmly stalled before we start poking files.
    state.lastEditAt = Date.now() - (STALL_WINDOW_MS + 1_000);
    const beforeNoise = state.lastEditAt;

    // Noisy write: a dependency rebuild dropping a file under node_modules/.
    fs.writeFileSync(
      path.join(dir, "node_modules", "left-pad", "index.js"),
      "module.exports = () => {};\n",
    );
    await new Promise((r) => setTimeout(r, 200));
    const afterNoise = getCoachedSession(sessionId)?.lastEditAt ?? 0;
    assert.equal(
      afterNoise,
      beforeNoise,
      "node_modules write must not bump lastEditAt",
    );
    assert.equal(isStalled(state), true);

    // Real edit: the user actually saves a source file.
    fs.writeFileSync(path.join(dir, "solution.ts"), "export const x = 1;\n");
    assert.ok(
      await waitForEditTick(sessionId, beforeNoise),
      "real source write must bump lastEditAt",
    );
    assert.equal(isStalled(state), false);
  } finally {
    endCoachedSession(sessionId);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
