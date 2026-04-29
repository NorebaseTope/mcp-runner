// Unit tests for the `prepsavant status` formatter.
//
// The runner CLI's `status` subcommand calls the same status endpoint the
// live polling loop uses and prints a one-shot snapshot: hook-channel
// summary, event count, integrity status, and elapsed time. These tests
// pin the output shape so the at-a-glance scan stays consistent across
// releases.

import test from "node:test";
import assert from "node:assert/strict";
import {
  formatElapsed,
  formatStatusReport,
  runStatus,
  type RunStatusDeps,
} from "../ai-assisted/cli-status.js";
import { ApiError, type AiAssistedSessionStatus } from "../api.js";
import type { StaleHookInfo } from "../ai-assisted/hook-installer.js";

function baseStatus(
  overrides: Partial<AiAssistedSessionStatus> = {},
): AiAssistedSessionStatus {
  return {
    sessionId: "sess_abc123",
    tool: "claude_code",
    eventCount: 0,
    hooksConnected: false,
    integrityStatus: "pending",
    integrityStatusDetail: "",
    startedAt: "2026-04-29T12:00:00Z",
    elapsedMs: 0,
    lastEventAt: null,
    hookHealth: {
      prompt: { fired: false, eventCount: 0 },
      response: { fired: false, eventCount: 0 },
      edit: { fired: false, eventCount: 0 },
      shell: { fired: false, eventCount: 0 },
    },
    consentRecordedAt: null,
    bundleReceivedAt: null,
    ...overrides,
  };
}

test("formatElapsed: seconds-only formatting under one minute", () => {
  assert.equal(formatElapsed(0), "0s");
  assert.equal(formatElapsed(1_000), "1s");
  assert.equal(formatElapsed(59_000), "59s");
});

test("formatElapsed: minutes + seconds formatting under one hour", () => {
  assert.equal(formatElapsed(60_000), "1m 0s");
  assert.equal(formatElapsed(90_000), "1m 30s");
  assert.equal(formatElapsed(59 * 60_000 + 59_000), "59m 59s");
});

test("formatElapsed: hours + minutes + seconds formatting", () => {
  assert.equal(formatElapsed(3_600_000), "1h 0m 0s");
  assert.equal(formatElapsed(3_600_000 + 90_000), "1h 1m 30s");
});

test("formatElapsed: clamps negatives and non-finite to 0s", () => {
  assert.equal(formatElapsed(-100), "0s");
  assert.equal(formatElapsed(Number.NaN), "0s");
});

test("formatStatusReport: includes session id, tool, elapsed, events, integrity, and hook channels", () => {
  const out = formatStatusReport(
    baseStatus({
      sessionId: "sess_abc123",
      tool: "cursor",
      eventCount: 7,
      integrityStatus: "ok",
      integrityStatusDetail: "signed log verified",
      elapsedMs: 90_000,
      hookHealth: {
        prompt: { fired: true, eventCount: 3 },
        response: { fired: true, eventCount: 2 },
        edit: { fired: false, eventCount: 0 },
        shell: { fired: true, eventCount: 1 },
      },
    }),
  );
  assert.match(out, /Session:\s+sess_abc123/);
  assert.match(out, /Tool:\s+cursor/);
  assert.match(out, /Elapsed:\s+1m 30s/);
  assert.match(out, /Events:\s+7/);
  assert.match(out, /Integrity:\s+ok — signed log verified/);
  assert.match(out, /Hook channels:.*✓ prompt.*✓ response.*\? edit.*✓ shell/s);
});

test("formatStatusReport: omits integrity detail when empty", () => {
  const out = formatStatusReport(
    baseStatus({
      integrityStatus: "pending",
      integrityStatusDetail: "",
    }),
  );
  assert.match(out, /Integrity:\s+pending\b/);
  // No trailing em-dash divider when there's no detail.
  assert.equal(/Integrity:\s+pending\s+—/.test(out), false);
});

test("formatStatusReport: still prints hook channel line when nothing has fired", () => {
  const out = formatStatusReport(baseStatus());
  assert.match(out, /Hook channels:/);
  assert.match(out, /\? prompt/);
  assert.match(out, /\? response/);
  assert.match(out, /\? edit/);
  assert.match(out, /\? shell/);
});

test("formatStatusReport: degraded integrity surfaces the detail message", () => {
  const out = formatStatusReport(
    baseStatus({
      integrityStatus: "degraded",
      integrityStatusDetail: "log_hash mismatch at seq 12",
    }),
  );
  assert.match(out, /Integrity:\s+degraded — log_hash mismatch at seq 12/);
});

// ---------------------------------------------------------------------------
// runStatus command-flow tests (DI-based, no real config / network / fs)
// ---------------------------------------------------------------------------

interface CapturedDeps extends RunStatusDeps {
  out: string[];
  err: string[];
  exitCodes: number[];
  fetchCalls: Array<{ token: string; sessionId: string }>;
}

function makeDeps(overrides: Partial<RunStatusDeps> = {}): CapturedDeps {
  const out: string[] = [];
  const err: string[] = [];
  const exitCodes: number[] = [];
  const fetchCalls: Array<{ token: string; sessionId: string }> = [];
  const deps: CapturedDeps = {
    out,
    err,
    exitCodes,
    fetchCalls,
    readToken: overrides.readToken ?? (() => "tok_default"),
    resolveActiveSessionId:
      overrides.resolveActiveSessionId ?? (() => null),
    fetchStatus:
      overrides.fetchStatus ??
      (async (token, sessionId) => {
        fetchCalls.push({ token, sessionId });
        return baseStatus({ sessionId });
      }),
    stdout: (s) => { out.push(s); },
    stderr: (s) => { err.push(s); },
    setExitCode: (code) => { exitCodes.push(code); },
  };
  // Wrap the user's fetchStatus (if any) to also record calls so assertions
  // can introspect what the command tried to fetch.
  if (overrides.fetchStatus) {
    const wrapped = overrides.fetchStatus;
    deps.fetchStatus = async (token, sessionId) => {
      fetchCalls.push({ token, sessionId });
      return wrapped(token, sessionId);
    };
  }
  return deps;
}

test("runStatus: missing token prints auth error and exits 1", async () => {
  const deps = makeDeps({ readToken: () => null });
  await runStatus(["sess_x"], {}, deps);
  assert.equal(deps.out.length, 0);
  assert.equal(deps.err.length, 1);
  assert.match(deps.err[0]!, /Not authorized/);
  assert.match(deps.err[0]!, /prepsavant auth/);
  assert.deepEqual(deps.exitCodes, [1]);
  assert.equal(deps.fetchCalls.length, 0);
});

test("runStatus: no positional and no marker → guidance + exit 1", async () => {
  const deps = makeDeps({
    readToken: () => "tok_x",
    resolveActiveSessionId: () => null,
  });
  await runStatus([], {}, deps);
  assert.equal(deps.out.length, 0);
  assert.match(deps.err.join(""), /No active session found in this workspace/);
  assert.match(deps.err.join(""), /prepsavant status <session-id>/);
  assert.deepEqual(deps.exitCodes, [1]);
  assert.equal(deps.fetchCalls.length, 0);
});

test("runStatus: no positional and 'unknown' marker is treated as no active session", async () => {
  // Corrupt-marker fallback in detectStaleHooks returns sessionId = "unknown".
  // We must not fetch /ai-sessions/unknown/status — that would always 404.
  const marker: StaleHookInfo = {
    toolId: "claude_code",
    sessionId: "unknown",
    installedAt: "2026-04-29T12:00:00Z",
  };
  const deps = makeDeps({
    readToken: () => "tok_x",
    resolveActiveSessionId: () => marker,
  });
  await runStatus([], {}, deps);
  assert.equal(deps.fetchCalls.length, 0);
  assert.match(deps.err.join(""), /No active session found/);
  assert.deepEqual(deps.exitCodes, [1]);
});

test("runStatus: no positional uses session id from workspace marker", async () => {
  const marker: StaleHookInfo = {
    toolId: "cursor",
    sessionId: "sess_from_marker",
    installedAt: "2026-04-29T12:00:00Z",
  };
  const deps = makeDeps({
    readToken: () => "tok_x",
    resolveActiveSessionId: () => marker,
  });
  await runStatus([], {}, deps);
  assert.equal(deps.fetchCalls.length, 1);
  assert.equal(deps.fetchCalls[0]!.sessionId, "sess_from_marker");
  assert.equal(deps.fetchCalls[0]!.token, "tok_x");
  assert.deepEqual(deps.exitCodes, []);
  assert.match(deps.out.join(""), /Session:\s+sess_from_marker/);
});

test("runStatus: positional session id wins over marker", async () => {
  const marker: StaleHookInfo = {
    toolId: "cursor",
    sessionId: "sess_from_marker",
    installedAt: "2026-04-29T12:00:00Z",
  };
  const deps = makeDeps({
    resolveActiveSessionId: () => marker,
  });
  await runStatus(["sess_arg"], {}, deps);
  assert.equal(deps.fetchCalls.length, 1);
  assert.equal(deps.fetchCalls[0]!.sessionId, "sess_arg");
});

test("runStatus: 404 from API → 'Unknown session id' + exit 1", async () => {
  const deps = makeDeps({
    fetchStatus: async () => {
      throw new ApiError(404, { error: "not found" }, "GET ... → 404");
    },
  });
  await runStatus(["sess_missing"], {}, deps);
  assert.match(deps.err.join(""), /Unknown session id: sess_missing/);
  assert.deepEqual(deps.exitCodes, [1]);
});

test("runStatus: 401 from API → re-link guidance + exit 1", async () => {
  const deps = makeDeps({
    fetchStatus: async () => {
      throw new ApiError(401, null, "GET ... → 401");
    },
  });
  await runStatus(["sess_x"], {}, deps);
  assert.match(deps.err.join(""), /Not authorized for this session/);
  assert.match(deps.err.join(""), /prepsavant auth/);
  assert.deepEqual(deps.exitCodes, [1]);
});

test("runStatus: 403 from API → same re-link guidance + exit 1", async () => {
  const deps = makeDeps({
    fetchStatus: async () => {
      throw new ApiError(403, null, "GET ... → 403");
    },
  });
  await runStatus(["sess_x"], {}, deps);
  assert.match(deps.err.join(""), /Not authorized for this session/);
  assert.deepEqual(deps.exitCodes, [1]);
});

test("runStatus: generic API error surfaces message + exit 1", async () => {
  const deps = makeDeps({
    fetchStatus: async () => {
      throw new Error("network is unreachable");
    },
  });
  await runStatus(["sess_x"], {}, deps);
  assert.match(deps.err.join(""), /Failed to fetch session status: network is unreachable/);
  assert.deepEqual(deps.exitCodes, [1]);
});

// ---------------------------------------------------------------------------
// --json mode tests
// ---------------------------------------------------------------------------

test("runStatus --json: success path prints AiAssistedSessionStatus as JSON to stdout", async () => {
  const deps = makeDeps({
    fetchStatus: async (_t, sessionId) =>
      baseStatus({
        sessionId,
        tool: "cursor",
        eventCount: 5,
        elapsedMs: 30_000,
        integrityStatus: "ok",
        integrityStatusDetail: "signed log verified",
      }),
  });
  await runStatus(["sess_json"], { json: true }, deps);
  assert.equal(deps.exitCodes.length, 0, "should not set exit code on success");
  assert.equal(deps.err.length, 0, "nothing written to stderr on success");
  assert.equal(deps.out.length, 1, "exactly one write to stdout");
  const raw = deps.out[0]!;
  // Must end with a newline.
  assert.ok(raw.endsWith("\n"), "output ends with newline");
  // Must be valid JSON.
  let parsed: unknown;
  assert.doesNotThrow(() => { parsed = JSON.parse(raw); }, "output is valid JSON");
  const s = parsed as AiAssistedSessionStatus;
  assert.equal(s.sessionId, "sess_json");
  assert.equal(s.tool, "cursor");
  assert.equal(s.eventCount, 5);
  assert.equal(s.integrityStatus, "ok");
  assert.equal(s.integrityStatusDetail, "signed log verified");
});

test("runStatus --json: output contains no human-format banner lines", async () => {
  const deps = makeDeps();
  await runStatus(["sess_no_banner"], { json: true }, deps);
  const raw = deps.out.join("");
  assert.equal(/PrepSavant AI-Assisted Session Status/.test(raw), false, "no banner in JSON mode");
  assert.equal(/─{5,}/.test(raw), false, "no separator line in JSON mode");
  assert.equal(/Session:/.test(raw), false, "no human-label 'Session:' in JSON mode");
});

test("runStatus --json: missing token sends JSON error to stderr and exits 1", async () => {
  const deps = makeDeps({ readToken: () => null });
  await runStatus(["sess_x"], { json: true }, deps);
  assert.equal(deps.out.length, 0);
  assert.deepEqual(deps.exitCodes, [1]);
  assert.equal(deps.err.length, 1);
  let parsed: unknown;
  assert.doesNotThrow(() => { parsed = JSON.parse(deps.err[0]!); }, "stderr is valid JSON");
  assert.ok(
    typeof (parsed as { error?: unknown }).error === "string",
    "error field is a string",
  );
  {
    const errStr = (parsed as { error: string }).error;
    assert.match(errStr, /Not authorized/);
    assert.equal(
      errStr,
      "Not authorized. Run `prepsavant auth` first.",
      "JSON error field is trimmed (no trailing newline)",
    );
  }
});

test("runStatus --json: no active session sends JSON error to stderr and exits 1", async () => {
  const deps = makeDeps({
    readToken: () => "tok_x",
    resolveActiveSessionId: () => null,
  });
  await runStatus([], { json: true }, deps);
  assert.equal(deps.out.length, 0);
  assert.deepEqual(deps.exitCodes, [1]);
  assert.equal(deps.err.length, 1);
  let parsed: unknown;
  assert.doesNotThrow(() => { parsed = JSON.parse(deps.err[0]!); });
  {
    const errStr = (parsed as { error: string }).error;
    assert.match(errStr, /No active session found/);
    assert.equal(
      errStr,
      "No active session found in this workspace.\n" +
      "Pass a session id explicitly: prepsavant status <session-id>",
      "JSON error field is trimmed (no trailing newline)",
    );
  }
});

test("runStatus --json: 404 API error sends JSON error to stderr and exits 1", async () => {
  const deps = makeDeps({
    fetchStatus: async () => {
      throw new ApiError(404, { error: "not found" }, "GET ... → 404");
    },
  });
  await runStatus(["sess_missing"], { json: true }, deps);
  assert.equal(deps.out.length, 0);
  assert.deepEqual(deps.exitCodes, [1]);
  let parsed: unknown;
  assert.doesNotThrow(() => { parsed = JSON.parse(deps.err[0]!); });
  {
    const errStr = (parsed as { error: string }).error;
    assert.match(errStr, /Unknown session id: sess_missing/);
    assert.equal(
      errStr,
      "Unknown session id: sess_missing",
      "JSON error field is trimmed (no trailing newline)",
    );
  }
});

test("runStatus --json: 401 API error sends JSON error to stderr and exits 1", async () => {
  const deps = makeDeps({
    fetchStatus: async () => {
      throw new ApiError(401, null, "GET ... → 401");
    },
  });
  await runStatus(["sess_x"], { json: true }, deps);
  assert.deepEqual(deps.exitCodes, [1]);
  let parsed: unknown;
  assert.doesNotThrow(() => { parsed = JSON.parse(deps.err[0]!); });
  {
    const errStr = (parsed as { error: string }).error;
    assert.match(errStr, /Not authorized for this session/);
    assert.equal(
      errStr,
      "Not authorized for this session. Run `prepsavant auth` to re-link this device.",
      "JSON error field is trimmed (no trailing newline)",
    );
  }
});

test("runStatus --json: 403 API error sends JSON error to stderr and exits 1", async () => {
  const deps = makeDeps({
    fetchStatus: async () => {
      throw new ApiError(403, null, "GET ... → 403");
    },
  });
  await runStatus(["sess_x"], { json: true }, deps);
  assert.deepEqual(deps.exitCodes, [1]);
  let parsed: unknown;
  assert.doesNotThrow(() => { parsed = JSON.parse(deps.err[0]!); });
  {
    const errStr = (parsed as { error: string }).error;
    assert.match(errStr, /Not authorized for this session/);
    assert.equal(
      errStr,
      "Not authorized for this session. Run `prepsavant auth` to re-link this device.",
      "JSON error field is trimmed (no trailing newline)",
    );
  }
});

test("runStatus --json: generic error sends JSON error to stderr and exits 1", async () => {
  const deps = makeDeps({
    fetchStatus: async () => {
      throw new Error("connection refused");
    },
  });
  await runStatus(["sess_x"], { json: true }, deps);
  assert.deepEqual(deps.exitCodes, [1]);
  let parsed: unknown;
  assert.doesNotThrow(() => { parsed = JSON.parse(deps.err[0]!); });
  {
    const errStr = (parsed as { error: string }).error;
    assert.match(errStr, /Failed to fetch session status: connection refused/);
    assert.equal(
      errStr,
      "Failed to fetch session status: connection refused",
      "JSON error field is trimmed (no trailing newline)",
    );
  }
});

test("runStatus: success path prints the formatted report and does not set exit code", async () => {
  const deps = makeDeps({
    fetchStatus: async (_t, sessionId) =>
      baseStatus({
        sessionId,
        tool: "claude_code",
        eventCount: 12,
        elapsedMs: 65_000,
        integrityStatus: "ok",
        integrityStatusDetail: "signed log verified",
        hookHealth: {
          prompt: { fired: true, eventCount: 5 },
          response: { fired: true, eventCount: 4 },
          edit: { fired: true, eventCount: 2 },
          shell: { fired: true, eventCount: 1 },
        },
      }),
  });
  await runStatus(["sess_ok"], {}, deps);
  const output = deps.out.join("");
  assert.match(output, /Session:\s+sess_ok/);
  assert.match(output, /Tool:\s+claude_code/);
  assert.match(output, /Elapsed:\s+1m 5s/);
  assert.match(output, /Events:\s+12/);
  assert.match(output, /Integrity:\s+ok — signed log verified/);
  assert.match(output, /Hook channels:.*✓ prompt.*✓ response.*✓ edit.*✓ shell/s);
  assert.deepEqual(deps.exitCodes, []);
  assert.equal(deps.err.length, 0);
});

// ---------------------------------------------------------------------------
// Watch mode tests
// ---------------------------------------------------------------------------

// Build deps wired for watch mode: zero-latency sleep, captured clear-screen
// calls, and an onWatchTick that stops the loop after `maxTicks` renders.
interface WatchDeps extends CapturedDeps {
  clearCalls: number;
}

function makeWatchDeps(
  maxTicks: number,
  overrides: Partial<RunStatusDeps> = {},
): WatchDeps {
  const clearCalls = { count: 0 };
  let ticks = 0;
  const base = makeDeps(overrides);
  const deps: WatchDeps = {
    ...base,
    clearCalls: 0,
    clearScreen: () => { clearCalls.count++; deps.clearCalls = clearCalls.count; },
    // Resolve immediately so the test doesn't hang on real timers.
    sleep: () => Promise.resolve(),
    onWatchTick: () => {
      ticks++;
      if (ticks >= maxTicks) {
        // Emit SIGINT to trigger stopWatch — safe because process.once has
        // already registered a listener that just sets watching=false.
        process.emit("SIGINT");
      }
    },
  };
  return deps;
}

test("runStatus --watch: clears the screen and prints the report on each tick", async () => {
  const deps = makeWatchDeps(2);
  await runStatus(["sess_w"], { watch: true }, deps);
  // 2 ticks → 2 clear-screen calls and 2 report renders
  assert.equal(deps.clearCalls, 2);
  const output = deps.out.join("");
  // The session should appear at least twice (once per tick)
  const matches = [...output.matchAll(/Session:\s+sess_w/g)];
  assert.ok(matches.length >= 2, `expected ≥2 session lines, got ${matches.length}`);
});

test("runStatus --watch: prints the 'Refreshing every Ns' footer on each tick", async () => {
  const deps = makeWatchDeps(1);
  await runStatus(["sess_w"], { watch: true }, deps);
  const output = deps.out.join("");
  assert.match(output, /Refreshing every \d+s — press Ctrl\+C to stop/);
});

test("runStatus --watch: exits cleanly (no exit code set) when SIGINT is received", async () => {
  const deps = makeWatchDeps(1);
  await runStatus(["sess_w"], { watch: true }, deps);
  assert.deepEqual(deps.exitCodes, []);
});

test("runStatus --watch: default interval is STATUS_POLL_INTERVAL_MS (5s)", async () => {
  const { STATUS_POLL_INTERVAL_MS: INTERVAL } = await import("../ai-assisted/cli-start.js");
  // Just assert the default resolves to 5 s — we verify via the footer text
  // rather than coupling to the private parseIntervalMs function.
  const deps = makeWatchDeps(1);
  await runStatus(["sess_w"], { watch: true }, deps);
  const intervalSec = Math.round(INTERVAL / 1000);
  assert.match(deps.out.join(""), new RegExp(`Refreshing every ${intervalSec}s`));
});

test("runStatus --watch: --interval overrides the refresh cadence", async () => {
  const deps = makeWatchDeps(1);
  await runStatus(["sess_w"], { watch: true, interval: "10" }, deps);
  assert.match(deps.out.join(""), /Refreshing every 10s/);
});

test("runStatus --watch: --interval is clamped to the minimum (1s)", async () => {
  const { WATCH_MIN_INTERVAL_MS } = await import("../ai-assisted/cli-status.js");
  const deps = makeWatchDeps(1);
  await runStatus(["sess_w"], { watch: true, interval: "0" }, deps);
  const minSec = Math.round(WATCH_MIN_INTERVAL_MS / 1000);
  // interval=0 is invalid → falls back to default (5s), not to minimum
  // (parseIntervalMs treats 0 as invalid and returns the default)
  const output = deps.out.join("");
  assert.match(output, /Refreshing every \d+s/);
  // Validate minimum is honoured for a sub-minimum value like 0.5s
  const deps2 = makeWatchDeps(1);
  await runStatus(["sess_w"], { watch: true, interval: "0.5" }, deps2);
  assert.match(deps2.out.join(""), new RegExp(`Refreshing every ${minSec}s`));
});

test("runStatus --watch: a fatal 404 error stops the loop and sets exit code 1", async () => {
  const { ApiError: ApiErr } = await import("../api.js");
  const deps = makeWatchDeps(99, {
    fetchStatus: async () => {
      throw new ApiErr(404, { error: "not found" }, "GET ... → 404");
    },
  });
  await runStatus(["sess_gone"], { watch: true }, deps);
  assert.deepEqual(deps.exitCodes, [1]);
  assert.match(deps.err.join(""), /Unknown session id: sess_gone/);
  // Only 1 clear-screen call because the loop breaks on the first fatal error.
  assert.equal(deps.clearCalls, 1);
});
