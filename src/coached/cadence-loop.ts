// Task #1169 — Cursor-first v1 Milestone 4.
//
// Local cadence loop: the runner is now the system of record for a
// Coached session. A per-session timer ticks every CADENCE_TICK_MS and
// proactively decides whether to emit a directive (stall nudge,
// hint-ladder escalation, time-warning at 50/75/90%, recap). Emitted
// directives are pushed to the host out-of-band via a `sink` callback
// (server.ts wires this to MCP server-initiated `notifications/message`
// + a per-session pending-directives queue). The host no longer has to
// poll `coached_check_in` to make Sam speak.
//
// The legacy `coached_check_in` tool is kept as a no-op acknowledgement
// that returns the most recent UNSENT queued directive, gated on the
// host echoing back acknowledged `directiveId` values. See server.ts.
//
// Decision logic is a pure function so it's unit-testable without a
// real timer. The driver class only owns the setInterval lifecycle and
// the dedup state; everything else flows through the pure decider.
import type { TimeMilestone } from "@workspace/session-milestones";
import { timeMilestoneFor } from "@workspace/session-milestones";

import { STALL_PROBE_LINES } from "../persona-cache.js";
import {
  pickStallProbeVariant,
  STALL_ESCALATION_REASON,
} from "./check-in.js";
import type { CoachedSessionState } from "./session.js";
import { isStalled, STALL_WINDOW_MS } from "./session.js";
import {
  classifyStuckShape,
  fallbackProbeText,
  nextRung,
  rungOrdinal,
  LADDER_RUNGS,
  type LadderRung,
  type StuckShape,
} from "./stuck-shape.js";

// How often the cadence loop wakes up to evaluate whether a directive
// should fire. 15s is a tradeoff: short enough that a 50/75/90% time
// warning lands within a quarter-minute of its target, long enough to
// stay invisible in CPU usage and avoid waking up the host's MCP
// transport on every second.
export const CADENCE_TICK_MS = 15_000;

// Task #1506 — Default directive mode for cadence-emitted directives.
// Flipped to `host_reasoning` so the runner authors each Sam line via
// cursor-agent (grounded in question + code state + memory) instead of
// firing canned `verbatim_relay` strings from STALL_PROBE_LINES /
// fallbackProbeText / TIME_WARNING_LINES. The env kill switch lets an
// operator revert without a runner publish. `suggestedWording` is kept
// as a fallback so renderDirectiveAsSamLine has something to speak if
// the host-reasoning ask() call fails or times out.
export const COACH_VERBATIM_ENV = "PREPSAVANT_COACH_VERBATIM";
export function defaultCadenceMode(
  env: NodeJS.ProcessEnv = process.env,
): "verbatim_relay" | "host_reasoning" {
  return env[COACH_VERBATIM_ENV] === "1" ? "verbatim_relay" : "host_reasoning";
}

// Shape every cadence-emitted directive carries on the wire. Mirrors
// the host-facing fields of `CheckInDirective` / `buildCheckInPayload`
// so a host that previously drained directives via `coached_check_in`
// can render the same JSON without branching. `directiveId` is added
// in M4 (code-review pass 2) so the host can acknowledge a notification-
// path delivery and prevent the demoted `coached_check_in` tool from
// re-relaying the same nudge.
export interface CadenceDirective {
  // `stall_nudge:<lastEditAt>`
  // | `time_warning:<milestone>`
  // | `hint_offer:<shape>:<rung>`
  kind: string;
  action: string;
  reason: string;
  intent: string;
  constraints: string[];
  suggestedWording: string | null;
  mustBeVerbatim: boolean;
  mode: "verbatim_relay" | "host_reasoning";
  // Best-effort metadata for the host / debug surface.
  emittedAt: number;
  sessionId: string;
  // Optional metadata surfaced to the recap so end-of-session can
  // group hint events by stuck shape and ladder rung.
  hintShape?: StuckShape;
  hintRung?: LadderRung;
  hintLevel?: number;
}

export interface CadenceDeciderInput {
  state: CoachedSessionState;
  now: number;
  // Set of `kind` values that already fired in this session. The pure
  // decider uses it for dedup; the driver owns the canonical set.
  alreadyFired: ReadonlySet<string>;
}

// Pure decision function. Returns the directive that should fire on
// THIS tick, or `null` if nothing changed. Always returns at most one
// directive per tick — the priority order below ensures the most
// important nudge wins:
//
//   1. time_warning:over_time   (>=100% of target duration)
//   2. time_warning:final_stretch (>=90%)
//   3. time_warning:warning       (>=75%)
//   4. time_warning:midway        (>=50%)
//   5. hint_offer:<shape>:<rung> (escalates the per-shape ladder
//      using the SAME stuck-shape classifier the api-server runs on
//      check-ins; the runner advances one rung at a time per shape
//      and saturates at "directive". Reuses
//      `STUCK_SHAPE_GLOBAL_FALLBACK` so wording does not drift
//      between server and runner.)
//   6. stall_nudge (no edits past STALL_WINDOW_MS)
//
// Each `kind` is fired at most once per session via the `alreadyFired`
// set the driver maintains.
export function decideProactiveDirective(
  input: CadenceDeciderInput,
): CadenceDirective | null {
  const { state, now, alreadyFired } = input;

  // 1) Time warnings — derived from `targetDurationMs`. Sessions
  //    without a target duration never fire time warnings.
  if (state.targetDurationMs != null && state.targetDurationMs > 0) {
    const elapsed = now - state.startedAt;
    const pct = elapsed / state.targetDurationMs;
    const milestone = timeMilestoneFor(pct);
    if (milestone) {
      const kind = `time_warning:${milestone}`;
      if (!alreadyFired.has(kind)) {
        return buildTimeWarning(state.sessionId, milestone, now);
      }
    }
  }

  // 2) Hint-ladder escalation, gated on a real stall. Uses the
  //    server-aligned stuck-shape classifier (see
  //    `coached/stuck-shape.ts`) so the silent-host case escalates
  //    against the SAME shape ladder the server-side check-in flow
  //    used to drive — not an independent "after N stalls bump a
  //    rung" heuristic. The decider advances one rung per shape and
  //    saturates at `directive`, mirroring `nextRung` in
  //    `coached-probes.ts`.
  if (isStalled(state, now)) {
    const idleMs = Math.max(0, now - state.lastEditAt);
    const shape = classifyStuckShape({
      idleMs,
      attemptsTotal: state.attemptsTotal ?? 0,
      consecutiveFailingTestCount: state.consecutiveFailingTestCount ?? 0,
      filesChangedSinceLastCheckIn: state.editedFilesSinceLastCheckIn.size,
      attemptsInRecentWindow: null,
      // The runner has no direct "best passed count vs latest passed"
      // window, so we leave this null rather than guess — the
      // classifier degrades gracefully (regression branch is skipped).
      regressedFromBest: null,
      distinctFailingTestsInWindow: null,
    });
    if (shape) {
      const currentRung = state.shapeLadderState[shape] ?? null;
      const proposed = nextRung(currentRung);
      // saturate at "directive": once we've issued the strongest rung
      // for a shape we never re-emit it (dedup via `alreadyFired`).
      const kind = hintOfferKind(shape, proposed);
      const isAlreadySaturated =
        currentRung === "directive" && proposed === "directive";
      if (!isAlreadySaturated && !alreadyFired.has(kind)) {
        return buildHintOffer(state, shape, proposed, now);
      }
    }
  }

  // 3) Stall nudge. `isStalled` already captures the STALL_WINDOW_MS
  //    threshold; the driver dedups so we only fire once per stall
  //    window (a fresh edit re-arms the marker via the watcher).
  if (isStalled(state, now) && !alreadyFired.has(stallKindFor(state))) {
    return buildStallNudge(state, now);
  }

  return null;
}

export function hintOfferKind(shape: StuckShape, rung: LadderRung): string {
  return `hint_offer:${shape}:${rung}`;
}

// Stall kind is keyed off `lastEditAt` so a fresh edit re-arms a new
// kind value and the next stall window can fire its own nudge without
// the dedup set growing unbounded.
export function stallKindFor(state: CoachedSessionState): string {
  return `stall_nudge:${state.lastEditAt}`;
}

function buildTimeWarning(
  sessionId: string,
  milestone: TimeMilestone,
  now: number,
): CadenceDirective {
  const wording = TIME_WARNING_LINES[milestone] ?? "";
  return {
    kind: `time_warning:${milestone}`,
    action: milestone === "over_time" ? "wrap_up" : "time_warning",
    reason: `runner_cadence_time_warning:${milestone}`,
    intent:
      milestone === "over_time"
        ? "Surface that the candidate is past the target duration; offer to wrap up cleanly."
        : "Surface a time milestone so the candidate can pace themselves.",
    constraints: [
      "Stay in Sam's coach voice — supportive, concise, no filler.",
      "Do NOT reveal the solution or write code on the candidate's behalf.",
    ],
    suggestedWording: wording,
    mustBeVerbatim: false,
    mode: defaultCadenceMode(),
    emittedAt: now,
    sessionId,
  };
}

function buildStallNudge(
  state: CoachedSessionState,
  now: number,
): CadenceDirective {
  const variant = pickStallProbeVariant(state);
  const wording = STALL_PROBE_LINES[variant];
  return {
    kind: stallKindFor(state),
    action: "probe",
    reason: `${STALL_ESCALATION_REASON}:${variant}`,
    intent:
      "Break a long silence: nudge the candidate to think out loud about what they are stuck on.",
    constraints: [
      "Stay in Sam's coach voice — supportive, concise, no filler.",
      "Do NOT reveal the solution or write code on the candidate's behalf.",
    ],
    suggestedWording: wording,
    mustBeVerbatim: false,
    mode: defaultCadenceMode(),
    emittedAt: now,
    sessionId: state.sessionId,
  };
}

function buildHintOffer(
  state: CoachedSessionState,
  shape: StuckShape,
  rung: LadderRung,
  now: number,
): CadenceDirective {
  const wording = fallbackProbeText(shape, rung);
  const level = rungOrdinal(rung);
  return {
    kind: hintOfferKind(shape, rung),
    action: "hint_offer",
    reason: `runner_cadence_hint_offer:${shape}:${rung}`,
    intent:
      "Offer a graduated, shape-aware hint after the candidate has stayed silent through a stall window. Stronger than a probe, weaker than the answer.",
    constraints: [
      "Stay in Sam's coach voice — supportive, concise, no filler.",
      "Do NOT reveal the solution or write code on the candidate's behalf.",
      `Hint rung ${rung} (level=${level} of ${LADDER_RUNGS.length}); do NOT skip rungs.`,
    ],
    suggestedWording: wording,
    mustBeVerbatim: false,
    mode: defaultCadenceMode(),
    emittedAt: now,
    sessionId: state.sessionId,
    hintShape: shape,
    hintRung: rung,
    hintLevel: level,
  };
}

// Sam-voice copy for each time milestone. Kept inline (rather than
// adding to persona-cache.ts) so the runner-driven cadence loop owns
// its own warning wording without needing a persona refresh.
const TIME_WARNING_LINES: Record<TimeMilestone, string> = {
  midway:
    "Halfway through. How's the plan holding up — anything you want to rethink before you push deeper?",
  warning:
    "About a quarter of your time left. Worth checking that the path you're on actually gets you to a passing answer.",
  final_stretch:
    "Final stretch — last 10% of your time. If you're not converging, now's the moment to lock in the simplest version that runs.",
  over_time:
    "You're past the target duration. Want to wrap with what you've got and debrief, or push for a couple more minutes?",
};

// Pluggable sink the driver invokes for every emitted directive. Real
// runtime wires this to MCP `notifications/message` for hosts that
// surface MCP logs (Cursor) and to the rolling recap so the next
// `coached_get_context` read surfaces every nudge that fired locally.
// Task #1194 (M8 runtime) — the legacy per-session `pendingDirectives`
// queue drained by `coached_check_in` was retired; the sink is now the
// only delivery channel. Tests pass an array push as the sink and
// assert the silent-host case.
export type CadenceSink = (directive: CadenceDirective) => void;

export interface CadenceDriverOptions {
  state: CoachedSessionState;
  sink: CadenceSink;
  // Override for tests. Defaults to global setInterval/clearInterval.
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
  // Override for tests so a fake clock can drive `now`.
  now?: () => number;
  tickMs?: number;
}

// Per-session driver. Owns the timer handle + the dedup set. Stop
// must be called when the session ends so the timer doesn't leak
// past `endCoachedSession`.
export class CadenceDriver {
  private readonly state: CoachedSessionState;
  private readonly sink: CadenceSink;
  private readonly fired = new Set<string>();
  private readonly setIntervalImpl: typeof globalThis.setInterval;
  private readonly clearIntervalImpl: typeof globalThis.clearInterval;
  private readonly now: () => number;
  private readonly tickMs: number;
  private timer: ReturnType<typeof globalThis.setInterval> | null = null;

  constructor(opts: CadenceDriverOptions) {
    this.state = opts.state;
    this.sink = opts.sink;
    this.setIntervalImpl = opts.setInterval ?? globalThis.setInterval;
    this.clearIntervalImpl = opts.clearInterval ?? globalThis.clearInterval;
    this.now = opts.now ?? Date.now;
    this.tickMs = opts.tickMs ?? CADENCE_TICK_MS;
  }

  start(): void {
    if (this.timer != null) return;
    this.timer = this.setIntervalImpl(() => this.tick(), this.tickMs);
    // Don't keep the Node event loop alive just for the cadence
    // timer — the MCP stdio transport owns process lifetime.
    const t = this.timer as unknown as { unref?: () => void };
    if (typeof t.unref === "function") {
      try {
        t.unref();
      } catch {
        /* noop */
      }
    }
  }

  stop(): void {
    if (this.timer == null) return;
    this.clearIntervalImpl(this.timer);
    this.timer = null;
  }

  // Public so tests can drive ticks deterministically without waiting
  // on real wall time.
  tick(): CadenceDirective | null {
    const directive = decideProactiveDirective({
      state: this.state,
      now: this.now(),
      alreadyFired: this.fired,
    });
    if (directive == null) return null;
    this.fired.add(directive.kind);
    // Persist the per-shape ladder advance INSIDE the driver so a
    // subsequent decide pass sees the new high-water rung. The sink
    // (server.ts) is also responsible for mirroring this advance into
    // the recap event log.
    if (directive.hintShape && directive.hintRung) {
      this.state.shapeLadderState[directive.hintShape] = directive.hintRung;
    }
    try {
      this.sink(directive);
    } catch {
      // Sink failures must never crash the timer. The next tick will
      // try again — but the dedup set has already swallowed this
      // kind, which is the right behaviour for transient host
      // disconnects (we don't want a backlog of stale time warnings
      // landing the moment the host reconnects).
    }
    return directive;
  }
}

// Re-export so tests can pin against the same ladder + classifier the
// runner actually uses without round-tripping through stuck-shape.ts.
export { LADDER_RUNGS, classifyStuckShape, fallbackProbeText, nextRung };
export type { LadderRung, StuckShape };
export { STALL_WINDOW_MS };
