// Local signed JSONL event log for an AI-Assisted session.
// Each event is signed with the runner's ephemeral Ed25519 key and references
// the previous event's hash to build a tamper-evident chain.
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { RunnerKeyPair } from "./signing.js";
import { signData, sha256Hex, canonicalEventBytes, verifySignature } from "./signing.js";
import type { AiAssistedEvent, AiAssistedEventKind, AiAssistedActor } from "@workspace/ai-assisted-events";
import { ADAPTER_VERSION } from "../config.js";

export interface EventLogOptions {
  sessionId: string;
  tool: string;
  toolVersion: string;
  keyPair: RunnerKeyPair;
  // Optional override for the log file path. Used by tests to write to a
  // temporary location instead of the default platform-specific data directory.
  logPath?: string;
}

export interface AppendEventOptions {
  kind: AiAssistedEventKind;
  actor: AiAssistedActor;
  payload: unknown;
  turnId?: string;
  shadowCommitSha?: string;
  workspaceTreeHash?: string;
}

export class SignedEventLog {
  private readonly logPath: string;
  private readonly sessionId: string;
  private readonly tool: string;
  private readonly toolVersion: string;
  private readonly keyPair: RunnerKeyPair;
  private seq = 0;
  private prevEventHash = "";
  private readonly sessionStartMs: number;
  // In-memory buffer of events appended since the last drainBuffer() call.
  // Used by session.ts to capture ALL events (including adapter-internal
  // secondary appends such as snapshot annotations) without relying on the
  // return value of the adapter handler functions.
  private eventBuffer: AiAssistedEvent[] = [];

  constructor(opts: EventLogOptions) {
    this.sessionId = opts.sessionId;
    this.tool = opts.tool;
    this.toolVersion = opts.toolVersion;
    this.keyPair = opts.keyPair;
    this.sessionStartMs = Date.now();
    this.logPath = opts.logPath ?? SignedEventLog.logPathFor(opts.sessionId);
    // Ensure the directory exists
    fs.mkdirSync(path.dirname(this.logPath), { recursive: true, mode: 0o700 });
  }

  static logPathFor(sessionId: string): string {
    const base =
      process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Application Support", "PrepSavant", "sessions")
        : process.platform === "win32"
          ? path.join(process.env.LOCALAPPDATA ?? os.homedir(), "PrepSavant", "sessions")
          : path.join(os.homedir(), ".local", "share", "prepsavant", "sessions");
    return path.join(base, sessionId, "events.jsonl");
  }

  append(opts: AppendEventOptions): AiAssistedEvent {
    const now = Date.now();
    const payloadHash = sha256Hex(JSON.stringify(opts.payload));

    // Build event without signature first (for canonical bytes)
    const withoutSignature: Omit<AiAssistedEvent, "signature"> = {
      v: 1,
      session_id: this.sessionId,
      seq: this.seq,
      ts: new Date(now).toISOString(),
      monotonic_ms: now - this.sessionStartMs,
      tool: this.tool,
      tool_version: this.toolVersion,
      adapter_version: ADAPTER_VERSION,
      turn_id: opts.turnId,
      kind: opts.kind,
      actor: opts.actor,
      payload: opts.payload,
      payload_hash: payloadHash,
      workspace_tree_hash: opts.workspaceTreeHash,
      shadow_commit_sha: opts.shadowCommitSha,
      prev_event_hash: this.prevEventHash,
    };

    const canonical = canonicalEventBytes(withoutSignature as Record<string, unknown>);
    const signature = signData(canonical, this.keyPair);

    const event: AiAssistedEvent = { ...withoutSignature, signature };

    // Append to JSONL log
    const line = JSON.stringify(event) + "\n";
    fs.appendFileSync(this.logPath, line, { mode: 0o600 });

    // Update chain state
    this.prevEventHash = sha256Hex(line.trimEnd()); // hash of raw JSON line
    this.seq++;

    // Buffer for drain-based upload (captures secondary appends like snapshot annotations)
    this.eventBuffer.push(event);

    return event;
  }

  // Return and clear all events appended since the last drainBuffer() call.
  // session.ts calls this after each hook dispatch to enqueue ALL new events
  // (including adapter-internal secondary appends) for upload.
  drainBuffer(): AiAssistedEvent[] {
    return this.eventBuffer.splice(0, this.eventBuffer.length);
  }

  getLogPath(): string {
    return this.logPath;
  }

  // Canonical aggregate log_hash sent to the server in the evidence bundle.
  //
  // Definition: sha256Hex(selfHashes ordered by seq joined by "\n"), where each
  // selfHash is sha256(JSON.stringify(event)) — equivalent to the per-line
  // sha256 of each JSONL entry after String.trimEnd() (see signing.ts header).
  //
  // The server recomputes the same value from its stored ai_assisted_events
  // rows in routes/runner.ts (POST /runner/ai-sessions/:id/bundle) and rejects
  // the bundle (integrity_status="bundle_log_hash_mismatch") on disagreement.
  // Both sides MUST stay in sync — if you change this scheme, update the
  // server handler and ai-signing.test.ts in lockstep.
  getLogHash(): string {
    if (!fs.existsSync(this.logPath)) return sha256Hex("");
    const content = fs.readFileSync(this.logPath, "utf-8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    const selfHashes = lines.map((line) => sha256Hex(line));
    return sha256Hex(selfHashes.join("\n"));
  }

  getEventCount(): number {
    return this.seq;
  }

  getPrevEventHash(): string {
    return this.prevEventHash;
  }
}

// Read and verify an existing JSONL event log.
// Returns { ok: true, events } on success, or { ok: false, error, at_seq } on failure.
export function verifyEventLog(
  logPath: string,
  runnerPublicKeyBase64Url: string,
): { ok: true; events: AiAssistedEvent[] } | { ok: false; error: string; at_seq?: number } {
  if (!fs.existsSync(logPath)) {
    return { ok: false, error: "log_file_not_found" };
  }
  const lines = fs.readFileSync(logPath, "utf-8").split("\n").filter(Boolean);
  const events: AiAssistedEvent[] = [];
  let prevHash = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let event: AiAssistedEvent;
    try {
      event = JSON.parse(line!) as AiAssistedEvent;
    } catch {
      return { ok: false, error: "json_parse_error", at_seq: i };
    }

    // Verify sequence
    if (event.seq !== i) {
      return { ok: false, error: "sequence_mismatch", at_seq: i };
    }

    // Verify prev_event_hash chain
    if (event.prev_event_hash !== prevHash) {
      return { ok: false, error: "chain_broken", at_seq: i };
    }

    // Verify signature: reconstruct canonical bytes without signature field
    const { signature, ...withoutSig } = event;
    const canonical = canonicalEventBytes(withoutSig as Record<string, unknown>);
    if (!verifySignature(canonical, signature, runnerPublicKeyBase64Url)) {
      return { ok: false, error: "signature_invalid", at_seq: i };
    }

    prevHash = sha256Hex(line!);
    events.push(event);
  }

  return { ok: true, events };
}
