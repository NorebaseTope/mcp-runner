// Task #1412 — Conversation memory: ring buffer, sanitization on push,
// opt-out env var, and the per-shape "hints already offered" guard
// surfaced through `buildAskPrompt`.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  ConversationMemory,
  MEMORY_MAX_TURNS,
} from "../coached/conversation-memory.js";
import { buildAskPrompt } from "../coached/terminal-coach.js";
import type { CadenceDirective } from "../coached/cadence-loop.js";

function directive(over: Partial<CadenceDirective> = {}): CadenceDirective {
  return {
    kind: "hint_offer:spinning:focused",
    action: "hint_offer",
    reason: "x",
    intent: "Probe data structure choice",
    constraints: ["Stay in Sam's coach voice."],
    suggestedWording: null,
    mustBeVerbatim: false,
    mode: "host_reasoning",
    emittedAt: 0,
    sessionId: "sess_a",
    hintShape: "spinning",
    hintRung: "focused",
    ...over,
  };
}

test("Task #1412 — ring buffer: push 10 entries, only the last MEMORY_MAX_TURNS survive", () => {
  const mem = new ConversationMemory();
  for (let i = 0; i < 10; i += 1) {
    if (i % 2 === 0) mem.pushSam(`coach line number ${i}`);
    else mem.pushUser(`reply number ${i}`);
  }
  assert.equal(mem.size(), MEMORY_MAX_TURNS);
  const block = mem.renderRecentContextBlock();
  // The first 4 entries (i=0..3) must have been evicted.
  assert.ok(!block.includes("number 0"));
  assert.ok(!block.includes("number 1"));
  assert.ok(!block.includes("number 2"));
  assert.ok(!block.includes("number 3"));
  // The most recent 6 (i=4..9) must remain in order.
  assert.ok(block.includes("Sam: coach line number 4"));
  assert.ok(block.includes("User: reply number 9"));
  assert.ok(block.indexOf("number 4") < block.indexOf("number 9"));
});

test("Task #1412 — pushSam stores the SANITIZED Sam line, never raw model output", () => {
  const mem = new ConversationMemory();
  // Raw model reply with markdown fence + "Sam:" prefix + smart quotes.
  const raw = '"Sam: Try this: ```ts\nconst x=1;\n``` "';
  mem.pushSam(raw);
  const block = mem.renderRecentContextBlock();
  assert.ok(!block.includes("```"), `expected no code fence, got: ${block}`);
  assert.ok(!/Sam:\s*Sam:/.test(block), "expected the 'Sam:' prefix to be stripped");
  assert.ok(!block.includes("“") && !block.includes("”"), "expected no smart quotes");
  // The renderer's tag is still "Sam" — the prefix on the stored line
  // is the one we add at render time, not a leftover from the raw text.
  assert.match(block, /Sam: Try this:/);
});

test("Task #1412 — opt-out: disabled memory produces a prompt with NO `Recent context:` block", () => {
  const mem = new ConversationMemory({ enabled: false });
  // Pushes are no-ops when disabled.
  mem.pushSam("sam said something");
  mem.pushUser("user replied");
  assert.equal(mem.size(), 0);
  assert.equal(mem.renderRecentContextBlock(), "");

  const prompt = buildAskPrompt(directive(), { memory: mem });
  assert.ok(
    !prompt.includes("Recent context:"),
    `expected no Recent context: block, got:\n${prompt}`,
  );
  // The directive intent block is still present.
  assert.match(prompt, /Directive intent: Probe data structure choice/);
});

test("Task #1412 — buildAskPrompt prepends Recent context block + per-shape hints-already-tried guard", () => {
  const mem = new ConversationMemory();
  // Pretend Sam already offered the `focused` rung for the spinning
  // shape last tick, and the user typed back declining.
  mem.pushSam("Have you considered using a hash map for the lookups?", {
    hintShape: "spinning",
    hintRung: "focused",
  });
  mem.pushUser("yeah I tried that, it doesn't work for the windowed case");

  // Sanity: the offered-hint set tracks the (shape, rung) pair.
  assert.ok(mem.hasOfferedHint("spinning", "focused"));
  assert.deepEqual(mem.offeredRungsFor("spinning"), ["focused"]);

  const prompt = buildAskPrompt(directive(), { memory: mem });
  // 1) Recent context block is prepended, before the directive intent.
  const recentIdx = prompt.indexOf("Recent context:");
  const intentIdx = prompt.indexOf("Directive intent:");
  assert.ok(recentIdx >= 0, "expected Recent context: block in prompt");
  assert.ok(recentIdx < intentIdx, "Recent context: must come before Directive intent");
  assert.match(prompt, /Sam: Have you considered using a hash map/);
  assert.match(prompt, /User: yeah I tried that/);
  // 2) The hints-already-tried guard suppresses repeating the same rung.
  assert.match(
    prompt,
    /Hints already tried for this shape: focused — do not repeat them/,
  );
});

test("Task #1412 — buildAskPrompt surfaces the contract-promised evidence (failing test + diff snippet, capped at 4 KB)", () => {
  const big = "+".repeat(8 * 1024);
  const prompt = buildAskPrompt(directive(), {
    lastFailingTestName: "two-sum/handles_empty_input",
    diffSnippet: big,
  });
  assert.match(prompt, /Last failing test: two-sum\/handles_empty_input/);
  assert.match(prompt, /Diff snippet \(truncated\):/);
  assert.match(prompt, /…\(truncated\)/);
  // The body of the diff section must not exceed the 4 KB cap +
  // truncation marker (with some slack for the per-line indentation).
  const diffStart = prompt.indexOf("Diff snippet (truncated):");
  const diffSection = prompt.slice(diffStart);
  assert.ok(
    diffSection.length < 4 * 1024 + 512,
    `diff section ${diffSection.length} exceeded soft cap`,
  );
});

test("Task #1412 — pushSam without a hintRung does not poison the offered-hints set", () => {
  const mem = new ConversationMemory();
  // A free-text Sam line with no hint metadata — must not register
  // an entry in the offered-hints map at all.
  mem.pushSam("Take a moment to think about the shape of the input.");
  assert.deepEqual(mem.offeredRungsFor("dataStructureChoice"), []);
  assert.equal(mem.hasOfferedHint("dataStructureChoice", "focused"), false);
});

test("Task #1412 — long entries are clipped to the per-turn char cap", () => {
  const mem = new ConversationMemory({ maxCharsPerTurn: 40 });
  mem.pushUser("a".repeat(200));
  const block = mem.renderRecentContextBlock();
  // The rendered line is "  User: <clipped>" — assert the user text
  // portion stays under the cap (with the ellipsis suffix).
  const userLine = block.split("\n").find((l) => l.startsWith("  User:"))!;
  const payload = userLine.replace(/^\s*User:\s*/, "");
  assert.ok(payload.length <= 40, `expected clip to <= 40, got ${payload.length}`);
  assert.ok(payload.endsWith("…"));
});

// Task #1412 — integration test: renderDirectiveAsSamLine forwards
// `state.lastFailingTest` and `state.lastDiffSnippet` into the prompt the
// coding agent receives. Captures the userPrompt via a stub adapter so a
// future refactor can't silently drop the wiring without flipping a red.
test("Task #1412 — renderDirectiveAsSamLine threads lastFailingTest + diffSnippet from state into the agent prompt", async () => {
  const { renderDirectiveAsSamLine } = await import(
    "../coached/terminal-coach.js"
  );
  const { startCoachedSession } = await import("../coached/session.js");
  const captured: Array<{ systemPrompt: string; userPrompt: string }> = [];
  const stubAgent = {
    id: "stub" as const,
    async probe() {
      return { ok: true as const, version: "stub-1" };
    },
    async ask(req: { systemPrompt: string; userPrompt: string }) {
      captured.push(req);
      return { text: "Stub Sam reply." };
    },
  };
  const stream = {
    emitSam: () => {},
    emitRecap: () => {},
    emitInternal: () => {},
    done: () => {},
  } as unknown as import("../coached/coach-stream.js").CoachStream;
  // Pin workspaceDir to an empty tmpdir so fs.watch() doesn't recursively
  // walk the runner's own package tree (process.cwd() during tests) and
  // hold the event loop open after the test completes.
  const tmpWorkspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "prepsavant-t1412-"),
  );
  const state = startCoachedSession({
    sessionId: "sess_render_test_t1412",
    questionId: "q_render_test_t1412",
    questionTitle: "Two Sum",
    questionPrompt: "Return indices of two numbers that add up to target.",
    workspaceDir: tmpWorkspace,
  });
  state.lastFailingTest = "two_sum/handles_empty_input";
  state.lastDiffSnippet =
    "diff --git a/sol.ts b/sol.ts\n@@ -1,2 +1,3 @@\n+const x = 1;\n";

  const memory = new ConversationMemory();
  memory.pushUser("I tried a hash map but it broke on empties.");

  try {
    await renderDirectiveAsSamLine(directive(), stream, stubAgent, {
      state,
      memory,
    });

    assert.equal(captured.length, 1);
    const prompt = captured[0]!.userPrompt;
    assert.match(prompt, /Last failing test: two_sum\/handles_empty_input/);
    assert.match(prompt, /Diff snippet/);
    assert.match(prompt, /diff --git a\/sol\.ts/);
    assert.match(prompt, /Recent context:/);
    assert.match(prompt, /User: I tried a hash map/);
  } finally {
    // Close the fs.watch handle and remove the tmpdir so the test
    // process exits cleanly (otherwise the watcher keeps the event
    // loop alive even with .unref() on some Linux/Node combos).
    try {
      state.watcher?.close();
    } catch {
      // best-effort
    }
    try {
      fs.rmSync(tmpWorkspace, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});
