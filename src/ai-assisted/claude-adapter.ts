// Claude Code adapter (GA).
// Translates Claude Code hook payloads into the common AiAssistedEvent schema.
// All handler functions in this file must satisfy the non-interference contract:
//   - They only READ stdin data; they never modify it
//   - They return nothing that affects tool behavior
//   - They emit events to the runner's capture pipeline only
import type { SignedEventLog } from "./event-log.js";
import type { SnapshotStore, SnapshotResult } from "./snapshot.js";
import type { AiAssistedEvent } from "@workspace/ai-assisted-events";
import { MAX_STDOUT_BYTES } from "@workspace/ai-assisted-events";

export const CLAUDE_CODE_TOOL_NAME = "claude_code";
export const CLAUDE_CODE_SUPPORTED_VERSION_MIN = "1.0.0";

// Raw hook payload shapes (as received from Claude Code via stdin)
export interface ClaudePreToolUsePayload {
  tool_name?: string;
  tool_input?: unknown;
  session_id?: string;
}

export interface ClaudePostToolUsePayload {
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  session_id?: string;
}

export interface ClaudeUserPromptPayload {
  prompt?: string;
  session_id?: string;
}

export interface ClaudeStopPayload {
  session_id?: string;
  transcript_path?: string;
}

export interface ClaudePermissionPayload {
  tool_name?: string;
  permission?: string;
  decision?: string;
  reason?: string;
  session_id?: string;
}

export interface ClaudeSubagentStopPayload {
  session_id?: string;
  subagent_id?: string;
  transcript_path?: string;
}

export interface ClaudeSessionStartPayload {
  session_id?: string;
  tool_name?: string;
  model?: string;
  cwd?: string;
}

export interface ClaudePostToolUseFailurePayload {
  tool_name?: string;
  tool_input?: unknown;
  error?: unknown;
  session_id?: string;
}

export interface ClaudePostToolBatchPayload {
  tool_results?: unknown[];
  session_id?: string;
}

export interface ClaudeSessionEndPayload {
  session_id?: string;
  transcript_path?: string;
  total_cost_usd?: number;
  duration_ms?: number;
}

export type OnSnapshotCallback = (result: SnapshotResult) => void;

// Non-interference contract validator: performs a runtime check that all
// adapter handlers produce valid events without throwing.
// Returns a list of failing handler names (must be empty for GA approval).
// This replaces unconditional self-attestation with enforceable runtime checks.
export function verifyNonInterference(): string[] {
  const violations: string[] = [];
  let mockSeq = 0;

  const mockLog = {
    append(opts: import("./event-log.js").AppendEventOptions): AiAssistedEvent {
      return {
        v: 1 as const,
        session_id: "ni-check",
        seq: mockSeq++,
        ts: new Date().toISOString(),
        monotonic_ms: 0,
        tool: "test",
        tool_version: "0",
        adapter_version: "0",
        turn_id: opts.turnId,
        kind: opts.kind,
        actor: opts.actor,
        payload: opts.payload,
        payload_hash: "x",
        prev_event_hash: "",
        signature: "x",
      } as AiAssistedEvent;
    },
  } as unknown as SignedEventLog;

  const cases: Array<[string, () => AiAssistedEvent]> = [
    ["handlePreToolUse",           () => handlePreToolUse({}, mockLog)],
    ["handlePostToolUse",          () => handlePostToolUse({}, mockLog, null)],
    ["handleUserPromptSubmit",     () => handleUserPromptSubmit({}, mockLog)],
    ["handleStop",                 () => handleStop({}, mockLog)],
    ["handlePermissionRequest",    () => handlePermissionRequest({}, mockLog)],
    ["handleSubagentStop",         () => handleSubagentStop({}, mockLog)],
    ["handleSessionStart",         () => handleSessionStart({}, mockLog)],
    ["handlePostToolUseFailure",   () => handlePostToolUseFailure({}, mockLog)],
    ["handlePostToolBatch",        () => handlePostToolBatch({}, mockLog)],
    ["handleSessionEnd",           () => handleSessionEnd({}, mockLog, null)],
  ];

  for (const [name, fn] of cases) {
    try {
      const ev = fn();
      if (!ev || typeof ev.kind !== "string") {
        violations.push(`${name}: returned invalid event (missing kind)`);
      } else if (!ev.actor || typeof ev.actor !== "string") {
        violations.push(`${name}: returned invalid event (missing actor)`);
      }
    } catch (err) {
      violations.push(`${name}: threw: ${(err as Error).message}`);
    }
  }

  return violations;
}

// Translate a PreToolUse hook payload into capture events.
// Returns the primary capture event.
export function handlePreToolUse(
  raw: ClaudePreToolUsePayload,
  log: SignedEventLog,
  turnId?: string,
): AiAssistedEvent {
  return log.append({
    kind: "tool_call_started",
    actor: "tool",
    turnId,
    payload: {
      tool_name: raw.tool_name,
      tool_input: capPayload(raw.tool_input),
    },
  });
}

// Translate a PostToolUse hook payload into capture events.
// Returns the primary capture event. Calls onSnapshot when a workspace snapshot is taken.
export function handlePostToolUse(
  raw: ClaudePostToolUsePayload,
  log: SignedEventLog,
  snapshot: SnapshotStore | null,
  onSnapshot?: OnSnapshotCallback,
  turnId?: string,
): AiAssistedEvent {
  const toolName = raw.tool_name ?? "unknown";
  const isEditTool = ["str_replace_editor", "write_file", "create_file", "edit_file"].includes(toolName);
  const isShellTool = ["bash", "shell", "run_command", "computer"].includes(toolName);

  // Detect test commands to emit test_completed instead of shell_completed.
  // Heuristic: stdin command string starts with a known test runner keyword.
  const inputStr = typeof raw.tool_input === "string" ? raw.tool_input
    : typeof (raw.tool_input as Record<string, unknown>)?.["command"] === "string"
    ? String((raw.tool_input as Record<string, unknown>)["command"])
    : "";
  const isTestCommand = isShellTool && /^(pytest|python -m pytest|npm test|jest|vitest|mocha|go test|cargo test|rspec)\b/.test(inputStr.trimStart());

  // Detect tool-level failure: Claude Code may set type="error", isError=true, or
  // return an object whose string form starts with an error indicator.
  const resp = raw.tool_response as Record<string, unknown> | null | undefined;
  const isFailure =
    (resp && resp["type"] === "error") ||
    (resp && resp["isError"] === true) ||
    (resp && typeof resp["error"] === "string");

  if (isFailure) {
    return log.append({
      kind: "tool_call_failed",
      actor: "tool",
      turnId,
      payload: {
        tool_name: toolName,
        tool_input: capPayload(raw.tool_input),
        error: capPayload(resp?.["error"] ?? resp),
      },
    });
  }

  if (isEditTool) {
    const primaryEvent = log.append({
      kind: "edit_applied",
      actor: "tool",
      turnId,
      payload: {
        tool_name: toolName,
        tool_input: capPayload(raw.tool_input),
        tool_response: capPayload(raw.tool_response),
      },
    });
    // Take a snapshot after edits and upload asynchronously
    if (snapshot) {
      const snap = snapshot.snapshot("edit_applied");
      if (snap) {
        log.append({
          kind: "edit_applied",
          actor: "runner",
          turnId,
          payload: { snapshot_kind: "edit_applied", ...snap },
          shadowCommitSha: snap.commitSha,
          workspaceTreeHash: snapshot.getTreeHash() ?? undefined,
        });
        onSnapshot?.(snap);
      }
    }
    return primaryEvent;
  } else if (isShellTool) {
    const response = raw.tool_response as Record<string, unknown> | undefined;
    const stdout = truncateOutput(String((response?.["stdout"] as string) ?? ""));
    const stderr = truncateOutput(String((response?.["stderr"] as string) ?? ""), 4096);
    // Emit test_completed for test runner invocations, shell_completed for all other shell tools.
    const shellEventKind = isTestCommand ? "test_completed" : "shell_completed";
    const primaryEvent = log.append({
      kind: shellEventKind,
      actor: "tool",
      turnId,
      payload: {
        tool_name: toolName,
        tool_input: capPayload(raw.tool_input),
        stdout,
        stderr,
        exit_code: response?.["exit_code"],
      },
    });
    // Take a snapshot after shell/test completions (state may have changed via test output).
    if (snapshot) {
      const snap = snapshot.snapshot(shellEventKind);
      if (snap) {
        log.append({
          kind: shellEventKind,
          actor: "runner",
          turnId,
          payload: { snapshot_kind: shellEventKind, ...snap },
          shadowCommitSha: snap.commitSha,
          workspaceTreeHash: snapshot.getTreeHash() ?? undefined,
        });
        onSnapshot?.(snap);
      }
    }
    return primaryEvent;
  } else {
    return log.append({
      kind: "tool_call_completed",
      actor: "tool",
      turnId,
      payload: {
        tool_name: toolName,
        tool_input: capPayload(raw.tool_input),
        tool_response: capPayload(raw.tool_response),
      },
    });
  }
}

// Translate a UserPromptSubmit hook payload.
// Returns the primary capture event.
export function handleUserPromptSubmit(
  raw: ClaudeUserPromptPayload,
  log: SignedEventLog,
  turnId?: string,
): AiAssistedEvent {
  return log.append({
    kind: "prompt_submitted",
    actor: "candidate",
    turnId,
    payload: {
      prompt: raw.prompt,
    },
  });
}

// Translate a PermissionRequest hook payload.
// Captures security-relevant permission decisions without blocking the flow.
// Returns the capture event.
export function handlePermissionRequest(
  raw: ClaudePermissionPayload,
  log: SignedEventLog,
  turnId?: string,
): AiAssistedEvent {
  return log.append({
    kind: "permission_decided",
    actor: "tool",
    turnId,
    payload: {
      tool_name: raw.tool_name,
      permission: raw.permission,
      decision: raw.decision,
      reason: raw.reason,
    },
  });
}

// Translate a SubagentStop hook payload (Claude Code GA lifecycle).
// Fires when a Claude Code subagent (sub-session) finishes.
// Returns the capture event.
export function handleSubagentStop(
  raw: ClaudeSubagentStopPayload,
  log: SignedEventLog,
  turnId?: string,
): AiAssistedEvent {
  return log.append({
    kind: "subagent_stopped",
    actor: "assistant",
    turnId,
    payload: {
      subagent_id: raw.subagent_id,
      transcript_path: raw.transcript_path,
    },
  });
}

// Translate a Stop hook payload (session or response end).
// Returns the primary capture event.
export function handleStop(
  raw: ClaudeStopPayload,
  log: SignedEventLog,
  turnId?: string,
): AiAssistedEvent {
  return log.append({
    kind: "response_received",
    actor: "assistant",
    turnId,
    payload: {
      transcript_path: raw.transcript_path,
    },
  });
}

// Translate a SessionStart hook payload.
// Fires at the start of a Claude Code GA session — good for verifying session
// identity and capturing initial environment state.
export function handleSessionStart(
  raw: ClaudeSessionStartPayload,
  log: SignedEventLog,
  turnId?: string,
): AiAssistedEvent {
  return log.append({
    kind: "session_started",
    actor: "runner",
    turnId,
    payload: {
      tool_session_id: raw.session_id,
      tool_name: raw.tool_name,
      model: raw.model,
      cwd: raw.cwd,
    },
  });
}

// Translate a PostToolUseFailure hook payload.
// Fires specifically when a tool invocation returns an error (distinct from
// PostToolUse which fires for all completions including errors).
export function handlePostToolUseFailure(
  raw: ClaudePostToolUseFailurePayload,
  log: SignedEventLog,
  turnId?: string,
): AiAssistedEvent {
  return log.append({
    kind: "tool_call_failed",
    actor: "tool",
    turnId,
    payload: {
      tool_name: raw.tool_name ?? "unknown",
      tool_input: capPayload(raw.tool_input),
      error: capPayload(raw.error),
    },
  });
}

// Translate a PostToolBatch hook payload.
// Fires once after all parallel tool calls in a batch complete.
// Captures a batch boundary marker so graders can reason about concurrent edits.
export function handlePostToolBatch(
  raw: ClaudePostToolBatchPayload,
  log: SignedEventLog,
  turnId?: string,
): AiAssistedEvent {
  return log.append({
    kind: "batch_completed",
    actor: "tool",
    turnId,
    payload: {
      tool_result_count: Array.isArray(raw.tool_results) ? raw.tool_results.length : 0,
    },
  });
}

// Translate a SessionEnd hook payload.
// Fires at the very end of the Claude Code GA session lifecycle.
export function handleSessionEnd(
  raw: ClaudeSessionEndPayload,
  log: SignedEventLog,
  snapshot: SnapshotStore | null,
  turnId?: string,
  onSnapshot?: OnSnapshotCallback,
): AiAssistedEvent {
  // Take a final snapshot on session end if workspace tracking is active.
  if (snapshot) {
    const snap = snapshot.snapshot("session_ended");
    if (snap) {
      log.append({
        kind: "session_ended",
        actor: "runner",
        turnId,
        payload: { snapshot_kind: "session_ended", ...snap },
        shadowCommitSha: snap.commitSha,
        workspaceTreeHash: snapshot.getTreeHash() ?? undefined,
      });
      onSnapshot?.(snap);
    }
  }
  return log.append({
    kind: "session_ended",
    actor: "assistant",
    turnId,
    payload: {
      transcript_path: raw.transcript_path,
      total_cost_usd: raw.total_cost_usd,
      duration_ms: raw.duration_ms,
    },
  });
}

// ---------------------------------------------------------------------------
// Internal helpers — enforce size caps
// ---------------------------------------------------------------------------

function capPayload(v: unknown, maxLen = 4096): unknown {
  if (typeof v === "string") return v.slice(0, maxLen);
  try {
    const s = JSON.stringify(v);
    if (s.length > maxLen) return s.slice(0, maxLen) + "…";
    return v;
  } catch {
    return String(v).slice(0, maxLen);
  }
}

function truncateOutput(s: string, maxBytes = MAX_STDOUT_BYTES): string {
  const buf = Buffer.from(s, "utf-8");
  if (buf.length <= maxBytes) return s;
  return buf.slice(0, maxBytes).toString("utf-8") + "\n[truncated]";
}
