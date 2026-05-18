// Task #1506 — Host-reasoning Sam in the runner-driven terminal coach.
//
// These tests pin the contract changes introduced by the task:
//   • Cadence directives default to `host_reasoning` so the runner
//     authors each Sam line via `agent.ask()`, with an env kill switch
//     (`PREPSAVANT_COACH_VERBATIM=1`) reverting to verbatim.
//   • `buildSystemPrompt` interpolates the question title + prompt so
//     `ask()` is always grounded.
//   • Free-text + `hint` user utterances are routed through
//     `agent.ask()` (with a "thinking…" status pre-emit).
//   • Offline mode (no usable coding-agent) surfaces a one-time
//     notice AND skips the `ask()` call entirely, falling back to the
//     directive's suggested wording.
//   • The dedupe guard collapses two near-identical emits fired
//     within a few seconds of each other.
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSystemPrompt,
  buildUserUtterancePrompt,
  handleUserUtterance,
  renderDirectiveAsSamLine,
  HOST_REASONING_PERSONA,
  OFFLINE_MODE_NOTICE,
} from "../coached/terminal-coach.js";
import { defaultCadenceMode } from "../coached/cadence-loop.js";
import { CoachStream } from "../coached/coach-stream.js";
import { ConversationMemory } from "../coached/conversation-memory.js";
import type { CadenceDirective } from "../coached/cadence-loop.js";
import type { CodingAgentAdapter } from "../coached/coding-agent.js";
import type { CoachedSessionState } from "../coached/session.js";

function fakeState(over: Partial<CoachedSessionState> = {}): CoachedSessionState {
  return {
    sessionId: "sess_t1506",
    questionId: "q_t1506",
    questionTitle: "Two Sum",
    questionPrompt: "Given nums and target, return indices of two numbers that sum to target.",
    startedAt: 0,
    targetDurationMs: 30 * 60_000,
    lastEditAt: 0,
    lastFailingTest: null,
    lastDiffSnippet: null,
    shapeLadderState: {},
    editedFilesSinceLastCheckIn: new Set<string>(),
    cadence: undefined as never,
    ...over,
  } as unknown as CoachedSessionState;
}

class StubAgent implements CodingAgentAdapter {
  id = "stub" as const;
  calls: Array<{ systemPrompt: string; userPrompt: string }> = [];
  reply = "Walk me through what you tried so far.";
  async ask(req: { systemPrompt: string; userPrompt: string }) {
    this.calls.push(req);
    return { text: this.reply };
  }
  async probe() {
    return { ok: true };
  }
}

class ThrowingAgent implements CodingAgentAdapter {
  id = "stub" as const;
  async ask(_req: { systemPrompt: string; userPrompt: string }): Promise<{ text: string }> {
    throw new Error("boom");
  }
  async probe() {
    return { ok: true };
  }
}

test("Task #1506 — defaultCadenceMode returns host_reasoning unless env kill switch is set", () => {
  assert.equal(defaultCadenceMode({}), "host_reasoning");
  assert.equal(
    defaultCadenceMode({ PREPSAVANT_COACH_VERBATIM: "1" }),
    "verbatim_relay",
  );
  // Anything other than "1" is ignored.
  assert.equal(
    defaultCadenceMode({ PREPSAVANT_COACH_VERBATIM: "true" }),
    "host_reasoning",
  );
});

test("Task #1506 — buildSystemPrompt grounds the persona in the question text", () => {
  const sp = buildSystemPrompt({
    questionTitle: "Two Sum",
    questionPrompt: "Find two numbers that sum to target.",
  });
  assert.ok(sp.startsWith(HOST_REASONING_PERSONA), "persona text leads the prompt");
  assert.match(sp, /Title: Two Sum/);
  assert.match(sp, /Find two numbers that sum to target\./);
  assert.match(sp, /Plain text only/);
});

test("Task #1506 — buildSystemPrompt omits question block when both fields empty", () => {
  const sp = buildSystemPrompt({ questionTitle: "", questionPrompt: "" });
  assert.ok(!sp.includes("Title:"));
  assert.ok(!sp.includes("Prompt:"));
});

test("Task #1506 — host_reasoning directive triggers agent.ask with the system prompt", async () => {
  const agent = new StubAgent();
  const stream = new CoachStream();
  const samLines: Array<{ text: string }> = [];
  stream.on("sam", (s) => samLines.push({ text: s.text }));
  const directive: CadenceDirective = {
    kind: "stall_nudge:default",
    action: "probe",
    reason: "stall",
    intent: "Probe what they tried.",
    constraints: ["Be short."],
    suggestedWording: "Take a beat.",
    mustBeVerbatim: false,
    mode: "host_reasoning",
    emittedAt: 1000,
    sessionId: "sess_t1506",
  };
  const sp = buildSystemPrompt({ questionTitle: "T", questionPrompt: "P" });
  await renderDirectiveAsSamLine(directive, stream, agent, {
    systemPrompt: sp,
    memory: new ConversationMemory({ enabled: false }),
  });
  assert.equal(agent.calls.length, 1);
  assert.equal(agent.calls[0]!.systemPrompt, sp);
  assert.equal(samLines.length, 1);
  assert.equal(samLines[0]!.text, agent.reply);
});

test("Task #1506 — host_reasoning falls back to suggestedWording when ask() throws", async () => {
  const agent = new ThrowingAgent();
  const stream = new CoachStream();
  const samLines: Array<{ text: string }> = [];
  stream.on("sam", (s) => samLines.push({ text: s.text }));
  const directive: CadenceDirective = {
    kind: "stall_nudge:default",
    action: "probe",
    reason: "stall",
    intent: "Probe.",
    constraints: [],
    suggestedWording: "Take a beat.",
    mustBeVerbatim: false,
    mode: "host_reasoning",
    emittedAt: 2000,
    sessionId: "sess_t1506",
  };
  await renderDirectiveAsSamLine(directive, stream, agent, {});
  assert.equal(samLines.length, 1);
  assert.equal(samLines[0]!.text, "Take a beat.");
});

test("Task #1506 — offline mode skips ask() and uses suggestedWording verbatim", async () => {
  const agent = new StubAgent();
  const stream = new CoachStream();
  const samLines: Array<{ text: string }> = [];
  stream.on("sam", (s) => samLines.push({ text: s.text }));
  const directive: CadenceDirective = {
    kind: "stall_nudge:default",
    action: "probe",
    reason: "stall",
    intent: "Probe.",
    constraints: [],
    suggestedWording: "Canned fallback line.",
    mustBeVerbatim: false,
    mode: "host_reasoning",
    emittedAt: 3000,
    sessionId: "sess_t1506",
  };
  await renderDirectiveAsSamLine(directive, stream, agent, { offlineMode: true });
  assert.equal(agent.calls.length, 0, "offline mode must not call ask()");
  assert.equal(samLines.length, 1);
  assert.equal(samLines[0]!.text, "Canned fallback line.");
});

test("Task #1506 — handleUserUtterance routes free text through ask() and emits a status beat first", async () => {
  const agent = new StubAgent();
  agent.reply = "What input shape are you working with?";
  const stream = new CoachStream();
  const events: Array<{ type: string; text: string }> = [];
  stream.on("status", (s) => events.push({ type: "status", text: s.text }));
  stream.on("sam", (s) => events.push({ type: "sam", text: s.text }));
  await handleUserUtterance(
    { text: "I'm stuck on the loop", emittedAt: 100 },
    {
      agent,
      stream,
      state: fakeState(),
      memory: new ConversationMemory({ enabled: false }),
      systemPrompt: "SP",
      now: () => 100,
    },
  );
  assert.equal(agent.calls.length, 1, "free text must hit ask()");
  assert.match(agent.calls[0]!.userPrompt, /Candidate just said/);
  assert.match(agent.calls[0]!.userPrompt, /I'm stuck on the loop/);
  assert.deepEqual(events.map((e) => e.type), ["status", "sam"]);
  assert.match(events[0]!.text, /thinking/i);
  assert.equal(events[1]!.text, agent.reply);
});

test("Task #1506 — handleUserUtterance(hint) reasons about hints (and never repeats rungs)", async () => {
  const agent = new StubAgent();
  agent.reply = "Look at how your loop terminates.";
  const stream = new CoachStream();
  await handleUserUtterance(
    { text: "/hint", command: "hint", emittedAt: 200 },
    {
      agent,
      stream,
      state: fakeState(),
      memory: new ConversationMemory({ enabled: false }),
      systemPrompt: "SP",
      now: () => 200,
    },
  );
  assert.equal(agent.calls.length, 1);
  assert.match(
    agent.calls[0]!.userPrompt,
    /hint/i,
    "hint command must surface in the ask() prompt",
  );
});

test("Task #1506 — buildUserUtterancePrompt embeds candidate text + command hint", () => {
  const p = buildUserUtterancePrompt("hello sam", { commandHint: "the candidate asked X" });
  assert.match(p, /Directive intent: the candidate asked X/);
  assert.match(p, /> hello sam/);
  assert.match(p, /one short Sam-voice line/);
});

test("Task #1506 — buildUserUtterancePrompt grounds the reply in memory + code-state evidence", () => {
  const mem = new ConversationMemory({ enabled: true });
  mem.pushSam("What input shape are you working with?", {
    hintShape: "off_by_one",
    hintRung: "r1",
  });
  mem.pushUser("an array of ints");
  const p = buildUserUtterancePrompt("any hint?", {
    commandHint: "candidate asked for a hint",
    memory: mem,
    lastFailingTestName: "twoSum_basic",
    diffSnippet: "- for (let i=0;i<n;i++)\n+ for (let i=0;i<=n;i++)",
    hintShape: "off_by_one",
  });
  // Memory block at the top.
  assert.match(p, /Recent context/);
  assert.match(p, /What input shape are you working with/);
  // Evidence block.
  assert.match(p, /Last failing test: twoSum_basic/);
  assert.match(p, /Diff snippet/);
  assert.match(p, /i<=n/);
  // Per-shape hints-already-tried guard.
  assert.match(p, /Hints already tried for this shape: r1/);
});

test("Task #1506 — handleUserUtterance threads memory + state evidence into the ask prompt", async () => {
  const agent = new StubAgent();
  const mem = new ConversationMemory({ enabled: true });
  mem.pushSam("Earlier line about loop bounds.", {
    hintShape: "off_by_one",
    hintRung: "r1",
  });
  const state = fakeState({
    lastFailingTest: "addsThree",
    lastDiffSnippet: "+ return a + b;",
    shapeLadderState: { off_by_one: "r1" } as never,
  });
  await handleUserUtterance(
    { text: "stuck", emittedAt: 1, command: "hint" },
    {
      agent,
      stream: new CoachStream(),
      state,
      memory: mem,
      systemPrompt: "SP",
      now: () => 1,
    },
  );
  assert.equal(agent.calls.length, 1);
  const userPrompt = agent.calls[0]!.userPrompt;
  assert.match(userPrompt, /Recent context/);
  assert.match(userPrompt, /Earlier line about loop bounds/);
  assert.match(userPrompt, /Last failing test: addsThree/);
  assert.match(userPrompt, /return a \+ b;/);
  assert.match(userPrompt, /Hints already tried for this shape: r1/);
});

test("Task #1506 — dedupe guard suppresses a second identical emit within the window", async () => {
  const agent = new StubAgent();
  agent.reply = "Walk me through what you tried.";
  const stream = new CoachStream();
  const samLines: string[] = [];
  stream.on("sam", (s) => samLines.push(s.text));
  const calls: Array<{ key: string; at: number }> = [];
  const seen = new Set<string>();
  const shouldSuppressEmit = (key: string, at: number) => {
    calls.push({ key, at });
    if (seen.has(key)) return true;
    seen.add(key);
    return false;
  };
  const directive: CadenceDirective = {
    kind: "stall_nudge:default",
    action: "probe",
    reason: "stall",
    intent: "Probe.",
    constraints: [],
    suggestedWording: null,
    mustBeVerbatim: false,
    mode: "host_reasoning",
    emittedAt: 5000,
    sessionId: "sess_t1506",
  };
  await renderDirectiveAsSamLine(directive, stream, agent, {
    systemPrompt: "SP",
    shouldSuppressEmit,
  });
  await renderDirectiveAsSamLine(
    { ...directive, emittedAt: 5500 },
    stream,
    agent,
    { systemPrompt: "SP", shouldSuppressEmit },
  );
  assert.equal(samLines.length, 1, "second identical emit must be suppressed");
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.key, calls[1]!.key);
});

test("Task #1506 — OFFLINE_MODE_NOTICE wording mentions cursor-agent + CURSOR_API_KEY", () => {
  assert.match(OFFLINE_MODE_NOTICE, /cursor-agent/i);
  assert.match(OFFLINE_MODE_NOTICE, /CURSOR_API_KEY/);
});

test("Task #1506 r2 — buildSystemPrompt honours a server-supplied persona override", () => {
  const override = "You are the test override persona.";
  const sp = buildSystemPrompt(
    { questionTitle: "T", questionPrompt: "P" },
    override,
  );
  assert.ok(sp.startsWith(override), "override persona must lead the prompt");
  assert.ok(!sp.includes(HOST_REASONING_PERSONA), "bundled persona must not also appear");
});
