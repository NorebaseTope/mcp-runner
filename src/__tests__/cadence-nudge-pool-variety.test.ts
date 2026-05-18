// Task #1561 — Broadened stall-nudge templated pool. With ~20 lines
// per stage, 50 stalls back-to-back from the same stage must surface
// at least 10 distinct lines (vs the 2-3 distinct lines that 2.2.4's
// 6-line pool was producing in `ses_3tofurxbf1`).
import test from "node:test";
import assert from "node:assert/strict";
import {
  EARLY_STALL_POOL,
  MID_STALL_POOL,
  LATE_STALL_POOL,
  HINT_OFFER_POOL,
  pickTemplate,
  poolFor,
  stageForDirectiveKind,
  type CadenceStage,
} from "../coached/stall-nudge-pool.js";

const STAGES: CadenceStage[] = [
  "early_stall",
  "mid_stall",
  "late_stall",
  "hint_offer",
];

test("every stage pool has at least ~20 distinct lines", () => {
  for (const stage of STAGES) {
    const pool = poolFor(stage);
    assert.ok(pool.length >= 20, `${stage} pool has ${pool.length} lines (<20)`);
    assert.equal(
      new Set(pool).size,
      pool.length,
      `${stage} pool contains duplicates`,
    );
  }
});

test("pool wording stays in Sam voice (no emoji / markdown / code fences)", () => {
  const banned = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]|```|<code>/u;
  for (const pool of [
    EARLY_STALL_POOL,
    MID_STALL_POOL,
    LATE_STALL_POOL,
    HINT_OFFER_POOL,
  ]) {
    for (const line of pool) {
      assert.ok(!banned.test(line), `forbidden char/markup in: ${line}`);
      // Two sentences max — keeps the cadence tick lightweight.
      const sentenceCount = (line.match(/[.!?]/g) ?? []).length;
      assert.ok(
        sentenceCount <= 3,
        `line too long (${sentenceCount} sentence terminators): ${line}`,
      );
    }
  }
});

test("50 picks from mid_stall pool surface ≥10 distinct lines", () => {
  // Seeded RNG so the test is deterministic but realistic — drand48
  // analogue good enough for a uniformity smoke test.
  let seed = 0xc0ffee;
  const rng = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const recent = new Set<string>();
  const picks: string[] = [];
  for (let i = 0; i < 50; i++) {
    const line = pickTemplate("mid_stall", recent, rng);
    picks.push(line);
    recent.add(line);
    // Mirror the ring-buffer cap in startTerminalCoach so we don't
    // exhaust the pool over very long sessions.
    if (recent.size > 20) {
      const first = recent.values().next().value;
      if (first !== undefined) recent.delete(first);
    }
  }
  const distinct = new Set(picks).size;
  assert.ok(
    distinct >= 10,
    `expected ≥10 distinct lines over 50 picks, got ${distinct}`,
  );
});

test("pickTemplate prefers fresh lines over the recent set", () => {
  const pool = poolFor("early_stall");
  const recent = new Set(pool.slice(0, pool.length - 1));
  // Only one fresh line remains — pickTemplate must surface it.
  const onlyFresh = pool[pool.length - 1]!;
  for (let i = 0; i < 10; i++) {
    assert.equal(pickTemplate("early_stall", recent), onlyFresh);
  }
});

test("stageForDirectiveKind maps cadence directive kinds to a stage", () => {
  assert.equal(stageForDirectiveKind("stall_nudge:12345"), "mid_stall");
  assert.equal(stageForDirectiveKind("hint_offer:rung_1"), "hint_offer");
  assert.equal(stageForDirectiveKind("check_in:60s"), "early_stall");
});
