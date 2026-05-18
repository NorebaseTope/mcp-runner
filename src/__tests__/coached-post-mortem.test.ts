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

// Task #797 — chat-reviewed vs runner-scored vs abandoned. The previous
// "ended without submitting" bucket conflated two very different
// session shapes: a candidate who held a long substantive chat with Sam
// (pasted code, talked tradeoffs, asked questions) but never submitted
// through the runner, and a candidate who just walked away without
// engaging at all. The recap now distinguishes them via per-session
// counters (`checkInCount`, `pastedCodeOffers`) so the wording matches
// what actually happened.
test("buildCoachedPostMortemText: chat-reviewed branch fires when attemptsTotal=0 and check-ins > 0 (Task #797)", () => {
  const text = buildCoachedPostMortemText({
    questionTitle: "Two Sum",
    attemptsTotal: 0,
    hintsUsed: 0,
    passedLatest: undefined,
    aiAssistDetected: false,
    aiAssistCount: 0,
    checkInCount: 8,
  });
  // The opener swaps from "ended without submitting" → "chat-reviewed".
  assert.match(text, /chat-reviewed, no hidden tests ran/);
  assert.doesNotMatch(text, /you ended without submitting/);
  // The new explanatory paragraph names the engagement Sam saw.
  assert.match(text, /8 check-ins/);
  assert.match(text, /that's engagement, not a score/);
  // And points at the explicit submit path so the candidate knows how
  // to score code next time.
  assert.match(text, /Next time, say "submit" or paste your final code/);
  assert.match(text, /runs the hidden tests/);
  // Should NOT raise the "your work end to end" affirmation — there's
  // no work to affirm when no code ran.
  assert.doesNotMatch(text, /your work end to end/);
});

test("buildCoachedPostMortemText: chat-reviewed branch also fires on pastedCodeOffers > 0 (Task #797)", () => {
  const text = buildCoachedPostMortemText({
    questionTitle: "Two Sum",
    attemptsTotal: 0,
    hintsUsed: 0,
    passedLatest: undefined,
    aiAssistDetected: false,
    aiAssistCount: 0,
    pastedCodeOffers: 1,
  });
  assert.match(text, /chat-reviewed, no hidden tests ran/);
  assert.match(text, /1 pasted-code offer \(none confirmed\)/);
  assert.doesNotMatch(text, /you ended without submitting/);
});

test("buildCoachedPostMortemText: chat-reviewed lists both counters when both > 0 (Task #797)", () => {
  const text = buildCoachedPostMortemText({
    questionTitle: "Two Sum",
    attemptsTotal: 0,
    hintsUsed: 0,
    passedLatest: undefined,
    aiAssistDetected: false,
    aiAssistCount: 0,
    checkInCount: 5,
    pastedCodeOffers: 2,
  });
  assert.match(text, /5 check-ins and 2 pasted-code offers \(none confirmed\)/);
});

test("buildCoachedPostMortemText: abandoned branch keeps existing wording when both counters are zero (Task #797)", () => {
  const text = buildCoachedPostMortemText({
    questionTitle: "Two Sum",
    attemptsTotal: 0,
    hintsUsed: 0,
    passedLatest: undefined,
    aiAssistDetected: false,
    aiAssistCount: 0,
    checkInCount: 0,
    pastedCodeOffers: 0,
  });
  assert.match(text, /you ended without submitting/);
  assert.doesNotMatch(text, /chat-reviewed/);
  assert.doesNotMatch(text, /Next time, say "submit"/);
});

test("buildCoachedPostMortemText: runner-scored branch is unchanged for attemptsTotal > 0 (Task #797)", () => {
  // Even when the candidate used coached_check_in heavily, a session
  // with attempts is "runner-scored", not chat-reviewed — the recap
  // wording must reflect the attempts, not the chat engagement.
  const text = buildCoachedPostMortemText({
    questionTitle: "Two Sum",
    attemptsTotal: 2,
    hintsUsed: 1,
    passedLatest: false,
    aiAssistDetected: false,
    aiAssistCount: 0,
    checkInCount: 8,
    pastedCodeOffers: 0,
  });
  assert.match(text, /you made 2 attempts and it did not pass/);
  assert.doesNotMatch(text, /chat-reviewed/);
});

// Task #797 — pin the exact chat-reviewed wording so future edits to
// the brief have to be intentional. Reviewer-specified copy: ≤120
// words across all three paragraphs, names the engagement counters,
// says no hidden tests ran, points at the explicit submit path.
test("buildCoachedPostMortemText: chat-reviewed wording snapshot (Task #797)", () => {
  const text = buildCoachedPostMortemText({
    questionTitle: "Two Sum",
    attemptsTotal: 0,
    hintsUsed: 0,
    passedLatest: undefined,
    aiAssistDetected: false,
    aiAssistCount: 0,
    checkInCount: 8,
    pastedCodeOffers: 0,
  });
  const expected = [
    "That session is closed. Two Sum — chat-reviewed, no hidden tests ran, no hints used.",
    "",
    "We talked it through here in chat but nothing was submitted, so there is no graded result. I saw 8 check-ins — that's engagement, not a score.",
    `Next time, say "submit" or paste your final code and confirm — that runs the hidden tests and gives you a real result. Chatting through the approach is useful prep; it is not a submission.`,
    "",
    "Ask me anything about this problem — the pattern, why your approach worked or didn't, the canonical solution, edge cases. I'll answer here via coached_ask.",
  ].join("\n");
  assert.equal(text, expected);
  // ≤120 words across the whole post-mortem.
  const wordCount = text.split(/\s+/).filter((w) => w.length > 0).length;
  assert.ok(
    wordCount <= 120,
    `chat-reviewed post-mortem must stay ≤120 words; got ${wordCount}`,
  );
});

// Task #1163 — runner-side post-mortem must mirror the api-server's
// reviewKind-aware wording so chat-reviewed sessions for rubric-graded
// questions don't claim hidden tests would have run on a future
// submit. Default behaviour (reviewKind unset / "tests") keeps the
// historic "hidden tests" copy — pinned by the existing snapshot test
// above.
test("buildCoachedPostMortemText: chat-reviewed swaps to rubric wording when reviewKind is 'rubric' (Task #1163)", () => {
  const text = buildCoachedPostMortemText({
    questionTitle: "Design URL Shortener",
    reviewKind: "rubric",
    attemptsTotal: 0,
    hintsUsed: 0,
    passedLatest: undefined,
    aiAssistDetected: false,
    aiAssistCount: 0,
    checkInCount: 5,
  });
  assert.match(text, /chat-reviewed, no rubric review ran/);
  assert.doesNotMatch(text, /hidden tests/);
  assert.match(
    text,
    /grade what you wrote against this question's rubric and give you a written review/,
  );
});

test("buildCoachedPostMortemText: chat-reviewed keeps 'hidden tests' wording when reviewKind is 'tests' (Task #1163)", () => {
  const text = buildCoachedPostMortemText({
    questionTitle: "Two Sum",
    reviewKind: "tests",
    attemptsTotal: 0,
    hintsUsed: 0,
    passedLatest: undefined,
    aiAssistDetected: false,
    aiAssistCount: 0,
    checkInCount: 3,
  });
  assert.match(text, /chat-reviewed, no hidden tests ran/);
  assert.match(text, /runs the hidden tests/);
  assert.doesNotMatch(text, /rubric/i);
});

test("buildCoachedPostMortemText: rubric reviewKind has no effect on runner-scored sessions (Task #1163)", () => {
  // The reviewKind swap is scoped to the chat-reviewed branch — a
  // session with attempts already has a real graded outcome, so the
  // recap stays attempt-driven regardless of how submit grades.
  const text = buildCoachedPostMortemText({
    questionTitle: "Design URL Shortener",
    reviewKind: "rubric",
    attemptsTotal: 2,
    hintsUsed: 0,
    passedLatest: false,
    aiAssistDetected: false,
    aiAssistCount: 0,
  });
  assert.doesNotMatch(text, /rubric review ran/);
  assert.doesNotMatch(text, /hidden tests/);
  assert.match(text, /you made 2 attempts and it did not pass/);
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
    // Task #797 — chat-activity counters are part of the structured
    // summary contract. Zero here because this fixture exercises a
    // runner-scored session (attemptsTotal: 2), not a chat-reviewed
    // one.
    coachedCheckInCount: 0,
    coachedPastedCodeOffers: 0,
    postMortem,
  };
  const out = formatCoachedEndSessionResponse(summary);

  // Human-readable header.
  assert.match(out, /^session_id: ses_test_123$/m);
  assert.match(out, /^status: ended$/m);
  assert.match(out, /^coachedAiAssistDetected: true$/m);
  assert.match(out, /^coachedAiAssistCount: 3$/m);
  // Task #797 — header must surface the new chat-activity counters
  // alongside the existing AI-assist / stall-nudge counters so host
  // parsers see a stable shape regardless of the recap label.
  assert.match(out, /^coachedCheckInCount: 0$/m);
  assert.match(out, /^coachedPastedCodeOffers: 0$/m);

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
  assert.equal(parsed.coachedCheckInCount, 0);
  assert.equal(parsed.coachedPastedCodeOffers, 0);
  assert.equal(parsed.postMortem, postMortem);
});

// Task #797 — chat-reviewed round-trip. When the session ends with
// zero attempts but real chat engagement, the structured summary must
// surface the actual counters (not zeros) so hosts can render the
// chat-reviewed label without parsing prose.
test("formatCoachedEndSessionResponse: round-trips chat-activity counters for a chat-reviewed session (Task #797)", () => {
  const postMortem = buildCoachedPostMortemText({
    questionTitle: "Two Sum",
    attemptsTotal: 0,
    hintsUsed: 0,
    passedLatest: undefined,
    aiAssistDetected: false,
    aiAssistCount: 0,
    checkInCount: 8,
    pastedCodeOffers: 1,
  });
  const out = formatCoachedEndSessionResponse({
    session_id: "ses_chat_reviewed",
    status: "ended",
    coachedAiAssistDetected: false,
    coachedAiAssistCount: 0,
    coachedStallNudgeCount: 0,
    coachedCheckInCount: 8,
    coachedPastedCodeOffers: 1,
    postMortem,
  });
  assert.match(out, /^coachedCheckInCount: 8$/m);
  assert.match(out, /^coachedPastedCodeOffers: 1$/m);
  const parsed = JSON.parse(
    out.split("\n").find((l) => l.startsWith("summary: "))!.slice("summary: ".length),
  );
  assert.equal(parsed.coachedCheckInCount, 8);
  assert.equal(parsed.coachedPastedCodeOffers, 1);
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
    // Task #797 — chat-activity counters are part of the structured
    // summary contract; zero here for an honest no-AI-assist
    // runner-scored session.
    coachedCheckInCount: 0,
    coachedPastedCodeOffers: 0,
    postMortem,
  });
  assert.match(out, /^coachedAiAssistDetected: false$/m);
  assert.match(out, /^coachedAiAssistCount: 0$/m);
  const summaryLine = out.split("\n").find((l) => l.startsWith("summary: "))!;
  const parsed = JSON.parse(summaryLine.slice("summary: ".length));
  assert.equal(parsed.coachedAiAssistDetected, false);
  assert.equal(parsed.coachedAiAssistCount, 0);
});

test("buildCoachedPostMortemText: includes file names when checkInDiffSummaries are present (Task #877)", () => {
  const text = buildCoachedPostMortemText({
    questionTitle: "Two Sum",
    attemptsTotal: 2,
    hintsUsed: 0,
    passedLatest: true,
    aiAssistDetected: false,
    aiAssistCount: 0,
    checkInDiffSummaries: [
      { filesChanged: ["solution.py", "helpers.py"], truncated: false },
      { filesChanged: ["solution.py", "test_solution.py"], truncated: false },
    ],
  });
  assert.match(text, /Files I reviewed during check-ins:/);
  assert.match(text, /solution\.py/);
  assert.match(text, /helpers\.py/);
  assert.match(text, /test_solution\.py/);
  assert.doesNotMatch(text, /\(list trimmed\)/);
});

test("buildCoachedPostMortemText: deduplicates file names across multiple check-ins (Task #877)", () => {
  const text = buildCoachedPostMortemText({
    questionTitle: "Two Sum",
    attemptsTotal: 1,
    hintsUsed: 0,
    passedLatest: true,
    aiAssistDetected: false,
    aiAssistCount: 0,
    checkInDiffSummaries: [
      { filesChanged: ["solution.py"], truncated: false },
      { filesChanged: ["solution.py"], truncated: false },
    ],
  });
  const matches = text.match(/solution\.py/g);
  assert.equal(matches?.length, 1, "file name should appear exactly once");
});

test("buildCoachedPostMortemText: shows trimmed indicator when any diff was truncated (Task #877)", () => {
  const text = buildCoachedPostMortemText({
    questionTitle: "Two Sum",
    attemptsTotal: 1,
    hintsUsed: 0,
    passedLatest: true,
    aiAssistDetected: false,
    aiAssistCount: 0,
    checkInDiffSummaries: [
      { filesChanged: ["solution.py"], truncated: true },
    ],
  });
  assert.match(text, /\(list trimmed\)/);
});

test("buildCoachedPostMortemText: omits file section when no diff summaries present (Task #877)", () => {
  const text = buildCoachedPostMortemText({
    questionTitle: "Two Sum",
    attemptsTotal: 1,
    hintsUsed: 0,
    passedLatest: true,
    aiAssistDetected: false,
    aiAssistCount: 0,
  });
  assert.doesNotMatch(text, /Files I reviewed/);
});

test("buildCoachedPostMortemText: omits file section when diff summaries have empty file lists (Task #877)", () => {
  const text = buildCoachedPostMortemText({
    questionTitle: "Two Sum",
    attemptsTotal: 1,
    hintsUsed: 0,
    passedLatest: true,
    aiAssistDetected: false,
    aiAssistCount: 0,
    checkInDiffSummaries: [
      { filesChanged: [], truncated: false },
    ],
  });
  assert.doesNotMatch(text, /Files I reviewed/);
});
