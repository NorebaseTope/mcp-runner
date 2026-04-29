// Codex CLI adapter (Beta).
// Translates Codex CLI hook payloads and JSONL stream events into the common
// AiAssistedEvent schema.
//
// Two capture paths:
//   1. Interactive hooks — Codex hooks behind CODEX_HOOKS=1 feature flag.
//      Hooks: SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest,
//             PostToolUse, Stop.
//      Default confidence ceiling: medium (shell and MCP coverage incomplete).
//
//   2. Non-interactive `codex exec --json` — JSONL event stream consumed from
//      stdout. Can reach high confidence when JSONL stream and workspace
//      snapshots agree on file changes.
//
// Known gaps (documented in capability manifest):
//   - PreToolUse is a guardrail hook, not a complete enforcement boundary.
//   - Not all shell calls are intercepted in interactive mode.
//   - WebSearch and other non-shell/non-MCP tool calls are not intercepted.
//   - Unsupported tool calls become trust_gap events, never silent omissions.
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { SignedEventLog } from "./event-log.js";
import type { SnapshotStore, SnapshotResult } from "./snapshot.js";
import type { AiAssistedEvent } from "@workspace/ai-assisted-events";
import { MAX_STDOUT_BYTES } from "@workspace/ai-assisted-events";

export const CODEX_TOOL_NAME = "codex";
// Hook feature flag env var that enables Codex hooks.
export const CODEX_HOOKS_ENV = "CODEX_HOOKS";
// Path to Codex session JSONL files.
export function codexJsonlDir(): string {
  return path.join(os.homedir(), ".codex", "sessions");
}

// ---------------------------------------------------------------------------
// Hook payload shapes (interactive path)
// ---------------------------------------------------------------------------

export interface CodexPreToolUsePayload {
  tool_name?: string;
  tool_input?: unknown;
  session_id?: string;
}

export interface CodexPostToolUsePayload {
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  session_id?: string;
}

export interface CodexUserPromptPayload {
  prompt?: string;
  session_id?: string;
}

export interface CodexStopPayload {
  session_id?: string;
  response?: string;
}

export interface CodexPermissionPayload {
  tool_name?: string;
  permission?: string;
  decision?: string;
  reason?: string;
  session_id?: string;
}

export interface CodexSessionStartPayload {
  session_id?: string;
  model?: string;
  cwd?: string;
  version?: string;
}

// ---------------------------------------------------------------------------
// JSONL event shapes (non-interactive path via codex exec --json)
// ---------------------------------------------------------------------------

export interface CodexJsonlEvent {
  type: string;
  [key: string]: unknown;
}

export interface CodexJsonlMessage {
  type: "message";
  role: "user" | "assistant";
  content: string | unknown[];
  message_id?: string;
}

export interface CodexJsonlToolUse {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface CodexJsonlToolResult {
  type: "tool_result";
  id: string;
  output?: string;
  error?: string;
  exit_code?: number;
}

export interface CodexJsonlFileChange {
  type: "file_change";
  path: string;
  diff?: string;
  content?: string;
}

export interface CodexJsonlCommand {
  type: "command";
  cmd: string;
  exit_code?: number;
  stdout?: string;
  stderr?: string;
}

export interface CodexJsonlWebSearch {
  type: "web_search";
  query: string;
  results?: unknown[];
}

export interface CodexJsonlPlanUpdate {
  type: "plan_update";
  plan: string;
}

export interface CodexJsonlReasoning {
  type: "reasoning";
  content: string;
}

export type OnSnapshotCallback = (result: SnapshotResult) => void;

// ---------------------------------------------------------------------------
// Non-interference validator
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Interactive hook handlers
// ---------------------------------------------------------------------------

export function handlePreToolUse(
  raw: CodexPreToolUsePayload,
  log: SignedEventLog,
  turnId?: string,
): AiAssistedEvent {
  const toolName = raw.tool_name ?? "unknown";
  // PreToolUse is a guardrail hook — it fires for some tool types but is not
  // a complete enforcement boundary. Record as trust_gap when tool is one of
  // the known-incomplete tool types (WebSearch, external APIs).
  const hasKnownGap = ["web_search", "browser", "external_api"].includes(toolName);
  if (hasKnownGap) {
    return log.append({
      kind: "trust_gap",
      actor: "runner",
      turnId,
      payload: {
        reason: "codex_pre_tool_use_incomplete_boundary",
        detail: { tool_name: toolName },
      },
    });
  }
  return log.append({
    kind: "tool_call_started",
    actor: "tool",
    turnId,
    payload: {
      tool_name: toolName,
      tool_input: capPayload(raw.tool_input),
    },
  });
}

export function handlePostToolUse(
  raw: CodexPostToolUsePayload,
  log: SignedEventLog,
  snapshot: SnapshotStore | null,
  onSnapshot?: OnSnapshotCallback,
  turnId?: string,
): AiAssistedEvent {
  const toolName = raw.tool_name ?? "unknown";
  const isEditTool = ["write_file", "create_file", "edit_file", "str_replace", "apply_patch"].includes(toolName);
  const isShellTool = ["bash", "shell", "run_command"].includes(toolName);
  const isWebSearch = toolName === "web_search";

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
        error: capPayload(resp?.["error"] ?? resp),
      },
    });
  }

  // WebSearch is captured as a trust_gap in interactive mode — it fires
  // PostToolUse but the content is not fully intercepted.
  if (isWebSearch) {
    return log.append({
      kind: "trust_gap",
      actor: "runner",
      turnId,
      payload: {
        reason: "codex_web_search_not_intercepted",
        detail: { tool_name: toolName },
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
    const toolInputObj = raw.tool_input as Record<string, unknown> | undefined;
    const cmdArr = toolInputObj?.["cmd"];
    const inputStr = typeof raw.tool_input === "string" ? raw.tool_input
      : typeof toolInputObj?.["command"] === "string"
      ? String(toolInputObj["command"])
      : Array.isArray(cmdArr)
      ? cmdArr.join(" ")
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
  raw: CodexUserPromptPayload,
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
  raw: CodexStopPayload,
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
  raw: CodexPermissionPayload,
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
  raw: CodexSessionStartPayload,
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

// ---------------------------------------------------------------------------
// JSONL event handlers (non-interactive path via codex exec --json)
// ---------------------------------------------------------------------------

// Translate a single JSONL event from `codex exec --json` into one or more
// capture events. Returns the primary event or undefined if the JSONL event
// type is not mapped (which becomes a trust_gap).
export function handleJsonlEvent(
  raw: CodexJsonlEvent,
  log: SignedEventLog,
  snapshot: SnapshotStore | null,
  onSnapshot?: OnSnapshotCallback,
  turnId?: string,
): AiAssistedEvent {
  switch (raw.type) {
    case "message": {
      const msg = raw as unknown as CodexJsonlMessage;
      const contentStr = typeof msg.content === "string"
        ? msg.content
        : JSON.stringify(msg.content);
      if (msg.role === "user") {
        return log.append({
          kind: "prompt_submitted",
          actor: "candidate",
          turnId,
          payload: { prompt: capPayload(contentStr) },
        });
      } else {
        return log.append({
          kind: "response_received",
          actor: "assistant",
          turnId,
          payload: { response: capPayload(contentStr) },
        });
      }
    }
    case "tool_use": {
      const tu = raw as unknown as CodexJsonlToolUse;
      return log.append({
        kind: "tool_call_started",
        actor: "tool",
        turnId,
        payload: {
          tool_name: tu.name,
          tool_input: capPayload(tu.input),
          tool_id: tu.id,
        },
      });
    }
    // OpenAI API format — used by `codex exec --json` output stream
    case "function_call": {
      const fc = raw as unknown as Record<string, unknown>;
      return log.append({
        kind: "tool_call_started",
        actor: "tool",
        turnId,
        payload: {
          tool_name: fc["name"] ?? "unknown",
          tool_input: capPayload(
            typeof fc["arguments"] === "string"
              ? ((): unknown => { try { return JSON.parse(fc["arguments"] as string); } catch { return fc["arguments"]; } })()
              : fc["arguments"],
          ),
          call_id: fc["call_id"],
        },
      });
    }
    case "function_call_output": {
      const fco = raw as unknown as Record<string, unknown>;
      const fcoOutput = typeof fco["output"] === "string"
        ? ((): unknown => { try { return JSON.parse(fco["output"] as string); } catch { return fco["output"]; } })()
        : fco["output"];
      const fcoErr = (fcoOutput as Record<string, unknown> | null)?.["error"];
      if (typeof fcoErr === "string" && fcoErr.length > 0) {
        return log.append({
          kind: "tool_call_failed",
          actor: "tool",
          turnId,
          payload: { call_id: fco["call_id"], error: capPayload(fcoErr) },
        });
      }
      return log.append({
        kind: "tool_call_completed",
        actor: "tool",
        turnId,
        payload: {
          call_id: fco["call_id"],
          output: capPayload(fcoOutput),
        },
      });
    }
    case "tool_result": {
      const tr = raw as unknown as CodexJsonlToolResult;
      if (tr.error) {
        return log.append({
          kind: "tool_call_failed",
          actor: "tool",
          turnId,
          payload: {
            tool_id: tr.id,
            error: capPayload(tr.error),
            exit_code: tr.exit_code,
          },
        });
      }
      return log.append({
        kind: "tool_call_completed",
        actor: "tool",
        turnId,
        payload: {
          tool_id: tr.id,
          output: capPayload(tr.output),
          exit_code: tr.exit_code,
        },
      });
    }
    case "file_change": {
      const fc = raw as unknown as CodexJsonlFileChange;
      const primaryEvent = log.append({
        kind: "edit_applied",
        actor: "tool",
        turnId,
        payload: {
          tool_name: "codex_file_change",
          file_path: fc.path,
          diff: capPayload(fc.diff),
        },
      });
      if (snapshot) {
        const snap = snapshot.snapshot("edit_applied");
        if (snap) {
          log.append({
            kind: "edit_applied",
            actor: "runner",
            turnId,
            payload: { snapshot_kind: "jsonl_file_change", ...snap },
            shadowCommitSha: snap.commitSha,
            workspaceTreeHash: snapshot.getTreeHash() ?? undefined,
          });
          onSnapshot?.(snap);
        }
      }
      return primaryEvent;
    }
    case "command": {
      const cmd = raw as unknown as CodexJsonlCommand;
      const stdout = truncateOutput(cmd.stdout ?? "");
      const stderr = truncateOutput(cmd.stderr ?? "", 4096);
      const isTestCommand = /^(pytest|python -m pytest|npm test|jest|vitest|mocha|go test|cargo test|rspec)\b/.test((cmd.cmd ?? "").trimStart());
      const shellEventKind = isTestCommand ? "test_completed" : "shell_completed";
      const primaryEvent = log.append({
        kind: shellEventKind,
        actor: "tool",
        turnId,
        payload: {
          tool_name: "codex_command",
          tool_input: { command: cmd.cmd },
          stdout,
          stderr,
          exit_code: cmd.exit_code,
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
    }
    case "web_search": {
      const ws = raw as unknown as CodexJsonlWebSearch;
      // WebSearch is captured from JSONL — no hook gap here unlike interactive mode.
      return log.append({
        kind: "tool_call_completed",
        actor: "tool",
        turnId,
        payload: {
          tool_name: "web_search",
          tool_input: { query: ws.query },
          tool_response: capPayload(ws.results),
        },
      });
    }
    case "plan_update": {
      const pu = raw as unknown as CodexJsonlPlanUpdate;
      return log.append({
        kind: "response_received",
        actor: "assistant",
        turnId,
        payload: { plan_update: capPayload(pu.plan) },
      });
    }
    case "reasoning": {
      const re = raw as unknown as CodexJsonlReasoning;
      return log.append({
        kind: "response_received",
        actor: "assistant",
        turnId,
        payload: { reasoning: capPayload(re.content) },
      });
    }
    default: {
      // Unknown JSONL event type — emit trust_gap (never silent omission).
      return log.append({
        kind: "trust_gap",
        actor: "runner",
        turnId,
        payload: {
          reason: "codex_jsonl_unknown_event_type",
          detail: { event_type: raw.type },
        },
      });
    }
  }
}

// Read all session JSONL files from ~/.codex/sessions/ for the given session.
// Returns lines sorted by creation order. Returns [] when directory is missing.
export function readCodexSessionJsonl(sessionDir: string): string[] {
  try {
    if (!fs.existsSync(sessionDir)) return [];
    const files = fs.readdirSync(sessionDir).sort();
    const lines: string[] = [];
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const content = fs.readFileSync(path.join(sessionDir, f), "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed) lines.push(trimmed);
      }
    }
    return lines;
  } catch {
    return [];
  }
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
