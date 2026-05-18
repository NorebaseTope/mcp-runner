// Pure helpers shared by the MCP server's coached_* tool handlers.
// Lifted out of server.ts so the same code path is unit-testable without
// booting the full McpServer + SamApi.
import type { CheckInDirective } from "../api.js";
import { STALL_PROBE_LINES, type StallProbeVariant } from "../persona-cache.js";
import {
  enrichDirectiveWithDiff,
  type EnrichDirectiveDeps,
} from "./diff-aware-nudge.js";
import { EnrichmentRateMonitor } from "./enrichment-rate-monitor.js";
import {
  type CoachedSessionState,
  isStalled,
  stalledSeconds,
} from "./session.js";
import { CONFIG_DIR } from "../config.js";
import * as path from "node:path";

export const enrichmentRateMonitor = new EnrichmentRateMonitor({
  persistPath: path.join(CONFIG_DIR, "enrichment-rate-outcomes.json"),
});

export function resolveCoachedWorkDir(args: {
  workDir?: string;
  workspaceDir?: string;
}): string | undefined {
  return args.workDir ?? args.workspaceDir;
}

// Reason-prefix marker on the directive when the runner-side stall watcher
// upgrades a stay_quiet server directive into a probe. Hosts and tests
// can key off this to distinguish a runner-driven nudge from a
// server-driven one. The actual `reason` field on the upgraded directive
// is `${STALL_ESCALATION_REASON}:${variant}` (e.g.
// `runner_stall_escalation:working_draft`) so the post-mortem can see
// which Sam-voice line was picked (Task #803).
export const STALL_ESCALATION_REASON = "runner_stall_escalation";

export function stallEscalationReason(variant: StallProbeVariant): string {
  return `${STALL_ESCALATION_REASON}:${variant}`;
}

// Pick the stall-probe variant from the runner's last-known progress
// signal. Mirrors `pickProgressVariant` on the server side
// (artifacts/api-server/src/lib/session-state.ts) so the runner-driven
// stall probe lines up with the server-driven time-directive variants:
//
//   blank_page    — no submissions yet (planning / reading phase)
//   stuck         — submitted, same test failing back-to-back
//   working_draft — submitted, no run of consecutive same-test failures
//
// `passedLatest === true` short-circuits to `working_draft` because by
// then the user clearly has a passing path and any stall is them weighing
// what to do next, not being blocked.
//
// Falls back to `blank_page` when the runner has never managed to
// refresh its progress fields. That preserves the historical
// "where did you get stuck" intent for the case where we genuinely
// don't know — better to say something close to the old line than to
// invent a "you have a working draft" claim with no evidence.
export function pickStallProbeVariant(
  state: CoachedSessionState,
): StallProbeVariant {
  if (state.attemptsTotal == null) return "blank_page";
  if (state.attemptsTotal === 0) return "blank_page";
  if (state.passedLatest === true) return "working_draft";
  if ((state.consecutiveFailingTestCount ?? 0) >= 2) return "stuck";
  return "working_draft";
}

// Escalate a server-issued directive when the runner observes that the
// user has stopped editing files past the stall window. We deliberately
// only upgrade `stay_quiet` and only as far as `probe` — the gentlest
// non-quiet rung on Sam's hint ladder. That way we never skip past
// probing straight into a hint or a solution. Once the server itself
// has decided to probe, hint, or escalate further, we leave its
// directive alone.
//
// The probe's voice line is picked from `pickStallProbeVariant(state)`
// so a working_draft session gets a "what tradeoff are you weighing?"
// probe instead of always speaking the blank-page "where did you get
// stuck" line (Task #803).
//
// Dedup: hosts call `coached_check_in` on every user message and on a
// ~3 min heartbeat. Without dedup the same Sam-voice line would be
// re-emitted on every check-in for as long as the user stayed idle,
// which feels nagging. We pin the "already fired" marker on the session
// to the current `lastEditAt`, so subsequent check-ins inside the same
// idle window pass through as `stay_quiet`. Any file edit bumps
// `lastEditAt` (via the fs watcher in `startCoachedSession`), the
// marker no longer matches, and the next stall window is re-armed.
export function escalateForStall(
  directive: CheckInDirective,
  state: CoachedSessionState | null,
): CheckInDirective {
  if (state == null) return directive;
  if (!isStalled(state)) return directive;
  if (directive.action !== "stay_quiet") return directive;
  if (state.stallNudgeFiredForEditAt === state.lastEditAt) return directive;
  state.stallNudgeFiredForEditAt = state.lastEditAt;
  const variant = pickStallProbeVariant(state);
  const wording = STALL_PROBE_LINES[variant];
  return {
    action: "probe",
    reason: stallEscalationReason(variant),
    // Task #1075 — runner-driven escalation never carries a
    // `mustBeVerbatim` contract; it's a paraphrase-friendly probe.
    intent:
      "Break a long silence: nudge the candidate to think out loud about what they are stuck on.",
    constraints: [
      "Stay in Sam's coach voice — supportive, concise, no filler.",
      "Do NOT reveal the solution or write code on the candidate's behalf.",
    ],
    suggestedWording: wording,
    mustBeVerbatim: false,
  };
}

// True iff the next `escalateForStall` pass would need fresh server-side
// progress fields (`attemptsTotal`, `passedLatest`,
// `consecutiveFailingTestCount`) to pick the right Sam-voice variant.
//
// Hosts call `coached_check_in` after every user message and on a ~3 min
// heartbeat, so refreshing progress on every call doubles the per-check-in
// network traffic for a feature that only matters when the user has
// actually stalled. Gate the refresh to the moments where it actually
// affects behaviour:
//
//   - We have an in-memory session at all (otherwise no escalation runs).
//   - The server returned `stay_quiet` (escalateForStall only upgrades
//     stay_quiet — anything else passes through unchanged regardless of
//     the progress fields).
//   - The session is currently stalled past `STALL_WINDOW_MS`.
//   - The runner-side dedup hasn't already fired the probe in this idle
//     window (`stallNudgeFiredForEditAt !== lastEditAt`). Once the probe
//     has fired, escalateForStall short-circuits to the original directive
//     until a file edit re-arms the window — fresh progress fields would
//     be ignored.
//
// If any of those conditions fail, the runner can safely skip the
// `api.getSession` round-trip and fall through with whatever progress
// fields it last knew (or none at all — `pickStallProbeVariant` falls back
// to `blank_page`, preserving the historical phrasing).
export function shouldRefreshProgressForStall(
  directive: CheckInDirective,
  state: CoachedSessionState | null,
): boolean {
  if (state == null) return false;
  if (directive.action !== "stay_quiet") return false;
  if (!isStalled(state)) return false;
  if (state.stallNudgeFiredForEditAt === state.lastEditAt) return false;
  return true;
}

// True iff `escalateForStall(directive, state)` would actually upgrade the
// server-issued directive into a runner-driven probe. The MCP server uses
// this to know when to report a `stall_nudge` event back to the API so the
// post-mortem can surface how many times Sam had to break the silence.
//
// PURE: must NOT call `escalateForStall`, which mutates
// `state.stallNudgeFiredForEditAt` as a dedup marker. Calling the
// mutating helper here would burn the marker and cause a subsequent
// `escalateForStall` (e.g. from server.ts feeding the resolved
// directive into diff-aware enrichment) to short-circuit and return
// the original `stay_quiet` — silently suppressing the runner-driven
// probe (Task #832 code-review fix).
export function isStallEscalation(
  directive: CheckInDirective,
  state: CoachedSessionState | null,
): boolean {
  if (state == null) return false;
  if (directive.action !== "stay_quiet") return false;
  if (!isStalled(state)) return false;
  if (state.stallNudgeFiredForEditAt === state.lastEditAt) return false;
  // The incoming directive could already be a runner-driven probe
  // re-emitted on a subsequent check-in inside the same idle window;
  // guard against double-counting it as a fresh escalation.
  const incomingIsRunnerDriven =
    directive.reason === STALL_ESCALATION_REASON ||
    directive.reason.startsWith(`${STALL_ESCALATION_REASON}:`);
  return !incomingIsRunnerDriven;
}

// Build the on-the-wire check-in payload from a directive that has ALREADY
// been resolved (escalation + diff-aware enrichment, if any, applied).
//
// Split out from `buildCheckInPayload` (Task #832) so the server can run the
// diff-aware nudge enrichment between escalation and payload assembly
// without `escalateForStall` being called twice (which would either be a
// no-op via the dedup marker or a wasted snapshot pass). Tests that drive
// only the legacy escalation path keep using `buildCheckInPayload`.
export function buildCheckInPayloadFromResolved(
  effectiveDirective: CheckInDirective,
  state: CoachedSessionState | null,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    action: effectiveDirective.action,
    reason: effectiveDirective.reason,
    // Task #1075 — hybrid directive + suggested-wording fields.
    intent: effectiveDirective.intent ?? "",
    constraints: effectiveDirective.constraints ?? [],
    suggestedWording: effectiveDirective.suggestedWording ?? null,
    mustBeVerbatim: effectiveDirective.mustBeVerbatim ?? false,
    // Task #1107 — Phase 1 host-reasoning mode pass-through. Default to
    // `verbatim_relay` so any host build that branches on this field
    // sees a deterministic value even when the server hasn't sent one.
    mode: effectiveDirective.mode ?? "verbatim_relay",
  };
  if (effectiveDirective.evidence) {
    payload["evidence"] = effectiveDirective.evidence;
  }
  if (
    "timeMilestone" in effectiveDirective &&
    effectiveDirective.timeMilestone != null
  ) {
    payload["timeMilestone"] = effectiveDirective.timeMilestone;
  }
  if (state != null) {
    const stalled = isStalled(state);
    payload["isStalled"] = stalled;
    if (stalled) {
      // `stallDetected` is kept for one release window so hosts pinned to
      // the previous payload contract keep working. Drop after the next
      // major runner release.
      payload["stallDetected"] = true;
      payload["stallSeconds"] = stalledSeconds(state);
    }
  }
  return payload;
}

export function buildCheckInPayload(
  directive: CheckInDirective,
  state: CoachedSessionState | null,
): Record<string, unknown> {
  return buildCheckInPayloadFromResolved(
    escalateForStall(directive, state),
    state,
  );
}

export interface ResolveCheckInDeps {
  enrichDeps: EnrichDirectiveDeps;
  onOutcome?: (outcome: string, action: string) => void;
}

export async function resolveCheckInDirective(
  directive: CheckInDirective,
  state: CoachedSessionState | null,
  opts: {
    recentUserMessage?: string;
    deps: ResolveCheckInDeps;
  },
): Promise<Record<string, unknown>> {
  const escalated = escalateForStall(directive, state);
  let resolved = escalated;
  let diffSummary: { filesChanged: string[]; truncated: boolean } | undefined;
  let diffSnippet: string | undefined;
  let enrichOutcome: string = "error:uncaught";
  try {
    const enrichment = await enrichDirectiveWithDiff(
      {
        directive: escalated,
        state,
        recentUserMessage: opts.recentUserMessage,
      },
      opts.deps.enrichDeps,
    );
    resolved = enrichment.directive;
    diffSummary = enrichment.diffSummary;
    diffSnippet = enrichment.diffSnippet;
    enrichOutcome = enrichment.outcome;
  } catch {
    resolved = escalated;
  }
  enrichmentRateMonitor.record(enrichOutcome);
  process.stderr.write(
    `[coached_check_in] diff_enrich outcome=${enrichOutcome} action=${escalated.action}\n`,
  );
  try {
    opts.deps.onOutcome?.(enrichOutcome, escalated.action);
  } catch {
    // fire-and-forget — never let telemetry recording break the check-in flow
  }
  const payload = buildCheckInPayloadFromResolved(resolved, state);
  if (diffSummary) {
    payload["diffSummary"] = diffSummary;
  }
  // Task #1126 (Phase 2) — surface the captured diff text on the
  // payload so the caller (server.ts) can pin it on the session state
  // and forward it as `diffSnippet` on the NEXT check-in. Not part of
  // the host-facing contract — hosts ignore unknown keys.
  if (diffSnippet) {
    payload["diffSnippet"] = diffSnippet;
  }
  return payload;
}
