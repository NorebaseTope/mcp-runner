// AI-Assisted session orchestration.
// Manages the lifecycle: key generation → session create → consent → hook install →
// event capture (with periodic upload) → snapshot → bundle upload → cleanup.
// Supports: claude_code (GA), cursor (Beta), codex (Beta).
import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import * as os from "node:os";
import { generateEphemeralKeyPair, sha256Hex } from "./signing.js";
import { SignedEventLog } from "./event-log.js";
import { SnapshotStore } from "./snapshot.js";
import {
  installClaudeCodeHooks,
  installCursorHooks,
  installCodexHooks,
  restoreClaudeCodeHooks,
  restoreCursorHooks,
  restoreCodexHooks,
  writeHookHandlerScript,
  validateHandlerNonInterference,
} from "./hook-installer.js";
import {
  handlePreToolUse as claudePreToolUse,
  handlePostToolUse as claudePostToolUse,
  handleUserPromptSubmit as claudeUserPromptSubmit,
  handleStop as claudeStop,
  handlePermissionRequest as claudePermissionRequest,
  handleSubagentStop,
  handleSessionStart as claudeSessionStart,
  handlePostToolUseFailure,
  handlePostToolBatch,
  handleSessionEnd as claudeSessionEnd,
} from "./claude-adapter.js";
import {
  handlePreToolUse as cursorPreToolUse,
  handlePostToolUse as cursorPostToolUse,
  handleUserPromptSubmit as cursorUserPromptSubmit,
  handleStop as cursorStop,
  handlePermissionRequest as cursorPermissionRequest,
  handleSessionStart as cursorSessionStart,
  handleSessionEnd as cursorSessionEnd,
  handleMcpToolUse,
  handleTabEdit,
} from "./cursor-adapter.js";
import {
  handlePreToolUse as codexPreToolUse,
  handlePostToolUse as codexPostToolUse,
  handleUserPromptSubmit as codexUserPromptSubmit,
  handleStop as codexStop,
  handlePermissionRequest as codexPermissionRequest,
  handleSessionStart as codexSessionStart,
  handleJsonlEvent,
  readCodexSessionJsonl,
  type CodexJsonlEvent,
} from "./codex-adapter.js";
import type { AiAssistedSessionBlock, SessionCapabilityManifest } from "@workspace/ai-assisted-events";
import { DEFAULT_CAPABILITY_MANIFEST, EvidenceBundleManifest } from "@workspace/ai-assisted-events";
import { SamApi } from "../api.js";
import { ADAPTER_VERSION, readConfig } from "../config.js";
import type { AiAssistedEvent } from "@workspace/ai-assisted-events";
import { computeCursorChannelGaps } from "./cursor-confidence.js";

export type SupportedTool = "claude_code" | "cursor" | "codex";

export interface StartAiSessionOptions {
  tool: SupportedTool;
  toolVersion: string;
  workspaceDir: string;
  questionId: string;
  companyId?: string;
  targetDurationMinutes?: number;
  runnerVersion: string;
  onEvent?: (kind: string, seq: number) => void;
  staleCleaned?: boolean;
  // For codex non-interactive path: pipe stdin JSONL from codex exec --json
  codexExecMode?: boolean;
}

export interface AiSessionHandle {
  sessionId: string;
  certificateJwt: string;
  capabilityManifest: SessionCapabilityManifest;
  // IPC socket path used by hook handlers. Exposed so the Codex exec --json
  // pipeline in cli-start.ts can forward JSONL events on the same channel.
  socketPath: string;
  stop(): Promise<void>;
}

// Exported so cli-start.ts can use the socket path for codex exec piping.
export function ipcSocketPathForSession(sessionId: string): string {
  return ipcSocketPath(sessionId);
}

const FLUSH_BATCH_SIZE = 10;
const FLUSH_INTERVAL_MS = 30_000;
const ANCHOR_EVERY_N_EVENTS = 50;

function ipcSocketPath(sessionId: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\prepsavant-${sessionId}`;
  }
  return path.join(os.tmpdir(), `prepsavant-${sessionId}.sock`);
}

// Directory where Codex writes per-session JSONL files in interactive mode.
function codexSessionsParentDir(): string {
  return path.join(os.homedir(), ".codex", "sessions");
}

function handlerScriptPath(sessionId: string): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "PrepSavant", "sessions", sessionId, "hook-handler.cjs");
  }
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? os.homedir(), "PrepSavant", "sessions", sessionId, "hook-handler.cjs");
  }
  return path.join(os.homedir(), ".local", "share", "prepsavant", "sessions", sessionId, "hook-handler.cjs");
}

// Build the tool-specific capability manifest.
// Confidence ceiling and OS caveats are set based on the tool and platform.
export function buildCapabilityManifest(
  tool: SupportedTool,
  codexExecMode = false,
): SessionCapabilityManifest {
  const platform = process.platform;

  if (tool === "claude_code") {
    return {
      ...DEFAULT_CAPABILITY_MANIFEST,
      toolLabel: "Claude Code",
      toolStatus: "ga",
      confidenceCeiling: "high",
    };
  }

  if (tool === "cursor") {
    const osCaveats: string[] = [];
    if (platform === "linux") {
      osCaveats.push("Cursor on Linux may have reduced hook coverage — Tab edits may not fire edit hooks");
    }
    if (platform === "win32") {
      osCaveats.push("Cursor on Windows requires version 0.45+ for hook support");
    }
    // Optimistic confidence ceiling: non-Linux platforms with Cursor 0.45+
    // support all required hooks (prompt, response, edit, shell, permission,
    // MCP, tab-edit).  Linux has known reduced hook coverage so we cap there.
    // The stop() reconciliation may downgrade from "high" to "medium" if
    // edit-hook coverage is found to be incomplete at session end.
    const initialCeiling: "high" | "medium" = platform === "linux" ? "medium" : "high";
    return {
      captures: [
        "Prompts you send to the Cursor agent",
        "Agent responses",
        "Tool calls and results (file reads, shell commands)",
        "File edits the agent applies",
        "Shell commands and capped stdout/stderr",
        "MCP tool calls before and after",
        "Workspace diffs at key boundaries (snapshot authority for file state)",
      ],
      notCaptures: [
        "Your screen or webcam",
        "Your microphone",
        "Keystroke timing or patterns",
        "Your private API keys or credentials",
        "Files outside the problem workspace",
        "Local Cursor SQLite chat database",
        "Tab-completion edits when edit hooks are not supported by this Cursor version",
      ],
      toolLabel: "Cursor (Beta)",
      consentVersion: "1.0",
      toolStatus: "beta",
      confidenceCeiling: initialCeiling,
      osCaveats,
    };
  }

  // codex
  const isHighConfidence = codexExecMode;
  const osCaveats: string[] = [];
  if (platform === "win32") {
    osCaveats.push("Codex CLI hooks require CODEX_HOOKS=1 env var; interactive hooks have limited coverage on Windows");
  }

  return {
    captures: codexExecMode
      ? [
          "Prompts and AI responses (from JSONL stream)",
          "Tool calls and results (file edits, shell commands, web searches)",
          "File changes with diffs",
          "Plan updates and reasoning steps",
          "Workspace diffs at key boundaries",
        ]
      : [
          "Prompts you send to Codex",
          "Codex responses",
          "Tool calls and results (file edits, shell commands)",
          "Permission decisions",
          "Workspace diffs at key boundaries",
        ],
    notCaptures: codexExecMode
      ? [
          "Your screen or webcam",
          "Your microphone",
          "Keystroke timing or patterns",
          "Your private API keys or credentials",
          "Files outside the problem workspace",
        ]
      : [
          "Your screen or webcam",
          "Your microphone",
          "Keystroke timing or patterns",
          "Your private API keys or credentials",
          "Files outside the problem workspace",
          "WebSearch results (incomplete hook coverage in interactive mode)",
          "Shell calls not intercepted by Codex hooks",
        ],
    toolLabel: codexExecMode ? "Codex CLI — exec mode (Beta)" : "Codex CLI (Beta)",
    consentVersion: "1.0",
    toolStatus: "beta",
    confidenceCeiling: isHighConfidence ? "high" : "medium",
    osCaveats,
  };
}

export async function startAiAssistedSession(
  opts: StartAiSessionOptions,
): Promise<AiSessionHandle> {
  const cfg = readConfig();
  const api = new SamApi(cfg);

  const keyPair = generateEphemeralKeyPair();

  const capabilityManifest = buildCapabilityManifest(
    opts.tool,
    opts.codexExecMode ?? false,
  );

  const aiAssistedBlock: AiAssistedSessionBlock = {
    tool: opts.tool,
    toolVersion: opts.toolVersion,
    adapterVersion: ADAPTER_VERSION,
    runnerVersion: opts.runnerVersion,
    runnerPublicKey: keyPair.publicKeyBase64Url,
    capabilityManifest,
  };

  const startRes = await api.startAiAssistedSession({
    questionId: opts.questionId,
    companyId: opts.companyId,
    targetDurationMinutes: opts.targetDurationMinutes,
    aiAssisted: aiAssistedBlock,
  });

  const { sessionId, certificateJwt } = startRes;

  await api.recordAiAssistedConsent(sessionId);

  const log = new SignedEventLog({
    sessionId,
    tool: opts.tool,
    toolVersion: opts.toolVersion,
    keyPair,
  });

  const snapshot = new SnapshotStore({
    sessionId,
    workspaceDir: opts.workspaceDir,
  });
  snapshot.initialize();

  // Baseline snapshot: captures the entire workspace state at session start.
  // Its commitSha is used as the diff base for Cursor reconciliation and Codex
  // exec confidence enforcement — only files changed AFTER this point are
  // compared against hook/JSONL events. Without this, getChangedFilesSince(null)
  // would include all files in the workspace from repo history start.
  const baselineSnap = snapshot.snapshot("session_baseline");
  // baselineSnap is null only for an empty workspace (nothing to stage).
  // In either case, sessionBaselineSha is the correct starting point.
  const sessionBaselineSha: string | null = baselineSnap?.commitSha ?? null;

  const socketPath = ipcSocketPath(sessionId);
  const handlerPath = handlerScriptPath(sessionId);
  writeHookHandlerScript(handlerPath, socketPath);

  const niCheck = validateHandlerNonInterference(handlerPath);
  if (!niCheck.ok) {
    throw new Error(`Hook handler failed non-interference check: ${niCheck.error}`);
  }

  // Install hooks for the appropriate tool
  let installResult;
  if (opts.tool === "claude_code") {
    installResult = installClaudeCodeHooks(opts.workspaceDir, {
      toolId: "claude_code",
      sessionId,
      handlerPath,
      socketPath,
    });
  } else if (opts.tool === "cursor") {
    installResult = installCursorHooks(opts.workspaceDir, {
      toolId: "cursor",
      sessionId,
      handlerPath,
      socketPath,
    });
  } else {
    // codex — hooks are behind feature flag; install best-effort
    installResult = installCodexHooks(opts.workspaceDir, {
      toolId: "codex",
      sessionId,
      handlerPath,
      socketPath,
    });
  }

  if (!installResult.ok) {
    throw new Error(`Hook install failed: ${installResult.error}`);
  }

  // ---------------------------------------------------------------------------
  // Upload pipeline
  // ---------------------------------------------------------------------------

  const pendingEvents: AiAssistedEvent[] = [];
  let uploading = false;
  let snapshotCount = 0;
  let anchorFlushAt = ANCHOR_EVERY_N_EVENTS;
  let uploadRetryCount = 0;
  const MAX_UPLOAD_RETRIES = 3;

  async function flushPendingEvents(): Promise<void> {
    if (uploading || pendingEvents.length === 0) return;
    uploading = true;
    const batch = pendingEvents.splice(0, pendingEvents.length);
    try {
      await api.appendAiAssistedEvents(sessionId, batch);
      uploadRetryCount = 0;
      const acceptedSeq = batch.length > 0 ? (batch[batch.length - 1]?.seq ?? -1) : -1;
      if (acceptedSeq >= 0 && acceptedSeq >= anchorFlushAt - ANCHOR_EVERY_N_EVENTS) {
        const anchors = batch.map((e) => ({
          seq: e.seq,
          eventHash: sha256Hex(JSON.stringify(e)),
        }));
        try {
          await api.anchorAiAssistedEvents(sessionId, anchors);
          anchorFlushAt = acceptedSeq + ANCHOR_EVERY_N_EVENTS;
        } catch {}
      }
    } catch {
      uploadRetryCount++;
      if (uploadRetryCount >= MAX_UPLOAD_RETRIES) {
        uploadRetryCount = 0;
        log.append({
          kind: "trust_gap",
          actor: "runner",
          payload: {
            reason: "event_upload_failed",
            failed_event_count: batch.length,
            first_seq: batch[0]?.seq ?? -1,
            last_seq: batch[batch.length - 1]?.seq ?? -1,
          },
        });
        for (const ev of log.drainBuffer()) {
          pendingEvents.push(ev);
        }
      } else {
        pendingEvents.unshift(...batch);
      }
    } finally {
      uploading = false;
    }
  }

  const flushTimer = setInterval(() => { void flushPendingEvents(); }, FLUSH_INTERVAL_MS);
  flushTimer.unref();

  // ---------------------------------------------------------------------------
  // Codex interactive JSONL polling — STRICTLY session-scoped
  //
  // Security contract:
  //   a) We only scan directories that were explicitly registered via
  //      `registerCodexSessionDir()` when a Codex session_start hook event
  //      arrives on the IPC socket. This prevents ingestion from unrelated or
  //      future Codex sessions.
  //   b) Mtime watermark: on first encounter of a file, if it predates the
  //      PrepSavant session start, we skip its existing content by watermarking
  //      seenLines to the current line count. This is a secondary guard.
  //   c) Only JSONL files (.jsonl) within the registered directory are read.
  // ---------------------------------------------------------------------------
  const knownCodexSessionDirs = new Set<string>(); // populated on session_start hook
  let codexJsonlPollTimer: ReturnType<typeof setInterval> | null = null;
  if (opts.tool === "codex" && !opts.codexExecMode) {
    const sessionStartMs = Date.now();
    const seenLinesByFile = new Map<string, number>();

    const processNewCodexJsonlLines = () => {
      // Only scan directories registered from a real Codex session_start event
      for (const sessionDir of knownCodexSessionDirs) {
        let jsonlFiles: string[];
        try {
          if (!fs.existsSync(sessionDir)) continue;
          jsonlFiles = fs.readdirSync(sessionDir)
            .filter((f) => f.endsWith(".jsonl"))
            .map((f) => path.join(sessionDir, f));
        } catch {
          continue;
        }
        for (const filePath of jsonlFiles) {
          try {
            if (!seenLinesByFile.has(filePath)) {
              // Secondary watermark: skip pre-existing file content
              const stat = fs.statSync(filePath);
              if (stat.mtimeMs < sessionStartMs) {
                const existingContent = fs.readFileSync(filePath, "utf-8");
                const existingLineCount = existingContent.split("\n").filter((l) => l.trim()).length;
                seenLinesByFile.set(filePath, existingLineCount);
                continue;
              }
              seenLinesByFile.set(filePath, 0);
            }

            const content = fs.readFileSync(filePath, "utf-8");
            const allLines = content.split("\n").filter((l) => l.trim());
            const seenCount = seenLinesByFile.get(filePath) ?? 0;
            const newLines = allLines.slice(seenCount);
            if (newLines.length === 0) continue;
            seenLinesByFile.set(filePath, allLines.length);

            for (const line of newLines) {
              try {
                const parsed = JSON.parse(line);
                handleJsonlEvent(parsed, log, snapshot, (snap) => { void uploadSnapshot(snap); });
                for (const ev of log.drainBuffer()) pendingEvents.push(ev);
              } catch {
                log.append({
                  kind: "trust_gap",
                  actor: "runner",
                  payload: { reason: "codex_interactive_jsonl_parse_error", detail: line.slice(0, 200) },
                });
                for (const ev of log.drainBuffer()) pendingEvents.push(ev);
              }
            }
          } catch {
            // File read errors are non-fatal
          }
        }
      }
    };

    codexJsonlPollTimer = setInterval(processNewCodexJsonlLines, 2000);
    codexJsonlPollTimer.unref();
  }

  async function uploadSnapshot(result: { commitSha: string; parentSha: string | null; filesChanged: number; kind: string }): Promise<void> {
    try {
      await api.uploadAiAssistedSnapshot(sessionId, {
        shadowCommitSha: result.commitSha,
        parentSha: result.parentSha,
        filesChanged: result.filesChanged,
        snapshotKind: result.kind,
        capturedAt: new Date().toISOString(),
      });
      snapshotCount++;
    } catch {}
  }

  // ---------------------------------------------------------------------------
  // IPC server
  // ---------------------------------------------------------------------------

  const ipcServer = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as { kind: string; data: string; ts: number };

          // When a Codex interactive session_start event arrives, register the
          // Codex session's JSONL directory so the polling loop can ingest it.
          // This is the ONLY way a directory enters knownCodexSessionDirs.
          if (opts.tool === "codex" && !opts.codexExecMode && msg.kind === "session_start") {
            try {
              const hookData = JSON.parse(msg.data) as { session_id?: string };
              const codexSessionId = hookData.session_id;
              if (codexSessionId && typeof codexSessionId === "string") {
                knownCodexSessionDirs.add(path.join(codexSessionsParentDir(), codexSessionId));
              }
            } catch {
              // Non-fatal — polling simply won't have a directory to scan until a valid event arrives
            }
          }

          handleHookEvent(opts.tool, msg.kind, msg.data, log, snapshot, opts.onEvent, (snap) => {
            void uploadSnapshot(snap);
          });
          for (const ev of log.drainBuffer()) {
            pendingEvents.push(ev);
          }
          if (pendingEvents.length >= FLUSH_BATCH_SIZE) {
            void flushPendingEvents();
          }
        } catch {
          log.append({
            kind: "trust_gap",
            actor: "runner",
            payload: { reason: "hook_payload_parse_error", detail: line.slice(0, 200) },
          });
          for (const ev of log.drainBuffer()) {
            pendingEvents.push(ev);
          }
          if (pendingEvents.length >= FLUSH_BATCH_SIZE) {
            void flushPendingEvents();
          }
        }
      }
    });
    socket.on("error", () => {});
  });

  await new Promise<void>((resolve, reject) => {
    ipcServer.listen(socketPath, resolve);
    ipcServer.once("error", reject);
  });

  await new Promise<void>((resolve, reject) => {
    const probeTimer = setTimeout(() => {
      probe.destroy();
      reject(new Error("Socket reachability probe timed out — IPC socket not accepting connections"));
    }, 2000);
    const probe = net.createConnection({ path: socketPath }, () => {
      clearTimeout(probeTimer);
      probe.destroy();
      resolve();
    });
    probe.once("error", (err) => {
      clearTimeout(probeTimer);
      reject(new Error(`IPC socket not reachable: ${err.message}`));
    });
  });

  log.append({
    kind: "hook_install_completed",
    actor: "runner",
    payload: {
      tool: opts.tool,
      hook_config_hash: installResult.hookConfigHash,
      adapter_binary_hash: installResult.adapterBinaryHash ?? null,
      confidence_ceiling: capabilityManifest.confidenceCeiling ?? "medium",
    },
  });

  if (opts.staleCleaned) {
    log.append({
      kind: "stale_hook_cleanup_completed",
      actor: "runner",
      payload: { cleaned_before_session_start: true },
    });
  }
  for (const ev of log.drainBuffer()) {
    pendingEvents.push(ev);
  }
  void flushPendingEvents();

  return {
    sessionId,
    certificateJwt,
    capabilityManifest,
    socketPath,
    async stop() {
      clearInterval(flushTimer);
      if (codexJsonlPollTimer !== null) clearInterval(codexJsonlPollTimer);

      const finalSnap = snapshot.snapshot("session_ended");
      log.append({
        kind: "session_ended",
        actor: "runner",
        payload: { reason: "runner_stop" },
        shadowCommitSha: finalSnap?.commitSha,
        workspaceTreeHash: snapshot.getTreeHash() ?? undefined,
      });
      for (const ev of log.drainBuffer()) {
        pendingEvents.push(ev);
      }

      if (finalSnap) {
        await uploadSnapshot(finalSnap);
      }

      ipcServer.close();
      try { fs.unlinkSync(socketPath); } catch {}

      // Restore hooks for the appropriate tool
      if (opts.tool === "claude_code") {
        restoreClaudeCodeHooks(opts.workspaceDir);
      } else if (opts.tool === "cursor") {
        restoreCursorHooks(opts.workspaceDir);
      } else {
        restoreCodexHooks(opts.workspaceDir);
      }

      log.append({
        kind: "cleanup_completed",
        actor: "runner",
        payload: { hooks_restored: true },
      });
      for (const ev of log.drainBuffer()) {
        pendingEvents.push(ev);
      }

      // -----------------------------------------------------------------------
      // Cursor edit-hook reconciliation
      // Compare snapshot authority (which files actually changed) against the
      // set of files covered by edit hook events. Any file in the snapshot that
      // was NOT captured by an edit hook emits a trust_gap with the
      // cursor_missing_edit_hook subtype.
      // -----------------------------------------------------------------------
      if (opts.tool === "cursor") {
        try {
          const snapshotFiles = new Set(snapshot.getChangedFilesSince(sessionBaselineSha));
          const hookCoveredFiles = new Set<string>();
          // Read the local event log to find all files covered by edit hooks.
          const localEvents = readAllLocalEvents(log);
          for (const ev of localEvents) {
            if (ev.kind === "edit_applied" && ev.actor === "tool") {
              const p = ev.payload as Record<string, unknown> | undefined;
              const toolInput = (p?.["tool_input"] as Record<string, unknown>) ?? {};
              const filePath =
                (toolInput["file_path"] as string) ||
                (toolInput["path"] as string) ||
                (toolInput["target_file"] as string);
              if (filePath) hookCoveredFiles.add(filePath);
            }
            // Tab edits fire edit_applied with actor=tool and tool_name=cursor_tab;
            // they include file_path in the payload directly.
            if (ev.kind === "edit_applied" && ev.actor === "tool") {
              const p = ev.payload as Record<string, unknown> | undefined;
              if ((p?.["tool_name"] as string) === "cursor_tab") {
                const fp = p?.["file_path"] as string;
                if (fp) hookCoveredFiles.add(fp);
              }
            }
          }
          // Emit one trust_gap per missing file (capped at 20 to avoid event spam)
          const missingFromHooks: string[] = [];
          for (const file of snapshotFiles) {
            if (!hookCoveredFiles.has(file)) missingFromHooks.push(file);
          }
          const reportMissing = missingFromHooks.slice(0, 20);
          for (const missingFile of reportMissing) {
            log.append({
              kind: "trust_gap",
              actor: "runner",
              payload: {
                reason: "cursor_missing_edit_hook",
                file_path: missingFile,
                detail: "File changed in snapshot but not captured by any edit hook event. " +
                  "Snapshot diff is the authority for this file.",
              },
            });
          }
          if (missingFromHooks.length > 20) {
            log.append({
              kind: "trust_gap",
              actor: "runner",
              payload: {
                reason: "cursor_missing_edit_hook",
                omitted_count: missingFromHooks.length - 20,
                detail: `${missingFromHooks.length - 20} additional files truncated from trust_gap report`,
              },
            });
          }
          for (const ev of log.drainBuffer()) {
            pendingEvents.push(ev);
          }
        } catch {
          // Best-effort — reconciliation failures are non-fatal
        }
      }

      // -----------------------------------------------------------------------
      // Cursor confidence ceiling enforcement
      // Started at "high" on non-Linux platforms (optimistic). Downgrade to
      // "medium" at stop time if edit-hook reconciliation found any uncovered
      // file changes — indicating the hook pipeline was not complete.
      // -----------------------------------------------------------------------
      if (opts.tool === "cursor" && capabilityManifest.confidenceCeiling === "high") {
        try {
          const localEvents = readAllLocalEvents(log);

          // Delegate to the pure channel-gap helper so the detection logic is
          // independently testable (see cursor-confidence.ts).
          const {
            hasMissingEditHook,
            hasShellHookGap,
            shellStartedCount,
            shellCompletedCount,
          } = computeCursorChannelGaps(localEvents);

          const needsDowngrade = hasMissingEditHook || hasShellHookGap;
          if (needsDowngrade) {
            capabilityManifest.confidenceCeiling = "medium";
            const channels: string[] = [];
            if (hasMissingEditHook) channels.push("edit");
            if (hasShellHookGap) channels.push("shell");
            log.append({
              kind: "trust_gap",
              actor: "runner",
              payload: {
                reason: "cursor_hook_coverage_incomplete",
                incomplete_channels: channels,
                shell_started_count: shellStartedCount,
                shell_completed_count: shellCompletedCount,
                initial_confidence_ceiling: "high",
                effective_confidence_ceiling: "medium",
                detail: `Cursor hook coverage incomplete for channel(s): ${channels.join(", ")}. ` +
                  "Confidence ceiling downgraded from high to medium. " +
                  "Snapshot diffs remain authoritative for file-change evidence.",
              },
            });
            for (const ev of log.drainBuffer()) {
              pendingEvents.push(ev);
            }
          }
        } catch {
          // Best-effort — enforcement failures are non-fatal
        }
      }

      // -----------------------------------------------------------------------
      // Codex exec --json confidence ceiling enforcement
      // The exec mode is granted "high" confidence at session start. Verify that
      // the JSONL file_change events and snapshot agree. If they diverge by more
      // than 10%, downgrade to "medium" by emitting a trust_gap.
      // -----------------------------------------------------------------------
      // effectiveConfidenceCeiling starts as the manifest value and can be
      // downgraded by runtime enforcement checks below.
      let effectiveConfidenceCeiling = capabilityManifest.confidenceCeiling ?? "medium";

      if (opts.tool === "codex" && opts.codexExecMode) {
        try {
          const snapshotFiles = snapshot.getChangedFilesSince(sessionBaselineSha);
          const localEvents = readAllLocalEvents(log);
          const jsonlFileChanges = new Set<string>();
          for (const ev of localEvents) {
            if (ev.kind === "edit_applied") {
              const p = ev.payload as Record<string, unknown> | undefined;
              const fp = (p?.["file_path"] as string) || (p?.["path"] as string);
              if (fp) jsonlFileChanges.add(fp);
            }
          }
          const snapshotFileCount = snapshotFiles.length;
          const jsonlCount = jsonlFileChanges.size;
          // If snapshot shows substantially more file changes than JSONL captured,
          // downgrade confidence ceiling. This enforces the "high" ceiling contract:
          // exec mode is only high confidence when JSONL↔snapshot agree.
          if (snapshotFileCount > 0 && jsonlCount < snapshotFileCount * 0.9) {
            effectiveConfidenceCeiling = "medium";
            // Also mutate the capability manifest so grading/report reads the
            // downgraded ceiling without needing to inspect trust_gap events.
            capabilityManifest.confidenceCeiling = "medium";
            log.append({
              kind: "trust_gap",
              actor: "runner",
              payload: {
                reason: "exec_jsonl_snapshot_disagreement",
                snapshot_file_count: snapshotFileCount,
                jsonl_file_count: jsonlCount,
                initial_confidence_ceiling: "high",
                effective_confidence_ceiling: "medium",
                detail: "JSONL file_change events do not cover all snapshot file changes. " +
                  "Confidence ceiling downgraded from high to medium.",
              },
            });
            for (const ev of log.drainBuffer()) {
              pendingEvents.push(ev);
            }
          }
        } catch {
          // Best-effort — enforcement failures are non-fatal
        }
      }

      const deadline = Date.now() + 10_000;
      while (pendingEvents.length > 0 && Date.now() < deadline) {
        await flushPendingEvents();
        if (pendingEvents.length > 0) {
          await new Promise<void>((r) => setTimeout(r, 500));
        }
      }

      const allEvents = readAllLocalEvents(log);
      if (allEvents.length > 0) {
        const anchors = allEvents.map((e) => ({
          seq: e.seq,
          eventHash: sha256Hex(JSON.stringify(e)),
        }));
        try {
          await api.anchorAiAssistedEvents(sessionId, anchors);
        } catch {}
      }

      const trustGapCount = allEvents.filter((e) => e.kind === "trust_gap").length;
      const finalEventHash = log.getPrevEventHash();

      const initialCeiling = buildCapabilityManifest(opts.tool, opts.codexExecMode ?? false).confidenceCeiling ?? "medium";
      const manifest: EvidenceBundleManifest = {
        session_id: sessionId,
        event_count: log.getEventCount(),
        final_event_hash: finalEventHash,
        log_hash: log.getLogHash(),
        snapshot_count: snapshotCount,
        trust_gap_count: trustGapCount,
        ended_at: new Date().toISOString(),
        runner_version: opts.runnerVersion,
        adapter_version: ADAPTER_VERSION,
        // Include effective ceiling if it was downgraded at runtime
        ...(effectiveConfidenceCeiling !== initialCeiling
          ? { effective_confidence_ceiling: effectiveConfidenceCeiling as "high" | "medium" | "low" }
          : {}),
      };

      await api.finalizeAiAssistedBundle(sessionId, manifest);

      snapshot.cleanup();
    },
  };
}

function readAllLocalEvents(log: SignedEventLog): AiAssistedEvent[] {
  try {
    const content = fs.readFileSync(log.getLogPath(), "utf-8");
    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AiAssistedEvent);
  } catch {
    return [];
  }
}

// Tool-aware hook event dispatch
function handleHookEvent(
  tool: SupportedTool,
  kind: string,
  rawData: string,
  log: SignedEventLog,
  snapshot: SnapshotStore,
  onEvent?: (kind: string, seq: number) => void,
  onSnapshot?: (result: { commitSha: string; parentSha: string | null; filesChanged: number; kind: string }) => void,
): AiAssistedEvent | undefined {
  try {
    const data = JSON.parse(rawData);
    let event: AiAssistedEvent | undefined;

    if (tool === "cursor") {
      switch (kind) {
        case "session_start":     event = cursorSessionStart(data, log); break;
        case "pre_tool_use":      event = cursorPreToolUse(data, log); break;
        case "post_tool_use":     event = cursorPostToolUse(data, log, snapshot, onSnapshot); break;
        case "user_prompt_submit":event = cursorUserPromptSubmit(data, log); break;
        case "permission_request":event = cursorPermissionRequest(data, log); break;
        case "mcp_tool_use":      event = handleMcpToolUse(data, log); break;
        case "tab_edit":          event = handleTabEdit(data, log, snapshot, onSnapshot); break;
        case "stop":              event = cursorStop(data, log); break;
        case "session_end":       event = cursorSessionEnd(data, log, snapshot, undefined, onSnapshot); break;
        default:
          event = log.append({ kind: "trust_gap", actor: "runner", payload: { reason: "unknown_hook_kind", expected_kind: kind } });
      }
    } else if (tool === "codex") {
      switch (kind) {
        case "session_start":     event = codexSessionStart(data, log); break;
        case "pre_tool_use":      event = codexPreToolUse(data, log); break;
        case "post_tool_use":     event = codexPostToolUse(data, log, snapshot, onSnapshot); break;
        case "user_prompt_submit":event = codexUserPromptSubmit(data, log); break;
        case "permission_request":event = codexPermissionRequest(data, log); break;
        case "stop":              event = codexStop(data, log); break;
        case "jsonl": {
          // Codex exec --json JSONL lines arrive in the IPC `data` field as raw
          // JSON strings (e.g. '{"type":"function_call","name":"shell",...}').
          // Parse explicitly here — rawData is the inner JSONL string, NOT the
          // outer IPC wrapper — and guard that the result is a plain object with
          // a `type` field before dispatching to handleJsonlEvent.
          let jsonlEvent: CodexJsonlEvent;
          try {
            const innerParsed = JSON.parse(rawData);
            jsonlEvent = (innerParsed !== null && typeof innerParsed === "object")
              ? innerParsed as CodexJsonlEvent
              : { type: "__unexpected_scalar__" } as unknown as CodexJsonlEvent;
          } catch {
            jsonlEvent = { type: "__parse_error__" } as unknown as CodexJsonlEvent;
          }
          event = handleJsonlEvent(jsonlEvent, log, snapshot, onSnapshot);
          break;
        }
        default:
          event = log.append({ kind: "trust_gap", actor: "runner", payload: { reason: "unknown_hook_kind", expected_kind: kind } });
      }
    } else {
      // claude_code
      switch (kind) {
        case "session_start":         event = claudeSessionStart(data, log); break;
        case "pre_tool_use":          event = claudePreToolUse(data, log); break;
        case "post_tool_use":         event = claudePostToolUse(data, log, snapshot, onSnapshot); break;
        case "post_tool_use_failure": event = handlePostToolUseFailure(data, log); break;
        case "post_tool_batch":       event = handlePostToolBatch(data, log); break;
        case "user_prompt_submit":    event = claudeUserPromptSubmit(data, log); break;
        case "permission_request":    event = claudePermissionRequest(data, log); break;
        case "subagent_stop":         event = handleSubagentStop(data, log); break;
        case "stop":                  event = claudeStop(data, log); break;
        case "session_end":           event = claudeSessionEnd(data, log, snapshot, undefined, onSnapshot); break;
        default:
          event = log.append({ kind: "trust_gap", actor: "runner", payload: { reason: "unknown_hook_kind", expected_kind: kind } });
      }
    }

    onEvent?.(kind, log.getEventCount());
    return event;
  } catch (err) {
    const trustGapEvent = log.append({
      kind: "trust_gap",
      actor: "runner",
      payload: { reason: "hook_handler_error", detail: (err as Error).message.slice(0, 200) },
    });
    return trustGapEvent;
  }
}
