// Task #1561 — Substantive first-hint path. Before any code activity
// (no diff, no edited files, no submitted attempts, empty memory),
// `/hint` and the first free-form utterance must compose an orient-the-
// candidate prompt that EXPLICITLY forbids solving anything, and must
// route the reply through the SDK rather than the templated fallback.
import test from "node:test";
import assert from "node:assert/strict";
import {
  composeIntroHintPrompt,
  hasZeroCodeActivity,
} from "../coached/intro-hint.js";

test("hasZeroCodeActivity is true at session start", () => {
  const startedAt = 1_000;
  const state = {
    lastEditAt: startedAt,
    startedAt,
    editedFilesSinceLastCheckIn: new Set<string>(),
    lastDiffSnippet: null,
    attemptsTotal: 0,
  };
  assert.equal(hasZeroCodeActivity({ state, memory: null }), true);
});

test("hasZeroCodeActivity flips false once any signal appears", () => {
  const startedAt = 1_000;
  const base = {
    lastEditAt: startedAt,
    startedAt,
    editedFilesSinceLastCheckIn: new Set<string>(),
    lastDiffSnippet: null as string | null,
    attemptsTotal: 0 as number | null,
  };
  // edit appeared
  assert.equal(
    hasZeroCodeActivity({
      state: { ...base, lastEditAt: startedAt + 1 },
      memory: null,
    }),
    false,
  );
  // diff captured
  assert.equal(
    hasZeroCodeActivity({
      state: { ...base, lastDiffSnippet: "diff --git a b" },
      memory: null,
    }),
    false,
  );
  // edited file recorded
  assert.equal(
    hasZeroCodeActivity({
      state: {
        ...base,
        editedFilesSinceLastCheckIn: new Set(["solution.ts"]),
      },
      memory: null,
    }),
    false,
  );
  // attempt submitted
  assert.equal(
    hasZeroCodeActivity({
      state: { ...base, attemptsTotal: 1 },
      memory: null,
    }),
    false,
  );
  // memory has a prior Sam turn
  assert.equal(
    hasZeroCodeActivity({
      state: { ...base },
      memory: { samTurnCount: () => 1 },
    }),
    false,
  );
  // memory has ONLY a current user line (no prior Sam turn) — still
  // eligible for intro, because the readline handler in
  // startTerminalCoach pushes the user line BEFORE the gate runs.
  assert.equal(
    hasZeroCodeActivity({
      state: { ...base },
      memory: { samTurnCount: () => 0 },
    }),
    true,
  );
});

test("hasZeroCodeActivity uses lastEditAtBeforeUtterance snapshot when provided", () => {
  // Reproduces the real readline flow: state.lastEditAt was just
  // bumped to `now` for the current user utterance — but the gate
  // must still see "no prior code activity" because nothing happened
  // BEFORE this utterance. Without the snapshot param, the gate
  // would mis-attribute the utterance bump as code activity and
  // dead-code the intro path.
  const startedAt = 1_000;
  const now = 5_000;
  const state = {
    lastEditAt: now, // bumped by the readline handler
    startedAt,
    editedFilesSinceLastCheckIn: new Set<string>(),
    lastDiffSnippet: null,
    attemptsTotal: 0,
  };
  // Without the snapshot — wrongly returns false (the utterance bump
  // looks like a code edit because state.lastEditAt > startedAt).
  assert.equal(
    hasZeroCodeActivity({ state, memory: { samTurnCount: () => 0 } }),
    false,
  );
  // With the pre-utterance snapshot equal to startedAt — correctly
  // returns true (no real edit BEFORE the utterance).
  assert.equal(
    hasZeroCodeActivity({
      state,
      memory: { samTurnCount: () => 0 },
      lastEditAtBeforeUtterance: startedAt,
    }),
    true,
  );
  // With the pre-utterance snapshot AFTER startedAt — correctly
  // returns false (there WAS a real edit before the utterance).
  assert.equal(
    hasZeroCodeActivity({
      state,
      memory: { samTurnCount: () => 0 },
      lastEditAtBeforeUtterance: startedAt + 100,
    }),
    false,
  );
});

test("composeIntroHintPrompt restates the question and forbids solving", () => {
  const prompt = composeIntroHintPrompt({
    questionTitle: "Two Sum",
    questionPrompt:
      "Given an array of integers and a target, return indices of two numbers that add up to the target.",
    utterance: "/hint",
  });
  // Restates the problem by including its title and body verbatim.
  assert.ok(prompt.includes("Two Sum"), "must include title");
  assert.ok(
    prompt.includes("indices of two numbers that add up to the target"),
    "must include prompt body",
  );
  // Hard "do NOT solve" constraint is present in unambiguous form.
  assert.match(prompt, /do NOT solve/);
  assert.match(prompt, /do NOT hint at an algorithm or data structure/);
  // Two-sentence shape is described in the instructions.
  assert.match(prompt, /Restate/);
  assert.match(prompt, /one specific orienting question/i);
  // The candidate's utterance is echoed back so the model sees it.
  assert.ok(prompt.includes("/hint"));
});

test("composeIntroHintPrompt caps a runaway prompt body", () => {
  const huge = "x".repeat(50_000);
  const out = composeIntroHintPrompt({
    questionTitle: "Big",
    questionPrompt: huge,
  });
  assert.ok(out.length < 50_000, "prompt body must be capped");
  assert.ok(out.includes("(truncated)"));
});
