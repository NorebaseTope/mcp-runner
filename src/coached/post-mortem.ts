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
}

export function buildCoachedPostMortemText(
  input: CoachedPostMortemInput,
): string {
  const {
    questionTitle,
    attemptsTotal,
    hintsUsed,
    passedLatest,
    aiAssistDetected,
    aiAssistCount,
    aiAssistSummaries = [],
    stallNudgeCount = 0,
  } = input;

  const outcomeNote =
    passedLatest === true
      ? "you passed it"
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
  } else {
    lines.push(
      "",
      "No AI-assist events detected — that was your work end to end. Good.",
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
    "",
    summary.postMortem,
    "",
    `summary: ${JSON.stringify(summary)}`,
  ].join("\n");
}
