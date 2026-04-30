// Pure helpers shared by the MCP server's coached_* tool handlers.
// Lifted out of server.ts so the same code path is unit-testable without
// booting the full McpServer + SamApi.
import type { CheckInDirective } from "../api.js";
import { STALL_PROBE_LINE } from "../persona-cache.js";
import {
  type CoachedSessionState,
  isStalled,
  stalledSeconds,
} from "./session.js";

export function resolveCoachedWorkDir(args: {
  workDir?: string;
  workspaceDir?: string;
}): string | undefined {
  return args.workDir ?? args.workspaceDir;
}

// Reason marker on the directive when the runner-side stall watcher
// upgrades a stay_quiet server directive into a probe. Hosts and tests
// can key off this to distinguish a runner-driven nudge from a
// server-driven one.
export const STALL_ESCALATION_REASON = "runner_stall_escalation";

// Escalate a server-issued directive when the runner observes that the
// user has stopped editing files past the stall window. We deliberately
// only upgrade `stay_quiet` and only as far as `probe` — the gentlest
// non-quiet rung on Sam's hint ladder. That way we never skip past
// probing straight into a hint or a solution. Once the server itself
// has decided to probe, hint, or escalate further, we leave its
// directive alone.
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
  return {
    action: "probe",
    samVoiceLine: STALL_PROBE_LINE,
    reason: STALL_ESCALATION_REASON,
  };
}

// True iff `escalateForStall(directive, state)` would actually upgrade the
// server-issued directive into a runner-driven probe. The MCP server uses
// this to know when to report a `stall_nudge` event back to the API so the
// post-mortem can surface how many times Sam had to break the silence.
export function isStallEscalation(
  directive: CheckInDirective,
  state: CoachedSessionState | null,
): boolean {
  return escalateForStall(directive, state).reason === STALL_ESCALATION_REASON
    && directive.reason !== STALL_ESCALATION_REASON;
}

export function buildCheckInPayload(
  directive: CheckInDirective,
  state: CoachedSessionState | null,
): Record<string, unknown> {
  const effectiveDirective = escalateForStall(directive, state);
  const payload: Record<string, unknown> = {
    action: effectiveDirective.action,
    samVoiceLine: effectiveDirective.samVoiceLine ?? null,
    reason: effectiveDirective.reason,
  };
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
