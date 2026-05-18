// Task #1169 (Cursor-first M4) — runner-side port of the stuck-shape
// classifier + 3-rung escalation ladder + Sam-voice fallback table.
//
// The api-server owns the canonical definition in
// `artifacts/api-server/src/lib/coached-probes.ts`. The runner is now
// the system of record for the cadence loop (Milestone 4): when a
// silent host never calls `coached_check_in`, the local CadenceDriver
// must still escalate hints using the SAME shape-aware ladder the
// server used to drive from the check-in flow, not an independent
// "after N stalls bump a rung" heuristic.
//
// Keep this file structurally aligned with `coached-probes.ts`: the
// shape names, ladder rung names, classifier priority order, and
// global-fallback Sam-voice text MUST match byte-for-byte. The version
// floor (MIN_SUPPORTED_RUNNER_VERSION) is what guarantees the runner
// and server agree on the wording the candidate sees.
//
// PURE: data-in / data-out, no I/O, no clock, no randomness. The
// CadenceDriver in `cadence-loop.ts` calls these to decide the next
// rung; the recap draft posted at end-of-session captures every
// (shape, rung) pair that fired.

export const STUCK_SHAPES = [
  "idle",
  "spinning",
  "slow_progress",
  "editing_without_testing",
  "regression",
  "same_test_stuck",
  "wrong_path",
] as const;
export type StuckShape = (typeof STUCK_SHAPES)[number];

export const LADDER_RUNGS = ["open_ended", "focused", "directive"] as const;
export type LadderRung = (typeof LADDER_RUNGS)[number];

export function nextRung(current: LadderRung | null): LadderRung {
  if (current === null) return "open_ended";
  if (current === "open_ended") return "focused";
  if (current === "focused") return "directive";
  return "directive"; // saturate at the top
}

export function rungOrdinal(rung: LadderRung): number {
  // 1-indexed so ladder display ("rung 1 of 3") matches the
  // recap draft posted at end-of-session and the api-server post-mortem.
  return LADDER_RUNGS.indexOf(rung) + 1;
}

export interface StuckClassifierInputs {
  idleMs: number;
  attemptsTotal: number;
  consecutiveFailingTestCount: number;
  filesChangedSinceLastCheckIn: number | null;
  attemptsInRecentWindow: number | null;
  regressedFromBest: boolean | null;
  distinctFailingTestsInWindow: number | null;
}

// Same priority order as the server-side classifier. Returns null when
// no shape matches — the cadence loop treats that as "no hint to fire
// this tick" and falls back to whatever lower-priority directive
// (stall_nudge, time_warning) the decider picked.
const STALL_MS = 5 * 60 * 1000;
export function classifyStuckShape(
  inputs: StuckClassifierInputs,
): StuckShape | null {
  const {
    idleMs,
    attemptsTotal,
    consecutiveFailingTestCount,
    filesChangedSinceLastCheckIn,
    attemptsInRecentWindow,
    regressedFromBest,
    distinctFailingTestsInWindow,
  } = inputs;
  if (regressedFromBest === true) return "regression";
  if (consecutiveFailingTestCount >= 2) return "same_test_stuck";
  if (
    attemptsInRecentWindow !== null &&
    distinctFailingTestsInWindow !== null &&
    attemptsInRecentWindow >= 3 &&
    distinctFailingTestsInWindow >= 2
  ) {
    return "spinning";
  }
  if (
    distinctFailingTestsInWindow !== null &&
    distinctFailingTestsInWindow >= 3 &&
    attemptsInRecentWindow !== null &&
    attemptsInRecentWindow <= 2
  ) {
    return "wrong_path";
  }
  if (
    filesChangedSinceLastCheckIn !== null &&
    filesChangedSinceLastCheckIn >= 1 &&
    attemptsInRecentWindow !== null &&
    attemptsInRecentWindow === 0 &&
    attemptsTotal > 0
  ) {
    return "editing_without_testing";
  }
  if (
    attemptsTotal >= 3 &&
    consecutiveFailingTestCount >= 1 &&
    (attemptsInRecentWindow === null || attemptsInRecentWindow <= 2)
  ) {
    return "slow_progress";
  }
  if (attemptsTotal > 0 && idleMs > STALL_MS) return "idle";
  // No-attempts-yet stall: still classify as `idle` so the cadence
  // loop can escalate the silent-host case where the candidate has
  // not submitted anything but has stopped editing for the stall
  // window. Without this branch the ladder never advances for blank-
  // page sessions, which is exactly the silent-host regression M4
  // is meant to fix.
  if (idleMs > STALL_MS) return "idle";
  return null;
}

// Sam-voice fallback table. MUST stay byte-for-byte aligned with
// `STUCK_SHAPE_GLOBAL_FALLBACK` in
// `artifacts/api-server/src/lib/coached-probes.ts`. Hosts may render
// either copy depending on whether the cadence loop or the server
// authored the directive; the wording must not drift between them.
export const STUCK_SHAPE_GLOBAL_FALLBACK: Record<
  StuckShape,
  Record<LadderRung, string>
> = {
  idle: {
    open_ended:
      "You've gone quiet — what are you turning over in your head? Walk me through what you're trying to do, even rough.",
    focused:
      "Pick the smallest sub-problem you actually understand and tell me how you'd solve just that piece.",
    directive:
      "Stop reading and write the simplest version that handles one example end-to-end. We can refine after.",
  },
  spinning: {
    open_ended:
      "You've submitted a few times and the failures keep moving. What pattern are you seeing across them?",
    focused:
      "Pick one failing case and walk me through what your code does step-by-step on that input.",
    directive:
      "Stop submitting. Trace one failing case by hand on paper or in a comment, then change one thing.",
  },
  slow_progress: {
    open_ended: "What's your current theory of why this isn't passing yet?",
    focused:
      "Which test is closest to passing? What's the single change you think would flip it?",
    directive:
      "Pick the one failing test you understand best and isolate the line that's wrong before changing anything else.",
  },
  editing_without_testing: {
    open_ended:
      "I see edits but no submissions in a while — what are you waiting for before you try it?",
    focused:
      "Run what you have now, even if you think it'll fail. The error message is data.",
    directive:
      "Submit your current draft. We'll work from whatever the runner says, not from what you think it'll say.",
  },
  regression: {
    open_ended:
      "You had more tests passing earlier — what changed in your head about the approach?",
    focused:
      "Compare what you just submitted to the version that was passing more tests. What did you remove?",
    directive:
      "Revert to the version that had more passing and re-state the case it didn't handle. Fix that one case only.",
  },
  same_test_stuck: {
    open_ended:
      "Read the failing test out loud to me. What input does it expect, and what does your code return?",
    focused:
      "Name in one sentence what this specific test is checking, then point at the line in your code that decides it.",
    directive:
      "Print the values your function sees on this test's input. Don't change any code until you've seen them.",
  },
  wrong_path: {
    open_ended:
      "A lot of different tests are failing. What does that tell you about your overall approach?",
    focused:
      "Which assumption in your design might be wrong? Pick the most load-bearing one and challenge it.",
    directive:
      "Throw out the current shape and sketch one alternative for two minutes. We'll compare them before you keep coding.",
  },
};

export function fallbackProbeText(shape: StuckShape, rung: LadderRung): string {
  return STUCK_SHAPE_GLOBAL_FALLBACK[shape][rung];
}
