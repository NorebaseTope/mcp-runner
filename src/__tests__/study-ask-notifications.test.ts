// Locks the IDE typing-indicator behavior for the `study_ask` MCP tool
// (task-570). The server-side test in
// artifacts/api-server/src/__tests__/runnerStudyConversationStream.test.ts
// pins the wire-level `thinking` event; this file pins how the runner
// turns that event (plus deltas / errors) into MCP notifications hosts
// can render as a "Sam is thinking…" affordance.
//
// We test the extracted helper directly so we don't have to stand up an
// McpServer + stdio transport just to assert notification ordering.

import test from "node:test";
import assert from "node:assert/strict";
import {
  consumeStudyAskStream,
  STUDY_THINKING_TEXT,
} from "../study/stream-consumer.js";
import type { StudyStreamEvent } from "../api.js";

async function* fromEvents(
  events: StudyStreamEvent[],
): AsyncGenerator<StudyStreamEvent> {
  for (const e of events) yield e;
}

function captureNotify(): {
  calls: Array<Record<string, unknown>>;
  notify: (data: Record<string, unknown>) => Promise<void>;
} {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    notify: async (data) => {
      calls.push(data);
    },
  };
}

// ---------------------------------------------------------------------------
// Happy path: thinking → thinking_done → deltas, in exactly this order.
// ---------------------------------------------------------------------------
test("emits a single thinking notification before the first delta and a single thinking_done notification right before it", async () => {
  const { calls, notify } = captureNotify();
  const result = await consumeStudyAskStream(
    fromEvents([
      { type: "user_persisted", message: { id: "u1" } as never },
      { type: "thinking" },
      { type: "delta", text: "Hello" },
      { type: "delta", text: " world" },
      { type: "complete", message: { id: "s1" } as never },
    ]),
    notify,
  );

  assert.equal(result.full, "Hello world");
  assert.equal(result.error, null);

  const thinking = calls.filter((c) => c["status"] === "thinking");
  const thinkingDone = calls.filter((c) => c["status"] === "thinking_done");
  const deltas = calls.filter((c) => typeof c["delta"] === "string");

  assert.equal(thinking.length, 1, "exactly one thinking notification");
  assert.equal(thinking[0]!["text"], STUDY_THINKING_TEXT);
  assert.equal(thinkingDone.length, 1, "exactly one thinking_done notification");
  assert.equal(deltas.length, 2);

  // Strict ordering: thinking → thinking_done → first delta. The
  // thinking_done call must land immediately before the first delta so
  // hosts can swap the indicator out for real Sam text without flicker.
  const thinkingIdx = calls.findIndex((c) => c["status"] === "thinking");
  const thinkingDoneIdx = calls.findIndex((c) => c["status"] === "thinking_done");
  const firstDeltaIdx = calls.findIndex(
    (c) => typeof c["delta"] === "string",
  );
  assert.ok(thinkingIdx >= 0 && thinkingIdx < thinkingDoneIdx);
  assert.equal(
    firstDeltaIdx,
    thinkingDoneIdx + 1,
    "thinking_done must fire immediately before the first delta",
  );
});

// ---------------------------------------------------------------------------
// Error before any delta: indicator MUST be cleared so hosts that key
// their UI off status notifications don't leave a stale "thinking" bubble.
// ---------------------------------------------------------------------------
test("clears the thinking indicator when the stream errors before any delta lands", async () => {
  const { calls, notify } = captureNotify();
  const result = await consumeStudyAskStream(
    fromEvents([
      { type: "user_persisted", message: { id: "u1" } as never },
      { type: "thinking" },
      { type: "error", error: "model down" },
    ]),
    notify,
  );

  assert.equal(result.full, "");
  assert.equal(result.error, "model down");

  const thinking = calls.filter((c) => c["status"] === "thinking");
  const thinkingDone = calls.filter((c) => c["status"] === "thinking_done");
  const deltas = calls.filter((c) => typeof c["delta"] === "string");

  assert.equal(thinking.length, 1);
  assert.equal(
    thinkingDone.length,
    1,
    "thinking_done must fire on early error so hosts clear the indicator",
  );
  assert.equal(deltas.length, 0);
});

// ---------------------------------------------------------------------------
// Error mid-stream (after deltas have started): no extra thinking_done
// fires — the first delta already cleared the indicator.
// ---------------------------------------------------------------------------
test("does not double-fire thinking_done when the stream errors after a delta", async () => {
  const { calls, notify } = captureNotify();
  const result = await consumeStudyAskStream(
    fromEvents([
      { type: "user_persisted", message: { id: "u1" } as never },
      { type: "thinking" },
      { type: "delta", text: "partial" },
      { type: "error", error: "stream cut" },
    ]),
    notify,
  );

  assert.equal(result.full, "partial");
  assert.equal(result.error, "stream cut");

  const thinkingDone = calls.filter((c) => c["status"] === "thinking_done");
  assert.equal(
    thinkingDone.length,
    1,
    "thinking_done fires exactly once — at the first delta",
  );
});
