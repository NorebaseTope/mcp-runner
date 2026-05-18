// Task #1561 (review pass) — Integration test for the substantive
// first-hint path. Earlier review caught that the unit-level gate test
// passed but the real call order in `startTerminalCoach` dead-coded
// the intro path (the readline handler pushes the user line into
// `ConversationMemory` BEFORE invoking `handleUserUtterance`, so a
// `memory.size() > 0` gate would always be true). This test exercises
// `handleUserUtterance` directly with the SAME pre-conditions the
// readline handler establishes, and asserts the recorded mock-agent
// prompt is the intro-hint prompt — not the legacy
// `buildUserUtterancePrompt` shape.
import test from "node:test";
import assert from "node:assert/strict";
import { handleUserUtterance } from "../coached/terminal-coach.js";
import { ConversationMemory } from "../coached/conversation-memory.js";
import { startCoachedSession, endCoachedSession } from "../coached/session.js";
import type { CoachStream } from "../coached/coach-stream.js";
import type {
  CodingAgentAdapter,
  CodingAgentAsk,
  CodingAgentReply,
  CodingAgentProbeResult,
} from "../coached/coding-agent.js";

class RecordingAgent implements CodingAgentAdapter {
  readonly id = "recording";
  readonly calls: CodingAgentAsk[] = [];
  async probe(): Promise<CodingAgentProbeResult> {
    return { ok: true, version: "test" };
  }
  async ask(req: CodingAgentAsk): Promise<CodingAgentReply> {
    this.calls.push(req);
    return { text: "Restated. What inputs are you picturing?" };
  }
}

function makeStream(): CoachStream & {
  samEmits: Array<{ text: string; directiveKind?: string }>;
} {
  const samEmits: Array<{ text: string; directiveKind?: string }> = [];
  const stream = {
    emitStatus: () => {},
    emitUser: () => {},
    emitSam: (msg: { text: string; directiveKind?: string }) => {
      samEmits.push({ text: msg.text, directiveKind: msg.directiveKind });
    },
    endStream: () => {},
  } as unknown as CoachStream & {
    samEmits: Array<{ text: string; directiveKind?: string }>;
  };
  (stream as { samEmits: typeof samEmits }).samEmits = samEmits;
  return stream;
}

test("first /hint in a fresh session uses composeIntroHintPrompt and routes through agent.ask()", async () => {
  // Reproduce exactly what the readline handler in startTerminalCoach
  // does on the user's FIRST utterance:
  //   1. push the trimmed line into memory (memory.size() becomes 1).
  //   2. snapshot the pre-utterance lastEditAt.
  //   3. bump state.lastEditAt = now().
  //   4. invoke handleUserUtterance with the snapshot.
  const state = startCoachedSession({
    sessionId: "ses_test_intro_integration",
    questionId: "q_test",
    questionTitle: "Two Sum",
    questionPrompt:
      "Given an array of integers and a target, return the indices of two numbers that add up to the target.",
  });
  const memory = new ConversationMemory();
  memory.pushUser("/hint");
  const lastEditAtBeforeUtterance = state.lastEditAt;
  state.lastEditAt = state.lastEditAt + 1; // readline bump
  const agent = new RecordingAgent();
  const stream = makeStream();

  await handleUserUtterance(
    { text: "/hint", command: "hint", emittedAt: state.lastEditAt },
    {
      agent,
      stream,
      state,
      memory,
      systemPrompt: "test-system",
      now: () => state.lastEditAt,
      lastEditAtBeforeUtterance,
    },
  );

  assert.equal(agent.calls.length, 1, "agent.ask() must be invoked once");
  const userPrompt = agent.calls[0]!.userPrompt;
  // Intro-hint prompt shape — these markers come ONLY from
  // composeIntroHintPrompt, not from the legacy directive path.
  assert.match(
    userPrompt,
    /not written any code yet/,
    "intro-hint prompt must orient the candidate",
  );
  assert.match(
    userPrompt,
    /do NOT solve/,
    "intro-hint prompt must forbid solving",
  );
  assert.match(
    userPrompt,
    /Two Sum/,
    "intro-hint prompt must restate the question title",
  );
  assert.match(
    userPrompt,
    /indices of two numbers/,
    "intro-hint prompt must include the question body",
  );

  // And the emitted Sam line carries the `:intro_hint` discriminator
  // so downstream consumers (recap, debug surface) can tell it apart
  // from a regular hint reply.
  assert.equal(stream.samEmits.length, 1);
  assert.match(stream.samEmits[0]!.directiveKind ?? "", /intro_hint$/);

  endCoachedSession(state.sessionId);
});

test("once Sam has spoken once, subsequent /hint takes the legacy path", async () => {
  const state = startCoachedSession({
    sessionId: "ses_test_intro_followup",
    questionId: "q_test",
    questionTitle: "Two Sum",
    questionPrompt: "irrelevant body",
  });
  const memory = new ConversationMemory();
  // Simulate that Sam has already replied once on a previous turn.
  memory.pushSam("Earlier reply.");
  memory.pushUser("/hint");
  const lastEditAtBeforeUtterance = state.lastEditAt;
  state.lastEditAt = state.lastEditAt + 1;
  const agent = new RecordingAgent();
  const stream = makeStream();

  await handleUserUtterance(
    { text: "/hint", command: "hint", emittedAt: state.lastEditAt },
    {
      agent,
      stream,
      state,
      memory,
      systemPrompt: "test-system",
      now: () => state.lastEditAt,
      lastEditAtBeforeUtterance,
    },
  );

  assert.equal(agent.calls.length, 1);
  const userPrompt = agent.calls[0]!.userPrompt;
  // The legacy directive-shaped prompt does NOT contain the intro-hint
  // markers, so we assert their absence.
  assert.doesNotMatch(userPrompt, /not written any code yet/);
  assert.doesNotMatch(userPrompt, /do NOT solve/);

  endCoachedSession(state.sessionId);
});
