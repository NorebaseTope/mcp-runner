// Task #1561 — Substantive first-hint path.
//
// Before any code activity (no diff, no scratch-file edits, no prior
// assistant turns), `/hint` and the first user utterance should NOT
// run through the standard "answer-this-question" prompt — the model
// has nothing concrete to ground on and replies tend to be generic
// (then fall through to the templated nudge).
//
// Instead, we compose an explicit "orient the candidate to the
// question" prompt: restate the problem in plain English and ask one
// targeted orienting question. Crucially, the prompt FORBIDS solving
// anything — a Sam reply that gives away the answer on the first hint
// is a worse failure than today's canned-line behavior.
//
// Pure module so the unit tests can exercise prompt composition + the
// zero-activity gate without standing up a real runner.

import type { ConversationMemory } from "./conversation-memory.js";
import type { CoachedSessionState } from "./session.js";

// Cap on the question prompt body so the system+user prompt envelope
// stays bounded on hosts with small context windows. Mirrors the cap
// used by `buildSystemPrompt`.
export const INTRO_HINT_PROMPT_CAP = 4 * 1024;

export interface ZeroCodeActivityInput {
  state: Pick<
    CoachedSessionState,
    | "lastEditAt"
    | "startedAt"
    | "editedFilesSinceLastCheckIn"
    | "lastDiffSnippet"
    | "attemptsTotal"
  >;
  memory?: Pick<ConversationMemory, "samTurnCount"> | null;
  // The readline handler bumps `state.lastEditAt = now()` BEFORE
  // calling handleUserUtterance, so by the time the gate runs the
  // edit timestamp has already moved forward. Callers in that path
  // must pass the pre-input `lastEditAt` snapshot here so the gate
  // sees the actual code-activity signal. Defaults to
  // `state.startedAt` so callers outside the readline path don't
  // need to think about it.
  lastEditAtBeforeUtterance?: number;
}

// Returns true when this session has seen NO meaningful code activity
// yet: no diff captured, no edited files since the watcher started, no
// submitted attempts, and the conversation memory holds no prior Sam
// turns. Gating on `samTurnCount` (not `size()`) is critical because
// the readline handler stores the current user line in memory BEFORE
// invoking `handleUserUtterance`, so `size()` is always ≥ 1 by the
// time this gate runs and would dead-code the intro-hint path.
export function hasZeroCodeActivity(input: ZeroCodeActivityInput): boolean {
  const { state, memory } = input;
  const hasDiff =
    typeof state.lastDiffSnippet === "string" &&
    state.lastDiffSnippet.trim().length > 0;
  if (hasDiff) return false;
  if (state.editedFilesSinceLastCheckIn.size > 0) return false;
  // If the caller provided a pre-utterance snapshot (readline path),
  // use THAT to detect prior edits — the current `state.lastEditAt`
  // has already been bumped for the utterance itself and would
  // otherwise mis-attribute the user's keystroke as code activity.
  const editProbe = input.lastEditAtBeforeUtterance ?? state.lastEditAt;
  if (editProbe > state.startedAt) return false;
  if ((state.attemptsTotal ?? 0) > 0) return false;
  if (memory && memory.samTurnCount() > 0) return false;
  return true;
}

export interface IntroHintPromptInput {
  questionTitle: string;
  questionPrompt: string;
  // Optional summary of the rubric (e.g. the first ~500 chars of the
  // rubric block). The runner doesn't currently parse the rubric off
  // the session pack, so callers pass `null` and we just omit the
  // slot — the model is told to orient on the prompt alone.
  rubricSummary?: string | null;
  utterance?: string | null;
}

// Compose the orient-the-candidate user prompt. The matching system
// prompt is the standard `HOST_REASONING_PERSONA`/`buildSystemPrompt`
// already constructed by `startTerminalCoach` — we don't override the
// persona here because Sam's voice is identical; only the directive
// shape changes.
export function composeIntroHintPrompt(input: IntroHintPromptInput): string {
  const title = (input.questionTitle ?? "").trim();
  const promptBody = (() => {
    const raw = (input.questionPrompt ?? "").trim();
    if (raw.length <= INTRO_HINT_PROMPT_CAP) return raw;
    return raw.slice(0, INTRO_HINT_PROMPT_CAP) + "\n…(truncated)";
  })();
  const rubric = (input.rubricSummary ?? "").trim();
  const utt = (input.utterance ?? "").trim();

  const lines: string[] = [];
  lines.push(
    "The candidate has not written any code yet and has just asked for an orienting nudge.",
  );
  lines.push(
    "Your job is to ORIENT them to the question — do NOT solve anything, do NOT suggest an algorithm, do NOT name a data structure.",
  );
  lines.push("");
  lines.push("Question they are working on:");
  if (title.length > 0) lines.push(`Title: ${title}`);
  if (promptBody.length > 0) {
    lines.push("Prompt:");
    for (const ln of promptBody.split("\n")) lines.push(`  ${ln}`);
  }
  if (rubric.length > 0) {
    lines.push("");
    lines.push("Rubric (what the candidate will be graded on):");
    for (const ln of rubric.split("\n")) lines.push(`  ${ln}`);
  }
  if (utt.length > 0) {
    lines.push("");
    lines.push("Candidate just said:");
    lines.push(`> ${utt.replace(/\n/g, "\n> ")}`);
  }
  lines.push("");
  lines.push("Reply with TWO short sentences in this exact shape:");
  lines.push(
    "  (a) Restate the core ask in 1-2 sentences in plain English so the candidate knows you've understood it.",
  );
  lines.push(
    "  (b) Ask ONE specific orienting question about what approach they're considering — e.g. how they'd frame the inputs, what shape they expect the answer to take, or what the brute-force version would look like.",
  );
  lines.push(
    "Hard constraint: do NOT solve, do NOT hint at an algorithm or data structure, do NOT write code. The candidate has not started — your job is only to help them START.",
  );
  return lines.join("\n");
}
