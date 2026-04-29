/**
 * Pure helpers for Cursor confidence-ceiling enforcement.
 *
 * Kept in a separate module so the gap-detection logic is independently
 * testable without instantiating a full session.
 */

import type { AiAssistedEvent } from "@workspace/ai-assisted-events";

/** Shell-tool names that Cursor's PostToolUse hook should cover. */
export const CURSOR_SHELL_TOOLS: ReadonlySet<string> = new Set([
  "run_terminal_command",
  "bash",
  "shell",
]);

/** Fraction of shell-started events that must have shell_completed events. */
const SHELL_COVERAGE_THRESHOLD = 0.5;

export interface CursorChannelGaps {
  /** At least one cursor_missing_edit_hook trust_gap was recorded. */
  hasMissingEditHook: boolean;
  /** Shell commands started but fewer than SHELL_COVERAGE_THRESHOLD were captured. */
  hasShellHookGap: boolean;
  /** Number of tool_call_started events for shell tools. */
  shellStartedCount: number;
  /** Number of shell_completed + test_completed events. */
  shellCompletedCount: number;
}

/**
 * Inspect a list of session events and identify which Cursor capture channels
 * are incomplete.  Returns a pure result with no side-effects.
 */
export function computeCursorChannelGaps(events: AiAssistedEvent[]): CursorChannelGaps {
  const hasMissingEditHook = events.some(
    (e) =>
      e.kind === "trust_gap" &&
      (e.payload as Record<string, unknown> | undefined)?.["reason"] === "cursor_missing_edit_hook",
  );

  const shellStartedCount = events.filter((e) => {
    if (e.kind !== "tool_call_started") return false;
    const p = e.payload as Record<string, unknown> | undefined;
    return CURSOR_SHELL_TOOLS.has((p?.["tool_name"] as string) ?? "");
  }).length;

  // Only count completions emitted by the tool's own PostToolUse hook (actor
  // "tool").  Runner-side snapshot-annotation events may share the same kinds
  // but have actor "runner" and must not be counted — they would inflate the
  // completion count and make coverage appear healthier than it is.
  const shellCompletedCount = events.filter(
    (e) => (e.kind === "shell_completed" || e.kind === "test_completed") && e.actor === "tool",
  ).length;

  const hasShellHookGap =
    shellStartedCount > 0 &&
    shellCompletedCount < Math.ceil(shellStartedCount * SHELL_COVERAGE_THRESHOLD);

  return { hasMissingEditHook, hasShellHookGap, shellStartedCount, shellCompletedCount };
}
