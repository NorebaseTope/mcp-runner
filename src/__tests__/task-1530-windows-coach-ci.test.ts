// Task #1530 — Run the in-terminal coach checks on real Windows shells
// automatically.
//
// Task #1508 added a manual Windows smoke checklist (PowerShell 7 in
// Windows Terminal, PowerShell in legacy conhost, cmd.exe, Cursor
// xterm.js) because Node's `tty.WriteStream` resize behaviour is not
// faithfully emulated on Linux CI. This file is the scripted readline
// sequence the CI lane drives on a real `windows-latest` runner so
// regressions in the coach footer / resize / exit invariants are
// caught automatically instead of relying on a release-time human
// pass.
//
// Invariants asserted (one-to-one with the manual checklist's three
// "Pass criteria" lines):
//
//   (1) Footer never overwrites typed chars — after the user has
//       typed into the readline buffer, a subsequent cadence tick
//       must repaint the footer on the row ABOVE the input (cursor
//       walks up via `\x1b[1A`, clears, paints, walks back down) and
//       the bytes emitted by that tick must NOT include the typed
//       buffer text verbatim (which would mean the renderer stomped
//       the input row).
//
//   (2) Footer re-truncates after a shrink — wiring
//       `process.stdout.on('resize', ...)` to `renderer.onResize`
//       (exactly as `startTerminalCoach` does) and then firing
//       `process.stdout.emit('resize')` after lowering
//       `process.stdout.columns` must produce a repainted footer
//       capped at the new width with an `…` suffix.
//
//   (3) Exit clears the rows — `renderer.detach()` (the Ctrl+C exit
//       path: SIGINT → `endStream("ctrl_c")` → renderer end → detach)
//       must emit clearLine + cursor-up + clearLine so neither the
//       footer row nor the input row leak escapes into the shell
//       prompt that takes over after the coach exits.
//
// The whole file is platform-agnostic (every assertion runs on Linux
// + macOS too) so the existing `pnpm --filter @prepsavant/mcp run
// test` job exercises it. The new `mcp-runner-windows-coach.yml` CI
// workflow re-runs it on `windows-latest` so any Windows-specific
// readline cursor-math regression fails the merge gate.

import test from "node:test";
import assert from "node:assert/strict";
import { Writable, PassThrough } from "node:stream";
import * as readline from "node:readline";

import { CoachStream } from "../coached/coach-stream.js";
import { TerminalRenderer } from "../coached/terminal-renderer.js";
import { redrawReadlineRow } from "../coached/terminal-coach.js";

interface Harness {
  renderer: TerminalRenderer;
  stream: CoachStream;
  rl: readline.Interface;
  out: Writable;
  writes: string[];
  transcript(): string;
  sinceMark(): string;
  mark(): void;
}

function setupHarness(initialColumns: number): Harness {
  const writes: string[] = [];
  let markIdx = 0;
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
    footerMaxWidth: initialColumns - 1,
    refreshInput: () => {
      try {
        redrawReadlineRow(rl, out);
      } catch {
        /* noop */
      }
    },
  });
  // Real `readline.Interface` so the prompt/buffer/cursor we read
  // off it in `redrawReadlineRow` come from the documented public
  // surface — exactly what runs under PowerShell / cmd.exe / xterm
  // on a real Windows host. We feed it a PassThrough input and
  // `terminal: false` so the interface itself doesn't try to drive
  // the output; the renderer's `refreshInput` hook owns the repaint.
  const input = new PassThrough();
  const rl = readline.createInterface({
    input,
    output: out,
    terminal: false,
    prompt: "> ",
  });
  return {
    renderer,
    stream,
    rl,
    out,
    writes,
    transcript: () => writes.join(""),
    sinceMark: () => writes.join("").slice(markIdx),
    mark: () => {
      markIdx = writes.join("").length;
    },
  };
}

function setReadlineBuffer(rl: readline.Interface, line: string): void {
  // `rl.line` and `rl.cursor` have been public per the Node readline
  // docs since 15.3; the same surface the production
  // `redrawReadlineRow` reads from.
  (rl as unknown as { line: string; cursor: number }).line = line;
  (rl as unknown as { line: string; cursor: number }).cursor = line.length;
}

test("Task #1530 — typed buffer survives a cadence tick (footer never overwrites typed chars)", () => {
  const h = setupHarness(200);
  // Reserve the footer with the first cadence tick.
  h.stream.emitTick({
    sessionId: "sess_t1530_typed",
    elapsedMs: 0,
    remainingMs: 60_000,
    hintRung: null,
  });
  // Simulate the user typing a 40-char reply (matching the manual
  // checklist's "type a 40-char reply" step).
  const typed = "hello world I am typing into the coach";
  setReadlineBuffer(h.rl, typed);
  // Production wiring repaints the input row via `refreshInput`
  // after every transcript scroll / footer reservation; mimic that
  // by calling the same helper directly.
  redrawReadlineRow(h.rl, h.out);
  // Sanity: the typed buffer must have been painted at least once.
  assert.ok(
    h.transcript().includes(`> ${typed}`),
    `expected typed buffer to be painted on the input row; got ${JSON.stringify(h.transcript())}`,
  );

  h.mark();
  // Second tick — repaint the footer.
  h.stream.emitTick({
    sessionId: "sess_t1530_typed",
    elapsedMs: 1_000,
    remainingMs: 59_000,
    hintRung: null,
  });
  const since = h.sinceMark();
  // Footer repaint MUST walk up to the footer row first — if it
  // doesn't, it's writing into the input row and stomping the typed
  // buffer (the Task #1505 regression).
  assert.match(
    since,
    /\u001b\[1A/,
    `tick repaint must move cursor up to the footer row before clearing; got ${JSON.stringify(since)}`,
  );
  // The bytes emitted by this tick MUST include the typed buffer
  // because the renderer now repaints the input row via
  // `refreshInput()` after every footer tick (Task #1554). Pre-#1554
  // we asserted the inverse here, but that invariant left the cursor
  // parked at col 0 of the input row, so the next keystroke on
  // PowerShell stomped the prompt. The footer-row clear is bounded
  // to a single line above (verified by the `\u001b[1A` match above
  // plus the single clearLine before the footer text), so this
  // repaint can't "stomp" anything — it re-emits readline's own
  // in-memory state.
  assert.ok(
    since.includes(typed),
    `tick repaint must REPAINT the typed buffer via refreshInput (Task #1554 — keeps readline visual state in sync); got ${JSON.stringify(since)}`,
  );
});

test("Task #1530 — process.stdout.emit('resize') drives renderer.onResize and re-truncates the footer", () => {
  const h = setupHarness(200);
  // Reserve the footer at the wide column count.
  h.stream.emitTick({
    sessionId: "sess_t1530_resize",
    elapsedMs: 0,
    remainingMs: 60_000,
    hintRung: null,
  });

  // Wire the SAME resize listener `startTerminalCoach` registers on
  // `process.stdout` so the test exercises the exact event path
  // PowerShell / Windows Terminal / cmd.exe / conhost trigger when
  // the user drags the window edge. The handler reads the current
  // `process.stdout.columns` (which Windows updates synchronously
  // before firing the event) and forwards it to the renderer.
  const origColumns = (process.stdout as { columns?: number }).columns;
  const resizeHandler = (): void => {
    const cols = (process.stdout as { columns?: number }).columns;
    h.renderer.onResize(typeof cols === "number" ? cols : undefined);
  };
  (process.stdout as unknown as {
    on: (ev: string, fn: () => void) => void;
  }).on("resize", resizeHandler);

  try {
    h.mark();
    // Shrink the terminal — the user dragged the window edge.
    (process.stdout as { columns?: number }).columns = 30;
    (process.stdout as unknown as {
      emit: (ev: string) => boolean;
    }).emit("resize");

    const since = h.sinceMark();
    // The repaint must include an ellipsis-truncated footer (the
    // original line is far longer than 30 chars).
    assert.match(
      since,
      /…/,
      `expected truncated footer with ellipsis after shrink; got ${JSON.stringify(since)}`,
    );
    // And must contain the cursor-up escape so the repaint hit the
    // footer row, not the input row.
    assert.match(
      since,
      /\u001b\[1A/,
      `expected cursor-up escape during resize repaint; got ${JSON.stringify(since)}`,
    );
    // Sanity: the truncated footer itself (the bytes between the
    // clearLine + the next cursor-up-or-newline) must fit in the
    // new width cap of `max(20, columns - 1) = 29`. We isolate the
    // footer text by stripping ANSI and pulling the substring from
    // the first `─` (footer's leading char) to the trailing `…`.
    const stripped = since.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
    const footerStart = stripped.indexOf("─");
    const footerEnd = stripped.indexOf("…", footerStart);
    assert.ok(
      footerStart >= 0 && footerEnd > footerStart,
      `expected truncated footer substring in stripped output; got ${JSON.stringify(stripped)}`,
    );
    const footerText = stripped.slice(footerStart, footerEnd + 1);
    assert.ok(
      footerText.length <= 29,
      `truncated footer must fit in max(20, columns-1)=29; got len=${footerText.length}: ${JSON.stringify(footerText)}`,
    );
  } finally {
    (process.stdout as unknown as {
      off: (ev: string, fn: () => void) => void;
    }).off("resize", resizeHandler);
    if (typeof origColumns === "number") {
      (process.stdout as { columns?: number }).columns = origColumns;
    }
  }
});

test("Task #1530 — Ctrl+C exit (detach) clears the footer row AND the input row", () => {
  const h = setupHarness(200);
  // Reserve the footer.
  h.stream.emitTick({
    sessionId: "sess_t1530_exit",
    elapsedMs: 0,
    remainingMs: 60_000,
    hintRung: null,
  });
  // Type something so the input row is non-empty — the detach must
  // clear both rows regardless of buffer contents.
  setReadlineBuffer(h.rl, "mid-sentence when the user hit Ctrl+C");
  redrawReadlineRow(h.rl, h.out);

  h.mark();
  // Ctrl+C path: `endStream("ctrl_c")` ends the CoachStream, which
  // fires the renderer's onEnd → detach. Call detach directly so the
  // test doesn't depend on the full CadenceDriver wiring.
  h.renderer.detach();
  const since = h.sinceMark();
  // The detach must emit at least two clearLine escapes (one for
  // the input row, one for the footer row) with a cursor-up between
  // them so the shell prompt comes back on a clean row.
  const clearLineMatches = since.match(/\u001b\[2K/g) ?? [];
  assert.ok(
    clearLineMatches.length >= 2,
    `expected at least two clearLine escapes on detach (input row + footer row); got ${clearLineMatches.length} in ${JSON.stringify(since)}`,
  );
  assert.match(
    since,
    /\u001b\[1A/,
    `expected cursor-up between the two clears so detach lands above the footer; got ${JSON.stringify(since)}`,
  );
  // A second detach must be a clean no-op (idempotent) so a stray
  // SIGINT after the session ended doesn't double-clear.
  h.mark();
  h.renderer.detach();
  assert.equal(
    h.sinceMark(),
    "",
    `second detach must be a no-op; got ${JSON.stringify(h.sinceMark())}`,
  );
});

test("Task #1530 — scripted sequence: type → resize → tick → exit, end-to-end", () => {
  // The full manual-checklist scripted sequence in one test so a
  // single failure on the Windows lane pinpoints which step broke.
  const h = setupHarness(200);
  // Step 1 — reserve footer.
  h.stream.emitTick({
    sessionId: "sess_t1530_full",
    elapsedMs: 0,
    remainingMs: 60_000,
    hintRung: null,
  });
  // Step 2 — type a 40-char reply.
  const typed = "this is the user mid-reply on Windows!!";
  setReadlineBuffer(h.rl, typed);
  redrawReadlineRow(h.rl, h.out);
  // Step 3 — simulated resize via process.stdout.emit('resize').
  const origColumns = (process.stdout as { columns?: number }).columns;
  const resizeHandler = (): void => {
    const cols = (process.stdout as { columns?: number }).columns;
    h.renderer.onResize(typeof cols === "number" ? cols : undefined);
  };
  (process.stdout as unknown as {
    on: (ev: string, fn: () => void) => void;
  }).on("resize", resizeHandler);
  try {
    (process.stdout as { columns?: number }).columns = 30;
    (process.stdout as unknown as {
      emit: (ev: string) => boolean;
    }).emit("resize");
    // Step 4 — another cadence tick after the resize. Must repaint
    // BOTH the footer AND the typed input row. Pre-#1554 we asserted
    // the inverse (`!tickAfterResize.includes(typed)`) under the
    // assumption that "leaving the input row alone" was safe — but
    // that left the cursor parked at col 0 of the input row, so the
    // next keystroke on Windows PowerShell was echoed at col 0 and
    // stomped the prompt. The #1554 fix calls `refreshInput()` after
    // every footer repaint, which re-emits `prompt+typed` and
    // repositions the cursor to `prompt.length + buffer.length`.
    h.mark();
    h.stream.emitTick({
      sessionId: "sess_t1530_full",
      elapsedMs: 1_000,
      remainingMs: 59_000,
      hintRung: null,
    });
    const tickAfterResize = h.sinceMark();
    assert.ok(
      tickAfterResize.includes(typed),
      `post-resize tick must REPAINT the typed buffer (Task #1554 — keeps readline visual state in sync so the next keystroke doesn't land at col 0); got ${JSON.stringify(tickAfterResize)}`,
    );
    assert.match(
      tickAfterResize,
      /…/,
      `post-resize tick repaint must use the truncated footer; got ${JSON.stringify(tickAfterResize)}`,
    );
    // Step 5 — Ctrl+C exit.
    h.mark();
    h.renderer.detach();
    const exit = h.sinceMark();
    const clears = exit.match(/\u001b\[2K/g) ?? [];
    assert.ok(
      clears.length >= 2,
      `Ctrl+C exit must clear both rows; got ${clears.length} clears in ${JSON.stringify(exit)}`,
    );
  } finally {
    (process.stdout as unknown as {
      off: (ev: string, fn: () => void) => void;
    }).off("resize", resizeHandler);
    if (typeof origColumns === "number") {
      (process.stdout as { columns?: number }).columns = origColumns;
    }
  }
});
