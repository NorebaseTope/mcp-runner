// Task #1561 — Text-based dedupe. emitDedupeKey must collapse two
// directives that happen to fall back to the same templated wording,
// regardless of their kind / hintShape / hintRung. Pre-fix in 2.2.4
// the key mixed in directive metadata, which let three different
// directives emit the SAME line in ~90s (`ses_3tofurxbf1`).
import test from "node:test";
import assert from "node:assert/strict";
import { emitDedupeKey } from "../coached/terminal-coach.js";
import type { CadenceDirective } from "../coached/cadence-loop.js";

function directive(partial: Partial<CadenceDirective>): CadenceDirective {
  return {
    kind: "stall_nudge:1",
    action: "probe",
    reason: "stall",
    intent: "probe_for_thinking",
    constraints: [],
    mode: "verbatim_relay",
    mustBeVerbatim: false,
    suggestedWording: "",
    emittedAt: 0,
    sessionId: "ses_test",
    ...partial,
  } as CadenceDirective;
}

test("emitDedupeKey is the same for two directives with identical text", () => {
  const text = "What are you turning over in your head right now?";
  const a = emitDedupeKey(
    directive({ kind: "stall_nudge:1" }),
    text,
  );
  const b = emitDedupeKey(
    directive({
      kind: "hint_offer:rung_2",
      hintShape: "spinning",
      hintRung: "focused",
    }),
    text,
  );
  assert.equal(a, b, "different directives, same text → same dedupe key");
});

test("emitDedupeKey normalizes whitespace and case", () => {
  const a = emitDedupeKey(directive({}), "What are you  TURNING over?");
  const b = emitDedupeKey(directive({}), "what are you turning over?");
  assert.equal(a, b);
});

test("emitDedupeKey differs when the text differs", () => {
  const a = emitDedupeKey(directive({}), "Walk me through what you tried.");
  const b = emitDedupeKey(directive({}), "What's the part you're stuck on?");
  assert.notEqual(a, b);
});

test("emitDedupeKey ignores directive kind / hint metadata entirely", () => {
  const text = "Want me to suggest one concrete thing to try?";
  const keys = new Set<string>();
  keys.add(emitDedupeKey(directive({ kind: "stall_nudge:1" }), text));
  keys.add(
    emitDedupeKey(
      directive({
        kind: "hint_offer:rung_3",
        hintShape: "slow_progress",
        hintRung: "directive",
      }),
      text,
    ),
  );
  keys.add(
    emitDedupeKey(
      directive({ kind: "check_in:90s", hintShape: undefined }),
      text,
    ),
  );
  assert.equal(keys.size, 1, "all three must collapse to one key");
});
