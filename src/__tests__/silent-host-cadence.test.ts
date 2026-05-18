// Task #1169 (Cursor-first M4) — silent-host integration test.
//
// Locks in the M4 contract: even if the host NEVER calls any
// (now-retired) check-in tool, the runner-owned cadence loop must
// still proactively emit
//   - the 50/75/90/over_time time warnings derived from the session's
//     `targetDurationMs`,
//   - a stall nudge once the candidate goes silent past the stall
//     window, and
//   - shape-aware hint-ladder escalations using the same stuck-shape
//     classifier the api-server runs from the check-in flow.
//
// Task #1194 (Cursor-first M8 runtime) retired the demoted
// `coached_check_in` queue drainer and the
// `pendingDirectives` / `directiveSeq` plumbing on CoachedSessionState.
// Cursor surfaces MCP `notifications/message` natively, so the
// runner sink writes directly to the recap log + the live MCP
// notification channel. These tests therefore exercise the sink path
// (local `pushed[]`) and the recap log only.
import test from "node:test";
import assert from "node:assert/strict";

import {
  CadenceDriver,
  hintOfferKind,
  fallbackProbeText,
  type CadenceDirective,
} from "../coached/cadence-loop.js";
import {
  startCoachedSession,
  endCoachedSession,
  appendRecapEvent,
  STALL_WINDOW_MS,
} from "../coached/session.js";

// Mirror server.ts's bootCoachedCadenceLoop sink so the test exercises
// the same wiring (notification stand-in array + recap log + per-shape
// hint level high-water mark).
function makeSink(state: ReturnType<typeof startCoachedSession>) {
  const pushed: CadenceDirective[] = [];
  const sink = (d: CadenceDirective) => {
    pushed.push(d);
    let recapKind: import("../coached/session.js").RecapEvent["kind"];
    if (d.kind.startsWith("time_warning")) recapKind = "time_warning_fired";
    else if (d.kind.startsWith("hint_offer:")) recapKind = "hint_level_advanced";
    else recapKind = "stall_nudge_fired";
    if (d.kind.startsWith("hint_offer:")) {
      const lvl = d.hintLevel;
      if (typeof lvl === "number" && lvl > state.hintLevelFired) {
        state.hintLevelFired = lvl;
      }
    }
    appendRecapEvent(state, {
      ts: d.emittedAt,
      kind: recapKind,
      detail: d.kind,
    });
  };
  return { pushed, sink };
}

const fakeIntervalImpl = ((_fn: () => void, _ms: number) => 0) as unknown as typeof globalThis.setInterval;
const fakeClearImpl = (() => undefined) as unknown as typeof globalThis.clearInterval;

test("silent-host cadence: time warnings + stall nudge fire without any check-in", () => {
  const TARGET_MIN = 10;
  const TARGET_MS = TARGET_MIN * 60_000;

  const state = startCoachedSession({
    sessionId: "ses_silent_host",
    questionId: "q_two_sum",
    questionTitle: "Two Sum",
    questionPrompt: "...",
    workspaceDir: "/tmp/silent-host-cadence-test",
    targetDurationMinutes: TARGET_MIN,
  });

  try {
    assert.equal(state.targetDurationMs, TARGET_MS);
    const { pushed, sink } = makeSink(state);

    let nowMs = state.startedAt;
    const driver = new CadenceDriver({
      state,
      sink,
      now: () => nowMs,
      setInterval: fakeIntervalImpl,
      clearInterval: fakeClearImpl,
    });
    driver.start();

    nowMs = state.startedAt + TARGET_MS * 0.5 + 1;
    driver.tick();
    nowMs = state.startedAt + TARGET_MS * 0.75 + 1;
    driver.tick();
    nowMs = state.startedAt + TARGET_MS * 0.9 + 1;
    driver.tick();
    nowMs = state.startedAt + TARGET_MS + 1;
    driver.tick();

    state.lastEditAt = Date.now() - STALL_WINDOW_MS - 1_000;
    nowMs = state.startedAt + TARGET_MS + 60_000;
    driver.tick();

    const kinds = pushed.map((d) => d.kind);
    for (const m of [
      "time_warning:midway",
      "time_warning:warning",
      "time_warning:final_stretch",
      "time_warning:over_time",
    ]) {
      assert.ok(kinds.includes(m), `expected ${m}, got ${kinds.join(", ")}`);
    }
    // Silent-host stall nudge: the M4 decider fires a shape-aware
    // hint_offer first (it has higher priority than stall_nudge in
    // the cadence ordering), then falls back to a stall_nudge once
    // the ladder saturates. Accept either as evidence the host got
    // nudged when the candidate went silent — the point of this
    // assertion is "silence is broken", not which rung breaks it.
    assert.ok(
      kinds.some(
        (k) => k.startsWith("stall_nudge:") || k.startsWith("hint_offer:"),
      ),
      `expected a silence-breaker (stall_nudge or hint_offer), got ${kinds.join(", ")}`,
    );

    nowMs = state.startedAt + TARGET_MS + 65_000;
    driver.tick();
    const counts = new Map<string, number>();
    for (const k of kinds) counts.set(k, (counts.get(k) ?? 0) + 1);
    for (const milestone of [
      "time_warning:midway",
      "time_warning:warning",
      "time_warning:final_stretch",
      "time_warning:over_time",
    ]) {
      assert.equal(counts.get(milestone), 1, `${milestone} fires once`);
    }

    const recapKinds = state.recapEvents.map((e) => e.kind);
    assert.ok(recapKinds.includes("time_warning_fired"));
    // Same priority caveat as above: the silence-breaker can be
    // either a stall_nudge_fired or a hint_level_advanced beat.
    assert.ok(
      recapKinds.includes("stall_nudge_fired") ||
        recapKinds.includes("hint_level_advanced"),
    );

    driver.stop();
  } finally {
    endCoachedSession(state.sessionId);
  }
});

test("silent-host cadence: shape-aware hint ladder escalates one rung per tick and saturates", () => {
  const state = startCoachedSession({
    sessionId: "ses_silent_host_hints",
    questionId: "q_two_sum",
    questionTitle: "Two Sum",
    questionPrompt: "...",
    workspaceDir: "/tmp/silent-host-cadence-hints-test",
  });

  try {
    assert.equal(state.targetDurationMs, null);
    assert.equal(state.hintLevelFired, 0);
    const { pushed, sink } = makeSink(state);

    let nowMs = state.startedAt;
    const driver = new CadenceDriver({
      state,
      sink,
      now: () => nowMs,
      setInterval: fakeIntervalImpl,
      clearInterval: fakeClearImpl,
    });
    driver.start();

    // Drive the runner into the silent-host stall: no attempts, no
    // edits since session start, and `lastEditAt` rewound past the
    // stall window. The classifier degrades to `idle` for this
    // shape (matches `coached-probes.ts`'s fallback when no fields
    // distinguish another shape).
    state.lastEditAt = Date.now() - STALL_WINDOW_MS - 1_000;
    state.editedFilesSinceLastCheckIn.clear();
    nowMs = Date.now();

    // First tick: hint ladder owns priority over the stall nudge,
    // so the open_ended hint for the `idle` shape fires first.
    driver.tick();
    const openEndedKind = hintOfferKind("idle", "open_ended");
    const focusedKind = hintOfferKind("idle", "focused");
    const directiveKind = hintOfferKind("idle", "directive");
    const hint1 = pushed.find((d) => d.kind === openEndedKind);
    assert.ok(hint1, "first stall tick must fire idle:open_ended hint");
    assert.equal(hint1!.action, "hint_offer");
    assert.equal(
      hint1!.suggestedWording,
      fallbackProbeText("idle", "open_ended"),
      "hint wording must come from STUCK_SHAPE_GLOBAL_FALLBACK",
    );
    assert.equal(state.hintLevelFired, 1);

    // Subsequent ticks escalate one rung at a time — focused, then
    // directive — never skipping a rung.
    nowMs += 30_000;
    driver.tick();
    assert.ok(
      pushed.some((d) => d.kind === focusedKind),
      "second tick must escalate to idle:focused",
    );
    assert.equal(state.hintLevelFired, 2);

    nowMs += 30_000;
    driver.tick();
    assert.ok(
      pushed.some((d) => d.kind === directiveKind),
      "third tick must escalate to idle:directive",
    );
    assert.equal(state.hintLevelFired, 3);

    // After the ladder saturates, no more hint_offer:* should fire
    // for this shape even on repeated ticks. The decider falls
    // back to the stall_nudge path (which fires once per stall
    // window via lastEditAt-keyed dedup).
    const beforeHintCount = pushed.filter((d) =>
      d.kind.startsWith("hint_offer:"),
    ).length;
    nowMs += 30_000;
    driver.tick();
    nowMs += 30_000;
    driver.tick();
    const afterHintCount = pushed.filter((d) =>
      d.kind.startsWith("hint_offer:"),
    ).length;
    assert.equal(
      afterHintCount,
      beforeHintCount,
      "ladder saturates at directive — no further hint_offer fires",
    );

    // Recap log captured every advancement.
    const recapHintEvents = state.recapEvents.filter(
      (e) => e.kind === "hint_level_advanced",
    );
    assert.equal(recapHintEvents.length, 3);

    // Shape state is tracked per-shape on the session.
    assert.equal(state.shapeLadderState.idle, "directive");

    driver.stop();
  } finally {
    endCoachedSession(state.sessionId);
  }
});

test("silent-host cadence: end-of-session recap draft is posted with the rolling local view", async () => {
  const { SamApi } = await import("../api.js");
  const state = startCoachedSession({
    sessionId: "ses_silent_host_recap",
    questionId: "q_two_sum",
    questionTitle: "Two Sum",
    questionPrompt: "...",
    workspaceDir: "/tmp/silent-host-cadence-recap-test",
  });

  try {
    appendRecapEvent(state, {
      ts: Date.now(),
      kind: "stall_nudge_fired",
      detail: "stall_nudge:1",
    });
    appendRecapEvent(state, {
      ts: Date.now(),
      kind: "hint_level_advanced",
      detail: hintOfferKind("idle", "open_ended"),
    });
    state.hintLevelFired = 1;
    state.aiAssistCount = 2;
    state.aiAssistSummaries = ["host wrote a unit test", "host fixed a typo"];

    const api = new SamApi({
      apiBaseUrl: "http://localhost:0",
      token: "tok_test",
    });
    let captured: { method: string; url: string; body: unknown } | null = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      const rawBody = typeof init?.body === "string" ? init.body : "";
      let parsed: unknown = null;
      try {
        parsed = rawBody ? JSON.parse(rawBody) : null;
      } catch {
        parsed = rawBody;
      }
      captured = {
        method: init?.method ?? "GET",
        url,
        body: parsed,
      };
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    try {
      const recapDraft = {
        sessionId: state.sessionId,
        startedAt: state.startedAt,
        endedAt: Date.now(),
        targetDurationMs: state.targetDurationMs,
        aiAssistCount: state.aiAssistCount,
        aiAssistSummaries: state.aiAssistSummaries,
        hintLevelFired: state.hintLevelFired,
        events: state.recapEvents,
      };

      await api.endSession(state.sessionId, { recapDraft });

      assert.ok(captured, "endSession must call fetch");
      const c = captured! as { method: string; url: string; body: unknown };
      assert.equal(c.method, "POST");
      assert.match(c.url, /\/runner\/sessions\/.+\/end$/);
      const body = c.body as { recapDraft: typeof recapDraft };
      assert.ok(body.recapDraft, "body must carry recapDraft");
      assert.equal(body.recapDraft.sessionId, state.sessionId);
      assert.equal(body.recapDraft.hintLevelFired, 1);
      assert.equal(body.recapDraft.aiAssistCount, 2);
      assert.ok(
        body.recapDraft.events.some(
          (e: { kind: string }) => e.kind === "stall_nudge_fired",
        ),
      );
      assert.ok(
        body.recapDraft.events.some(
          (e: { kind: string }) => e.kind === "hint_level_advanced",
        ),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    endCoachedSession(state.sessionId);
  }
});
