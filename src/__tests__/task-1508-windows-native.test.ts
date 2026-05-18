// Task #1508 — Make the in-terminal coach feel native on Windows
// shells. Three concerns covered here:
//
//   (1) The runner must NOT depend on the `_refreshLine()` Node
//       internal anymore — the previous Task #1505 implementation
//       called it via a typed escape hatch, but it shifted across
//       Node majors and behaved differently on Windows. We now use
//       a documented-API helper (`redrawReadlineRow`) built on
//       `rl.getPrompt()` / `rl.line` / `rl.cursor`.
//   (2) Terminal resize (SIGWINCH on POSIX, the `tty.WriteStream`
//       `'resize'` event on Windows + POSIX) must repaint the
//       footer at the new column count and refresh the readline
//       input row.
//   (3) A static source-level guard so a future refactor can't
//       silently re-introduce an underscore-prefixed readline
//       internal call.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Writable } from "node:stream";
import * as readline from "node:readline";
import { PassThrough } from "node:stream";

import { CoachStream } from "../coached/coach-stream.js";
import { TerminalRenderer } from "../coached/terminal-renderer.js";
import { redrawReadlineRow } from "../coached/terminal-coach.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(__dirname, "..", "coached");

function makeRenderer(opts: {
  refreshInput?: () => void;
  footerMaxWidth?: number;
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
    footerMaxWidth: opts.footerMaxWidth ?? 200,
    ...(opts.refreshInput ? { refreshInput: opts.refreshInput } : {}),
  });
  return { renderer, stream, writes };
}

test("Task #1508 — no source file under coached/ references readline._refreshLine", () => {
  // Static guard: the runner must not call `_refreshLine` anymore.
  // Comments mentioning the historical name are fine; an actual call
  // (followed by `(` or `?.()` after the identifier) is not.
  const files = [
    resolve(SRC_ROOT, "terminal-coach.ts"),
    resolve(SRC_ROOT, "terminal-renderer.ts"),
  ];
  // Match an actual invocation of `_refreshLine`. To avoid false
  // positives on comment text like "we used to call `rl._refreshLine()`",
  // strip `//` line comments first and only scan the executable code.
  const callRe = /_refreshLine\s*\??\.?\s*\(/;
  for (const f of files) {
    const src = readFileSync(f, "utf-8")
      .split("\n")
      .map((ln) => ln.replace(/\/\/.*$/, ""))
      .join("\n");
    assert.ok(
      !callRe.test(src),
      `${f} still calls _refreshLine(); use the documented redrawReadlineRow helper instead`,
    );
  }
});

test("Task #1508 — redrawReadlineRow uses only public readline APIs and repaints prompt + buffer + cursor", () => {
  // Build a real readline.Interface against in-memory streams so we
  // exercise the documented public surface (`getPrompt()`, `line`,
  // `cursor`) end-to-end. The Writable captures every byte so we
  // can assert the redraw never emits an underscore-prefixed escape.
  const input = new PassThrough();
  const writes: string[] = [];
  const output = new Writable({
    write(buf, _enc, cb) {
      writes.push(buf.toString("utf-8"));
      cb();
    },
  });
  const rl = readline.createInterface({
    input,
    output,
    terminal: false,
    prompt: "> ",
  });
  // Inject a buffer + cursor offset via the documented surface
  // (these properties are public per Node's readline docs).
  (rl as unknown as { line: string; cursor: number }).line = "hello world";
  (rl as unknown as { line: string; cursor: number }).cursor = 5;

  // Reset writes so we only inspect what redrawReadlineRow emits.
  writes.length = 0;
  redrawReadlineRow(rl, output);
  const out = writes.join("");
  // Cursor-to-column-0 then clear-line then prompt + buffer then
  // cursor-to absolute column. `readline.cursorTo` emits `\x1b[1G`
  // (CSI 1 G — absolute column 1, i.e. column 0 in 0-indexed terms);
  // `readline.clearLine(_, 0)` emits `\x1b[2K`; subsequent
  // `cursorTo(n)` for non-zero n emits `\x1b[<n+1>G`.
  assert.match(
    out,
    /\x1b\[1G/,
    `expected cursorTo(0) escape (\\x1b[1G); got ${JSON.stringify(out)}`,
  );
  assert.match(out, /\x1b\[2K/, "expected clearLine escape");
  assert.match(
    out,
    /> hello world/,
    `expected prompt + buffer to be repainted; got ${JSON.stringify(out)}`,
  );
  // 5 chars into the buffer + 2-char prompt = column 7 (1-indexed 8).
  assert.match(
    out,
    /\x1b\[8G/,
    `expected cursor-to absolute column 8 after redraw; got ${JSON.stringify(out)}`,
  );

  rl.close();
});

test("Task #1508 — onResize re-caps footer width and refreshes the input row", () => {
  let refreshes = 0;
  const { renderer, stream, writes } = makeRenderer({
    refreshInput: () => {
      refreshes++;
    },
    footerMaxWidth: 200,
  });
  // Reserve the footer with a normal tick first.
  stream.emitTick({
    sessionId: "sess_resize_a",
    elapsedMs: 0,
    remainingMs: 60_000,
    hintRung: null,
  });
  const baselineRefreshes = refreshes;
  const beforeLen = writes.join("").length;

  // Now shrink the terminal to 30 columns.
  renderer.onResize(30);
  const afterTranscript = writes.join("").slice(beforeLen);
  // Refresh-input must fire so the readline buffer redraws.
  assert.ok(
    refreshes > baselineRefreshes,
    `expected onResize to trigger refreshInput; got baseline=${baselineRefreshes} now=${refreshes}`,
  );
  // The repaint must include an ellipsis-truncated footer (the
  // original line is longer than 30 chars).
  assert.match(
    afterTranscript,
    /…/,
    `expected truncated footer with ellipsis after shrink; got ${JSON.stringify(afterTranscript)}`,
  );
  // And it must contain the cursor-up escape so we walked OFF the
  // input row before repainting the footer row — the same invariant
  // Task #1505 enforces for normal ticks.
  assert.match(
    afterTranscript,
    /\u001b\[1A/,
    `expected cursor-up escape during onResize repaint; got ${JSON.stringify(afterTranscript)}`,
  );
});

test("Task #1508 — onResize is a no-op before the footer is reserved", () => {
  // If a resize event fires BEFORE the first cadence tick (footer
  // hasn't been reserved yet), we must not emit any cursor moves —
  // the next tick will reserve the footer at the correct width.
  let refreshes = 0;
  const { renderer, writes } = makeRenderer({
    refreshInput: () => {
      refreshes++;
    },
  });
  renderer.onResize(40);
  assert.equal(refreshes, 0, "refreshInput must not fire before footer is reserved");
  assert.equal(
    writes.join(""),
    "",
    `no bytes should be written before footer is reserved; got ${JSON.stringify(writes.join(""))}`,
  );
});

test("Task #1508 — onResize is a no-op in non-TTY mode", () => {
  // Non-TTY renderers suppress the footer entirely; a resize event
  // on stdout (e.g. piped output that somehow grew) must not paint.
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
    isTTY: false,
    noColor: true,
  });
  renderer.onResize(120);
  assert.equal(writes.length, 0);
  // Detach should also be a clean no-op in non-TTY mode.
  renderer.detach();
});

test("Task #1508 — onResize after detach is a no-op", () => {
  // Once the session ends we tear down the renderer; a late resize
  // event must not crash or emit cursor escapes into a torn-down
  // terminal.
  let refreshes = 0;
  const { renderer, stream } = makeRenderer({
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
  renderer.detach();
  const before = refreshes;
  renderer.onResize(50);
  assert.equal(refreshes, before, "no refresh should fire after detach");
});
