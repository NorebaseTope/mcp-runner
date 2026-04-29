// Unit tests pinning the SignedEventLog.getLogHash() contract.
//
// getLogHash() must return the canonical aggregate hash that the API server
// recomputes when it receives the evidence bundle:
//
//   sha256Hex(selfHashes.join("\n"))
//
// where selfHashes are the per-line sha256 of each JSONL entry (in seq order)
// after trimming the trailing newline.
//
// A regression that re-introduces the old "sha256 of file bytes" implementation
// would cause server-side bundle_log_hash_mismatch in production but would not
// be caught by any pure runner-side test today. These cases lock the contract.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

import { generateEphemeralKeyPair } from "../ai-assisted/signing.js";
import { SignedEventLog } from "../ai-assisted/event-log.js";

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-event-log-hash-"));
});

after(() => {
  try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
});

// Independently recompute sha256(hex) — duplicated here on purpose so the test
// does not depend on the same helper the implementation under test uses.
function sha256HexLocal(data: string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function makeLog(sessionId: string, logPath: string): SignedEventLog {
  const keyPair = generateEphemeralKeyPair();
  return new SignedEventLog({
    sessionId,
    tool: "claude_code",
    toolVersion: "1.0.0",
    keyPair,
    logPath,
  });
}

describe("SignedEventLog.getLogHash — canonical aggregate", () => {
  it("matches sha256Hex(selfHashes.join('\\n')) recomputed independently from JSONL", () => {
    const logPath = path.join(tmpDir, "events-aggregate.jsonl");
    fs.rmSync(logPath, { force: true });
    const log = makeLog("hash-001", logPath);

    log.append({ kind: "session_started", actor: "runner",    payload: { tool: "claude_code" } });
    log.append({ kind: "prompt_submitted", actor: "candidate", payload: { prompt: "Solve two-sum" } });
    log.append({ kind: "tool_call_started", actor: "tool",     payload: { tool_name: "bash" } });
    log.append({ kind: "response_received", actor: "assistant", payload: {} });

    const lines = fs.readFileSync(logPath, "utf-8").split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 4, "expected 4 JSONL lines on disk");

    const selfHashes = lines.map((line) => sha256HexLocal(line));
    const expected = sha256HexLocal(selfHashes.join("\n"));

    assert.equal(log.getLogHash(), expected);
  });

  it("is NOT equal to sha256 of raw file bytes (regression guard for old impl)", () => {
    // The previous implementation hashed the file contents directly. That value
    // diverges from what the server recomputes, so getLogHash() must differ
    // from sha256(rawBytes) once there is at least one event on disk.
    const logPath = path.join(tmpDir, "events-not-file-bytes.jsonl");
    fs.rmSync(logPath, { force: true });
    const log = makeLog("hash-002", logPath);

    log.append({ kind: "session_started", actor: "runner", payload: { tool: "claude_code" } });
    log.append({ kind: "response_received", actor: "assistant", payload: {} });

    const fileBytes = fs.readFileSync(logPath, "utf-8");
    const fileBytesHash = sha256HexLocal(fileBytes);

    assert.notEqual(
      log.getLogHash(),
      fileBytesHash,
      "getLogHash() must not be sha256 of raw file bytes — that was the old, server-incompatible scheme",
    );
  });

  it("returns sha256Hex('') for an empty / never-written log", () => {
    const logPath = path.join(tmpDir, "events-empty.jsonl");
    fs.rmSync(logPath, { force: true });
    // Construct the log but do not append anything. The file may not exist yet.
    makeLog("hash-empty-001", logPath);

    const expectedEmpty = sha256HexLocal("");
    // Sanity: the well-known SHA-256 of the empty string.
    assert.equal(
      expectedEmpty,
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );

    const log = makeLog("hash-empty-002", logPath);
    assert.equal(log.getLogHash(), expectedEmpty);
  });

  it("returns sha256Hex('') when the log file exists but is zero bytes", () => {
    const logPath = path.join(tmpDir, "events-zero-bytes.jsonl");
    fs.writeFileSync(logPath, "");
    const log = makeLog("hash-empty-003", logPath);

    assert.equal(log.getLogHash(), sha256HexLocal(""));
  });

  it("changes deterministically when a new event is appended", () => {
    const logPath = path.join(tmpDir, "events-incremental.jsonl");
    fs.rmSync(logPath, { force: true });
    const log = makeLog("hash-003", logPath);

    log.append({ kind: "session_started", actor: "runner", payload: { tool: "claude_code" } });
    const after1 = log.getLogHash();

    log.append({ kind: "prompt_submitted", actor: "candidate", payload: { prompt: "hello" } });
    const after2 = log.getLogHash();

    assert.notEqual(after1, after2, "appending an event must change the aggregate hash");

    // Recompute after2 independently to make sure it still follows the contract
    // for multi-line logs (not just single-line).
    const lines = fs.readFileSync(logPath, "utf-8").split("\n").filter((l) => l.length > 0);
    const selfHashes = lines.map((line) => sha256HexLocal(line));
    assert.equal(after2, sha256HexLocal(selfHashes.join("\n")));
  });
});
