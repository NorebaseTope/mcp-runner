// Sam-voice post-mortem text for the `coached_end_session` MCP tool.
//
// Mirrors the canonical `buildCoachedPostMortem` in
// @workspace/api-server's `sam-study-persona.ts`. The MCP runner is
// published as a standalone package and cannot import from the api-server,
// so the wording is duplicated here and pinned by tests on both sides
// (api-server's `practice-proactivity.test.ts` for the canonical helper,
// and `coached-post-mortem.test.ts` here for the runner copy).
//
// Honest about AI usage when it happened (the session is still scored
// and saved — we do not punish), and points at the next concrete thing
// to study.

export interface CoachedPostMortemInput {
  questionTitle: string;
  // Task #1163 — per-question review kind. Drives the chat-reviewed
  // wording so rubric-graded questions don't lie about "hidden tests"
  // running on a future submit. Optional for backward compat with
  // older callers/fixtures — defaults to "tests" (the historic
  // wording) when not provided.
  reviewKind?: "tests" | "rubric" | null;
  attemptsTotal: number;
  hintsUsed: number;
  passedLatest: boolean | undefined;
  aiAssistDetected: boolean;
  aiAssistCount: number;
  aiAssistSummaries?: string[];
  // Runner-driven stall nudges (Task #564). Number of times the local
  // stall watcher upgraded a server `stay_quiet` directive into a
  // Sam-voice probe because the user stopped editing files. Optional for
  // backward compat with older callers that don't track this yet.
  stallNudgeCount?: number;
  // Per-session chat-activity counters (Task #797). Used to distinguish
  // a "chat-reviewed" session — the candidate held a substantive chat
  // with Sam but never submitted code through the runner — from a truly
  // "abandoned" session where nothing happened at all. Both default to
  // 0 for backward compat with older callers that don't pass them.
  //   - checkInCount: total successful `coached_check_in` calls (DB
  //     column `practiceCheckInCount`).
  //   - pastedCodeOffers: total times the server returned a
  //     `submit_pasted_code` directive because the candidate pasted code
  //     in chat instead of editing the scratch file.
  checkInCount?: number;
  pastedCodeOffers?: number;
  checkInDiffSummaries?: Array<{
    filesChanged: string[];
    truncated: boolean;
  }>;
}

export function buildCoachedPostMortemText(
  input: CoachedPostMortemInput,
): string {
  const {
    questionTitle,
    reviewKind,
    attemptsTotal,
    hintsUsed,
    passedLatest,
    aiAssistDetected,
    aiAssistCount,
    aiAssistSummaries = [],
    stallNudgeCount = 0,
    checkInCount = 0,
    pastedCodeOffers = 0,
    checkInDiffSummaries = [],
  } = input;
  // Task #1163 — only swap to rubric wording when the question is
  // explicitly graded by rubric. Default ("tests" or unset) preserves
  // the historic "hidden tests" copy so older fixtures stay green.
  const isRubric = reviewKind === "rubric";

  // Outcome wording (Task #797 splits the previous attemptsTotal===0
  // bucket into two states: "chat-reviewed" when the candidate engaged
  // in chat without submitting, and "abandoned" — the existing "ended
  // without submitting" branch — when nothing happened at all). The
  // chat-reviewed branch carries its own explanatory paragraph below.
  const isChatReviewed =
    attemptsTotal === 0 && (checkInCount > 0 || pastedCodeOffers > 0);
  const outcomeNote =
    passedLatest === true
      ? "you passed it"
      : isChatReviewed
        ? isRubric
          ? "chat-reviewed, no rubric review ran"
          : "chat-reviewed, no hidden tests ran"
        : attemptsTotal === 0
          ? "you ended without submitting"
          : `you made ${attemptsTotal} attempt${attemptsTotal === 1 ? "" : "s"} and it did not pass`;

  const hintNote =
    hintsUsed === 0
      ? "no hints used"
      : `${hintsUsed} hint${hintsUsed === 1 ? "" : "s"} used`;

  const stallNudgeNote =
    stallNudgeCount > 0
      ? `, I broke the silence ${stallNudgeCount} time${stallNudgeCount === 1 ? "" : "s"} when you went quiet`
      : "";

  const lines = [
    `That session is closed. ${questionTitle} — ${outcomeNote}, ${hintNote}${stallNudgeNote}.`,
  ];

  // Chat-reviewed paragraph (Task #797). Names the engagement Sam saw,
  // says hidden tests did not run, and points at the explicit submit
  // path so the candidate knows how to score code next time. ≤120 words
  // total across the closed/heads-up/closer paragraphs.
  if (isChatReviewed) {
    const checkInPart =
      checkInCount > 0
        ? `${checkInCount} check-in${checkInCount === 1 ? "" : "s"}`
        : "";
    const pastePart =
      pastedCodeOffers > 0
        ? `${pastedCodeOffers} pasted-code offer${pastedCodeOffers === 1 ? "" : "s"} (none confirmed)`
        : "";
    const engagementNote = [checkInPart, pastePart]
      .filter((p) => p.length > 0)
      .join(" and ");
    lines.push(
      "",
      `We talked it through here in chat but nothing was submitted, so there is no graded result. I saw ${engagementNote} — that's engagement, not a score.`,
      isRubric
        ? `Next time, say "submit" or paste your final code and confirm — I will grade what you wrote against this question's rubric and give you a written review. Chatting through the approach is useful prep; it is not a submission.`
        : `Next time, say "submit" or paste your final code and confirm — that runs the hidden tests and gives you a real result. Chatting through the approach is useful prep; it is not a submission.`,
    );
  }

  if (aiAssistDetected && aiAssistCount > 0) {
    lines.push(
      "",
      `Heads up: I detected ${aiAssistCount} AI-assist event${aiAssistCount === 1 ? "" : "s"} during this session — the host model wrote or edited code on your behalf.`,
      "The session is still scored and saved. This is not a deduction, it's a flag so you know what you actually practiced versus what got generated.",
      "Next time, try the same problem without the assist and see what changes — that's where the muscle gets built.",
    );
    if (aiAssistSummaries.length > 0) {
      lines.push("", ...aiAssistSummaries.map((s) => `  - ${s}`));
    }
  } else if (!isChatReviewed) {
    // Skip the "no AI-assist" affirmation for chat-reviewed sessions —
    // there's nothing to affirm when no code ran. The chat-reviewed
    // paragraph above already does the honest framing.
    lines.push(
      "",
      "No AI-assist events detected — that was your work end to end. Good.",
    );
  }

  const allFiles = checkInDiffSummaries.flatMap((d) => d.filesChanged);
  const uniqueFiles = [...new Set(allFiles)];
  if (uniqueFiles.length > 0) {
    const anyTruncated = checkInDiffSummaries.some((d) => d.truncated);
    lines.push(
      "",
      `Files I reviewed during check-ins: ${uniqueFiles.join(", ")}${anyTruncated ? " (list trimmed)" : ""}.`,
    );
  }

  lines.push(
    "",
    "Ask me anything about this problem — the pattern, why your approach worked or didn't, the canonical solution, edge cases. I'll answer here via coached_ask.",
  );

  return lines.join("\n");
}

// Shape of the structured `summary` block appended to the
// `coached_end_session` tool response. Hosts and tests can parse the
// trailing `summary: <json>` line to read these fields directly without
// re-deriving them from the human-readable text.
export interface CoachedEndSessionSummary {
  session_id: string;
  status: "ended";
  coachedAiAssistDetected: boolean;
  coachedAiAssistCount: number;
  // Runner-driven stall nudges (Task #564). Always emitted (even as 0)
  // so host parsers can rely on a stable shape.
  coachedStallNudgeCount: number;
  // Per-session chat-activity counters (Task #797). Always emitted
  // (even as 0) so host parsers can read them without re-deriving from
  // the post-mortem prose. Mirror the per-session DB counters
  // `practiceCheckInCount` and `pastedCodeOffers`. The "chat-reviewed"
  // recap label is derived from these (`coachedCheckInCount > 0` or
  // `coachedPastedCodeOffers > 0` with zero attempts).
  coachedCheckInCount: number;
  coachedPastedCodeOffers: number;
  postMortem: string;
}

export function formatCoachedEndSessionResponse(
  summary: CoachedEndSessionSummary,
): string {
  return [
    `session_id: ${summary.session_id}`,
    `status: ${summary.status}`,
    `coachedAiAssistDetected: ${summary.coachedAiAssistDetected}`,
    `coachedAiAssistCount: ${summary.coachedAiAssistCount}`,
    `coachedStallNudgeCount: ${summary.coachedStallNudgeCount}`,
    `coachedCheckInCount: ${summary.coachedCheckInCount}`,
    `coachedPastedCodeOffers: ${summary.coachedPastedCodeOffers}`,
    "",
    summary.postMortem,
    "",
    `summary: ${JSON.stringify(summary)}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Session-memory rewrite directive (Task #800)
//
// At end-of-session the runner asks the host model (via MCP sampling) to
// rewrite the candidate's rolling session memory with what we just learned
// in this session, then PATCHes the result back to /profile/session-memory.
// Without a cap that body grows unbounded across sessions until it eats
// the kickoff prompt budget on the next session-start.
//
// `SESSION_MEMORY_MAX_CHARS` MUST stay aligned with the OpenAPI spec's
// `UpdateSessionMemoryBody.sessionMemory.maxLength` and the api-server's
// `SESSION_MEMORY_MAX_CHARS` constant — the server returns a 413 with
// `code: "session_memory_too_long"` if a rewritten body would exceed it.
//
// `SESSION_MEMORY_REWRITE_INSTRUCTION` is the cap-aware portion of the
// sampling prompt. Callers compose it with the previous memory and the
// current session's learnings; the wording deliberately tells the model
// to drop the OLDEST entries first so recent learnings stay intact.
export const SESSION_MEMORY_MAX_CHARS = 2000;

export const SESSION_MEMORY_REWRITE_INSTRUCTION = [
  `Rewrite the candidate's rolling session memory as Markdown.`,
  `Hard cap: keep the entire output to ${SESSION_MEMORY_MAX_CHARS} characters or fewer.`,
  `Prefer recent learnings over old ones — when you have to cut, drop the OLDEST entries first.`,
  `Use bullet-point form. Do not include any preamble, headers, or explanation outside the memory itself.`,
  `If you cannot fit everything within the cap, summarize the older bullets into a single line ("Earlier sessions: …") rather than truncating mid-sentence.`,
].join("\n");

// ---------------------------------------------------------------------------
// Session-memory rewrite helper (Task #804)
//
// The end-of-session rewrite is unit-tested through this pure helper —
// the live server.ts wraps it with real MCP `sample` and `SamApi.patch`
// dependencies, but tests inject fakes so we can pin the contract
// without spinning up a Server transport. The contract is:
//
//   - `sample` is called EXACTLY ONCE with `SESSION_MEMORY_REWRITE_INSTRUCTION`
//     as the system prompt and the rewrite prompt as the user prompt.
//   - When the host refuses sampling (`source === "runner_fallback"`)
//     PATCH is SKIPPED and a stderr line is logged. Pushing the runner
//     fallback would silently overwrite the candidate's memory with the
//     prior body or empty string.
//   - When the host returns whitespace, PATCH is SKIPPED.
//   - When the rewritten body still exceeds `SESSION_MEMORY_MAX_CHARS`,
//     PATCH is SKIPPED (we keep the prior memory unchanged rather than
//     hard-trimming and pushing a partial bullet that destroys context).
//   - When PATCH throws a 413 with `code: "session_memory_too_long"`,
//     it is caught and logged — never propagated to the post-mortem.
//   - Any other thrown error is caught and logged.

export interface SessionMemoryRewriteContext {
  priorMemory: string;
  questionTitle: string;
  attemptsTotal: number;
  hintsUsed: number;
  passedLatest: boolean | undefined;
  aiAssistDetected: boolean;
}

export interface SessionMemoryRewriteDeps {
  sample: (args: {
    systemPrompt: string;
    userPrompt: string;
  }) => Promise<{
    text: string;
    source: "runner_sampling" | "runner_fallback";
  }>;
  patch: (sessionMemory: string) => Promise<unknown>;
  log?: (line: string) => void;
}

export type SessionMemoryRewriteOutcome =
  | { kind: "patched"; bytes: number }
  | { kind: "skipped_no_change" }
  | { kind: "skipped_refused" }
  | { kind: "skipped_too_long"; bytes: number }
  | { kind: "skipped_too_long_server" }
  | { kind: "skipped_error"; error: unknown };

export function buildSessionMemoryRewritePrompt(
  input: SessionMemoryRewriteContext,
): string {
  const outcome =
    input.passedLatest === true
      ? "passed"
      : input.passedLatest === false
        ? "failed"
        : "incomplete";
  const lines = [
    SESSION_MEMORY_REWRITE_INSTRUCTION,
    "",
    `Hard cap: ${SESSION_MEMORY_MAX_CHARS} characters.`,
    "",
    "Previous session memory (Markdown, may be empty):",
    "---",
    input.priorMemory || "(empty)",
    "---",
    "",
    "This session's outcome:",
    `- Question: ${input.questionTitle}`,
    `- Attempts: ${input.attemptsTotal}`,
    `- Hints used: ${input.hintsUsed}`,
    `- Latest attempt: ${outcome}`,
    `- AI assist detected: ${input.aiAssistDetected ? "yes" : "no"}`,
    "",
    "Return ONLY the new memory body — Markdown, no fences, no preamble.",
  ];
  return lines.join("\n");
}

export async function rewriteSessionMemoryWithDeps(
  ctx: SessionMemoryRewriteContext,
  deps: SessionMemoryRewriteDeps,
): Promise<SessionMemoryRewriteOutcome> {
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  let sampling: { text: string; source: "runner_sampling" | "runner_fallback" };
  try {
    sampling = await deps.sample({
      systemPrompt: SESSION_MEMORY_REWRITE_INSTRUCTION,
      userPrompt: buildSessionMemoryRewritePrompt(ctx),
    });
  } catch (err) {
    log(
      `[coached_end_session] session memory rewrite skipped: sampling threw (${err instanceof Error ? err.message : String(err)})`,
    );
    return { kind: "skipped_error", error: err };
  }

  if (sampling.source === "runner_fallback") {
    log(
      "[coached_end_session] session memory rewrite skipped: host refused sampling",
    );
    return { kind: "skipped_refused" };
  }

  const next = sampling.text.trim();
  if (!next) {
    log(
      "[coached_end_session] session memory rewrite skipped: host returned empty body",
    );
    return { kind: "skipped_refused" };
  }
  if (next === ctx.priorMemory) {
    return { kind: "skipped_no_change" };
  }
  if (next.length > SESSION_MEMORY_MAX_CHARS) {
    log(
      `[coached_end_session] session memory rewrite skipped: host returned ${next.length} chars (cap ${SESSION_MEMORY_MAX_CHARS}); keeping prior memory`,
    );
    return { kind: "skipped_too_long", bytes: next.length };
  }

  try {
    await deps.patch(next);
    return { kind: "patched", bytes: next.length };
  } catch (err) {
    const status = (err as { status?: number } | null)?.status;
    const code = (err as { body?: { code?: string } } | null)?.body?.code;
    if (status === 413 || code === "session_memory_too_long") {
      log(
        "[coached_end_session] session memory rewrite skipped: server returned 413 session_memory_too_long; keeping prior memory",
      );
      return { kind: "skipped_too_long_server" };
    }
    log(
      `[coached_end_session] session memory rewrite skipped: PATCH failed (${err instanceof Error ? err.message : String(err)})`,
    );
    return { kind: "skipped_error", error: err };
  }
}
