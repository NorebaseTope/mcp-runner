// Task #1561 — Skip-SDK on empty-content cadence ticks. The
// runner-driven cadence sink must NOT round-trip through the coding
// agent when a stall_nudge tick arrives with no new diff, no new
// failing test, and no user utterance — that round-trip costs ~1-3s of
// latency and almost always falls through to the templated wording
// pool anyway. We validate the picker's behavior here at the
// stall-nudge-pool level (the sink wiring is exercised end-to-end by
// the runner harness in coached/__tests__/runner-harness/).
import test from "node:test";
import assert from "node:assert/strict";
import {
  pickTemplate,
  stageForDirectiveKind,
  poolFor,
} from "../coached/stall-nudge-pool.js";

test("picker returns a real pool line when invoked with no SDK ask", () => {
  const line = pickTemplate("mid_stall");
  const pool = poolFor("mid_stall");
  assert.ok(pool.includes(line), "picked line must come from the live pool");
  assert.ok(line.length > 0);
});

test("repeated empty-tick picks stay in pool and respect recency", () => {
  // Simulate 30 pure-idle ticks back-to-back. Without SDK ask() calls,
  // the sink must still hand back varied, in-pool lines.
  const recent = new Set<string>();
  const pool = poolFor("late_stall");
  for (let i = 0; i < 30; i++) {
    const line = pickTemplate("late_stall", recent);
    assert.ok(pool.includes(line));
    recent.add(line);
  }
  // Ring buffer behavior is the caller's responsibility, but at the
  // 30-tick mark we should have surfaced most of the 20-line pool.
  assert.ok(recent.size >= Math.min(pool.length, 15));
});

test("stage routing chooses correct pool for stall_nudge vs hint_offer", () => {
  // The sink uses stageForDirectiveKind to decide WHICH pool to pull
  // from when it rewrites an empty-tick directive into a templated
  // nudge. Two different directive kinds → two different pools.
  const stallStage = stageForDirectiveKind("stall_nudge:42");
  const hintStage = stageForDirectiveKind("hint_offer:sliding_window:2");
  assert.notEqual(stallStage, hintStage);

  const stallLine = pickTemplate(stallStage);
  const hintLine = pickTemplate(hintStage);
  assert.ok(poolFor(stallStage).includes(stallLine));
  assert.ok(poolFor(hintStage).includes(hintLine));
});

test("picker is pure: same seed → same pick (skip-SDK is deterministic)", () => {
  let seed = 42;
  const rng = (): number => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  const recent = new Set<string>();
  const a = pickTemplate("early_stall", recent, rng);
  seed = 42;
  const b = pickTemplate("early_stall", recent, rng);
  assert.equal(a, b);
});

test("empty-tick fallback NEVER returns empty string or null-shaped data", () => {
  // Defense in depth: a sink that swaps in a templated nudge MUST hand
  // back non-empty text — empty text was the original bug that left
  // ses_3tofurxbf1 silent for 60s windows.
  for (const stage of [
    "early_stall",
    "mid_stall",
    "late_stall",
    "hint_offer",
  ] as const) {
    for (let i = 0; i < 100; i++) {
      const line = pickTemplate(stage);
      assert.ok(line && line.trim().length > 0);
    }
  }
});
