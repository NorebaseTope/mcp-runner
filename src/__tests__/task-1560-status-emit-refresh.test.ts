// Task #1560 — Regression coverage for the status-line input-stomp fix.
// When `handleUserUtterance` emits the "Sam is thinking…" status beat,
// the terminal renderer MUST repaint the readline input row so the
// user's typed buffer (if any) is not visually lost. The renderer
// achieves this by routing status emissions through
// `scrollIntoTranscript`, which calls the `refreshInput` callback
// after writing. This test exercises that wiring end-to-end against
// the public `CoachStream.emitStatus` API.

import test from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";

import { CoachStream } from "../coached/coach-stream.js";
import { TerminalRenderer } from "../coached/terminal-renderer.js";

function makeRenderer(refreshInput: () => void): {
  stream: CoachStream;
  writes: string[];
} {
  const writes: string[] = [];
  const out = new Writable({
    write(buf, _enc, cb) {
      writes.push(buf.toString("utf-8"));
      cb();
    },
  });
  const stream = new CoachStream();
  new TerminalRenderer({
    stream,
    out,
    isTTY: true,
    noColor: true,
    footerMaxWidth: 200,
    refreshInput,
  });
  return { stream, writes };
}

test("Task #1560 — emitStatus refreshes the input row so typed buffer survives", () => {
  let refreshes = 0;
  const { stream } = makeRenderer(() => {
    refreshes++;
  });
  // Reserve the footer row (mirrors the runtime sequence: the cadence
  // tick fires first, then the user-utterance path emits the
  // "Sam is thinking…" status beat).
  stream.emitTick({
    sessionId: "sess_1560",
    elapsedMs: 0,
    remainingMs: null,
    hintRung: null,
  });
  const baseline = refreshes;
  stream.emitStatus({ text: "Sam is thinking…", emittedAt: 0 });
  assert.ok(
    refreshes > baseline,
    `expected refreshInput to fire after emitStatus; got baseline=${baseline} now=${refreshes}`,
  );
});

test("Task #1560 — emitStatus writes the status line into the transcript above the footer", () => {
  const { stream, writes } = makeRenderer(() => {});
  stream.emitTick({
    sessionId: "s",
    elapsedMs: 0,
    remainingMs: null,
    hintRung: null,
  });
  stream.emitStatus({ text: "Sam is thinking…", emittedAt: 0 });
  const transcript = writes.join("");
  assert.ok(
    /Sam is thinking…/.test(transcript),
    `expected status text in transcript; got ${JSON.stringify(transcript)}`,
  );
  // The pre-#1560 path could have stomped the input row with `\r<spaces>`
  // when emitting status; the dedicated-row dance never does that.
  assert.ok(
    !/\r {3,}/.test(transcript),
    `expected no "\\r<spaces>" wipe; got ${JSON.stringify(transcript)}`,
  );
});
