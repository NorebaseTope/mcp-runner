// Task #1401 — Owns the terminal for the lifetime of a coached session.
// Wires:
//   • CadenceDriver (sink → CoachStream Sam beats + recap events)
//   • file-watcher status events (already wired in session.ts; we
//     surface a subset to the stream as "you saved <file>")
//   • readline input loop (free-text "talk back to Sam" + commands)
//   • a tick interval that updates the footer
//
// Task #1506 — Host-reasoning Sam: the cadence driver now emits
// `mode: "host_reasoning"` by default (see `defaultCadenceMode`), so
// every cadence directive flows through `renderDirectiveAsSamLine` ->
// `agent.ask()` with a per-session system prompt grounded in the
// question. User utterances (free-form text + the `hint` command) are
// also routed through `agent.ask()` so the user can actually converse
// with Sam. File-watcher edits proactively trigger a cadence tick
// after they settle so the model speaks to what was just written.

import * as readline from "node:readline";
import type { CodingAgentAdapter } from "./coding-agent.js";
import type { CoachedSessionState } from "./session.js";
import { CoachStream, type UserUtterance } from "./coach-stream.js";
import {
  CadenceDriver,
  defaultCadenceMode,
  type CadenceDirective,
} from "./cadence-loop.js";
import { TerminalRenderer } from "./terminal-renderer.js";
import { ConversationMemory } from "./conversation-memory.js";
import {
  composeIntroHintPrompt,
  hasZeroCodeActivity,
} from "./intro-hint.js";
import {
  pickTemplate,
  stageForDirectiveKind,
  type CadenceStage,
} from "./stall-nudge-pool.js";

const DEFAULT_FOOTER_TICK_MS = 1_000;

// Task #1506 — Bundled fallback persona text. Mirrors
// `SAM_VOICE.coached_host_reasoning_persona` on the api-server. If the
// server later adds a /runner/voice fetch helper, swap this constant
// for a cached fetch in `buildSystemPrompt`; today the bundled copy is
// authoritative so the runner has zero round-trips before its first
// `ask()` call.
export const HOST_REASONING_PERSONA: string = [
  "You are Sam, a calm and concise interview-prep coach.",
  "Replies are SHORT (one or two sentences), spoken in plain English, and never include code blocks or markdown headings.",
  "You probe and nudge — you do NOT write the candidate's solution for them.",
  "Ground every response in the directive intent, the candidate's most recent code/file state, and what you just said to them.",
  "If the evidence is thin, ask one clarifying question instead of guessing.",
  "Never repeat a hint rung that has already been offered for the same stuck shape.",
].join(" ");

export const OFFLINE_MODE_NOTICE: string =
  "Heads up: cursor-agent isn't available, so I'll fall back to generic nudges instead of reasoned responses. " +
  "Run `cursor-agent login` or set `CURSOR_API_KEY` in your shell to enable host-reasoning Sam.";

// Task #1506 — Per-session system-prompt builder. Interpolates the
// question title + prompt so every `ask()` call grounds the model in
// the problem being worked on. Kept pure + exported so unit tests can
// assert the question text actually lands in the prompt.
export function buildSystemPrompt(
  state: Pick<CoachedSessionState, "questionTitle" | "questionPrompt">,
  personaText: string = HOST_REASONING_PERSONA,
): string {
  const title = (state.questionTitle ?? "").trim();
  const prompt = (state.questionPrompt ?? "").trim();
  const lines: string[] = [personaText, ""];
  if (title.length > 0 || prompt.length > 0) {
    lines.push("The candidate is working on this question:");
    if (title.length > 0) lines.push(`Title: ${title}`);
    if (prompt.length > 0) {
      // Cap the prompt body to keep the system prompt bounded.
      const cap = 4 * 1024;
      const body = prompt.length > cap ? prompt.slice(0, cap) + "\n…(truncated)" : prompt;
      lines.push("Prompt:");
      for (const ln of body.split("\n")) lines.push(`  ${ln}`);
    }
    lines.push("");
  }
  lines.push(
    "Honour the directive intent and constraints exactly. Plain text only — no markdown headings, no code fences.",
  );
  return lines.join("\n");
}

// Task #1506 — User-utterance prompt. Used when the candidate types
// free text or `hint` into the terminal; we hand it to the coding
// agent as the user turn so Sam can author a reasoned reply.
//
// Reviewer feedback (Task #1506 round 1): a Sam reply that isn't
// grounded in recent conversation + current code state reads as
// generic. We therefore include the same evidence block
// `buildAskPrompt` uses for cadence directives: recent context block
// (memory), last failing test, diff snippet, and per-shape
// hints-already-tried (for `/hint`).
export interface BuildUserUtterancePromptOpts {
  commandHint?: string;
  memory?: ConversationMemory | null;
  lastFailingTestName?: string | null;
  diffSnippet?: string | null;
  hintShape?: string | null;
}

export function buildUserUtterancePrompt(
  utterance: string,
  opts: BuildUserUtterancePromptOpts = {},
): string {
  const lines: string[] = [];
  const memBlock = opts.memory?.renderRecentContextBlock() ?? "";
  if (memBlock.length > 0) {
    lines.push(memBlock);
    lines.push("");
  }
  if (opts.commandHint) lines.push(`Directive intent: ${opts.commandHint}`);
  lines.push("Constraints:");
  lines.push("- Stay in Sam's coach voice — supportive, concise, no filler.");
  lines.push("- Do NOT write the candidate's solution for them.");
  lines.push("- One or two sentences. Plain text only.");
  lines.push("");
  lines.push("Evidence:");
  if (opts.lastFailingTestName && opts.lastFailingTestName.trim().length > 0) {
    lines.push(`  Last failing test: ${opts.lastFailingTestName.trim()}`);
  }
  if (opts.diffSnippet && opts.diffSnippet.trim().length > 0) {
    let snip = opts.diffSnippet;
    if (snip.length > ASK_PROMPT_DIFF_SNIPPET_MAX_CHARS) {
      snip = snip.slice(0, ASK_PROMPT_DIFF_SNIPPET_MAX_CHARS) + "\n…(truncated)";
    }
    lines.push("  Diff snippet (truncated):");
    for (const ln of snip.split("\n")) lines.push(`    ${ln}`);
  }
  if (opts.hintShape && opts.memory) {
    const offered = opts.memory.offeredRungsFor(opts.hintShape);
    if (offered.length > 0) {
      lines.push(
        `  Hints already tried for this shape: ${offered.join(", ")} — do not repeat them, build on what you've said.`,
      );
    }
  }
  lines.push("");
  lines.push("Candidate just said:");
  lines.push(`> ${utterance.replace(/\n/g, "\n> ")}`);
  lines.push("");
  lines.push(
    "Reply in one short Sam-voice line that responds to what they said, grounded in the evidence above. " +
      "If you need more information, ask one clarifying question.",
  );
  return lines.join("\n");
}

export interface TerminalCoachOptions {
  state: CoachedSessionState;
  agent: CodingAgentAdapter;
  // Test-only: skip readline (so unit tests can inject stdin synthetically).
  noReadline?: boolean;
  // Test-only: clock + tick override. Defaults to setInterval(Date.now, 1s).
  now?: () => number;
  footerTickMs?: number;
  // Task #1412 — Test-only override of the per-session conversation
  // memory. Production callers leave this undefined and we construct
  // one honouring `PREPSAVANT_COACH_MEMORY=0`.
  memory?: ConversationMemory;
  env?: NodeJS.ProcessEnv;
  // Task #1506 — When true, the runner has detected that the configured
  // coding agent is unavailable (no API key + no local login). The
  // terminal coach surfaces a one-time notice and renderDirectiveAsSamLine
  // falls back to `suggestedWording` rather than calling ask().
  offlineMode?: boolean;
  // Task #1506 r2 — server-fetched (via PersonaCache) overrides for the
  // bundled persona + offline notice constants. Callers pass these
  // in so admins can re-tune Sam's coaching voice from the persona
  // page without shipping a new runner. Either may be omitted and
  // we fall back to the bundled constant.
  personaText?: string;
  offlineNoticeText?: string;
}

export interface TerminalCoach {
  stream: CoachStream;
  renderer: TerminalRenderer;
  driver: CadenceDriver;
  // Resolves when the session ends (Ctrl+C, "quit", or timer expires).
  done: Promise<"user_quit" | "ctrl_c" | "timer_expired" | "error">;
  // Force-stop from outside (used by tests + the api-server end POST).
  end(reason: "user_quit" | "ctrl_c" | "timer_expired" | "error"): void;
}

export function startTerminalCoach(opts: TerminalCoachOptions): TerminalCoach {
  const { state, agent } = opts;
  const stream = new CoachStream();
  // Task #1505 — declared up here so the renderer's `refreshInput`
  // closure (constructed on the next line) can see the binding once
  // readline has been initialised below.
  let rl: readline.Interface | null = null;
  // Task #1505 — give the renderer a hook to refresh the readline
  // input row after we scroll the transcript or first-paint the
  // footer. Without this, the user's in-progress input would visually
  // disappear after Sam speaks (the buffer is still there — readline
  // just needs to repaint it).
  //
  // Task #1508 — Previously this called `rl._refreshLine()`, an
  // underscore-prefixed Node internal whose behaviour has shifted
  // across Node 18/20/22 (especially on Windows where readline's
  // cursor math differs from POSIX). We now redraw using only the
  // DOCUMENTED public surface: `rl.getPrompt()`, `rl.line`, and
  // `rl.cursor` (all stable since Node 15) plus the canonical
  // `readline.cursorTo` / `readline.clearLine` cursor helpers. This
  // works identically on cmd.exe, PowerShell 7, Windows Terminal,
  // and the older conhost — none of which had reliable behaviour
  // when the internal underscore method was called.
  const renderer = new TerminalRenderer({
    stream,
    refreshInput: () => {
      if (!rl) return;
      try {
        redrawReadlineRow(rl, process.stdout);
      } catch {
        /* noop */
      }
    },
  });
  const now = opts.now ?? Date.now;
  const footerTickMs = opts.footerTickMs ?? DEFAULT_FOOTER_TICK_MS;
  const env = opts.env ?? process.env;
  const memory =
    opts.memory ??
    new ConversationMemory({ enabled: env["PREPSAVANT_COACH_MEMORY"] !== "0" });
  const offlineMode = !!opts.offlineMode;
  const personaText = opts.personaText ?? HOST_REASONING_PERSONA;
  const offlineNoticeText = opts.offlineNoticeText ?? OFFLINE_MODE_NOTICE;
  const systemPrompt = buildSystemPrompt(state, personaText);

  // Task #1506 — one-time offline-mode notice. Surfaced as a status
  // line (not a Sam line) so the user can tell the difference between
  // "Sam said this" and "the runner is warning you".
  if (offlineMode) {
    stream.emitStatus({ text: offlineNoticeText, emittedAt: now() });
  }

  let endResolve: (r: "user_quit" | "ctrl_c" | "timer_expired" | "error") => void;
  const done = new Promise<"user_quit" | "ctrl_c" | "timer_expired" | "error">(
    (r) => {
      endResolve = r;
    },
  );

  // Task #1506 — Dedupe guard. Suppresses an emit if the same
  // (kind + hint metadata + text-hash) was emitted within the last
  // few seconds. Stops a cadence-tick race + a user-utterance reply
  // from both speaking essentially the same nudge back-to-back.
  const recentEmits: Array<{ key: string; at: number }> = [];
  const DEDUPE_WINDOW_MS = 4_000;
  function shouldSuppressEmit(key: string, at: number): boolean {
    // Drop expired entries.
    while (recentEmits.length > 0 && at - recentEmits[0]!.at > DEDUPE_WINDOW_MS) {
      recentEmits.shift();
    }
    for (const e of recentEmits) {
      if (e.key === key) return true;
    }
    recentEmits.push({ key, at });
    return false;
  }

  // ----- Cadence sink: turn directives into Sam lines ----------------
  // Task #1561 — Skip-SDK-on-empty-tick tracking. A "pure idle" cadence
  // tick has no new diff, no new user utterance, and no new failing
  // test, so the SDK has nothing to reason about and will return an
  // empty reply (then fall through to a generic templated nudge). We
  // detect that BEFORE the ask() round-trip, force the directive into
  // verbatim_relay mode, and pick a fresh template from the broader
  // pool. Saves ~1-3s of latency per tick and a non-trivial slice of
  // Cursor API quota over a 30-minute session.
  let lastSignalEditAt = state.lastEditAt;
  let lastSignalFailingTest = state.lastFailingTest;
  // Ring buffer of recently emitted template lines so we keep variety
  // even when the dedupe window expires. Sized to one pool's worth so
  // we cycle the full set before repeating.
  const RECENT_TEMPLATES_CAP = 20;
  const recentTemplates: string[] = [];
  // Saved-call counter for the session-end summary.
  const sdkCallStats = {
    skippedEmptyTicks: 0,
  };
  function noteEmittedTemplate(line: string): void {
    recentTemplates.push(line);
    if (recentTemplates.length > RECENT_TEMPLATES_CAP) {
      recentTemplates.splice(0, recentTemplates.length - RECENT_TEMPLATES_CAP);
    }
  }
  function isEmptyContentTick(directive: CadenceDirective): boolean {
    // Task #1561 (review pass) — broadened from `stall_nudge` only to
    // ALL cadence kinds. Any directive that fires WITHOUT a new diff,
    // a new failing test, or a new user utterance since the previous
    // tick has nothing fresh for the SDK to reason about; the
    // round-trip will reliably return empty or generic text. The
    // exception is `time_warning:*` directives, which DO have new
    // signal (the clock crossed a milestone) and must keep their
    // host-reasoning path.
    if (directive.kind.startsWith("time_warning")) return false;
    const editChanged = state.lastEditAt !== lastSignalEditAt;
    const failingChanged = state.lastFailingTest !== lastSignalFailingTest;
    // The readline handler bumps `state.lastEditAt` on every user
    // utterance, so `editChanged` already covers free-form input and
    // /hint commands too.
    return !editChanged && !failingChanged;
  }
  function rewriteAsTemplatedNudge(
    directive: CadenceDirective,
    stage: CadenceStage,
  ): CadenceDirective {
    const recent = new Set(recentTemplates);
    const text = pickTemplate(stage, recent);
    noteEmittedTemplate(text);
    return {
      ...directive,
      mode: "verbatim_relay",
      mustBeVerbatim: false,
      suggestedWording: text,
    };
  }

  const driver = new CadenceDriver({
    state,
    sink: (directive: CadenceDirective) => {
      let effective = directive;
      if (isEmptyContentTick(directive)) {
        sdkCallStats.skippedEmptyTicks += 1;
        effective = rewriteAsTemplatedNudge(
          directive,
          stageForDirectiveKind(directive.kind),
        );
      }
      // Update signal markers AFTER the decision so the next tick
      // compares against the snapshot at THIS tick's emit time.
      lastSignalEditAt = state.lastEditAt;
      lastSignalFailingTest = state.lastFailingTest;
      void renderDirectiveAsSamLine(effective, stream, agent, {
        state,
        memory,
        systemPrompt,
        offlineMode,
        shouldSuppressEmit,
      }).catch(() => {
        // Sink failures must never crash the coach.
      });
      if (effective.hintShape && effective.hintRung) {
        state.shapeLadderState[effective.hintShape] = effective.hintRung;
      }
    },
  });
  // Expose the saved-call counter on the returned coach handle so the
  // session-end caller can log it in the recap summary. Stash on the
  // state for the simplest test surface; the cadence driver itself
  // doesn't need it.
  (state as unknown as { sdkCallStats?: typeof sdkCallStats }).sdkCallStats =
    sdkCallStats;
  state.cadence = driver;
  driver.start();

  // ----- Footer tick + proactive file-edit tick ----------------------
  // Task #1506 — when the user has saved a new edit since the last
  // cadence tick AND a few seconds have passed since the edit settled,
  // force a `driver.tick()` so Sam can speak to what just changed
  // without waiting on the 15s cadence interval. Throttled by
  // `lastProactiveTickAt` so a noisy save burst doesn't fire repeatedly.
  let lastSeenEditAt = state.lastEditAt;
  let lastProactiveTickAt = 0;
  const PROACTIVE_TICK_SETTLE_MS = 3_000;
  const PROACTIVE_TICK_COOLDOWN_MS = 10_000;
  const footerTimer = setInterval(() => {
    const t = now();
    stream.emitTick({
      sessionId: state.sessionId,
      elapsedMs: t - state.startedAt,
      remainingMs:
        state.targetDurationMs == null
          ? null
          : state.targetDurationMs - (t - state.startedAt),
      hintRung: pickCurrentHintRung(state),
    });
    // Proactive edit-driven tick.
    if (
      state.lastEditAt !== lastSeenEditAt &&
      t - state.lastEditAt >= PROACTIVE_TICK_SETTLE_MS &&
      t - lastProactiveTickAt >= PROACTIVE_TICK_COOLDOWN_MS
    ) {
      lastSeenEditAt = state.lastEditAt;
      lastProactiveTickAt = t;
      try {
        driver.tick();
      } catch {
        /* noop */
      }
    }
    if (
      state.targetDurationMs != null &&
      t - state.startedAt > state.targetDurationMs + 2 * 60_000
    ) {
      endStream("timer_expired");
    }
  }, footerTickMs);
  (footerTimer as { unref?: () => void }).unref?.();

  // ----- Readline input loop ----------------------------------------
  // (`rl` is declared above so the renderer's refreshInput closure can
  // see the binding once we assign it below.)
  let sigintHandler: (() => void) | null = null;
  // Task #1508 — Hook resize so the footer + input row redraw when
  // the user drags the terminal window edge. POSIX delivers
  // `SIGWINCH`; Windows + POSIX BOTH fire `process.stdout`'s
  // `'resize'` event (it's a `tty.WriteStream` event). Wiring both
  // is belt-and-braces: on Linux/macOS either path works; on
  // Windows only the stdout event fires; on a future runtime that
  // signals one but not the other we still get a redraw.
  let resizeHandler: (() => void) | null = null;
  let sigwinchHandler: (() => void) | null = null;
  if (!opts.noReadline && process.stdin.isTTY) {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
      prompt: "",
    });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;
      const utt = parseUtterance(trimmed, now());
      stream.emitUser(utt);
      memory.pushUser(trimmed);
      if (utt.command === "quit") {
        endStream("user_quit");
        return;
      }
      // Task #1561 — snapshot the edit timestamp BEFORE we bump it for
      // this utterance; handleUserUtterance's intro-hint gate uses the
      // snapshot to decide whether any prior code activity exists.
      const lastEditAtBeforeUtterance = state.lastEditAt;
      // User typing engages the loop and pre-empts any pending stall
      // nudge: bump lastEditAt so the next decideProactiveDirective
      // does not treat the user as stalled.
      state.lastEditAt = now();
      // Task #1506 — route free-text + `hint` through ask() so Sam
      // can author a reasoned reply.
      //
      // Explicitly out of scope: `submit` and `skip` are state-machine
      // commands owned by the server (they advance/end the session,
      // not the coach voice). The runner deliberately does NOT ask()
      // for them — Sam's wrap-up line is server-authored after submit,
      // and skip is a silent transition.
      const shouldAsk =
        !offlineMode && (utt.command === undefined || utt.command === "hint");
      if (shouldAsk) {
        void handleUserUtterance(utt, {
          agent,
          stream,
          state,
          memory,
          systemPrompt,
          now,
          shouldSuppressEmit,
          lastEditAtBeforeUtterance,
        }).catch(() => {
          // ask() failures must never crash the coach.
        });
      } else if (offlineMode && utt.command === "hint") {
        // Task #1506 r2 — offline-mode hint fallback: the user asked
        // for help and we have no ask() to call. Emit an immediate
        // canned Sam line so they get an acknowledgement now AND
        // force a cadence tick so the next stall_nudge / hint_offer
        // fires on the next interval with a fresh suggestedWording.
        const at = now();
        if (
          !shouldSuppressEmit(
            `offline_hint|${state.sessionId}`,
            at,
          )
        ) {
          stream.emitSam({
            kind: "hint_offer",
            text: "Let's pause and look at what you've tried so far. Walk me through it.",
            emittedAt: at,
            directiveKind: "user_utterance:hint",
          });
          memory.pushSam(
            "Let's pause and look at what you've tried so far. Walk me through it.",
          );
        }
        try {
          driver.tick();
        } catch {
          /* noop */
        }
      }
    });
    sigintHandler = () => endStream("ctrl_c");
    process.on("SIGINT", sigintHandler);

    // Task #1508 — Wire terminal resize so the footer + readline
    // input row redraw cleanly when the window edge is dragged.
    // `tty.WriteStream`'s `'resize'` event fires on Windows AND
    // POSIX; `SIGWINCH` is POSIX-only. We register both so every
    // host we support (PowerShell 7, Windows Terminal, conhost,
    // macOS Terminal, Linux xterm) gets a redraw.
    resizeHandler = () => {
      const cols = (process.stdout as { columns?: number }).columns;
      renderer.onResize(typeof cols === "number" ? cols : undefined);
    };
    try {
      (process.stdout as unknown as {
        on: (ev: string, fn: () => void) => void;
      }).on("resize", resizeHandler);
    } catch {
      resizeHandler = null;
    }
    if (process.platform !== "win32") {
      sigwinchHandler = () => {
        const cols = (process.stdout as { columns?: number }).columns;
        renderer.onResize(typeof cols === "number" ? cols : undefined);
      };
      try {
        process.on("SIGWINCH", sigwinchHandler);
      } catch {
        sigwinchHandler = null;
      }
    }
  }

  function endStream(
    reason: "user_quit" | "ctrl_c" | "timer_expired" | "error",
  ): void {
    try {
      driver.stop();
    } catch {
      /* noop */
    }
    try {
      clearInterval(footerTimer);
    } catch {
      /* noop */
    }
    if (rl) {
      try {
        rl.close();
      } catch {
        /* noop */
      }
      rl = null;
    }
    if (sigintHandler) {
      try {
        process.removeListener("SIGINT", sigintHandler);
      } catch {
        /* noop */
      }
      sigintHandler = null;
    }
    // Task #1508 — Drop the resize listeners we registered above so
    // we don't leak handlers across sessions in a long-lived host
    // process (the runner CLI is single-session today, but the
    // TerminalCoach is also constructable from tests and future
    // multi-session hosts).
    if (resizeHandler) {
      try {
        (process.stdout as unknown as {
          removeListener: (ev: string, fn: () => void) => void;
        }).removeListener("resize", resizeHandler);
      } catch {
        /* noop */
      }
      resizeHandler = null;
    }
    if (sigwinchHandler) {
      try {
        process.removeListener("SIGWINCH", sigwinchHandler);
      } catch {
        /* noop */
      }
      sigwinchHandler = null;
    }
    stream.emitEnd(reason);
    endResolve(reason);
  }

  return {
    stream,
    renderer,
    driver,
    done,
    end: endStream,
  };
}

// Task #1505 — accepted aliases for "end this session cleanly". Kept
// as a `const` array (rather than inlined) so the startup banner can
// render the same list in its help text without drift, and so the
// regression tests can iterate it.
export const QUIT_ALIASES: readonly string[] = [
  "quit",
  "exit",
  ":q",
  "stop",
  "end",
  "bye",
];

export function parseUtterance(text: string, ts: number): UserUtterance {
  const lower = text.toLowerCase();
  if (QUIT_ALIASES.includes(lower)) {
    return { text, command: "quit", emittedAt: ts };
  }
  if (lower === "hint" || lower === "/hint") {
    return { text, command: "hint", emittedAt: ts };
  }
  if (lower === "submit" || lower === "/submit") {
    return { text, command: "submit", emittedAt: ts };
  }
  if (lower === "skip" || lower === "/skip") {
    return { text, command: "skip", emittedAt: ts };
  }
  return { text, emittedAt: ts };
}

function pickCurrentHintRung(state: CoachedSessionState): string | null {
  const rungs = Object.values(state.shapeLadderState).filter(Boolean) as string[];
  if (rungs.length === 0) return null;
  return rungs.sort().join(",");
}

// Task #1508 — Documented-API replacement for `rl._refreshLine()`.
// Reads the prompt + buffer + cursor offset off the public readline
// surface (`getPrompt()`, `line`, `cursor` — all stable since Node
// 15.3) and repaints the input row using the standard `readline`
// cursor helpers. Behaves identically on POSIX and Windows shells
// (cmd.exe, PowerShell 7, Windows Terminal, conhost) because every
// byte we emit is one of: `\r` (cursorTo), `\x1b[K` (clearLine), or
// printable text — no underscore-prefixed internals.
//
// Exported for unit tests; production callers go through the
// `refreshInput` closure wired in `startTerminalCoach`.
export function redrawReadlineRow(
  rl: readline.Interface,
  out: NodeJS.WritableStream,
): void {
  const r = rl as readline.Interface & {
    line?: string;
    cursor?: number;
    getPrompt?: () => string;
  };
  const prompt = typeof r.getPrompt === "function" ? r.getPrompt() : "";
  const line = typeof r.line === "string" ? r.line : "";
  const cursorOffset =
    typeof r.cursor === "number"
      ? Math.max(0, Math.min(r.cursor, line.length))
      : line.length;
  readline.cursorTo(out, 0);
  readline.clearLine(out, 0);
  out.write(prompt + line);
  readline.cursorTo(out, prompt.length + cursorOffset);
}

export interface RenderDirectiveOpts {
  state?: CoachedSessionState;
  memory?: ConversationMemory;
  // Task #1506 — per-session system prompt + offline-mode + dedupe
  // guard. All optional so existing call sites (and the Task #1412
  // tests that pass just state+memory) continue to compile.
  systemPrompt?: string;
  offlineMode?: boolean;
  shouldSuppressEmit?: (key: string, at: number) => boolean;
}

// Task #1561 — Text-based dedupe. Previously keyed by directive kind +
// hint metadata + text-prefix, which let two different directives that
// happened to fall back to the same templated wording slip through
// dedupe and emit 3x in ~90s (`ses_3tofurxbf1`). Keying by normalized
// text alone collapses ANY exact-text repeat within DEDUPE_WINDOW_MS,
// regardless of which directive produced it.
//
// Note we deliberately keep `directive` in the signature for forward
// compatibility (callers may want to add a future cross-directive
// salt) — today it's unused.
export function emitDedupeKey(_directive: CadenceDirective, text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

export async function renderDirectiveAsSamLine(
  directive: CadenceDirective,
  stream: CoachStream,
  agent: CodingAgentAdapter,
  opts: RenderDirectiveOpts = {},
): Promise<void> {
  let text = directive.suggestedWording ?? "";
  const offlineMode = opts.offlineMode === true;
  // Host-reasoning directives have no suggestedWording — author one
  // via the coding-agent adapter using the directive intent + evidence.
  // Task #1506 — offline mode skips the ask() call entirely and falls
  // back to whatever `suggestedWording` carries (the cadence-loop
  // builders still populate it so we never emit an empty Sam line).
  const wantsAsk =
    !offlineMode &&
    (directive.mode === "host_reasoning" || text.trim().length === 0);
  if (wantsAsk) {
    if (text.trim().length === 0 && directive.mode !== "host_reasoning") {
      // Verbatim relay missing wording (server bug). Fallback below.
    } else {
      try {
        const reply = await agent.ask({
          systemPrompt: opts.systemPrompt ?? HOST_REASONING_PERSONA,
          userPrompt: buildAskPrompt(directive, {
            ...(opts.state?.lastFailingTest
              ? { lastFailingTestName: opts.state.lastFailingTest }
              : {}),
            ...(opts.state?.lastDiffSnippet
              ? { diffSnippet: opts.state.lastDiffSnippet }
              : {}),
            ...(opts.memory ? { memory: opts.memory } : {}),
          }),
        });
        if (reply.text.trim().length > 0) text = reply.text;
      } catch {
        // adapter failure → keep verbatim/fallback below.
      }
    }
  }
  if (text.trim().length === 0) {
    text = "Let's pause and talk through where you are.";
  }
  // Dedupe guard — skip the emit entirely if an equivalent line just
  // fired. Conversation memory is also skipped so a redundant "you
  // already saw this" doesn't enter the recent-context block.
  if (
    opts.shouldSuppressEmit &&
    opts.shouldSuppressEmit(emitDedupeKey(directive, text), directive.emittedAt)
  ) {
    return;
  }
  opts.memory?.pushSam(text, {
    ...(directive.hintShape ? { hintShape: directive.hintShape } : {}),
    ...(directive.hintRung ? { hintRung: directive.hintRung } : {}),
  });
  stream.emitSam({
    kind: classifySamLineKind(directive),
    text,
    emittedAt: directive.emittedAt,
    directiveKind: directive.kind,
    ...(directive.hintRung ? { hintRung: directive.hintRung } : {}),
    ...(directive.hintShape ? { hintShape: directive.hintShape } : {}),
  });
}

export function classifySamLineKind(d: CadenceDirective): import("./coach-stream.js").SamLineKind {
  if (d.kind.startsWith("time_warning:over_time")) return "wrap_up";
  if (d.kind.startsWith("time_warning:")) return "time_warning";
  if (d.kind.startsWith("hint_offer:")) return "hint_offer";
  if (d.kind.startsWith("stall_nudge")) return "stall_nudge";
  if (d.kind.startsWith("user_utterance:")) return "free";
  return "free";
}

// Task #1506 — Route a user utterance through `agent.ask()` so Sam
// authors a reasoned reply. Emits a status "thinking…" beat first so
// the user knows their input registered even if the ask() round trip
// takes a couple of seconds. Exported for unit tests.
export interface HandleUtteranceOpts {
  agent: CodingAgentAdapter;
  stream: CoachStream;
  state: CoachedSessionState;
  memory: ConversationMemory;
  systemPrompt: string;
  now?: () => number;
  shouldSuppressEmit?: (key: string, at: number) => boolean;
  // Task #1561 — see comment on ZeroCodeActivityInput. Optional so
  // unit tests can omit it when constructing a fresh session.
  lastEditAtBeforeUtterance?: number;
}

export async function handleUserUtterance(
  utt: UserUtterance,
  opts: HandleUtteranceOpts,
): Promise<void> {
  const now = opts.now ?? Date.now;
  const at = now();
  opts.stream.emitStatus({ text: "Sam is thinking…", emittedAt: at });

  // Task #1561 — Substantive first-hint path. When the user types
  // /hint (or any free-form question) BEFORE any code activity, the
  // standard prompt has nothing concrete to ground on and replies
  // come out generic. Compose an explicit "orient the candidate to
  // the question" prompt instead, with a hard "do NOT solve anything"
  // constraint baked in. Once the first substantive exchange has
  // happened, fall back to the regular prompt path below.
  const introHintEligible = hasZeroCodeActivity({
    state: opts.state,
    memory: opts.memory,
    lastEditAtBeforeUtterance: opts.lastEditAtBeforeUtterance,
  });
  if (introHintEligible) {
    let introText = "";
    try {
      const reply = await opts.agent.ask({
        systemPrompt: opts.systemPrompt,
        userPrompt: composeIntroHintPrompt({
          questionTitle: opts.state.questionTitle,
          questionPrompt: opts.state.questionPrompt,
          utterance: utt.text,
        }),
      });
      introText = reply.text;
    } catch {
      // adapter failure — fall through to the legacy path below.
    }
    if (introText.trim().length > 0) {
      if (
        opts.shouldSuppressEmit &&
        opts.shouldSuppressEmit(
          emitDedupeKey(
            {
              kind: `user_utterance:${utt.command ?? "free"}:intro_hint`,
            } as CadenceDirective,
            introText,
          ),
          at,
        )
      ) {
        return;
      }
      opts.memory.pushSam(introText);
      opts.stream.emitSam({
        kind: "free",
        text: introText,
        emittedAt: at,
        directiveKind: `user_utterance:${utt.command ?? "free"}:intro_hint`,
      });
      return;
    }
    // Empty reply — fall through to the regular path so the templated
    // fallback still fires rather than leaving the user hanging.
  }

  const commandHint =
    utt.command === "hint"
      ? "The candidate asked for a hint. Offer the next-step nudge grounded in the current code and what you've said before. Do NOT repeat a hint rung you've already given."
      : "The candidate just spoke in chat. Reply in Sam's voice — answer or probe further. Do NOT write the candidate's solution for them.";
  const synthetic: CadenceDirective = {
    kind: `user_utterance:${utt.command ?? "free"}`,
    action: utt.command === "hint" ? "hint_offer" : "probe",
    reason: "user_input",
    intent: commandHint,
    constraints: [
      "Stay in Sam's coach voice — supportive, concise, no filler.",
      "Do NOT write the candidate's solution for them.",
      "One or two sentences. Plain text only.",
    ],
    suggestedWording: null,
    mustBeVerbatim: false,
    mode: "host_reasoning",
    emittedAt: at,
    sessionId: opts.state.sessionId,
  };
  let text = "";
  // Task #1506 r2 — pick the most recent hint shape from the ladder
  // so /hint replies don't repeat a rung we've already offered for
  // the same stuck shape.
  const recentHintShape =
    Object.entries(opts.state.shapeLadderState).find(([, v]) => !!v)?.[0] ?? null;
  try {
    const reply = await opts.agent.ask({
      systemPrompt: opts.systemPrompt,
      userPrompt: buildUserUtterancePrompt(utt.text, {
        commandHint,
        memory: opts.memory,
        lastFailingTestName: opts.state.lastFailingTest,
        diffSnippet: opts.state.lastDiffSnippet,
        ...(utt.command === "hint" && recentHintShape
          ? { hintShape: recentHintShape }
          : {}),
      }),
    });
    text = reply.text;
  } catch {
    // adapter failure — fall through to the generic line below.
  }
  if (text.trim().length === 0) {
    text =
      utt.command === "hint"
        ? "Let's pause and look at what you've tried so far. Walk me through it."
        : "Tell me more — what did you try, and what did you see?";
  }
  if (
    opts.shouldSuppressEmit &&
    opts.shouldSuppressEmit(emitDedupeKey(synthetic, text), at)
  ) {
    return;
  }
  opts.memory.pushSam(text);
  opts.stream.emitSam({
    kind: "free",
    text,
    emittedAt: at,
    directiveKind: synthetic.kind,
  });
}

// Re-export so existing callers don't break.
export { defaultCadenceMode };

// Task #1412 — extra evidence + memory hooks for buildAskPrompt. Kept
// optional so existing call sites (and the unit tests that pass just
// the directive) continue to compile.
export interface BuildAskPromptEvidence {
  lastFailingTestName?: string | null;
  diffSnippet?: string | null;
  memory?: ConversationMemory | null;
}

export const ASK_PROMPT_DIFF_SNIPPET_MAX_CHARS = 4 * 1024;

export function buildAskPrompt(
  d: CadenceDirective,
  evidence: BuildAskPromptEvidence = {},
): string {
  const lines: string[] = [];
  const memBlock = evidence.memory?.renderRecentContextBlock() ?? "";
  if (memBlock.length > 0) {
    lines.push(memBlock);
    lines.push("");
  }
  lines.push(`Directive intent: ${d.intent}`);
  if (d.constraints.length > 0) {
    lines.push("Constraints:");
    for (const c of d.constraints) lines.push(`- ${c}`);
  }
  lines.push("Evidence:");
  if (d.hintRung) lines.push(`  Hint rung: ${d.hintRung}`);
  if (d.hintShape) lines.push(`  Stuck shape: ${d.hintShape}`);
  if (evidence.lastFailingTestName && evidence.lastFailingTestName.trim().length > 0) {
    lines.push(`  Last failing test: ${evidence.lastFailingTestName.trim()}`);
  }
  if (evidence.diffSnippet && evidence.diffSnippet.trim().length > 0) {
    let snip = evidence.diffSnippet;
    if (snip.length > ASK_PROMPT_DIFF_SNIPPET_MAX_CHARS) {
      snip = snip.slice(0, ASK_PROMPT_DIFF_SNIPPET_MAX_CHARS) + "\n…(truncated)";
    }
    lines.push("  Diff snippet (truncated):");
    for (const ln of snip.split("\n")) lines.push(`    ${ln}`);
  }
  if (d.hintShape && evidence.memory) {
    const offered = evidence.memory.offeredRungsFor(d.hintShape);
    if (offered.length > 0) {
      lines.push(
        `  Hints already tried for this shape: ${offered.join(", ")} — do not repeat them, build on what you've said.`,
      );
    }
  }
  lines.push(
    "Author one short Sam-voice line that delivers the intent under those " +
      "constraints, grounded in the evidence. Plain text only. No markdown " +
      "headings, no code fences.",
  );
  return lines.join("\n");
}

// Re-export so callers don't have to deep-import.
export { ConversationMemory };
