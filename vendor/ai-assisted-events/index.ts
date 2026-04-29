// Shared TypeScript + Zod types for the AI-Assisted mode event log.
// Imported by the runner, API server, and web app so the event contract
// is defined exactly once.
import { z } from "zod";

// ---------------------------------------------------------------------------
// Event kind enum — the authoritative, ratified contract for the full set of
// event types the capture pipeline may emit.
//
// Original GA set (Claude Code adapter + lifecycle hooks):
//   session_started, prompt_submitted, response_received,
//   tool_call_started, tool_call_completed, edit_proposed, edit_applied,
//   shell_started, shell_completed, test_completed, permission_decided,
//   manual_edit, trust_gap, session_ended
//
// Intentional additions beyond original spec (ratified):
//   tool_call_failed      — emitted by PostToolUseFailure hook (Claude Code GA)
//   batch_completed       — emitted by PostToolBatch hook (Claude Code GA)
//   subagent_stopped      — emitted by SubagentStop lifecycle hook
//   sam_hint_requested    — server annotation: user requested a hint
//   sam_hint_delivered    — server annotation: hint was delivered
//   sam_nudge             — server annotation: proactive nudge from Sam
//   hook_install_completed — runner lifecycle: hooks successfully installed
//   cleanup_completed      — runner lifecycle: session teardown completed
//   stale_hook_cleanup_completed — runner lifecycle: old hooks removed
//
// All three server annotation kinds (sam_*) are emitted server-side only and
// stored in ai_assisted_server_annotations — they never appear in the
// runner-signed event chain. They are included here so the ingest layer and
// downstream graders share a single enum.
// ---------------------------------------------------------------------------

export const AiAssistedEventKind = z.enum([
  "session_started",
  "prompt_submitted",
  "response_received",
  "tool_call_started",
  "tool_call_completed",
  "edit_proposed",
  "edit_applied",
  "shell_started",
  "shell_completed",
  "test_completed",
  "permission_decided",
  "manual_edit",
  "tool_call_failed",
  "batch_completed",
  "subagent_stopped",
  "sam_hint_requested",
  "sam_hint_delivered",
  "trust_gap",
  "session_ended",
  "hook_install_completed",
  "cleanup_completed",
  "stale_hook_cleanup_completed",
  "sam_nudge",
]);

export type AiAssistedEventKind = z.infer<typeof AiAssistedEventKind>;

// Actor: who produced the event
export const AiAssistedActor = z.enum([
  "candidate",
  "assistant",
  "tool",
  "runner",
  "sam",
]);
export type AiAssistedActor = z.infer<typeof AiAssistedActor>;

// ---------------------------------------------------------------------------
// Session capability manifest
// ---------------------------------------------------------------------------

export const SessionCapabilityManifest = z.object({
  // What the runner captures
  captures: z.array(z.string()),
  // What the runner explicitly never captures
  notCaptures: z.array(z.string()),
  // Short human-readable label
  toolLabel: z.string(),
  // Consent version for audit trail
  consentVersion: z.string(),
  // Maximum confidence level the grader will assign for this session.
  // "high" requires all hook channels healthy; "medium" is the default for
  // beta tools or sessions with incomplete shell/edit hook coverage.
  confidenceCeiling: z.enum(["high", "medium", "low"]).optional(),
  // OS-specific limitations that affect capture fidelity on this platform.
  osCaveats: z.array(z.string()).optional(),
  // Whether the tool is GA or in beta. Beta tools show a visible label.
  toolStatus: z.enum(["ga", "beta"]).optional(),
});
export type SessionCapabilityManifest = z.infer<typeof SessionCapabilityManifest>;

export const DEFAULT_CAPABILITY_MANIFEST: SessionCapabilityManifest = {
  captures: [
    "Prompts you send to the AI assistant",
    "AI responses",
    "Tool calls and their results (file reads, shell commands)",
    "File edits the AI proposes and applies",
    "Shell commands and capped stdout/stderr",
    "Test outcomes",
    "Workspace diffs at key boundaries",
  ],
  notCaptures: [
    "Your screen or webcam",
    "Your microphone",
    "Keystroke timing or patterns",
    "Your private AI API keys or credentials",
    "Files outside the problem workspace",
  ],
  toolLabel: "Claude Code",
  consentVersion: "1.0",
  confidenceCeiling: "high",
  toolStatus: "ga",
};

// ---------------------------------------------------------------------------
// Common signed event
// ---------------------------------------------------------------------------

export const AiAssistedEvent = z.object({
  // Schema version (always 1 for now)
  v: z.literal(1),
  // Session identifier
  session_id: z.string(),
  // Monotonically increasing sequence number (0-indexed)
  seq: z.number().int().nonnegative(),
  // Wall-clock ISO 8601 timestamp
  ts: z.string().datetime(),
  // Elapsed milliseconds since session start (monotonic, from runner)
  monotonic_ms: z.number().int().nonnegative(),
  // Which tool produced this event (e.g. "claude_code")
  tool: z.string(),
  tool_version: z.string(),
  adapter_version: z.string(),
  // Opaque turn identifier grouping related events (e.g. one prompt+response)
  turn_id: z.string().optional(),
  // Event classification
  kind: AiAssistedEventKind,
  actor: AiAssistedActor,
  // Payload — structured data specific to the event kind. Intentionally
  // typed as unknown here; callers narrow with kind-specific validators.
  payload: z.unknown(),
  // SHA-256 hash of JSON.stringify(payload)
  payload_hash: z.string(),
  // SHA-256 tree hash of the workspace at time of event (optional; computed
  // by the snapshot module after edit_applied / shell_completed / session_ended)
  workspace_tree_hash: z.string().optional(),
  // Shadow git commit SHA at time of event (optional)
  shadow_commit_sha: z.string().optional(),
  // Hash of the previous event in the chain (empty string for seq=0)
  prev_event_hash: z.string(),
  // Ed25519 signature over the canonical event bytes (base64url)
  signature: z.string(),
});
export type AiAssistedEvent = z.infer<typeof AiAssistedEvent>;

// ---------------------------------------------------------------------------
// Trust-gap event payload
// ---------------------------------------------------------------------------

export const TrustGapPayload = z.object({
  reason: z.string(),
  // Which event kind was expected but failed / missing
  expected_kind: AiAssistedEventKind.optional(),
  // The seq number where the gap was detected
  at_seq: z.number().int().optional(),
  // Any additional context
  detail: z.record(z.unknown()).optional(),
});
export type TrustGapPayload = z.infer<typeof TrustGapPayload>;

// ---------------------------------------------------------------------------
// Evidence bundle manifest (uploaded at session end)
// ---------------------------------------------------------------------------

export const EvidenceBundleManifest = z.object({
  session_id: z.string(),
  event_count: z.number().int(),
  final_event_hash: z.string(),
  // Aggregate log hash: sha256 over the ordered selfHash chain joined by
  // "\n". Computed by both runner (event-log.ts getLogHash) and server
  // (routes/runner.ts bundle handler) to detect tampering of the structured
  // event log; mismatch flips integrity to "bundle_log_hash_mismatch".
  log_hash: z.string(),
  snapshot_count: z.number().int(),
  trust_gap_count: z.number().int(),
  ended_at: z.string().datetime(),
  runner_version: z.string(),
  adapter_version: z.string(),
  // Effective confidence ceiling after runtime enforcement checks (may differ from
  // the initial manifest.confidenceCeiling if snapshot/JSONL disagreement was detected).
  effective_confidence_ceiling: z.enum(["high", "medium", "low"]).optional(),
});
export type EvidenceBundleManifest = z.infer<typeof EvidenceBundleManifest>;

// ---------------------------------------------------------------------------
// Session certificate (issued by server, signed by server key)
// ---------------------------------------------------------------------------

export const SessionCertificateClaims = z.object({
  sessionId: z.string(),
  userId: z.string(),
  problemId: z.string(),
  runnerVersion: z.string(),
  adapterVersion: z.string(),
  tool: z.string(),
  capabilityManifest: SessionCapabilityManifest,
  // Runner's Ed25519 public key (base64url)
  runnerPublicKey: z.string(),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});
export type SessionCertificateClaims = z.infer<typeof SessionCertificateClaims>;

// ---------------------------------------------------------------------------
// AI-Assisted session create request block
// ---------------------------------------------------------------------------

export const AiAssistedSessionBlock = z.object({
  tool: z.string(),
  toolVersion: z.string(),
  adapterVersion: z.string(),
  runnerVersion: z.string(),
  // Runner's ephemeral Ed25519 public key (base64url)
  runnerPublicKey: z.string(),
  capabilityManifest: SessionCapabilityManifest,
});
export type AiAssistedSessionBlock = z.infer<typeof AiAssistedSessionBlock>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Compute canonical event hash for chain: SHA-256 of the raw JSONL line
// (without the signature field). Used both by the runner and server.
// We re-export the algorithm name so both sides use the same constant.
export const CHAIN_HASH_ALGORITHM = "sha256" as const;

// Maximum payload capture sizes
export const MAX_STDOUT_BYTES = 64 * 1024; // 64 KB
export const MAX_FILE_SIZE_BYTES = 512 * 1024; // 512 KB
