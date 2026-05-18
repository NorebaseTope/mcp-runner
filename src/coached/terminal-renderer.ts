// Task #1401 — Terminal renderer for the runner-driven coached session.
// Subscribes to a CoachStream and prints Sam/user/status lines plus a
// persistent footer with session id, elapsed/remaining time, current
// hint rung, and "Ctrl+C to stop". Honors NO_COLOR and non-TTY (degrades
// to plain transcript). `--json` mode bypasses the renderer entirely
// (the caller never instantiates one).
//
// Task #1505 — Status-line stomp fix. The footer used to live on the
// SAME row as readline's input prompt: every second the tick handler
// did `\r` + spaces + new footer text, which clobbered whatever the
// user had typed since the previous tick. On Windows (Cursor terminal,
// PowerShell 7, cmd.exe) typed characters were eaten and a 60-char
// reply ended up looking like the last few chars jammed against the
// footer.
//
// New layout reserves a dedicated row ABOVE the readline input for the
// footer. Footer redraws use `readline.moveCursor` / `readline.clearLine`
// so the cursor never enters the input row, and the user's in-progress
// input is left completely untouched. Sam / status emissions still
// scroll into the transcript above the footer; after writing them we
// re-render the footer and ask readline to refresh the input row so
// the prompt + buffer paint cleanly. All cursor moves use the same
// `readline.*` helpers that Node already uses internally for prompts,
// so the fix works on every shell `readline` supports (incl. cmd.exe,
// PowerShell, Windows Terminal, and xterm.js inside Cursor).
//
// Task #1508 — Windows-native polish. Two changes land here:
//   (1) `footerMaxWidth` is now mutable so terminal resize events can
//       re-cap the footer to the new column count. The constructor
//       option becomes a SEED (defaulted from `process.stdout.columns`
//       when the caller doesn't pass one) instead of a frozen value.
//   (2) A public `onResize(columns?)` method repaints the footer +
//       calls the input-refresh hook so a SIGWINCH (POSIX) or
//       `process.stdout` `'resize'` event (Windows + POSIX) leaves the
//       layout intact. The terminal-coach wires both the POSIX signal
//       and the `tty.WriteStream` resize event to this method so
//       PowerShell, conhost, and Windows Terminal all redraw cleanly
//       when the user drags the window edge.

import * as readline from "node:readline";
import type { Writable } from "node:stream";
import type { CoachStream, SamLine, TickInfo, UserUtterance, StatusLine } from "./coach-stream.js";

export interface TerminalRendererOptions {
  stream: CoachStream;
  out?: Writable;            // defaults to process.stdout
  isTTY?: boolean;           // defaults to process.stdout.isTTY
  noColor?: boolean;         // defaults to !!process.env.NO_COLOR
  // Length of the hint-rung suffix in the footer, capped to keep the
  // line under most terminals' column count without wrapping.
  footerMaxWidth?: number;
  // Task #1505 — Optional callback invoked after we've scrolled the
  // transcript or repainted the footer. Production wiring passes a
  // closure that repaints the readline buffer on the input row
  // without losing the user's typed chars. Task #1508 swapped this
  // from `rl._refreshLine()` (a Node internal) to a documented
  // implementation built on the public `rl.getPrompt()` / `rl.line`
  // / `rl.cursor` surface plus `readline.cursorTo` / `clearLine`.
  refreshInput?: () => void;
}

const ANSI = {
  reset: "\u001b[0m",
  // Task #1507 — bump from standard cyan (1;36) to bold + BRIGHT cyan
  // (1;96) so the `Sam ›` prefix pops on dark terminals (Cursor's
  // default theme included). Standard cyan-on-dark sits at ~3:1
  // against the background which fails WCAG-AA — bright cyan-bold
  // clears 7:1 on every default terminal palette we tested.
  cyanBold: "\u001b[1;96m",
  dim: "\u001b[2m",
  italic: "\u001b[3m",
  yellow: "\u001b[33m",
};

export class TerminalRenderer {
  private readonly out: Writable;
  private readonly useColor: boolean;
  private readonly isTTY: boolean;
  private lastFooter = "";
  // Task #1508 — Mutable so `onResize` can re-cap the footer to the
  // new terminal width without having to rebuild the renderer.
  private footerMaxWidth: number;
  private detached = false;
  // Task #1505 — true once we've reserved a dedicated row above the
  // input for the persistent footer. We reserve lazily on the first
  // tick so non-TTY callers (tests, piped transcripts) never see a
  // stray blank line.
  private footerRowReserved = false;
  private readonly refreshInput: (() => void) | undefined;

  constructor(opts: TerminalRendererOptions) {
    this.out = opts.out ?? process.stdout;
    this.isTTY =
      opts.isTTY ?? Boolean((process.stdout as { isTTY?: boolean }).isTTY);
    // Task #1507 — honor FORCE_COLOR (any truthy value) as an explicit
    // opt-IN that overrides the !isTTY fall-back, mirroring the
    // convention used by chalk / supports-color / npm. NO_COLOR
    // still wins over FORCE_COLOR per https://no-color.org.
    const envNoColor = !!process.env["NO_COLOR"];
    const envForceColor =
      typeof process.env["FORCE_COLOR"] === "string" &&
      process.env["FORCE_COLOR"].length > 0 &&
      process.env["FORCE_COLOR"] !== "0" &&
      process.env["FORCE_COLOR"].toLowerCase() !== "false";
    const colorAllowed = !(opts.noColor ?? envNoColor);
    this.useColor = colorAllowed && (this.isTTY || envForceColor);
    // Task #1508 — seed footerMaxWidth from the explicit option, else
    // from `process.stdout.columns` (typed loosely so unit tests can
    // pass a mock `out` without a `columns` getter), else the legacy
    // 100-column default. `onResize` will overwrite this on every
    // terminal resize event the coach forwards to us.
    const seedColumns =
      typeof (process.stdout as { columns?: number }).columns === "number"
        ? (process.stdout as { columns: number }).columns
        : undefined;
    this.footerMaxWidth =
      opts.footerMaxWidth ??
      (seedColumns && seedColumns > 0 ? Math.max(20, seedColumns - 1) : 100);
    this.refreshInput = opts.refreshInput;

    opts.stream.onSam((l) => this.renderSam(l));
    opts.stream.onUser((u) => this.renderUser(u));
    opts.stream.onStatus((s) => this.renderStatus(s));
    opts.stream.onTick((t) => this.renderFooter(t));
    opts.stream.onEnd(() => this.detach());
  }

  detach(): void {
    if (this.detached) return;
    this.detached = true;
    if (this.isTTY && this.footerRowReserved) {
      // Wipe the input row (where the cursor lives) and the footer row
      // above it so the shell prompt comes back clean.
      readline.cursorTo(this.out, 0);
      readline.clearLine(this.out, 0);
      readline.moveCursor(this.out, 0, -1);
      readline.cursorTo(this.out, 0);
      readline.clearLine(this.out, 0);
      this.footerRowReserved = false;
      this.lastFooter = "";
    }
  }

  // Task #1508 — Handle a terminal resize (SIGWINCH on POSIX, the
  // `tty.WriteStream` `'resize'` event on Windows + POSIX). We
  // re-cap the footer width to the new column count, repaint the
  // reserved footer row, and ask the readline buffer to redraw so
  // the user's in-progress input survives the window edge being
  // dragged. No-op when the footer hasn't been reserved yet (the
  // next normal tick will reserve at the correct width) or in
  // non-TTY mode (footer is suppressed there).
  onResize(columns?: number): void {
    if (this.detached || !this.isTTY) return;
    if (typeof columns === "number" && columns > 0) {
      this.footerMaxWidth = Math.max(20, columns - 1);
    }
    if (!this.footerRowReserved) return;
    let footer = this.lastFooter;
    if (footer.length > this.footerMaxWidth) {
      footer = footer.slice(0, this.footerMaxWidth - 1) + "…";
    }
    const colored = this.useColor ? `${ANSI.dim}${footer}${ANSI.reset}` : footer;
    // Cursor lives on the input row; wipe it, step up to the footer
    // row, wipe + repaint, then step back to the input row and ask
    // the readline buffer to redraw itself.
    readline.cursorTo(this.out, 0);
    readline.clearLine(this.out, 0);
    readline.moveCursor(this.out, 0, -1);
    readline.cursorTo(this.out, 0);
    readline.clearLine(this.out, 0);
    this.out.write(colored);
    readline.moveCursor(this.out, 0, 1);
    readline.cursorTo(this.out, 0);
    this.lastFooter = footer;
    this.refreshInput?.();
  }

  // Internal helpers — public so unit tests can drive them deterministically
  // without spinning a CoachStream.

  renderSam(line: SamLine): void {
    if (this.detached) return;
    const prefix = this.useColor
      ? `${ANSI.cyanBold}Sam ›${ANSI.reset}`
      : "Sam ›";
    this.scrollIntoTranscript(`${prefix} ${line.text}\n`);
  }

  renderUser(u: UserUtterance): void {
    if (this.detached) return;
    // Most terminals echo input as the user types, so we ONLY write a
    // user line back when there's an out-of-band reason (e.g. a piped
    // transcript test). Detect "TTY echo already happened" by checking
    // isTTY: if true, the user already saw their text.
    if (this.isTTY) return;
    const prefix = this.useColor
      ? `${ANSI.dim}you ›${ANSI.reset}`
      : "you ›";
    this.out.write(`${prefix} ${u.text}\n`);
  }

  renderStatus(s: StatusLine): void {
    if (this.detached) return;
    const prefix = this.useColor
      ? `${ANSI.dim}${ANSI.italic}·${ANSI.reset}`
      : "·";
    this.scrollIntoTranscript(`${prefix} ${s.text}\n`);
  }

  renderFooter(t: TickInfo): void {
    if (this.detached) return;
    if (!this.isTTY) return; // footer would just be transcript noise
    const footer = this.formatFooter(t);
    const colored = this.useColor ? `${ANSI.dim}${footer}${ANSI.reset}` : footer;
    if (!this.footerRowReserved) {
      // Task #1533 — Defensively normalise cursor state before the
      // first footer reservation. When the user answers Y to "An
      // active coached session for this question already exists. End
      // it and start a new one?" inside a single `prepsavant start`
      // invocation (or when a prior process exited via SIGKILL and
      // left the cursor mid-row), the input row may already contain
      // characters (the readline prompt for the Y/n question, leftover
      // banner output, etc.). Without this clearLine the first
      // reservation emits its "\n" against a non-empty row, the
      // footer is painted one column to the right of those residual
      // chars, and every subsequent 1s repaint stomps the user's
      // input on Q#2 — exactly the symptom Task #1505 fixed for the
      // happy path. We wipe the current row before reserving so the
      // new session always starts from a clean cursor state.
      readline.cursorTo(this.out, 0);
      readline.clearLine(this.out, 0);
      // First tick — reserve a fresh row above the input. The cursor
      // currently sits on whatever row readline is using for the
      // prompt. We move the prompt down one row by emitting "\n",
      // then step back up, paint the footer, and step back down so
      // the cursor lands on the input row again. The user's typed
      // buffer (if any) is repainted by `refreshInput`.
      this.out.write("\n");
      readline.moveCursor(this.out, 0, -1);
      readline.cursorTo(this.out, 0);
      readline.clearLine(this.out, 0);
      this.out.write(colored);
      readline.moveCursor(this.out, 0, 1);
      readline.cursorTo(this.out, 0);
      this.footerRowReserved = true;
      this.lastFooter = footer;
      this.refreshInput?.();
      return;
    }
    // Subsequent tick — repaint the footer row above the input
    // WITHOUT touching the input row's CONTENT. This is the core of
    // the status-line stomp fix (Task #1505).
    readline.moveCursor(this.out, 0, -1);
    readline.cursorTo(this.out, 0);
    readline.clearLine(this.out, 0);
    this.out.write(colored);
    readline.moveCursor(this.out, 0, 1);
    readline.cursorTo(this.out, 0);
    this.lastFooter = footer;
    // Task #1554 — After the footer repaint the cursor is parked at
    // col 0 of the input row, but readline's in-memory state still
    // thinks it's at col=(prompt.length + buffer.length). Without a
    // refresh, the next keystroke is echoed at col 0 and overwrites
    // the first character of the prompt/typed buffer. On POSIX
    // terminals readline's echo timing usually hides this; on
    // Windows PowerShell (especially win32-arm64 conhost) it
    // surfaces as the user's typing getting deleted/overwritten on
    // roughly the second char of every Q#2+ input. `refreshInput`
    // is idempotent — it just re-emits `\r\x1b[K<prompt><buffer>`
    // and repositions the cursor to (prompt.length + cursor) — so
    // running it on every tick is safe and the right state-sync
    // primitive to call here.
    this.refreshInput?.();
  }

  formatFooter(t: TickInfo): string {
    const elapsed = formatDuration(t.elapsedMs);
    const remaining =
      t.remainingMs == null ? "open-ended" : formatDuration(Math.max(0, t.remainingMs));
    const rung = t.hintRung ?? "—";
    const sid = shortenSessionId(t.sessionId);
    const raw = `─ [${sid} · ${elapsed} / ${remaining} · hint: ${rung} · Ctrl+C to stop]`;
    if (raw.length <= this.footerMaxWidth) return raw;
    return raw.slice(0, this.footerMaxWidth - 1) + "…";
  }

  // Task #1505 — scroll a Sam/status line into the transcript above
  // the footer, then repaint the footer and ask readline to refresh
  // the input. The pre-#1505 implementation wrote the line over the
  // shared footer+input row and relied on \n to push it into the
  // scrollback; with the footer on a dedicated row we have to do the
  // dance explicitly so the visual order stays:
  //
  //   ...transcript history...
  //   <new Sam/status line>
  //   <footer>
  //   > <input>
  private scrollIntoTranscript(content: string): void {
    if (!this.isTTY || !this.footerRowReserved) {
      this.out.write(content);
      return;
    }
    // Cursor is on the input row, possibly with characters drawn.
    // Wipe the input row, then walk up to the footer row, wipe it,
    // write the new transcript line (which scrolls the previous
    // footer into history) and re-render the footer + refresh input.
    readline.cursorTo(this.out, 0);
    readline.clearLine(this.out, 0);
    readline.moveCursor(this.out, 0, -1);
    readline.cursorTo(this.out, 0);
    readline.clearLine(this.out, 0);
    this.out.write(content);
    const colored = this.useColor
      ? `${ANSI.dim}${this.lastFooter}${ANSI.reset}`
      : this.lastFooter;
    this.out.write(colored + "\n");
    readline.cursorTo(this.out, 0);
    this.refreshInput?.();
  }
}

export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function shortenSessionId(id: string): string {
  if (id.length <= 12) return id;
  return id.slice(0, 8) + "…";
}
