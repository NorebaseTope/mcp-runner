// Unit tests for the `coached_end_session` post-mortem helpers.
//
// The MCP `coached_end_session` tool delegates its text/format work to
// `buildCoachedPostMortemText` and `formatCoachedEndSessionResponse`
// (`packages/mcp-runner/src/coached/post-mortem.ts`). These tests pin
// the contract:
//   - response includes `coachedAiAssistDetected`,
//     `coachedAiAssistCount`, and `postMortem`
//   - post-mortem mentions AI-assist honestly without being punitive
//   - post-mortem affirms the user's own work when no AI-assist
//   - structured `summary: <json>` line is parseable
//
// Mirrors `buildCoachedPostMortem` in @workspace/api-server's
// sam-study-persona — the api-server `practice-proactivity.test.ts` pins
// the canonical wording, this file pins the runner copy stays in sync.

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCoachedPostMortemText,
  formatCoachedEndSessionResponse,
  type CoachedEndSessionSummary,
} from "../coached/post-mortem.js";

test("buildCoachedPostMortemText: mentions AI-assist count and the non-punitive framing", () => {
  const text = buildCoachedPostMortemText({
    questionTitle: "Two Sum",
    attemptsTotal: 2,
    hintsUsed: 1,
    passedLatest: false,
    aiAssistDetected: true,
    aiAssistCount: 3,
  });
  assert.match(text, /3 AI-assist event/i);
  assert.match(text, /still scored and saved/i);
  assert.match(text, /not a deduction/i);
  assert.match(text, /coached_ask/);
});

// Task #566 — the IDE post-mortem must close by naming the `coached_ask`
// MCP tool exactly. The web surface in the api-server uses a different
// closing line (it points at the in-page Sam chat) because web users
// cannot invoke MCP tools from the browser; this assertion locks in the
// IDE wording so any drift between this runner copy and the api-server
// IDE variant fails loudly here.
test("buildCoachedPostMortemText: closing line names the coached_ask MCP tool exactly", () => {
  const text = buildCoachedPostMortemText({
    questionTitle: "Two Sum",
    attemptsTotal: 1,
    hintsUsed: 0,
    passedLatest: true,
    aiAssistDetected: false,
    aiAssistCount: 0,
  });
  assert.ok(
    text.endsWith(
      "Ask me anything about this problem — the pattern, why your approach worked or didn't, the canonical solution, edge cases. I'll answer here via coached_ask.",
    ),
    "IDE post-mortem must end with the canonical coached_ask invitation",
  );
});

test("buildCoachedPostMortemText: singular wording for one event", () => {
  const text = buildCoachedPostMortemText({
    questionTitle: "Two Sum",
    attemptsTotal: 1,
    hintsUsed: 0,
    passedLatest: true,
    aiAssistDetected: true,
    aiAssistCount: 1,
  });
  assert.match(text, /1 AI-assist event\b/);
  assert.doesNotMatch(text, /1 AI-assist events/i);
});

test("buildCoachedPostMortemText: omits the heads-up when no AI-assist was detected", () => {
  const text = buildCoachedPostMortemText({
    questionTitle: "Two Sum",
    attemptsTotal: 1,
    hintsUsed: 0,
    passedLatest: true,
    aiAssistDetected: false,
    aiAssistCount: 0,
  });
  assert.doesNotMatch(text, /heads up/i);
  assert.doesNotMatch(text, /not a deduction/i);
  assert.match(text, /your work end to end/i);
  assert.match(text, /coached_ask/);
});

test("buildCoachedPostMortemText: includes per-event summaries when supplied", () => {
  const text = buildCoachedPostMortemText({
    questionTitle: "Two Sum",
    attemptsTotal: 0,
    hintsUsed: 0,
    passedLatest: undefined,
    aiAssistDetected: true,
    aiAssistCount: 2,
    aiAssistSummaries: ["Generated sort helper", "Refactored loop"],
  });
  assert.match(text, /- Generated sort helper/);
  assert.match(text, /- Refactored loop/);
});

test("buildCoachedPostMortemText: surfaces runner-driven stall-nudge count when > 0", () => {
  const text = buildCoachedPostMortemText({
    questionTitle: "Two Sum",
    attemptsTotal: 1,
    hintsUsed: 0,
    passedLatest: true,
    aiAssistDetected: false,
    aiAssistCount: 0,
    stallNudgeCount: 2,
  });
  assert.match(text, /broke the silence 2 times/i);

  const oneNudge = buildCoachedPostMortemText({
    questionTitle: "Two Sum",
    attemptsTotal: 1,
    hintsUsed: 0,
    passedLatest: true,
    aiAssistDetected: false,
    aiAssistCount: 0,
    stallNudgeCount: 1,
  });
  assert.match(oneNudge, /broke the silence 1 time\b/);
  assert.doesNotMatch(oneNudge, /broke the silence 1 times/);
});

test("buildCoachedPostMortemText: omits stall-nudge mention when count is zero", () => {
  const text = buildCoachedPostMortemText({
    questionTitle: "Two Sum",
    attemptsTotal: 1,
    hintsUsed: 0,
    passedLatest: true,
    aiAssistDetected: false,
    aiAssistCount: 0,
    stallNudgeCount: 0,
  });
  assert.doesNotMatch(text, /broke the silence/i);
});

test("buildCoachedPostMortemText: outcome wording covers pass / fail / no-submit", () => {
  const passed = buildCoachedPostMortemText({
    questionTitle: "Q",
    attemptsTotal: 1,
    hintsUsed: 0,
    passedLatest: true,
    aiAssistDetected: false,
    aiAssistCount: 0,
  });
  assert.match(passed, /you passed it/);

  const failed = buildCoachedPostMortemText({
    questionTitle: "Q",
    attemptsTotal: 3,
    hintsUsed: 2,
    passedLatest: false,
    aiAssistDetected: false,
    aiAssistCount: 0,
  });
  assert.match(failed, /you made 3 attempts and it did not pass/);
  assert.match(failed, /2 hints used/);

  const noSubmit = buildCoachedPostMortemText({
    questionTitle: "Q",
    attemptsTotal: 0,
    hintsUsed: 0,
    passedLatest: undefined,
    aiAssistDetected: false,
    aiAssistCount: 0,
  });
  assert.match(noSubmit, /you ended without submitting/);
});

test("formatCoachedEndSessionResponse: includes header keys, post-mortem, and parseable summary JSON", () => {
  const postMortem = buildCoachedPostMortemText({
    questionTitle: "Two Sum",
    attemptsTotal: 2,
    hintsUsed: 1,
    passedLatest: false,
    aiAssistDetected: true,
    aiAssistCount: 3,
  });
  const summary: CoachedEndSessionSummary = {
    session_id: "ses_test_123",
    status: "ended",
    coachedAiAssistDetected: true,
    coachedAiAssistCount: 3,
    coachedStallNudgeCount: 0,
    postMortem,
  };
  const out = formatCoachedEndSessionResponse(summary);

  // Human-readable header.
  assert.match(out, /^session_id: ses_test_123$/m);
  assert.match(out, /^status: ended$/m);
  assert.match(out, /^coachedAiAssistDetected: true$/m);
  assert.match(out, /^coachedAiAssistCount: 3$/m);

  // Post-mortem block is included verbatim.
  assert.ok(out.includes(postMortem), "response must include the post-mortem text");

  // Trailing summary JSON line is parseable and round-trips the fields.
  const summaryLine = out
    .split("\n")
    .find((l) => l.startsWith("summary: "));
  assert.ok(summaryLine, "response must include a `summary: <json>` line");
  const parsed = JSON.parse(summaryLine!.slice("summary: ".length));
  assert.equal(parsed.session_id, "ses_test_123");
  assert.equal(parsed.status, "ended");
  assert.equal(parsed.coachedAiAssistDetected, true);
  assert.equal(parsed.coachedAiAssistCount, 3);
  assert.equal(parsed.postMortem, postMortem);
});

test("formatCoachedEndSessionResponse: surfaces zero counts honestly when no AI-assist", () => {
  const postMortem = buildCoachedPostMortemText({
    questionTitle: "Q",
    attemptsTotal: 1,
    hintsUsed: 0,
    passedLatest: true,
    aiAssistDetected: false,
    aiAssistCount: 0,
  });
  const out = formatCoachedEndSessionResponse({
    session_id: "ses_x",
    status: "ended",
    coachedAiAssistDetected: false,
    coachedAiAssistCount: 0,
    coachedStallNudgeCount: 0,
    postMortem,
  });
  assert.match(out, /^coachedAiAssistDetected: false$/m);
  assert.match(out, /^coachedAiAssistCount: 0$/m);
  const summaryLine = out.split("\n").find((l) => l.startsWith("summary: "))!;
  const parsed = JSON.parse(summaryLine.slice("summary: ".length));
  assert.equal(parsed.coachedAiAssistDetected, false);
  assert.equal(parsed.coachedAiAssistCount, 0);
});
