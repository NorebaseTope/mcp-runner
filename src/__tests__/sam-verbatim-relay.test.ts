// Task #1064 — sentinel + classification helpers (runner mirror).
import test from "node:test";
import assert from "node:assert/strict";
import {
  SAM_VERBATIM_OPEN,
  SAM_VERBATIM_CLOSE,
  wrapSamVerbatim,
  extractSamVerbatim,
  classifyRelay,
  normalizeForCompare,
} from "../sam-verbatim.js";

test("wrapSamVerbatim wraps once and is idempotent", () => {
  const wrapped = wrapSamVerbatim("Take a breath, then re-read the prompt.");
  assert.ok(wrapped.startsWith(SAM_VERBATIM_OPEN));
  assert.ok(wrapped.endsWith(SAM_VERBATIM_CLOSE));
  assert.equal(wrapSamVerbatim(wrapped), wrapped);
  assert.equal(wrapSamVerbatim(""), "");
  assert.equal(wrapSamVerbatim(null), "");
  assert.equal(wrapSamVerbatim(undefined), "");
});

test("extractSamVerbatim returns the inner block", () => {
  const inner = "Take a breath, then re-read the prompt.";
  assert.equal(extractSamVerbatim(wrapSamVerbatim(inner)), inner);
});

test("normalizeForCompare flattens whitespace, smart quotes, markdown", () => {
  assert.equal(normalizeForCompare("  Hello,   world!  "), "hello, world!");
  assert.equal(normalizeForCompare("Sam\u2019s nudge"), "sam's nudge");
  assert.equal(normalizeForCompare("**bold** _italic_"), "bold italic");
});

test("classifyRelay buckets verbatim / drift / not_relayed / unknown", () => {
  const line = "What's the smallest input that breaks your current plan and surprises you?";
  const wrapped = wrapSamVerbatim(line);

  // verbatim — host turn includes the line text
  assert.equal(
    classifyRelay({ lastAssistantTurn: wrapped, lastSamVoiceLine: wrapped }),
    "relayed_verbatim",
  );
  assert.equal(
    classifyRelay({
      lastAssistantTurn: `Sure! ${line}\nThen pause.`,
      lastSamVoiceLine: wrapped,
    }),
    "relayed_verbatim",
  );

  // drift — long contiguous prefix appears in turn but full line does not
  const drifted = `What's the smallest input that breaks your current plan and... wait, let me rephrase.`;
  assert.equal(
    classifyRelay({ lastAssistantTurn: drifted, lastSamVoiceLine: wrapped }),
    "relayed_with_drift",
  );

  // not_relayed — paraphrased, no shared prefix
  assert.equal(
    classifyRelay({
      lastAssistantTurn: "Hey, what edge case breaks your approach?",
      lastSamVoiceLine: wrapped,
    }),
    "not_relayed",
  );

  // unknown — server has no last line to compare against
  assert.equal(
    classifyRelay({ lastAssistantTurn: "anything", lastSamVoiceLine: null }),
    "unknown",
  );

  // not_relayed — host did not surface a turn (server has a line)
  assert.equal(
    classifyRelay({ lastAssistantTurn: "", lastSamVoiceLine: wrapped }),
    "not_relayed",
  );
});
