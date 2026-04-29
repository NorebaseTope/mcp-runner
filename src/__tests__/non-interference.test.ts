// Non-interference contract tests for the Claude Code, Cursor, and Codex adapters.
//
// The non-interference contract states:
//   1. All hook handlers return an event (never undefined/null).
//   2. No handler writes to stdout (which would corrupt the tool's hook protocol).
//   3. verifyNonInterference() self-attests that the contract is upheld (returns []).
//   4. Handlers must not throw for any well-formed or malformed payload shape.
//
// These tests run in Node's built-in test runner (tsx --test).

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AiAssistedEvent } from "@workspace/ai-assisted-events";
import {
  verifyNonInterference,
  handlePreToolUse,
  handlePostToolUse,
  handleUserPromptSubmit,
  handleStop,
  handlePermissionRequest,
  handleSubagentStop,
  handleSessionStart,
  handlePostToolUseFailure,
  handlePostToolBatch,
  handleSessionEnd,
} from "../ai-assisted/claude-adapter.js";
import {
  verifyNonInterference as cursorVerifyNonInterference,
  handlePreToolUse as cursorHandlePreToolUse,
  handlePostToolUse as cursorHandlePostToolUse,
  handleUserPromptSubmit as cursorHandleUserPromptSubmit,
  handleStop as cursorHandleStop,
  handlePermissionRequest as cursorHandlePermissionRequest,
  handleSessionStart as cursorHandleSessionStart,
  handleSessionEnd as cursorHandleSessionEnd,
  handleMcpToolUse as cursorHandleMcpToolUse,
  handleTabEdit as cursorHandleTabEdit,
} from "../ai-assisted/cursor-adapter.js";
import {
  verifyNonInterference as codexVerifyNonInterference,
  handlePreToolUse as codexHandlePreToolUse,
  handlePostToolUse as codexHandlePostToolUse,
  handleUserPromptSubmit as codexHandleUserPromptSubmit,
  handleStop as codexHandleStop,
  handlePermissionRequest as codexHandlePermissionRequest,
  handleSessionStart as codexHandleSessionStart,
  handleJsonlEvent as codexHandleJsonlEvent,
} from "../ai-assisted/codex-adapter.js";
import { writeHookHandlerScript } from "../ai-assisted/hook-installer.js";
import type { AppendEventOptions, SignedEventLog } from "../ai-assisted/event-log.js";
import { sha256Hex } from "../ai-assisted/signing.js";
import { computeCursorChannelGaps } from "../ai-assisted/cursor-confidence.js";

// ---------------------------------------------------------------------------
// Minimal mock SignedEventLog — never touches the filesystem or signs anything
// ---------------------------------------------------------------------------

let appendedEvents: AiAssistedEvent[] = [];
let seqCounter = 0;

function makeMockEvent(opts: AppendEventOptions, seq: number): AiAssistedEvent {
  return {
    v: 1,
    session_id: "test-session",
    seq,
    ts: new Date().toISOString(),
    monotonic_ms: seq * 10,
    tool: "claude_code",
    tool_version: "1.0.0",
    adapter_version: "0.3.0",
    turn_id: opts.turnId,
    kind: opts.kind,
    actor: opts.actor,
    payload: opts.payload,
    payload_hash: "mock-hash",
    workspace_tree_hash: opts.workspaceTreeHash,
    shadow_commit_sha: opts.shadowCommitSha,
    prev_event_hash: seq === 0 ? "" : `prev-${seq - 1}`,
    signature: "mock-sig",
  } as AiAssistedEvent;
}

const mockLog = {
  append(opts: AppendEventOptions): AiAssistedEvent {
    const ev = makeMockEvent(opts, seqCounter++);
    appendedEvents.push(ev);
    return ev;
  },
} as unknown as SignedEventLog;

// ---------------------------------------------------------------------------
// Stdout capture helper
// ---------------------------------------------------------------------------

let stdoutCapture = "";
let originalWrite: typeof process.stdout.write;

function startCapturingStdout(): void {
  stdoutCapture = "";
  originalWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (...args: unknown[]) => boolean }).write = (
    chunk: unknown,
    ...rest: unknown[]
  ): boolean => {
    stdoutCapture += String(chunk);
    return (originalWrite as unknown as (...args: unknown[]) => boolean)(chunk, ...rest);
  };
}

function stopCapturingStdout(): string {
  process.stdout.write = originalWrite;
  return stdoutCapture;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

before(() => {
  appendedEvents = [];
  seqCounter = 0;
});

beforeEach(() => {
  // Ensure stdout is restored if a previous test left it captured
  if (originalWrite) process.stdout.write = originalWrite;
});

after(() => {
  if (originalWrite) process.stdout.write = originalWrite;
});

// ---------------------------------------------------------------------------
// Self-attestation
// ---------------------------------------------------------------------------

describe("verifyNonInterference", () => {
  it("returns an empty array (self-attestation passes)", () => {
    const violations = verifyNonInterference();
    assert.deepEqual(violations, []);
  });
});

// ---------------------------------------------------------------------------
// handlePreToolUse
// ---------------------------------------------------------------------------

describe("handlePreToolUse", () => {
  it("returns tool_call_started event for a realistic bash payload", () => {
    const ev = handlePreToolUse(
      { tool_name: "bash", tool_input: { command: "ls -la /workspace", description: "List files" }, session_id: "s1" },
      mockLog,
      "turn-001",
    );
    assert.ok(ev, "event must not be null/undefined");
    assert.equal(ev.kind, "tool_call_started");
    assert.equal(ev.actor, "tool");
  });

  it("returns tool_call_started for str_replace_editor PreToolUse", () => {
    const ev = handlePreToolUse(
      {
        tool_name: "str_replace_editor",
        tool_input: { command: "create", path: "/workspace/solution.py", file_text: "def solve():\n    pass\n" },
        session_id: "s1",
      },
      mockLog,
    );
    assert.ok(ev);
    assert.equal(ev.kind, "tool_call_started");
  });

  it("handles missing tool_name gracefully without throwing", () => {
    assert.doesNotThrow(() => {
      handlePreToolUse({ session_id: "s1" }, mockLog);
    });
  });

  it("handles empty payload without throwing", () => {
    assert.doesNotThrow(() => {
      handlePreToolUse({}, mockLog);
    });
  });

  it("does not write to stdout", () => {
    startCapturingStdout();
    handlePreToolUse({ tool_name: "bash", tool_input: "x", session_id: "s1" }, mockLog);
    const captured = stopCapturingStdout();
    assert.equal(captured, "", "handler must not write to stdout");
  });
});

// ---------------------------------------------------------------------------
// handlePostToolUse — edit tool fixtures
// ---------------------------------------------------------------------------

describe("handlePostToolUse — edit tool", () => {
  it("returns edit_applied event for str_replace_editor (GA create flow)", () => {
    const ev = handlePostToolUse(
      {
        tool_name: "str_replace_editor",
        tool_input: { command: "create", path: "/workspace/solution.py", file_text: "def solve(n):\n    return n * 2\n" },
        tool_response: { type: "text", text: "File created successfully at /workspace/solution.py" },
      },
      mockLog,
      null,
      undefined,
      "turn-002",
    );
    assert.ok(ev);
    assert.equal(ev.kind, "edit_applied");
    assert.equal(ev.actor, "tool");
  });

  it("returns edit_applied event for str_replace_editor (str_replace flow)", () => {
    const ev = handlePostToolUse(
      {
        tool_name: "str_replace_editor",
        tool_input: {
          command: "str_replace",
          path: "/workspace/solution.py",
          old_str: "return n * 2",
          new_str: "return n * n",
        },
        tool_response: { type: "text", text: "The file /workspace/solution.py has been edited." },
      },
      mockLog,
      null,
    );
    assert.ok(ev);
    assert.equal(ev.kind, "edit_applied");
  });

  it("returns edit_applied for write_file tool name", () => {
    const ev = handlePostToolUse(
      { tool_name: "write_file", tool_input: { path: "a.py", content: "x=1" }, tool_response: "ok" },
      mockLog,
      null,
    );
    assert.ok(ev);
    assert.equal(ev.kind, "edit_applied");
  });

  it("does not write to stdout", () => {
    startCapturingStdout();
    handlePostToolUse({ tool_name: "str_replace_editor", tool_input: {}, tool_response: "ok" }, mockLog, null);
    const captured = stopCapturingStdout();
    assert.equal(captured, "", "edit handler must not write to stdout");
  });
});

// ---------------------------------------------------------------------------
// handlePostToolUse — shell tool fixtures
// ---------------------------------------------------------------------------

describe("handlePostToolUse — shell tool", () => {
  it("returns test_completed for pytest bash invocations", () => {
    const ev = handlePostToolUse(
      {
        tool_name: "bash",
        tool_input: { command: "python -m pytest tests/ -v" },
        tool_response: {
          stdout: "PASSED tests/test_solution.py::test_basic\nPASSED tests/test_solution.py::test_edge\n",
          stderr: "",
          exit_code: 0,
        },
      },
      mockLog,
      null,
    );
    assert.ok(ev);
    assert.equal(ev.kind, "test_completed");
    assert.equal(ev.actor, "tool");
  });

  it("returns test_completed for pytest with non-zero exit code", () => {
    const ev = handlePostToolUse(
      {
        tool_name: "bash",
        tool_input: { command: "python -m pytest tests/ -v" },
        tool_response: {
          stdout: "FAILED tests/test_solution.py::test_basic\n",
          stderr: "AssertionError: expected 4 got 2\n",
          exit_code: 1,
        },
      },
      mockLog,
      null,
    );
    assert.ok(ev);
    assert.equal(ev.kind, "test_completed");
  });

  it("returns shell_completed for non-test bash commands", () => {
    const ev = handlePostToolUse(
      {
        tool_name: "bash",
        tool_input: { command: "ls -la src/" },
        tool_response: {
          stdout: "total 8\ndrwxr-xr-x 2 user user 4096 Jan 1 00:00 .\n",
          stderr: "",
          exit_code: 0,
        },
      },
      mockLog,
      null,
    );
    assert.ok(ev);
    assert.equal(ev.kind, "shell_completed");
    assert.equal(ev.actor, "tool");
  });

  it("truncates large stdout without throwing", () => {
    const largeStdout = "x".repeat(100_000);
    assert.doesNotThrow(() => {
      handlePostToolUse(
        { tool_name: "bash", tool_input: "cat big.txt", tool_response: { stdout: largeStdout, stderr: "", exit_code: 0 } },
        mockLog,
        null,
      );
    });
  });

  it("does not write to stdout", () => {
    startCapturingStdout();
    handlePostToolUse(
      { tool_name: "bash", tool_input: "x", tool_response: { stdout: "", stderr: "", exit_code: 0 } },
      mockLog,
      null,
    );
    const captured = stopCapturingStdout();
    assert.equal(captured, "", "shell handler must not write to stdout");
  });
});

// ---------------------------------------------------------------------------
// handlePostToolUse — generic tool
// ---------------------------------------------------------------------------

describe("handlePostToolUse — generic tool", () => {
  it("returns tool_call_completed for unrecognised tool", () => {
    const ev = handlePostToolUse(
      { tool_name: "some_custom_tool", tool_input: { arg: "value" }, tool_response: { data: 42 } },
      mockLog,
      null,
    );
    assert.ok(ev);
    assert.equal(ev.kind, "tool_call_completed");
  });

  it("handles null tool_response without throwing", () => {
    assert.doesNotThrow(() => {
      handlePostToolUse({ tool_name: "some_tool", tool_input: {}, tool_response: null }, mockLog, null);
    });
  });
});

// ---------------------------------------------------------------------------
// handleUserPromptSubmit
// ---------------------------------------------------------------------------

describe("handleUserPromptSubmit", () => {
  it("returns prompt_submitted for a realistic candidate prompt", () => {
    const ev = handleUserPromptSubmit(
      { prompt: "Implement a function that finds the kth largest element in an array using a min-heap.", session_id: "s1" },
      mockLog,
      "turn-003",
    );
    assert.ok(ev);
    assert.equal(ev.kind, "prompt_submitted");
    assert.equal(ev.actor, "candidate");
  });

  it("handles empty prompt string without throwing", () => {
    assert.doesNotThrow(() => {
      handleUserPromptSubmit({ prompt: "", session_id: "s1" }, mockLog);
    });
  });

  it("handles missing prompt field without throwing", () => {
    assert.doesNotThrow(() => {
      handleUserPromptSubmit({}, mockLog);
    });
  });

  it("does not write to stdout", () => {
    startCapturingStdout();
    handleUserPromptSubmit({ prompt: "test" }, mockLog);
    const captured = stopCapturingStdout();
    assert.equal(captured, "", "prompt handler must not write to stdout");
  });
});

// ---------------------------------------------------------------------------
// handleStop
// ---------------------------------------------------------------------------

describe("handleStop", () => {
  it("returns response_received for normal stop with transcript", () => {
    const ev = handleStop(
      { session_id: "s1", transcript_path: "/home/user/.claude/projects/workspace/abc123.jsonl" },
      mockLog,
      "turn-004",
    );
    assert.ok(ev);
    assert.equal(ev.kind, "response_received");
    assert.equal(ev.actor, "assistant");
  });

  it("handles missing transcript_path without throwing", () => {
    assert.doesNotThrow(() => {
      handleStop({ session_id: "s1" }, mockLog);
    });
  });

  it("handles empty payload without throwing", () => {
    assert.doesNotThrow(() => {
      handleStop({}, mockLog);
    });
  });

  it("does not write to stdout", () => {
    startCapturingStdout();
    handleStop({ session_id: "s1" }, mockLog);
    const captured = stopCapturingStdout();
    assert.equal(captured, "", "stop handler must not write to stdout");
  });
});

// ---------------------------------------------------------------------------
// handlePermissionRequest — GA lifecycle hook
// ---------------------------------------------------------------------------

describe("handlePermissionRequest", () => {
  it("returns permission_decided event for a realistic permission payload", () => {
    const ev = handlePermissionRequest(
      {
        tool_name: "bash",
        permission: "execute_command",
        decision: "allow",
        reason: "Candidate approved shell execution",
        session_id: "s1",
      },
      mockLog,
      "turn-005",
    );
    assert.ok(ev);
    assert.equal(ev.kind, "permission_decided");
    assert.equal(ev.actor, "tool");
  });

  it("returns permission_decided for deny decision", () => {
    const ev = handlePermissionRequest(
      { tool_name: "bash", permission: "execute_command", decision: "deny", session_id: "s1" },
      mockLog,
    );
    assert.ok(ev);
    assert.equal(ev.kind, "permission_decided");
  });

  it("handles missing fields without throwing", () => {
    assert.doesNotThrow(() => {
      handlePermissionRequest({}, mockLog);
    });
  });

  it("does not write to stdout", () => {
    startCapturingStdout();
    handlePermissionRequest({ tool_name: "bash", permission: "write", decision: "allow" }, mockLog);
    const captured = stopCapturingStdout();
    assert.equal(captured, "", "permission handler must not write to stdout");
  });
});

// ---------------------------------------------------------------------------
// handleSubagentStop — GA lifecycle hook (Claude Code subagent)
// ---------------------------------------------------------------------------

describe("handleSubagentStop", () => {
  it("returns subagent_stopped event for a realistic payload", () => {
    const ev = handleSubagentStop(
      { session_id: "s1", subagent_id: "sub-abc123", transcript_path: "/home/user/.claude/projects/sub.jsonl" },
      mockLog,
      "turn-006",
    );
    assert.ok(ev);
    assert.equal(ev.kind, "subagent_stopped");
    assert.equal(ev.actor, "assistant");
  });

  it("handles missing fields without throwing", () => {
    assert.doesNotThrow(() => {
      handleSubagentStop({}, mockLog);
    });
  });

  it("does not write to stdout", () => {
    startCapturingStdout();
    handleSubagentStop({ session_id: "s1" }, mockLog);
    const captured = stopCapturingStdout();
    assert.equal(captured, "", "subagent_stop handler must not write to stdout");
  });
});

// ---------------------------------------------------------------------------
// handleSessionStart — GA lifecycle hook
// ---------------------------------------------------------------------------

describe("handleSessionStart", () => {
  it("returns session_started event with tool and model info", () => {
    const ev = handleSessionStart(
      { session_id: "abc", model: "claude-3-5-sonnet", cwd: "/workspace" },
      mockLog,
    );
    assert.ok(ev);
    assert.equal(ev.kind, "session_started");
    assert.equal(ev.actor, "runner");
    assert.equal((ev.payload as Record<string, unknown>)["tool_session_id"], "abc");
  });

  it("does not write to stdout", () => {
    startCapturingStdout();
    handleSessionStart({ session_id: "s1" }, mockLog);
    const captured = stopCapturingStdout();
    assert.equal(captured, "", "session_start handler must not write to stdout");
  });
});

// ---------------------------------------------------------------------------
// handlePostToolUseFailure — GA lifecycle hook
// ---------------------------------------------------------------------------

describe("handlePostToolUseFailure", () => {
  it("returns tool_call_failed event with error info", () => {
    const ev = handlePostToolUseFailure(
      { tool_name: "bash", tool_input: { command: "npm test" }, error: "Process exited with code 1" },
      mockLog,
    );
    assert.ok(ev);
    assert.equal(ev.kind, "tool_call_failed");
    assert.equal(ev.actor, "tool");
  });

  it("handles missing fields without throwing", () => {
    assert.doesNotThrow(() => handlePostToolUseFailure({}, mockLog));
  });

  it("does not write to stdout", () => {
    startCapturingStdout();
    handlePostToolUseFailure({ tool_name: "bash" }, mockLog);
    const captured = stopCapturingStdout();
    assert.equal(captured, "", "post_tool_use_failure handler must not write to stdout");
  });
});

// ---------------------------------------------------------------------------
// handlePostToolBatch — GA lifecycle hook
// ---------------------------------------------------------------------------

describe("handlePostToolBatch", () => {
  it("returns batch_completed event with result count", () => {
    const ev = handlePostToolBatch(
      { tool_results: [{ stdout: "ok" }, { stdout: "ok2" }] },
      mockLog,
    );
    assert.ok(ev);
    assert.equal(ev.kind, "batch_completed");
    assert.equal(ev.actor, "tool");
    assert.equal((ev.payload as Record<string, unknown>)["tool_result_count"], 2);
  });

  it("handles empty batch without throwing", () => {
    const ev = handlePostToolBatch({}, mockLog);
    assert.ok(ev);
    assert.equal((ev.payload as Record<string, unknown>)["tool_result_count"], 0);
  });

  it("does not write to stdout", () => {
    startCapturingStdout();
    handlePostToolBatch({ tool_results: [] }, mockLog);
    const captured = stopCapturingStdout();
    assert.equal(captured, "", "post_tool_batch handler must not write to stdout");
  });
});

// ---------------------------------------------------------------------------
// handleSessionEnd — GA lifecycle hook
// ---------------------------------------------------------------------------

describe("handleSessionEnd", () => {
  it("returns session_ended event with cost and duration", () => {
    const ev = handleSessionEnd(
      { session_id: "s1", total_cost_usd: 0.05, duration_ms: 12000 },
      mockLog,
      null,
    );
    assert.ok(ev);
    assert.equal(ev.kind, "session_ended");
    assert.equal(ev.actor, "assistant");
    assert.equal((ev.payload as Record<string, unknown>)["total_cost_usd"], 0.05);
  });

  it("handles missing fields without throwing", () => {
    assert.doesNotThrow(() => handleSessionEnd({}, mockLog, null));
  });

  it("does not write to stdout", () => {
    startCapturingStdout();
    handleSessionEnd({ session_id: "s1" }, mockLog, null);
    const captured = stopCapturingStdout();
    assert.equal(captured, "", "session_end handler must not write to stdout");
  });
});

// ---------------------------------------------------------------------------
// handlePostToolUse — failure detection (tool_call_failed)
// ---------------------------------------------------------------------------

describe("handlePostToolUse — failure detection", () => {
  it("returns tool_call_failed when type=error", () => {
    const ev = handlePostToolUse(
      { tool_name: "bash", tool_input: { command: "npm test" }, tool_response: { type: "error", error: "Process exited with code 1" } },
      mockLog,
      null,
    );
    assert.ok(ev);
    assert.equal(ev.kind, "tool_call_failed");
    assert.equal(ev.actor, "tool");
  });

  it("returns tool_call_failed when isError=true", () => {
    const ev = handlePostToolUse(
      { tool_name: "str_replace_editor", tool_input: {}, tool_response: { isError: true, error: "File not found" } },
      mockLog,
      null,
    );
    assert.ok(ev);
    assert.equal(ev.kind, "tool_call_failed");
  });

  it("returns tool_call_failed when error field is a string", () => {
    const ev = handlePostToolUse(
      { tool_name: "some_tool", tool_input: {}, tool_response: { error: "Something went wrong" } },
      mockLog,
      null,
    );
    assert.ok(ev);
    assert.equal(ev.kind, "tool_call_failed");
  });

  it("returns edit_applied (not tool_call_failed) for successful str_replace_editor", () => {
    const ev = handlePostToolUse(
      { tool_name: "str_replace_editor", tool_input: { command: "create", path: "a.py", file_text: "x=1" }, tool_response: { type: "text", text: "File created." } },
      mockLog,
      null,
    );
    assert.ok(ev);
    assert.equal(ev.kind, "edit_applied");
  });

  it("does not write to stdout for failure cases", () => {
    startCapturingStdout();
    handlePostToolUse({ tool_name: "bash", tool_input: {}, tool_response: { type: "error", error: "boom" } }, mockLog, null);
    const captured = stopCapturingStdout();
    assert.equal(captured, "", "failure handler must not write to stdout");
  });
});

// ---------------------------------------------------------------------------
// Hook-script boundary test — write the handler script and run it as a child
// ---------------------------------------------------------------------------

describe("hook-script boundary", () => {
  let tmpDir: string;
  let handlerPath: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-hook-test-"));
    handlerPath = path.join(tmpDir, "hook-handler.js");
    // Write the handler script pointing at a dummy socket (not used for the
    // boundary test since we just want to verify exit-code and stdout shape)
    writeHookHandlerScript(handlerPath, path.join(tmpDir, "session.sock"));
  });

  after(() => {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  });

  for (const hookKind of ["pre_tool_use", "post_tool_use", "user_prompt_submit", "stop", "permission_request", "subagent_stop"] as const) {
    it(`${hookKind}: exits 0 and writes parseable JSON to stdout`, () => {
      const payload = JSON.stringify({ tool_name: "bash", tool_input: {}, session_id: "test-s1" });
      const result = spawnSync(
        "node",
        [handlerPath, hookKind],
        {
          input: payload,
          encoding: "utf-8",
          timeout: 5000,
          env: { ...process.env, PREPSAVANT_SESSION_ID: "test-s1" },
        },
      );
      assert.equal(result.status, 0, `hook ${hookKind} exited with non-zero code ${result.status}: ${result.stderr}`);
      const stdout = (result.stdout ?? "").trim();
      if (stdout.length > 0) {
        // Any stdout output must be valid JSON (Claude Code protocol requires this)
        assert.doesNotThrow(() => JSON.parse(stdout), `hook ${hookKind} stdout must be valid JSON, got: ${stdout}`);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Hook delivery E2E — verifies payload reaches a real Unix socket listener
// ---------------------------------------------------------------------------

describe("hook delivery E2E", () => {
  it("payload is received by socket listener before process exits", async () => {
    const net = await import("node:net");
    const tmpD = fs.mkdtempSync(path.join(os.tmpdir(), "ps-hook-delivery-"));
    const sockPath = path.join(tmpD, "runner.sock");
    const handlerScriptPath = path.join(tmpD, "handler.js");

    try {
      // Start a Unix socket server that collects incoming data
      const received: string[] = [];
      let resolveReceived!: (v: string) => void;
      const receivedPromise = new Promise<string>((r) => { resolveReceived = r; });

      const server = net.createServer((c) => {
        let buf = "";
        c.on("data", (d) => { buf += d.toString(); });
        c.on("end", () => { received.push(buf); resolveReceived(buf); });
      });
      await new Promise<void>((r) => server.listen(sockPath, r));

      // Write handler pointing at the socket
      writeHookHandlerScript(handlerScriptPath, sockPath);

      // Spawn the handler with a payload on stdin (async so event loop stays alive
      // and the socket server can process incoming connections while child runs)
      const payload = JSON.stringify({ tool_name: "bash", session_id: "e2e-test" });
      const child = spawn("node", [handlerScriptPath, "pre_tool_use"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let childExitCode: number | null = null;
      const childDone = new Promise<void>((res) => {
        child.on("close", (code) => { childExitCode = code; res(); });
      });
      child.stdin.write(payload);
      child.stdin.end();

      // Wait for both: socket delivery AND child exit (with timeout)
      const deliveredData = await Promise.race([
        receivedPromise,
        new Promise<string>((_, reject) => setTimeout(() => reject(new Error("socket delivery timed out")), 3000)),
      ]);
      await Promise.race([childDone, new Promise<void>((_, reject) => setTimeout(() => reject(new Error("child exit timed out")), 3000))]);

      server.close();

      // Hook must exit cleanly
      assert.equal(childExitCode, 0, `hook exited ${childExitCode}`);
      // Payload must have been delivered to the socket
      assert.ok(deliveredData.length > 0, "socket server received no data");
      const parsed = JSON.parse(deliveredData.trim());
      assert.equal(parsed.kind, "pre_tool_use", "delivered payload has wrong kind");
      assert.ok(parsed.data, "delivered payload missing data field");
    } finally {
      try { fs.rmSync(tmpD, { recursive: true }); } catch { /* ignore */ }
    }
  });
});

// ===========================================================================
// CURSOR ADAPTER — non-interference contract tests
// ===========================================================================

describe("cursor: verifyNonInterference", () => {
  it("returns an empty array (self-attestation passes)", () => {
    const violations = cursorVerifyNonInterference();
    assert.deepEqual(violations, []);
  });
});

describe("cursor: handlePreToolUse", () => {
  it("returns tool_call_started event for an edit tool payload", () => {
    const ev = cursorHandlePreToolUse(
      { tool_name: "edit_file", tool_input: { path: "/workspace/solution.py", content: "def solve(): pass" }, session_id: "c1" },
      mockLog,
      "turn-c01",
    );
    assert.ok(ev, "event must not be null/undefined");
    assert.equal(ev.kind, "tool_call_started");
    assert.equal(ev.actor, "tool");
  });

  it("returns tool_call_started for read_file", () => {
    const ev = cursorHandlePreToolUse(
      { tool_name: "read_file", tool_input: { path: "/workspace/solution.py" }, session_id: "c1" },
      mockLog,
    );
    assert.ok(ev);
    assert.equal(ev.kind, "tool_call_started");
  });

  it("handles missing tool_name without throwing", () => {
    assert.doesNotThrow(() => cursorHandlePreToolUse({ session_id: "c1" }, mockLog));
  });

  it("handles empty payload without throwing", () => {
    assert.doesNotThrow(() => cursorHandlePreToolUse({}, mockLog));
  });

  it("does not write to stdout", () => {
    startCapturingStdout();
    cursorHandlePreToolUse({ tool_name: "edit_file", session_id: "c1" }, mockLog);
    const captured = stopCapturingStdout();
    assert.equal(captured, "", "cursor handlePreToolUse must not write to stdout");
  });
});

describe("cursor: handlePostToolUse — edit tool", () => {
  it("returns edit_applied for edit_file", () => {
    const ev = cursorHandlePostToolUse(
      {
        tool_name: "edit_file",
        tool_input: { path: "/workspace/solution.py", content: "def solve(n):\n    return n * 2\n" },
        tool_response: { success: true },
      },
      mockLog,
      null,
      undefined,
      "turn-c02",
    );
    assert.ok(ev);
    assert.equal(ev.kind, "edit_applied");
    assert.equal(ev.actor, "tool");
  });

  it("returns edit_applied for write_file", () => {
    const ev = cursorHandlePostToolUse(
      { tool_name: "write_file", tool_input: { path: "a.py", content: "x=1" }, tool_response: "ok" },
      mockLog,
      null,
    );
    assert.ok(ev);
    assert.equal(ev.kind, "edit_applied");
  });

  it("handles null tool_response without throwing", () => {
    assert.doesNotThrow(() => {
      cursorHandlePostToolUse({ tool_name: "edit_file", tool_input: {}, tool_response: null }, mockLog, null);
    });
  });

  it("does not write to stdout", () => {
    startCapturingStdout();
    cursorHandlePostToolUse({ tool_name: "edit_file", tool_input: {}, tool_response: "ok" }, mockLog, null);
    const captured = stopCapturingStdout();
    assert.equal(captured, "", "cursor edit handler must not write to stdout");
  });
});

describe("cursor: handlePostToolUse — terminal tool", () => {
  it("returns test_completed for run_terminal_command pytest", () => {
    const ev = cursorHandlePostToolUse(
      {
        tool_name: "run_terminal_command",
        tool_input: { command: "python -m pytest tests/ -v" },
        tool_response: { exit_code: 0, stdout: "PASSED tests/test_sol.py::test_basic\n", stderr: "" },
      },
      mockLog,
      null,
    );
    assert.ok(ev);
    assert.equal(ev.kind, "test_completed");
  });

  it("returns shell_completed for non-test terminal commands", () => {
    const ev = cursorHandlePostToolUse(
      {
        tool_name: "run_terminal_command",
        tool_input: { command: "ls -la src/" },
        tool_response: { exit_code: 0, stdout: "total 8\n", stderr: "" },
      },
      mockLog,
      null,
    );
    assert.ok(ev);
    assert.equal(ev.kind, "shell_completed");
  });

  it("does not write to stdout for shell results", () => {
    startCapturingStdout();
    cursorHandlePostToolUse(
      { tool_name: "run_terminal_command", tool_input: "ls", tool_response: { exit_code: 0, stdout: "", stderr: "" } },
      mockLog,
      null,
    );
    const captured = stopCapturingStdout();
    assert.equal(captured, "", "cursor shell handler must not write to stdout");
  });
});

describe("cursor: handleUserPromptSubmit", () => {
  it("returns prompt_submitted for a candidate prompt", () => {
    const ev = cursorHandleUserPromptSubmit(
      { prompt: "Implement binary search in Python.", session_id: "c1" },
      mockLog,
      "turn-c03",
    );
    assert.ok(ev);
    assert.equal(ev.kind, "prompt_submitted");
    assert.equal(ev.actor, "candidate");
  });

  it("handles empty prompt without throwing", () => {
    assert.doesNotThrow(() => cursorHandleUserPromptSubmit({ prompt: "" }, mockLog));
  });

  it("does not write to stdout", () => {
    startCapturingStdout();
    cursorHandleUserPromptSubmit({ prompt: "solve it" }, mockLog);
    const captured = stopCapturingStdout();
    assert.equal(captured, "", "cursor prompt handler must not write to stdout");
  });
});

describe("cursor: handleStop", () => {
  it("returns response_received for normal stop", () => {
    const ev = cursorHandleStop({ session_id: "c1" }, mockLog, "turn-c04");
    assert.ok(ev);
    assert.equal(ev.kind, "response_received");
    assert.equal(ev.actor, "assistant");
  });

  it("handles empty payload without throwing", () => {
    assert.doesNotThrow(() => cursorHandleStop({}, mockLog));
  });

  it("does not write to stdout", () => {
    startCapturingStdout();
    cursorHandleStop({ session_id: "c1" }, mockLog);
    const captured = stopCapturingStdout();
    assert.equal(captured, "", "cursor stop handler must not write to stdout");
  });
});

describe("cursor: handlePermissionRequest", () => {
  it("returns permission_decided for allow decision", () => {
    const ev = cursorHandlePermissionRequest(
      { tool_name: "run_terminal_command", permission: "execute", decision: "allow", session_id: "c1" },
      mockLog,
    );
    assert.ok(ev);
    assert.equal(ev.kind, "permission_decided");
    assert.equal(ev.actor, "tool");
  });

  it("handles missing fields without throwing", () => {
    assert.doesNotThrow(() => cursorHandlePermissionRequest({}, mockLog));
  });

  it("does not write to stdout", () => {
    startCapturingStdout();
    cursorHandlePermissionRequest({ tool_name: "edit_file", decision: "allow" }, mockLog);
    const captured = stopCapturingStdout();
    assert.equal(captured, "", "cursor permission handler must not write to stdout");
  });
});

describe("cursor: handleSessionStart", () => {
  it("returns session_started with tool session id", () => {
    const ev = cursorHandleSessionStart({ session_id: "cursor-abc", model: "claude-3-5-sonnet", cwd: "/workspace" }, mockLog);
    assert.ok(ev);
    assert.equal(ev.kind, "session_started");
    assert.equal(ev.actor, "runner");
    assert.equal((ev.payload as Record<string, unknown>)["tool_session_id"], "cursor-abc");
  });

  it("does not write to stdout", () => {
    startCapturingStdout();
    cursorHandleSessionStart({ session_id: "s1" }, mockLog);
    const captured = stopCapturingStdout();
    assert.equal(captured, "", "cursor session_start handler must not write to stdout");
  });
});

describe("cursor: handleSessionEnd", () => {
  it("returns session_ended with cost and duration", () => {
    const ev = cursorHandleSessionEnd({ session_id: "c1", total_cost_usd: 0.02, duration_ms: 8000 }, mockLog, null);
    assert.ok(ev);
    assert.equal(ev.kind, "session_ended");
    assert.equal((ev.payload as Record<string, unknown>)["total_cost_usd"], 0.02);
  });

  it("handles missing fields without throwing", () => {
    assert.doesNotThrow(() => cursorHandleSessionEnd({}, mockLog, null));
  });

  it("does not write to stdout", () => {
    startCapturingStdout();
    cursorHandleSessionEnd({ session_id: "c1" }, mockLog, null);
    const captured = stopCapturingStdout();
    assert.equal(captured, "", "cursor session_end handler must not write to stdout");
  });
});

describe("cursor: handleMcpToolUse", () => {
  it("returns tool_call_completed for a realistic MCP tool payload", () => {
    const ev = cursorHandleMcpToolUse(
      { tool_name: "mcp_fetch", tool_input: { url: "https://example.com" }, tool_response: { content: "page text" }, session_id: "c1" },
      mockLog,
    );
    assert.ok(ev);
    assert.equal(ev.kind, "tool_call_completed");
    assert.equal(ev.actor, "tool");
  });

  it("handles empty payload without throwing", () => {
    assert.doesNotThrow(() => cursorHandleMcpToolUse({}, mockLog));
  });

  it("does not write to stdout", () => {
    startCapturingStdout();
    cursorHandleMcpToolUse({ tool_name: "mcp_search", tool_input: {}, tool_response: null }, mockLog);
    const captured = stopCapturingStdout();
    assert.equal(captured, "", "cursor mcp_tool_use handler must not write to stdout");
  });
});

describe("cursor: handleTabEdit", () => {
  it("returns edit_applied for a tab-edit event", () => {
    const ev = cursorHandleTabEdit(
      { file_path: "/workspace/solution.py", diff: "@@ -1,3 +1,4 @@\n def solve():\n-    pass\n+    return 42\n", session_id: "c1" },
      mockLog,
      null,
    );
    assert.ok(ev);
    assert.equal(ev.kind, "edit_applied");
    assert.equal(ev.actor, "tool");
  });

  it("handles empty payload without throwing", () => {
    assert.doesNotThrow(() => cursorHandleTabEdit({}, mockLog, null));
  });

  it("does not write to stdout", () => {
    startCapturingStdout();
    cursorHandleTabEdit({ file_path: "a.py", diff: "+x=1" }, mockLog, null);
    const captured = stopCapturingStdout();
    assert.equal(captured, "", "cursor tab_edit handler must not write to stdout");
  });
});

// ===========================================================================
// CODEX ADAPTER — non-interference contract tests
// ===========================================================================

describe("codex: verifyNonInterference", () => {
  it("returns an empty array (self-attestation passes)", () => {
    const violations = codexVerifyNonInterference();
    assert.deepEqual(violations, []);
  });
});

describe("codex: handlePreToolUse", () => {
  it("returns tool_call_started for a shell command payload", () => {
    const ev = codexHandlePreToolUse(
      { tool_name: "shell", tool_input: { cmd: ["python", "-m", "pytest", "tests/"] }, session_id: "cx1" },
      mockLog,
      "turn-cx01",
    );
    assert.ok(ev, "event must not be null/undefined");
    assert.equal(ev.kind, "tool_call_started");
    assert.equal(ev.actor, "tool");
  });

  it("returns tool_call_started for apply_patch", () => {
    const ev = codexHandlePreToolUse(
      { tool_name: "apply_patch", tool_input: { patch: "--- a/sol.py\n+++ b/sol.py\n" }, session_id: "cx1" },
      mockLog,
    );
    assert.ok(ev);
    assert.equal(ev.kind, "tool_call_started");
  });

  it("handles missing tool_name without throwing", () => {
    assert.doesNotThrow(() => codexHandlePreToolUse({ session_id: "cx1" }, mockLog));
  });

  it("handles empty payload without throwing", () => {
    assert.doesNotThrow(() => codexHandlePreToolUse({}, mockLog));
  });

  it("does not write to stdout", () => {
    startCapturingStdout();
    codexHandlePreToolUse({ tool_name: "shell", session_id: "cx1" }, mockLog);
    const captured = stopCapturingStdout();
    assert.equal(captured, "", "codex handlePreToolUse must not write to stdout");
  });
});

describe("codex: handlePostToolUse — patch tool", () => {
  it("returns edit_applied for apply_patch", () => {
    const ev = codexHandlePostToolUse(
      {
        tool_name: "apply_patch",
        tool_input: { patch: "--- a/sol.py\n+++ b/sol.py\n@@ -1 +1 @@\n-pass\n+return 42\n" },
        tool_response: { success: true },
      },
      mockLog,
      null,
      undefined,
      "turn-cx02",
    );
    assert.ok(ev);
    assert.equal(ev.kind, "edit_applied");
    assert.equal(ev.actor, "tool");
  });

  it("handles null tool_response without throwing", () => {
    assert.doesNotThrow(() => {
      codexHandlePostToolUse({ tool_name: "apply_patch", tool_input: {}, tool_response: null }, mockLog, null);
    });
  });

  it("does not write to stdout for patch results", () => {
    startCapturingStdout();
    codexHandlePostToolUse({ tool_name: "apply_patch", tool_input: {}, tool_response: "ok" }, mockLog, null);
    const captured = stopCapturingStdout();
    assert.equal(captured, "", "codex patch handler must not write to stdout");
  });
});

describe("codex: handlePostToolUse — shell tool", () => {
  it("returns test_completed for pytest shell invocation", () => {
    const ev = codexHandlePostToolUse(
      {
        tool_name: "shell",
        tool_input: { cmd: ["python", "-m", "pytest", "tests/", "-v"] },
        tool_response: { stdout: "PASSED tests/test_sol.py::test_main\n", stderr: "", exit_code: 0 },
      },
      mockLog,
      null,
    );
    assert.ok(ev);
    assert.equal(ev.kind, "test_completed");
  });

  it("returns shell_completed for non-test shell commands", () => {
    const ev = codexHandlePostToolUse(
      {
        tool_name: "shell",
        tool_input: { cmd: ["ls", "-la", "src/"] },
        tool_response: { stdout: "file.ts\n", stderr: "", exit_code: 0 },
      },
      mockLog,
      null,
    );
    assert.ok(ev);
    assert.equal(ev.kind, "shell_completed");
  });

  it("does not write to stdout", () => {
    startCapturingStdout();
    codexHandlePostToolUse(
      { tool_name: "shell", tool_input: "ls", tool_response: { exit_code: 0, stdout: "", stderr: "" } },
      mockLog,
      null,
    );
    const captured = stopCapturingStdout();
    assert.equal(captured, "", "codex shell handler must not write to stdout");
  });
});

describe("codex: handleUserPromptSubmit", () => {
  it("returns prompt_submitted for a candidate prompt", () => {
    const ev = codexHandleUserPromptSubmit(
      { prompt: "Implement a heap-sort algorithm.", session_id: "cx1" },
      mockLog,
      "turn-cx03",
    );
    assert.ok(ev);
    assert.equal(ev.kind, "prompt_submitted");
    assert.equal(ev.actor, "candidate");
  });

  it("handles empty prompt without throwing", () => {
    assert.doesNotThrow(() => codexHandleUserPromptSubmit({ prompt: "" }, mockLog));
  });

  it("does not write to stdout", () => {
    startCapturingStdout();
    codexHandleUserPromptSubmit({ prompt: "test" }, mockLog);
    const captured = stopCapturingStdout();
    assert.equal(captured, "", "codex prompt handler must not write to stdout");
  });
});

describe("codex: handleStop", () => {
  it("returns response_received for normal stop", () => {
    const ev = codexHandleStop({ session_id: "cx1" }, mockLog, "turn-cx04");
    assert.ok(ev);
    assert.equal(ev.kind, "response_received");
    assert.equal(ev.actor, "assistant");
  });

  it("handles empty payload without throwing", () => {
    assert.doesNotThrow(() => codexHandleStop({}, mockLog));
  });

  it("does not write to stdout", () => {
    startCapturingStdout();
    codexHandleStop({ session_id: "cx1" }, mockLog);
    const captured = stopCapturingStdout();
    assert.equal(captured, "", "codex stop handler must not write to stdout");
  });
});

describe("codex: handlePermissionRequest", () => {
  it("returns permission_decided for allow decision", () => {
    const ev = codexHandlePermissionRequest(
      { tool_name: "shell", permission: "execute", decision: "allow", session_id: "cx1" },
      mockLog,
    );
    assert.ok(ev);
    assert.equal(ev.kind, "permission_decided");
    assert.equal(ev.actor, "tool");
  });

  it("handles missing fields without throwing", () => {
    assert.doesNotThrow(() => codexHandlePermissionRequest({}, mockLog));
  });

  it("does not write to stdout", () => {
    startCapturingStdout();
    codexHandlePermissionRequest({ tool_name: "shell", decision: "deny" }, mockLog);
    const captured = stopCapturingStdout();
    assert.equal(captured, "", "codex permission handler must not write to stdout");
  });
});

describe("codex: handleSessionStart", () => {
  it("returns session_started with tool session id", () => {
    const ev = codexHandleSessionStart({ session_id: "codex-sess-001", model: "o3", cwd: "/workspace" }, mockLog);
    assert.ok(ev);
    assert.equal(ev.kind, "session_started");
    assert.equal(ev.actor, "runner");
    assert.equal((ev.payload as Record<string, unknown>)["tool_session_id"], "codex-sess-001");
  });

  it("does not write to stdout", () => {
    startCapturingStdout();
    codexHandleSessionStart({ session_id: "s1" }, mockLog);
    const captured = stopCapturingStdout();
    assert.equal(captured, "", "codex session_start handler must not write to stdout");
  });
});

describe("codex: handleJsonlEvent", () => {
  it("returns tool_call_started for a function_call JSONL event (OpenAI format)", () => {
    const ev = codexHandleJsonlEvent(
      {
        type: "function_call",
        call_id: "call-001",
        name: "shell",
        arguments: JSON.stringify({ cmd: ["python", "solution.py"] }),
      },
      mockLog,
      null,
      undefined,
      "turn-cx05",
    );
    assert.ok(ev);
    assert.equal(ev.kind, "tool_call_started");
    assert.equal(ev.actor, "tool");
  });

  it("returns tool_call_completed for a function_call_output JSONL event (OpenAI format)", () => {
    const ev = codexHandleJsonlEvent(
      { type: "function_call_output", call_id: "call-001", output: JSON.stringify({ exit_code: 0, stdout: "42\n", stderr: "" }) },
      mockLog,
      null,
    );
    assert.ok(ev);
    assert.equal(ev.kind, "tool_call_completed");
  });

  it("returns tool_call_started for a tool_use JSONL event (Anthropic format)", () => {
    const ev = codexHandleJsonlEvent(
      { type: "tool_use", id: "tu-001", name: "shell", input: { cmd: ["python", "-m", "pytest"] } },
      mockLog,
      null,
    );
    assert.ok(ev);
    assert.equal(ev.kind, "tool_call_started");
  });

  it("returns trust_gap for an unknown JSONL event type (forward-compat guard)", () => {
    const ev = codexHandleJsonlEvent(
      { type: "some_future_event_type", data: "opaque" },
      mockLog,
      null,
    );
    assert.ok(ev);
    assert.equal(ev.kind, "trust_gap");
  });

  it("handles malformed/empty payload without throwing", () => {
    assert.doesNotThrow(() => codexHandleJsonlEvent({ type: "__unknown_type__" } as unknown as Parameters<typeof codexHandleJsonlEvent>[0], mockLog, null));
  });

  it("does not write to stdout", () => {
    startCapturingStdout();
    codexHandleJsonlEvent({ type: "function_call", call_id: "c1", name: "shell", arguments: "{}" }, mockLog, null);
    const captured = stopCapturingStdout();
    assert.equal(captured, "", "codex jsonl_event handler must not write to stdout");
  });
});

// ---------------------------------------------------------------------------
// Hash-chain canonicalization contract
//
// The runner stores prevEventHash as sha256Hex(rawJsonLine.trimEnd()).
// The server computes selfHash as sha256Hex(JSON.stringify(ev)).
// These two expressions must produce identical results for the same event
// object — this test locks in that contract so future serialization changes
// (e.g., field ordering, minification) are caught immediately.
// ---------------------------------------------------------------------------

describe("hash-chain canonicalization — runner prevEventHash === server selfHash", () => {
  it("sha256(JSON.stringify(obj).trimEnd()) equals sha256(JSON.stringify(obj)) for a fixture event", () => {
    const fixtureEvent = {
      v: 1,
      session_id: "ses_canonicalization_fixture",
      seq: 0,
      ts: "2026-01-01T00:00:00.000Z",
      monotonic_ms: 1000,
      tool: "claude_code",
      tool_version: "1.0.0",
      adapter_version: "0.3.0",
      turn_id: "t1",
      kind: "tool_call_started",
      actor: "tool",
      payload: { tool_name: "bash", tool_input: { command: "ls -la" } },
      payload_hash: "aabbcc",
      prev_event_hash: "",
      signature: "ddeeff",
    };

    // Runner path: JSONL line writer appends "\n", prevEventHash trims it.
    const runnerLine = JSON.stringify(fixtureEvent) + "\n";
    const runnerHash = sha256Hex(runnerLine.trimEnd());

    // Server path: sha256(JSON.stringify(raw event object from request body))
    const serverHash = sha256Hex(JSON.stringify(fixtureEvent));

    assert.equal(runnerHash, serverHash,
      "runner and server must produce identical SHA-256 hashes for the same event object");
  });

  it("hash changes when a single field changes (integrity check)", () => {
    const base = { seq: 0, kind: "tool_call_started", actor: "tool", signature: "abc" };
    const modified = { ...base, kind: "shell_completed" };
    assert.notEqual(sha256Hex(JSON.stringify(base)), sha256Hex(JSON.stringify(modified)));
  });

  it("round-trip: JSONL line → JSON.parse → JSON.stringify produces same hash as original", () => {
    // This is the critical integration check: a runner-emitted JSONL line
    // (JSON.stringify(event) + newline), when received by the server as a
    // JSON-decoded POST body field, must produce the same SHA-256 via
    // JSON.stringify that the runner computed for prevEventHash.
    //
    // If any intermediate step (HTTP JSON parse, field reordering, type
    // coercion) mutates the object, the hashes will diverge and the
    // chain will break for every subsequent event.
    const originalEvent = {
      v: 1,
      session_id: "ses_roundtrip_test",
      seq: 5,
      ts: "2026-01-01T12:00:00.000Z",
      monotonic_ms: 5000,
      tool: "claude_code",
      tool_version: "1.2.3",
      adapter_version: "0.3.0",
      turn_id: "turn-7",
      kind: "shell_completed",
      actor: "tool",
      payload: { exit_code: 0, stdout: "ok", duration_ms: 42 },
      payload_hash: "aabbccddeeff00112233",
      prev_event_hash: "prev-hash-0",
      signature: "runner-sig-base64url",
    };

    // Step 1: runner writes JSONL line
    const jsonlLine = JSON.stringify(originalEvent) + "\n";

    // Step 2: runner computes prevEventHash from the JSONL line
    const runnerPrevHash = sha256Hex(jsonlLine.trimEnd());

    // Step 3: server receives the event in a JSON-decoded POST body.
    // Simulate HTTP JSON parse: parse the full JSON body as the server would.
    const serverParsed = JSON.parse(JSON.stringify(originalEvent)) as Record<string, unknown>;

    // Step 4: server computes selfHash = sha256(JSON.stringify(parsedEv))
    const serverSelfHash = sha256Hex(JSON.stringify(serverParsed));

    // The runner's prevEventHash MUST equal the server's selfHash for the chain to validate.
    assert.equal(runnerPrevHash, serverSelfHash,
      "runner prevEventHash must equal server selfHash after a JSON round-trip");

    // Additional: the server's selfHash must also match direct serialization of original
    const directHash = sha256Hex(JSON.stringify(originalEvent));
    assert.equal(serverSelfHash, directHash,
      "JSON.parse(JSON.stringify(x)) must not change the SHA-256 for plain event objects");
  });
});

// ===========================================================================
// CURSOR CONFIDENCE-CEILING ENFORCEMENT — computeCursorChannelGaps tests
// Parallel coverage to the edit-hook downgrade gate, now for shell channel.
// ===========================================================================

function fakeEvent(kind: string, actor: string, payload: Record<string, unknown> = {}): AiAssistedEvent {
  return makeMockEvent({ kind, actor, payload } as AppendEventOptions, seqCounter++);
}

describe("cursor: computeCursorChannelGaps — no events", () => {
  it("returns no gaps when event list is empty", () => {
    const gaps = computeCursorChannelGaps([]);
    assert.equal(gaps.hasMissingEditHook, false);
    assert.equal(gaps.hasShellHookGap, false);
    assert.equal(gaps.shellStartedCount, 0);
    assert.equal(gaps.shellCompletedCount, 0);
  });
});

describe("cursor: computeCursorChannelGaps — edit hook gap", () => {
  it("detects hasMissingEditHook when cursor_missing_edit_hook trust_gap is present", () => {
    const events: AiAssistedEvent[] = [
      fakeEvent("trust_gap", "runner", { reason: "cursor_missing_edit_hook", file: "solver.py" }),
    ];
    const gaps = computeCursorChannelGaps(events);
    assert.equal(gaps.hasMissingEditHook, true, "should detect missing edit hook");
    assert.equal(gaps.hasShellHookGap, false, "no shell gap when no shell commands ran");
  });

  it("ignores unrelated trust_gap reasons", () => {
    const events: AiAssistedEvent[] = [
      fakeEvent("trust_gap", "runner", { reason: "some_other_reason" }),
    ];
    const gaps = computeCursorChannelGaps(events);
    assert.equal(gaps.hasMissingEditHook, false);
  });
});

describe("cursor: computeCursorChannelGaps — shell hook gap (downgrade trigger)", () => {
  it("detects shell gap when started > 0 and zero completions", () => {
    const events: AiAssistedEvent[] = [
      fakeEvent("tool_call_started", "tool", { tool_name: "run_terminal_command", cmd: "pytest tests/" }),
      fakeEvent("tool_call_started", "tool", { tool_name: "bash", cmd: "ls -la" }),
    ];
    const gaps = computeCursorChannelGaps(events);
    assert.equal(gaps.shellStartedCount, 2);
    assert.equal(gaps.shellCompletedCount, 0);
    assert.equal(gaps.hasShellHookGap, true, "0 of 2 captured — shell gap must be flagged");
  });

  it("detects shell gap when completion count is below 50% threshold", () => {
    const events: AiAssistedEvent[] = [
      fakeEvent("tool_call_started", "tool", { tool_name: "run_terminal_command" }),
      fakeEvent("tool_call_started", "tool", { tool_name: "run_terminal_command" }),
      fakeEvent("tool_call_started", "tool", { tool_name: "bash" }),
      fakeEvent("shell_completed", "tool", { exit_code: 0 }),
    ];
    const gaps = computeCursorChannelGaps(events);
    assert.equal(gaps.shellStartedCount, 3);
    assert.equal(gaps.shellCompletedCount, 1);
    assert.equal(gaps.hasShellHookGap, true, "1/3 captured (33%) is below 50% threshold");
  });

  it("no shell gap when completions meet the 50% threshold", () => {
    const events: AiAssistedEvent[] = [
      fakeEvent("tool_call_started", "tool", { tool_name: "run_terminal_command" }),
      fakeEvent("tool_call_started", "tool", { tool_name: "run_terminal_command" }),
      fakeEvent("shell_completed", "tool", { exit_code: 0 }),
      fakeEvent("shell_completed", "tool", { exit_code: 0 }),
    ];
    const gaps = computeCursorChannelGaps(events);
    assert.equal(gaps.hasShellHookGap, false, "2/2 captured — no shell gap");
  });

  it("no shell gap when no shell-tool tool_call_started events fired", () => {
    const events: AiAssistedEvent[] = [
      fakeEvent("tool_call_started", "tool", { tool_name: "edit_file" }),
      fakeEvent("edit_applied", "tool", {}),
    ];
    const gaps = computeCursorChannelGaps(events);
    assert.equal(gaps.shellStartedCount, 0);
    assert.equal(gaps.hasShellHookGap, false, "no shell commands — shell gap must not be flagged");
  });

  it("test_completed events from actor=tool count toward shell completions", () => {
    const events: AiAssistedEvent[] = [
      fakeEvent("tool_call_started", "tool", { tool_name: "bash" }),
      fakeEvent("test_completed", "tool", { passed: 3, failed: 0 }),
    ];
    const gaps = computeCursorChannelGaps(events);
    assert.equal(gaps.shellCompletedCount, 1);
    assert.equal(gaps.hasShellHookGap, false, "test_completed (tool actor) counts as shell completion");
  });

  it("runner-actor shell_completed events are NOT counted toward completions", () => {
    // Runner-side snapshot-annotation events share shell_completed/test_completed
    // kind names but have actor="runner".  They must NOT inflate the count.
    const events: AiAssistedEvent[] = [
      fakeEvent("tool_call_started", "tool", { tool_name: "run_terminal_command" }),
      fakeEvent("shell_completed", "runner", { note: "snapshot annotation" }),
    ];
    const gaps = computeCursorChannelGaps(events);
    assert.equal(gaps.shellStartedCount, 1, "one shell command started");
    assert.equal(gaps.shellCompletedCount, 0, "runner-actor event must not count as completion");
    assert.equal(gaps.hasShellHookGap, true, "shell gap must be flagged when no tool completions recorded");
  });
});

describe("cursor: computeCursorChannelGaps — combined edit+shell gaps", () => {
  it("flags both channels when both gaps are present", () => {
    const events: AiAssistedEvent[] = [
      fakeEvent("trust_gap", "runner", { reason: "cursor_missing_edit_hook", file: "sol.py" }),
      fakeEvent("tool_call_started", "tool", { tool_name: "run_terminal_command" }),
    ];
    const gaps = computeCursorChannelGaps(events);
    assert.equal(gaps.hasMissingEditHook, true);
    assert.equal(gaps.hasShellHookGap, true);
  });
});

// ---------------------------------------------------------------------------
// Aggregate sanity checks
// ---------------------------------------------------------------------------

describe("event log capture completeness", () => {
  it("all handlers together produced events (log not bypassed)", () => {
    assert.ok(appendedEvents.length > 0, "at least one event must have been appended via the mock log");
  });

  it("every appended event has a defined kind and actor", () => {
    for (const ev of appendedEvents) {
      assert.ok(ev.kind, `event at seq=${ev.seq} must have a kind`);
      assert.ok(ev.actor, `event at seq=${ev.seq} must have an actor`);
    }
  });

  it("appended events have monotonically non-decreasing seq values", () => {
    for (let i = 1; i < appendedEvents.length; i++) {
      assert.ok(
        appendedEvents[i]!.seq >= appendedEvents[i - 1]!.seq,
        `seq at index ${i} should be >= seq at index ${i - 1}`,
      );
    }
  });
});
