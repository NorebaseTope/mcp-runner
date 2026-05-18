// Task #1086 — pure helper that converts the runner's per-session state
// plus the latest `api.getSession` response into the four
// `progressSignals` fields the server's stuck-shape classifier
// (`artifacts/api-server/src/lib/coached-probes.ts:classifyStuckShape`)
// expects on every `/runner/sessions/:id/check-in`:
//
//   - filesChangedSinceLastCheckIn — distinct file paths the watcher
//     has seen edited in the window between the previous and current
//     `coached_check_in` call. The runner clears its set after each
//     successful POST, so this number is per-window, not cumulative.
//   - attemptsInRecentWindow        — count of attempts whose
//     `submittedAt` falls within the trailing `RECENT_WINDOW_MS`.
//   - distinctFailingTestsInWindow  — count of unique failing-test ids
//     across those same recent attempts.
//   - regressedFromBest             — true iff the most recent attempt's
//     `passedCount` is strictly less than the highest `passedCount`
//     observed in any prior attempt this session.
//
// All four signals are individually nullable. The server treats `null`
// as "unknown" and degrades to the legacy idle-stall path for that
// branch. We therefore prefer to emit a real number (including 0) over
// returning `null`, except for `regressedFromBest`, where `null` is the
// honest answer when no prior attempt exists yet (a first-attempt run
// cannot have regressed).
//
// This module is deliberately pure / data-in-data-out so the unit
// tests in `__tests__/progress-signals.test.ts` can exercise every
// classifier branch without spinning up the runner or the API.

import type { CoachedSessionState } from "./session.js";

/** Trailing window used by `attemptsInRecentWindow` and
 *  `distinctFailingTestsInWindow`. Mirrors the comment in
 *  `ClassifierInputs` ("trailing ~10-minute window") and matches the
 *  cadence at which a stalled candidate would normally have submitted
 *  another attempt. Exported for the unit tests; not configurable at
 *  runtime — the server's classifier thresholds are tuned around this. */
export const RECENT_WINDOW_MS = 10 * 60 * 1000;

/** Subset of the `Attempt` shape returned by `api.getSession`. We only
 *  read the fields we need so a future schema addition (e.g. a new
 *  `failedTests` shape) won't break this helper at compile time. */
export interface AttemptForSignals {
  submittedAt: string;
  passedCount: number;
  failedTests?: Array<{ id: string }> | null;
}

export interface ProgressSignals {
  filesChangedSinceLastCheckIn: number | null;
  attemptsInRecentWindow: number | null;
  distinctFailingTestsInWindow: number | null;
  regressedFromBest: boolean | null;
}

/** Pure computation. Mutates `state.bestPassedCount` so the next call
 *  sees the updated high-water mark; the caller (the `coached_check_in`
 *  server handler) is responsible for clearing
 *  `state.editedFilesSinceLastCheckIn` AFTER the POST succeeds so a
 *  retried POST still carries the same file list. */
export function computeProgressSignals(
  state: CoachedSessionState | undefined,
  attempts: ReadonlyArray<AttemptForSignals> | null | undefined,
  now: number = Date.now(),
): ProgressSignals {
  // filesChangedSinceLastCheckIn — the runner watcher always populates
  // this set, so 0 is a meaningful answer ("the candidate hasn't
  // touched a file since the previous check-in"). When we have no
  // session state at all (e.g. the host called `coached_check_in`
  // before `coached_start_session`, which the server rejects but the
  // runner still tries to be defensive about), fall back to null so
  // the server treats it as unknown rather than wrongly emitting
  // `editing_without_testing` on session boot.
  const filesChangedSinceLastCheckIn = state
    ? state.editedFilesSinceLastCheckIn.size
    : null;

  // Attempts list — when undefined/null we genuinely don't know, so
  // every attempt-derived signal must be null (the classifier will
  // skip the attempt-cadence branches). An empty array, by contrast,
  // means "we asked and there are no attempts yet" — a real 0.
  if (attempts == null) {
    return {
      filesChangedSinceLastCheckIn,
      attemptsInRecentWindow: null,
      distinctFailingTestsInWindow: null,
      regressedFromBest: null,
    };
  }

  const cutoff = now - RECENT_WINDOW_MS;
  let attemptsInRecentWindow = 0;
  const distinctFailingTestIds = new Set<string>();
  for (const a of attempts) {
    const ts = Date.parse(a.submittedAt);
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    attemptsInRecentWindow += 1;
    if (Array.isArray(a.failedTests)) {
      for (const t of a.failedTests) {
        if (t && typeof t.id === "string" && t.id.length > 0) {
          distinctFailingTestIds.add(t.id);
        }
      }
    }
  }

  // regressedFromBest — compare the latest attempt's `passedCount`
  // against the best `passedCount` we know about EXCLUDING the latest
  // attempt itself. The "prior best" is derived from BOTH the
  // persisted high-water mark on `state.bestPassedCount` AND the
  // attempts history we just fetched, so a fresh runner process (with
  // no in-memory state yet) or a runner that missed earlier check-ins
  // still detects regressions accurately on the very first call.
  // With no prior attempt and no persisted best, the answer is
  // `null` ("unknown"), not `false`, because a first attempt cannot
  // have regressed.
  let regressedFromBest: boolean | null = null;
  if (attempts.length > 0) {
    // attempts list ordering is not contractually guaranteed, so
    // identify the one with the most recent `submittedAt` and pick
    // the prior best from everything else.
    let latestIdx = -1;
    let latestTs = -Infinity;
    for (let i = 0; i < attempts.length; i++) {
      const ts = Date.parse(attempts[i]!.submittedAt);
      if (Number.isFinite(ts) && ts > latestTs) {
        latestTs = ts;
        latestIdx = i;
      }
    }
    if (latestIdx >= 0) {
      const latest = attempts[latestIdx]!;
      // Build the prior best from state + every attempt except the
      // latest. Math.max returns -Infinity for an empty list so we
      // start from a sentinel and only flip to a real number when we
      // actually saw a prior data point.
      let priorBest: number | null = state?.bestPassedCount ?? null;
      for (let i = 0; i < attempts.length; i++) {
        if (i === latestIdx) continue;
        const pc = attempts[i]!.passedCount;
        if (typeof pc === "number") {
          priorBest = priorBest === null ? pc : Math.max(priorBest, pc);
        }
      }
      if (priorBest !== null) {
        regressedFromBest = latest.passedCount < priorBest;
      }
      if (state) {
        // Update the persisted high-water mark to the true max across
        // ALL known history (state + every attempt, including the
        // latest). This way the next check-in carries an accurate
        // best forward even if the attempts list is shorter then
        // (e.g. server pagination, or the runner went back to the
        // host editor and the cached list dropped older entries).
        let newBest: number | null = state.bestPassedCount ?? null;
        for (const a of attempts) {
          if (typeof a.passedCount === "number") {
            newBest = newBest === null ? a.passedCount : Math.max(newBest, a.passedCount);
          }
        }
        state.bestPassedCount = newBest;
      }
    }
  }

  return {
    filesChangedSinceLastCheckIn,
    attemptsInRecentWindow,
    distinctFailingTestsInWindow: distinctFailingTestIds.size,
    regressedFromBest,
  };
}
