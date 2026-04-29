// E2E chain smoke test: exercises the full SignedEventLog → verifyEventLog path
// using a real Ed25519 keypair and real disk I/O to a temporary directory.
//
// These tests run in Node's built-in test runner (tsx --test).
//
// What this verifies:
//   - A real ephemeral keypair can sign events
//   - Events are written to disk as JSONL
//   - The hash chain is valid (prev_event_hash links correctly)
//   - Every signature verifies against the public key
//   - Tampering with one event breaks the chain and is detected

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { generateEphemeralKeyPair } from "../ai-assisted/signing.js";
import { SignedEventLog, verifyEventLog } from "../ai-assisted/event-log.js";

let tmpDir: string;
let logPath: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-chain-smoke-"));
  logPath = path.join(tmpDir, "events.jsonl");
});

after(() => {
  try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLog(sessionId: string): { log: SignedEventLog; pubKey: string } {
  const keyPair = generateEphemeralKeyPair();
  const log = new SignedEventLog({
    sessionId,
    tool: "claude_code",
    toolVersion: "1.0.0",
    keyPair,
    logPath,
  });
  return { log, pubKey: keyPair.publicKeyBase64Url };
}

// ---------------------------------------------------------------------------
// Basic happy-path chain
// ---------------------------------------------------------------------------

describe("chain smoke — happy path", () => {
  let pubKey: string;

  before(() => {
    fs.rmSync(logPath, { force: true });
    const { log, pubKey: pk } = makeLog("chain-smoke-001");
    pubKey = pk;

    log.append({ kind: "session_started", actor: "runner", payload: { tool: "claude_code" } });
    log.append({ kind: "prompt_submitted",  actor: "candidate", payload: { prompt: "Solve two-sum" } });
    log.append({ kind: "tool_call_started", actor: "tool",      payload: { tool_name: "bash" } });
    log.append({ kind: "shell_completed",   actor: "tool",      payload: { tool_name: "bash", exit_code: 0 } });
    log.append({ kind: "response_received", actor: "assistant", payload: {} });
  });

  it("log file exists and has 5 lines", () => {
    const lines = fs.readFileSync(logPath, "utf-8").split("\n").filter(Boolean);
    assert.equal(lines.length, 5, "expected 5 JSONL lines");
  });

  it("verifyEventLog returns ok=true for valid chain", () => {
    const result = verifyEventLog(logPath, pubKey);
    if (!result.ok) {
      assert.fail(`verifyEventLog failed: ${result.error} at seq=${result.at_seq}`);
    }
    assert.equal(result.ok, true);
  });

  it("returned events array has length 5", () => {
    const result = verifyEventLog(logPath, pubKey);
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.events.length, 5);
    }
  });

  it("events have sequential seq values starting at 0", () => {
    const result = verifyEventLog(logPath, pubKey);
    assert.ok(result.ok);
    if (result.ok) {
      for (let i = 0; i < result.events.length; i++) {
        assert.equal(result.events[i]!.seq, i, `event ${i} has wrong seq`);
      }
    }
  });

  it("first event has empty prev_event_hash", () => {
    const result = verifyEventLog(logPath, pubKey);
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.events[0]!.prev_event_hash, "");
    }
  });

  it("all events have non-empty signatures", () => {
    const result = verifyEventLog(logPath, pubKey);
    assert.ok(result.ok);
    if (result.ok) {
      for (const ev of result.events) {
        assert.ok(ev.signature.length > 0, `event seq=${ev.seq} has empty signature`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Subagent_stopped and tool_call_failed event kinds make it into the chain
// ---------------------------------------------------------------------------

describe("chain smoke — new GA event kinds", () => {
  let pubKey: string;

  before(() => {
    fs.rmSync(logPath, { force: true });
    const { log, pubKey: pk } = makeLog("chain-smoke-002");
    pubKey = pk;

    log.append({ kind: "session_started",   actor: "runner",    payload: { tool: "claude_code" } });
    log.append({ kind: "tool_call_failed",  actor: "tool",      payload: { tool_name: "bash", error: "exit 1" } });
    log.append({ kind: "subagent_stopped",  actor: "assistant", payload: { subagent_id: "sub-abc" } });
    log.append({ kind: "session_ended",     actor: "runner",    payload: {} });
  });

  it("verifyEventLog returns ok=true", () => {
    const result = verifyEventLog(logPath, pubKey);
    if (!result.ok) {
      assert.fail(`verifyEventLog failed: ${result.error} at seq=${result.at_seq}`);
    }
    assert.equal(result.ok, true);
  });

  it("contains tool_call_failed event at seq=1", () => {
    const result = verifyEventLog(logPath, pubKey);
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.events[1]!.kind, "tool_call_failed");
    }
  });

  it("contains subagent_stopped event at seq=2", () => {
    const result = verifyEventLog(logPath, pubKey);
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.events[2]!.kind, "subagent_stopped");
    }
  });
});

// ---------------------------------------------------------------------------
// Tamper detection — modifying a JSONL line breaks the chain
// ---------------------------------------------------------------------------

describe("chain smoke — tamper detection", () => {
  let pubKey: string;

  before(() => {
    fs.rmSync(logPath, { force: true });
    const { log, pubKey: pk } = makeLog("chain-smoke-003");
    pubKey = pk;

    log.append({ kind: "session_started",   actor: "runner",    payload: { tool: "claude_code" } });
    log.append({ kind: "prompt_submitted",  actor: "candidate", payload: { prompt: "original" } });
    log.append({ kind: "response_received", actor: "assistant", payload: {} });
  });

  it("verifyEventLog detects chain_broken when line 0 is tampered", () => {
    const content = fs.readFileSync(logPath, "utf-8");
    const lines = content.split("\n").filter(Boolean);

    // Tamper with the first event's payload
    const ev0 = JSON.parse(lines[0]!) as Record<string, unknown>;
    ev0["payload"] = { tool: "TAMPERED" };
    lines[0] = JSON.stringify(ev0);

    const tamperedPath = path.join(tmpDir, "tampered.jsonl");
    fs.writeFileSync(tamperedPath, lines.join("\n") + "\n");

    const result = verifyEventLog(tamperedPath, pubKey);
    assert.equal(result.ok, false, "tampered log must fail verification");
    // Either signature_invalid (seq 0 sig fails) or chain_broken (seq 1 prev hash mismatch)
    assert.ok(
      result.ok === false && (result.error === "signature_invalid" || result.error === "chain_broken"),
      `expected signature_invalid or chain_broken, got: ${(result as { error: string }).error}`,
    );
  });

  it("verifyEventLog with wrong public key returns signature_invalid", () => {
    const { publicKeyBase64Url: wrongKey } = generateEphemeralKeyPair();
    const result = verifyEventLog(logPath, wrongKey);
    assert.equal(result.ok, false, "wrong public key must fail verification");
    assert.equal((result as { error: string }).error, "signature_invalid");
  });
});

// ---------------------------------------------------------------------------
// Empty log
// ---------------------------------------------------------------------------

describe("chain smoke — edge cases", () => {
  it("verifyEventLog returns ok=true for empty log file", () => {
    const emptyPath = path.join(tmpDir, "empty.jsonl");
    fs.writeFileSync(emptyPath, "");
    // A fresh keypair — public key doesn't matter since there's nothing to verify
    const { publicKeyBase64Url } = generateEphemeralKeyPair();
    const result = verifyEventLog(emptyPath, publicKeyBase64Url);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.events.length, 0);
    }
  });

  it("verifyEventLog returns log_file_not_found for missing path", () => {
    const { publicKeyBase64Url } = generateEphemeralKeyPair();
    const result = verifyEventLog(path.join(tmpDir, "does-not-exist.jsonl"), publicKeyBase64Url);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "log_file_not_found");
    }
  });
});
