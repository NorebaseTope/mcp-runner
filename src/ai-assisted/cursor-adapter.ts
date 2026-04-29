// Cursor adapter (Beta).
// Translates Cursor hook payloads into the common AiAssistedEvent schema.
// All handler functions must satisfy the non-interference contract:
//   - They only READ stdin data; they never modify it
//   - They return nothing that affects tool behavior
//   - They emit events to the runner's capture pipeline only
//
// Known gaps (documented in capability manifest):
//   - Cursor's hook coverage depends on version (0.45+ required)
//   - Agent thoughts are not exposed via hooks in all Cursor versions
//   - Tab-completion edits may not fire edit hooks; snapshot diff is the authority
//   - Shell hooks may be incomplete in older Cursor versions
//
// Confidence ceiling: medium unless preflight confirms prompt + response +
// edit + shell + snapshot channels all healthy. High confidence requires
// all channels to remain healthy throughout the session.
import type { SignedEventLog } from "./event-log.js";
import type { SnapshotStore, SnapshotResult } from "./snapshot.js";
import type { AiAssistedEvent } from "@workspace/ai-assisted-events";
import { MAX_STDOUT_BYTES } from "@workspace/ai-assisted-events";

export const CURSOR_TOOL_NAME = "cursor";
// Minimum Cursor version that supports project-scoped hooks.
// 0.45 introduced the .cursor/settings.json hook config surface.
export const CURSOR_SUPPORTED_VERSION_MIN = "0.45.0";

export interface CursorPreToolUsePayload {
  tool_name?: string;
  tool_input?: unknown;
  session_id?: string;
}

export interface CursorPostToolUsePayload {
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  session_id?: string;
}

export interface CursorUserPromptPayload {
  prompt?: string;
  session_id?: string;
}

export interface CursorStopPayload {
  session_id?: string;
  response?: string;
}

export interface CursorPermissionPayload {
  tool_name?: string;
  permission?: string;
  decision?: string;
  reason?: string;
  session_id?: string;
}

export interface CursorSessionStartPayload {
  session_id?: string;
  model?: string;
  cwd?: string;
  version?: string;
}

export interface CursorSessionEndPayload {
  session_id?: string;
  duration_ms?: number;
  total_cost_usd?: number;
}

export interface CursorMcpToolPayload {
  tool_name?: string;
  server_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  session_id?: string;
}

export interface CursorTabEditPayload {
  file_path?: string;
  diff?: string;
  session_id?: string;
}

export type OnSnapshotCallback = (result: SnapshotResult) => void;

// Non-interference contract validator for Cursor adapter handlers.
// Returns a list of failing handler names (must be empty before launch).
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
    ["handlePreToolUse",        () => handlePreToolUse({}, mockLog)],
    ["handlePostToolUse",       () => handlePostToolUse({}, mockLog, null)],
    ["handleUserPromptSubmit",  () => handleUserPromptSubmit({}, mockLog)],
    ["handleStop",              () => handleStop({}, mockLog)],
    ["handlePermissionRequest", () => handlePermissionRequest({}, mockLog)],
    ["handleSessionStart",      () => handleSessionStart({}, mockLog)],
    ["handleSessionEnd",        () => handleSessionEnd({}, mockLog, null)],
    ["handleMcpToolUse",        () => handleMcpToolUse({}, mockLog)],
    ["handleTabEdit",           () => handleTabEdit({}, mockLog, null)],
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

export function handlePreToolUse(
  raw: CursorPreToolUsePayload,
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

export function handlePostToolUse(
  raw: CursorPostToolUsePayload,
  log: SignedEventLog,
  snapshot: SnapshotStore | null,
  onSnapshot?: OnSnapshotCallback,
  turnId?: string,
): AiAssistedEvent {
  const toolName = raw.tool_name ?? "unknown";
  const isEditTool = ["edit_file", "create_file", "write_file", "str_replace"].includes(toolName);
  const isShellTool = ["run_terminal_command", "bash", "shell"].includes(toolName);

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
    const inputStr = typeof raw.tool_input === "string" ? raw.tool_input
      : typeof (raw.tool_input as Record<string, unknown>)?.["command"] === "string"
      ? String((raw.tool_input as Record<string, unknown>)["command"])
      : "";
    const isTestCommand = /^(pytest|python -m pytest|npm test|jest|vitest|mocha|go test|cargo test|rspec)\b/.test(inputStr.trimStart());
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

export function handleUserPromptSubmit(
  raw: CursorUserPromptPayload,
  log: SignedEventLog,
  turnId?: string,
): AiAssistedEvent {
  return log.append({
    kind: "prompt_submitted",
    actor: "candidate",
    turnId,
    payload: { prompt: raw.prompt },
  });
}

export function handleStop(
  raw: CursorStopPayload,
  log: SignedEventLog,
  turnId?: string,
): AiAssistedEvent {
  return log.append({
    kind: "response_received",
    actor: "assistant",
    turnId,
    payload: { response: capPayload(raw.response) },
  });
}

export function handlePermissionRequest(
  raw: CursorPermissionPayload,
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

export function handleSessionStart(
  raw: CursorSessionStartPayload,
  log: SignedEventLog,
  turnId?: string,
): AiAssistedEvent {
  return log.append({
    kind: "session_started",
    actor: "runner",
    turnId,
    payload: {
      tool_session_id: raw.session_id,
      model: raw.model,
      cwd: raw.cwd,
      version: raw.version,
    },
  });
}

export function handleSessionEnd(
  raw: CursorSessionEndPayload,
  log: SignedEventLog,
  snapshot: SnapshotStore | null,
  turnId?: string,
  onSnapshot?: OnSnapshotCallback,
): AiAssistedEvent {
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
      duration_ms: raw.duration_ms,
      total_cost_usd: raw.total_cost_usd,
    },
  });
}

// Capture MCP tool execution before/after (Cursor-specific).
// Fires when Cursor uses an MCP server tool call.
export function handleMcpToolUse(
  raw: CursorMcpToolPayload,
  log: SignedEventLog,
  turnId?: string,
): AiAssistedEvent {
  const hasResponse = raw.tool_response !== undefined;
  return log.append({
    kind: hasResponse ? "tool_call_completed" : "tool_call_started",
    actor: "tool",
    turnId,
    payload: {
      tool_name: raw.tool_name,
      server_name: raw.server_name,
      tool_input: capPayload(raw.tool_input),
      ...(hasResponse ? { tool_response: capPayload(raw.tool_response) } : {}),
    },
  });
}

// Capture Tab-completion file edits (Cursor-specific).
// Fires when Cursor Tab applies an inline completion to a file.
// When this hook fires, it is treated as an edit_applied event.
// When it does NOT fire but a snapshot diff detects a change, the
// reconciliation step in session.ts emits a trust_gap with
// subtype cursor_missing_edit_hook.
export function handleTabEdit(
  raw: CursorTabEditPayload,
  log: SignedEventLog,
  snapshot: SnapshotStore | null,
  onSnapshot?: OnSnapshotCallback,
  turnId?: string,
): AiAssistedEvent {
  const primaryEvent = log.append({
    kind: "edit_applied",
    actor: "tool",
    turnId,
    payload: {
      tool_name: "cursor_tab",
      file_path: raw.file_path,
      diff: capPayload(raw.diff),
    },
  });
  if (snapshot) {
    const snap = snapshot.snapshot("edit_applied");
    if (snap) {
      log.append({
        kind: "edit_applied",
        actor: "runner",
        turnId,
        payload: { snapshot_kind: "tab_edit", ...snap },
        shadowCommitSha: snap.commitSha,
        workspaceTreeHash: snapshot.getTreeHash() ?? undefined,
      });
      onSnapshot?.(snap);
    }
  }
  return primaryEvent;
}

// ---------------------------------------------------------------------------
// Internal helpers
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
