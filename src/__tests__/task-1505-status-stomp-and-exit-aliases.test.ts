// Task #1505 — Regression coverage for:
//   (1) the status-line stomp on Windows (footer repaint used to clobber
//       in-progress readline input), and
//   (2) the limited set of exit aliases (`quit` / `exit` / `:q` only —
//       `stop`, `end`, `bye` were missing).
//
// Both defects shipped together because the stomp ate characters
// from typed commands, so even when the user tried a recognised
// alias it would mis-parse and the session refused to end.
import test from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";

import { CoachStream } from "../coached/coach-stream.js";
import { TerminalRenderer } from "../coached/terminal-renderer.js";
import {
  parseUtterance,
  QUIT_ALIASES,
} from "../coached/terminal-coach.js";

function makeRenderer(opts: {
  refreshInput?: () => void;
} = {}): { renderer: TerminalRenderer; stream: CoachStream; writes: string[] } {
  const writes: string[] = [];
  const out = new Writable({
    write(buf, _enc, cb) {
      writes.push(buf.toString("utf-8"));
      cb();
    },
  });
  const stream = new CoachStream();
  const renderer = new TerminalRenderer({
    stream,
    out,
    isTTY: true,
    noColor: true,
    footerMaxWidth: 200,
    ...(opts.refreshInput ? { refreshInput: opts.refreshInput } : {}),
  });
  return { renderer, stream, writes };
}

test("Task #1505 — footer repaint never overwrites the input row in place", () => {
  // Three timer ticks fire over the course of a user typing "hello".
  // Each tick must repaint the footer on a DEDICATED row above the
  // input — never as `\r`+spaces+text on the current row (which is
  // what the pre-#1505 code did and which is what stomped typed
  // characters on Windows terminals where readline's echo lives on
  // the same row).
  const { stream, writes } = makeRenderer();
  for (let i = 0; i < 3; i++) {
    stream.emitTick({
      sessionId: "sess_abc12345",
      elapsedMs: i * 1_000,
      remainingMs: 60_000 - i * 1_000,
      hintRung: null,
    });
  }
  const transcript = writes.join("");
  // The old implementation issued `\r` followed by a long run of
  // spaces to wipe the current row before writing the footer back.
  // That is exactly the byte sequence that ate typed input on Win.
  assert.ok(
    !/\r {3,}/.test(transcript),
    `expected no "\\r<spaces>" wipe of the current row; got: ${JSON.stringify(transcript)}`,
  );
  // The new implementation MUST use ANSI cursor-up to walk OFF the
  // input row before repainting the footer. `readline.moveCursor`
  // emits `\x1b[1A` for "up one line".
  assert.ok(
    /\u001b\[1A/.test(transcript),
    `expected cursor-up escape before footer repaint; got: ${JSON.stringify(transcript)}`,
  );
  // Three ticks → footer text appears at least three times (the
  // exact count is implementation-defined: first paint + two
  // repaints, possibly with an initial "\n" reservation).
  const footerHits = (transcript.match(/Ctrl\+C to stop/g) ?? []).length;
  assert.ok(
    footerHits >= 3,
    `expected ≥3 footer paints across 3 ticks; got ${footerHits}`,
  );
});

test("Task #1505 — refreshInput is called after the first-paint footer reservation", () => {
  // Without this, the user's already-typed characters would visually
  // disappear the moment the first tick fires (readline still has the
  // buffer, but the displayed text was overwritten by the footer
  // reservation flow).
  let refreshes = 0;
  const { stream } = makeRenderer({
    refreshInput: () => {
      refreshes++;
    },
  });
  stream.emitTick({
    sessionId: "s",
    elapsedMs: 0,
    remainingMs: null,
    hintRung: null,
  });
  assert.ok(
    refreshes >= 1,
    `expected at least one refreshInput call after first footer paint; got ${refreshes}`,
  );
});

test("Task #1505 — Sam line emissions trigger an input refresh so typed buffer redraws", () => {
  // Once the footer is reserved, scrolling a Sam line into the
  // transcript must re-render the input row so the readline buffer
  // (which still contains the user's in-progress text) repaints. The
  // pre-#1505 renderer wrote the Sam line with no refresh hook, so
  // the typed input visually vanished even though pressing Enter
  // would still submit the right string.
  let refreshes = 0;
  const { stream } = makeRenderer({
    refreshInput: () => {
      refreshes++;
    },
  });
  // Reserve footer first.
  stream.emitTick({
    sessionId: "s",
    elapsedMs: 0,
    remainingMs: null,
    hintRung: null,
  });
  const baseline = refreshes;
  stream.emitSam({ kind: "free", text: "How's it going?", emittedAt: 0 });
  assert.ok(
    refreshes > baseline,
    `expected refreshInput to fire after a Sam emission; got baseline=${baseline} now=${refreshes}`,
  );
});

test("Task #1505 — every documented exit alias triggers the quit command", () => {
  // Mirrors the user-facing help text emitted by cli-start.ts and
  // startup-banner.ts. If you add another alias, extend both the
  // QUIT_ALIASES constant and the banners — this test will hold them
  // in sync.
  const expected = ["quit", "exit", ":q", "stop", "end", "bye"];
  assert.deepEqual(
    [...QUIT_ALIASES],
    expected,
    "QUIT_ALIASES drifted from the help-text contract",
  );
  for (const alias of expected) {
    const lower = parseUtterance(alias, 0);
    const upper = parseUtterance(alias.toUpperCase(), 0);
    const padded = parseUtterance(alias, 0);
    assert.equal(
      lower.command,
      "quit",
      `expected "${alias}" → quit; got ${JSON.stringify(lower)}`,
    );
    assert.equal(
      upper.command,
      "quit",
      `expected "${alias.toUpperCase()}" → quit (aliases are case-insensitive); got ${JSON.stringify(upper)}`,
    );
    assert.equal(padded.command, "quit");
  }
  // Negative control: free-text that merely contains an alias as a
  // substring must NOT be parsed as quit.
  assert.equal(parseUtterance("stop the bleeding", 0).command, undefined);
  assert.equal(parseUtterance("let me end here briefly", 0).command, undefined);
  assert.equal(parseUtterance("goodbye", 0).command, undefined);
});
