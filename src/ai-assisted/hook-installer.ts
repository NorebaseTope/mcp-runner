// Tool-agnostic hook install/restore framework for AI-Assisted mode.
// Provides transactional install (backup → write → verify) and crash recovery
// (stale hook detection on next launch).
// Supports: claude_code (GA), cursor (Beta), codex (Beta).
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

export type ToolId = "claude_code" | "cursor" | "codex";

export interface HookConfig {
  toolId: ToolId;
  sessionId: string;
  // Absolute path to the hook handler JS file
  handlerPath: string;
  // Absolute path to the hook socket (runner IPC endpoint)
  socketPath: string;
}

export interface HookInstallResult {
  ok: boolean;
  backupPath?: string;
  hookConfigHash?: string;
  adapterBinaryHash?: string;
  error?: string;
}

export interface StaleHookInfo {
  toolId: ToolId;
  sessionId: string;
  installedAt: string;
}

const STALE_MARKER_FILENAME = ".prepsavant-hook-meta.json";

// ---------------------------------------------------------------------------
// Claude Code paths
// ---------------------------------------------------------------------------

export function claudeCodeHooksDir(): string {
  return ".claude/hooks";
}

export function claudeCodeHooksConfigPath(workspaceDir: string): string {
  return path.join(workspaceDir, ".claude", "settings.json");
}

function claudeMarkerPath(workspaceDir: string): string {
  return path.join(workspaceDir, claudeCodeHooksDir(), STALE_MARKER_FILENAME);
}

// ---------------------------------------------------------------------------
// Cursor paths — .cursor/settings.json project-scoped hooks
// ---------------------------------------------------------------------------

export function cursorHooksDir(workspaceDir: string): string {
  return path.join(workspaceDir, ".cursor");
}

export function cursorHooksConfigPath(workspaceDir: string): string {
  return path.join(workspaceDir, ".cursor", "settings.json");
}

function cursorMarkerPath(workspaceDir: string): string {
  return path.join(workspaceDir, ".cursor", STALE_MARKER_FILENAME);
}

// ---------------------------------------------------------------------------
// Codex paths — ~/.codex/hooks.json (global, not workspace-scoped)
// ---------------------------------------------------------------------------

export function codexHooksConfigPath(): string {
  return path.join(os.homedir(), ".codex", "hooks.json");
}

function codexMarkerPath(workspaceDir: string): string {
  return path.join(workspaceDir, STALE_MARKER_FILENAME);
}

// Global active-session registry for Codex.
//
// Codex installs hooks globally at ~/.codex/hooks.json, so stale hooks from a
// crashed session in workspace A are NOT detectable via workspace B's local
// marker file.  This global registry bridges the gap: written on Codex hook
// install, deleted on restore, and checked by detectStaleHooks regardless of
// the current workspace directory.
function globalCodexActiveSessionPath(): string {
  let dataDir: string;
  if (process.platform === "darwin") {
    dataDir = path.join(os.homedir(), "Library", "Application Support", "PrepSavant");
  } else if (process.platform === "win32") {
    dataDir = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "PrepSavant");
  } else {
    dataDir = path.join(os.homedir(), ".local", "share", "prepsavant");
  }
  return path.join(dataDir, "codex-active-session.json");
}

function writeGlobalCodexActiveSession(info: StaleHookInfo): void {
  try {
    const p = globalCodexActiveSessionPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(info, null, 2) + "\n");
  } catch {
    // Non-fatal — workspace-local marker is still authoritative for the
    // current workspace.  Global write failures don't block install.
  }
}

function deleteGlobalCodexActiveSession(): void {
  try {
    const p = globalCodexActiveSessionPath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {}
}

// ---------------------------------------------------------------------------
// Stale hook detection — checks all three tools
// ---------------------------------------------------------------------------

export function detectStaleHooks(workspaceDir: string): StaleHookInfo | null {
  // 1. Workspace-local markers (fast path, covers the common same-workspace case)
  for (const markerFn of [claudeMarkerPath, cursorMarkerPath, codexMarkerPath]) {
    const mp = markerFn(workspaceDir);
    if (!fs.existsSync(mp)) continue;
    try {
      const raw = fs.readFileSync(mp, "utf-8");
      return JSON.parse(raw) as StaleHookInfo;
    } catch {
      // Corrupt marker — treat as stale
      return { toolId: "claude_code", sessionId: "unknown", installedAt: new Date().toISOString() };
    }
  }

  // 2. Global Codex registry — covers stale hooks left by a crash in a
  //    different workspace.  We check two independent signals:
  //      a) The global active-session file (written on install, deleted on restore)
  //      b) The global backup file (always present when hooks are installed)
  //    Either alone is sufficient to declare staleness because both are
  //    deleted transactionally at the end of every clean session.
  const codexBackupPath = codexHooksConfigPath() + ".prepsavant-backup";
  const globalSessionPath = globalCodexActiveSessionPath();

  if (fs.existsSync(globalSessionPath)) {
    try {
      const raw = fs.readFileSync(globalSessionPath, "utf-8");
      return JSON.parse(raw) as StaleHookInfo;
    } catch {
      // Corrupt global file + backup present → stale
      if (fs.existsSync(codexBackupPath)) {
        return { toolId: "codex", sessionId: "unknown", installedAt: new Date().toISOString() };
      }
    }
  } else if (fs.existsSync(codexBackupPath)) {
    // Backup present without any registry entry — hooks were installed (in this
    // or another workspace) but never cleaned up.
    return { toolId: "codex", sessionId: "unknown", installedAt: new Date().toISOString() };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Claude Code hook install / restore
// ---------------------------------------------------------------------------

export function installClaudeCodeHooks(
  workspaceDir: string,
  config: HookConfig,
): HookInstallResult {
  const hooksDir = path.join(workspaceDir, claudeCodeHooksDir());
  const settingsPath = claudeCodeHooksConfigPath(workspaceDir);
  const backupPath = settingsPath + ".prepsavant-backup";

  try {
    fs.mkdirSync(hooksDir, { recursive: true });

    if (fs.existsSync(settingsPath)) {
      fs.copyFileSync(settingsPath, backupPath);
    }

    let settings: Record<string, unknown> = {};
    if (fs.existsSync(settingsPath)) {
      try {
        settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      } catch {
        settings = {};
      }
    }

    const samHooks: Record<string, unknown[]> = {
      SessionStart: [{ hooks: [{ type: "command", command: `node "${config.handlerPath}" session_start` }] }],
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `node "${config.handlerPath}" pre_tool_use` }] }],
      PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `node "${config.handlerPath}" post_tool_use` }] }],
      PostToolUseFailure: [{ matcher: "*", hooks: [{ type: "command", command: `node "${config.handlerPath}" post_tool_use_failure` }] }],
      PostToolBatch: [{ hooks: [{ type: "command", command: `node "${config.handlerPath}" post_tool_batch` }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: `node "${config.handlerPath}" user_prompt_submit` }] }],
      PermissionRequest: [{ hooks: [{ type: "command", command: `node "${config.handlerPath}" permission_request` }] }],
      SubagentStop: [{ hooks: [{ type: "command", command: `node "${config.handlerPath}" subagent_stop` }] }],
      Stop: [{ hooks: [{ type: "command", command: `node "${config.handlerPath}" stop` }] }],
      SessionEnd: [{ hooks: [{ type: "command", command: `node "${config.handlerPath}" session_end` }] }],
    };

    const existingHooks = (settings["hooks"] ?? {}) as Record<string, unknown[]>;
    const mergedHooks: Record<string, unknown[]> = { ...existingHooks };
    for (const [kind, samEntries] of Object.entries(samHooks)) {
      const existing = Array.isArray(mergedHooks[kind]) ? (mergedHooks[kind] as unknown[]) : [];
      const userEntries = existing.filter((e) => !JSON.stringify(e).includes(config.handlerPath));
      mergedHooks[kind] = [...samEntries, ...userEntries];
    }
    settings["hooks"] = mergedHooks;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");

    const marker: StaleHookInfo = { toolId: config.toolId, sessionId: config.sessionId, installedAt: new Date().toISOString() };
    fs.writeFileSync(claudeMarkerPath(workspaceDir), JSON.stringify(marker, null, 2));

    const hookConfigHash = createHash("sha256").update(JSON.stringify(samHooks)).digest("hex");
    const adapterBinaryHash = hashBinary("claude");

    return { ok: true, backupPath, hookConfigHash, adapterBinaryHash };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export function restoreClaudeCodeHooks(workspaceDir: string): void {
  const settingsPath = claudeCodeHooksConfigPath(workspaceDir);
  const backupPath = settingsPath + ".prepsavant-backup";
  const mp = claudeMarkerPath(workspaceDir);

  try {
    if (fs.existsSync(backupPath)) {
      fs.copyFileSync(backupPath, settingsPath);
      fs.unlinkSync(backupPath);
    } else if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      delete settings["hooks"];
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    }
  } catch {}

  try { if (fs.existsSync(mp)) fs.unlinkSync(mp); } catch {}
}

// ---------------------------------------------------------------------------
// Cursor hook install / restore
// ---------------------------------------------------------------------------

export function installCursorHooks(
  workspaceDir: string,
  config: HookConfig,
): HookInstallResult {
  const cursorDir = cursorHooksDir(workspaceDir);
  const settingsPath = cursorHooksConfigPath(workspaceDir);
  const backupPath = settingsPath + ".prepsavant-backup";

  try {
    fs.mkdirSync(cursorDir, { recursive: true });

    if (fs.existsSync(settingsPath)) {
      fs.copyFileSync(settingsPath, backupPath);
    }

    let settings: Record<string, unknown> = {};
    if (fs.existsSync(settingsPath)) {
      try {
        settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      } catch {
        settings = {};
      }
    }

    // Cursor hook config — mirrors Claude Code's format using the same
    // hook event kind names as Cursor's internal hook system.
    const samHooks: Record<string, unknown[]> = {
      SessionStart: [{ hooks: [{ type: "command", command: `node "${config.handlerPath}" session_start` }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: `node "${config.handlerPath}" user_prompt_submit` }] }],
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `node "${config.handlerPath}" pre_tool_use` }] }],
      PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `node "${config.handlerPath}" post_tool_use` }] }],
      PermissionRequest: [{ hooks: [{ type: "command", command: `node "${config.handlerPath}" permission_request` }] }],
      McpToolUse: [{ hooks: [{ type: "command", command: `node "${config.handlerPath}" mcp_tool_use` }] }],
      TabEdit: [{ hooks: [{ type: "command", command: `node "${config.handlerPath}" tab_edit` }] }],
      Stop: [{ hooks: [{ type: "command", command: `node "${config.handlerPath}" stop` }] }],
      SessionEnd: [{ hooks: [{ type: "command", command: `node "${config.handlerPath}" session_end` }] }],
    };

    const existingHooks = (settings["hooks"] ?? {}) as Record<string, unknown[]>;
    const mergedHooks: Record<string, unknown[]> = { ...existingHooks };
    for (const [kind, samEntries] of Object.entries(samHooks)) {
      const existing = Array.isArray(mergedHooks[kind]) ? (mergedHooks[kind] as unknown[]) : [];
      const userEntries = existing.filter((e) => !JSON.stringify(e).includes(config.handlerPath));
      mergedHooks[kind] = [...samEntries, ...userEntries];
    }
    settings["hooks"] = mergedHooks;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");

    const marker: StaleHookInfo = { toolId: config.toolId, sessionId: config.sessionId, installedAt: new Date().toISOString() };
    fs.writeFileSync(cursorMarkerPath(workspaceDir), JSON.stringify(marker, null, 2));

    const hookConfigHash = createHash("sha256").update(JSON.stringify(samHooks)).digest("hex");
    const adapterBinaryHash = hashBinary("cursor");

    return { ok: true, backupPath, hookConfigHash, adapterBinaryHash };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export function restoreCursorHooks(workspaceDir: string): void {
  const settingsPath = cursorHooksConfigPath(workspaceDir);
  const backupPath = settingsPath + ".prepsavant-backup";
  const mp = cursorMarkerPath(workspaceDir);

  try {
    if (fs.existsSync(backupPath)) {
      fs.copyFileSync(backupPath, settingsPath);
      fs.unlinkSync(backupPath);
    } else if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      delete settings["hooks"];
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    }
  } catch {}

  try { if (fs.existsSync(mp)) fs.unlinkSync(mp); } catch {}
}

// ---------------------------------------------------------------------------
// Codex hook install / restore
// ---------------------------------------------------------------------------

// Codex hooks are installed globally (~/.codex/hooks.json) because Codex
// does not currently support project-scoped hook config files.
export function installCodexHooks(
  workspaceDir: string,
  config: HookConfig,
): HookInstallResult {
  const hooksPath = codexHooksConfigPath();
  const backupPath = hooksPath + ".prepsavant-backup";

  try {
    fs.mkdirSync(path.dirname(hooksPath), { recursive: true });

    if (fs.existsSync(hooksPath)) {
      fs.copyFileSync(hooksPath, backupPath);
    } else {
      // No pre-existing file. Write an empty backup marker so restoreCodexHooks
      // knows it can safely delete the installed file on cleanup.
      fs.writeFileSync(backupPath, "{}");
    }

    let hooks: Record<string, unknown> = {};
    if (fs.existsSync(hooksPath)) {
      try {
        hooks = JSON.parse(fs.readFileSync(hooksPath, "utf-8"));
      } catch {
        hooks = {};
      }
    }

    // Codex hooks require CODEX_HOOKS=1 env var to be active.
    // We install the hook definitions; the feature flag must be set by the
    // candidate as documented in the install steps.
    const samHooks: Record<string, unknown> = {
      session_start: `node "${config.handlerPath}" session_start`,
      user_prompt_submit: `node "${config.handlerPath}" user_prompt_submit`,
      pre_tool_use: `node "${config.handlerPath}" pre_tool_use`,
      permission_request: `node "${config.handlerPath}" permission_request`,
      post_tool_use: `node "${config.handlerPath}" post_tool_use`,
      stop: `node "${config.handlerPath}" stop`,
    };

    const merged = { ...hooks, ...samHooks };
    fs.writeFileSync(hooksPath, JSON.stringify(merged, null, 2) + "\n");

    const marker: StaleHookInfo = { toolId: config.toolId, sessionId: config.sessionId, installedAt: new Date().toISOString() };
    fs.writeFileSync(codexMarkerPath(workspaceDir), JSON.stringify(marker, null, 2));
    // Also write global registry so stale hooks from this workspace are
    // detectable from any other workspace (Codex hooks are global).
    writeGlobalCodexActiveSession(marker);

    const hookConfigHash = createHash("sha256").update(JSON.stringify(samHooks)).digest("hex");
    const adapterBinaryHash = hashBinary("codex");

    return { ok: true, backupPath, hookConfigHash, adapterBinaryHash };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export function restoreCodexHooks(workspaceDir: string): void {
  const hooksPath = codexHooksConfigPath();
  const backupPath = hooksPath + ".prepsavant-backup";
  const mp = codexMarkerPath(workspaceDir);

  try {
    if (fs.existsSync(backupPath)) {
      // Restore from backup — we know what state the file was in before install.
      const backupContent = fs.readFileSync(backupPath, "utf-8").trim();
      if (backupContent === "{}") {
        // Empty backup marker — we created hooks.json from scratch, safe to delete.
        if (fs.existsSync(hooksPath)) fs.unlinkSync(hooksPath);
      } else {
        fs.copyFileSync(backupPath, hooksPath);
      }
      fs.unlinkSync(backupPath);
    } else if (fs.existsSync(hooksPath)) {
      // No backup exists. This can mean either:
      //   a) We created the file from scratch (user had no prior hooks.json)
      //   b) The backup was somehow lost (crash + further corruption)
      // In case (b), deleting would destroy the user's own hooks.
      // Safe approach: strip only PrepSavant entries (those referencing hook-handler.cjs).
      // If nothing is left after stripping, delete the file (case a).
      try {
        const raw = JSON.parse(fs.readFileSync(hooksPath, "utf-8"));
        const cleaned: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(raw)) {
          if (typeof value === "string" && value.includes("hook-handler.cjs")) continue;
          cleaned[key] = value;
        }
        if (Object.keys(cleaned).length === 0) {
          fs.unlinkSync(hooksPath);
        } else {
          fs.writeFileSync(hooksPath, JSON.stringify(cleaned, null, 2) + "\n");
        }
      } catch {
        // If we can't parse it, leave it alone — don't destroy it.
      }
    }
  } catch {}

  try { if (fs.existsSync(mp)) fs.unlinkSync(mp); } catch {}
  // Delete global registry so stale detection from any workspace is cleared.
  deleteGlobalCodexActiveSession();
}

// ---------------------------------------------------------------------------
// Unified cleanup — restores only the tool identified in the stale marker.
// Does NOT touch configs for other tools (avoids destructive cross-tool cleanup).
// ---------------------------------------------------------------------------

export function cleanupStaleHooks(workspaceDir: string): void {
  const stale = detectStaleHooks(workspaceDir);
  if (!stale) return;
  switch (stale.toolId) {
    case "claude_code": restoreClaudeCodeHooks(workspaceDir); break;
    case "cursor":      restoreCursorHooks(workspaceDir); break;
    case "codex":       restoreCodexHooks(workspaceDir); break;
    default: {
      // Unknown tool ID — attempt all three restorations conservatively.
      restoreClaudeCodeHooks(workspaceDir);
      restoreCursorHooks(workspaceDir);
      restoreCodexHooks(workspaceDir);
    }
  }
}

// ---------------------------------------------------------------------------
// Hook handler script (shared by all tools)
// ---------------------------------------------------------------------------

export function writeHookHandlerScript(handlerPath: string, socketPath: string): void {
  const handlerCode = `#!/usr/bin/env node
// PrepSavant AI-Assisted hook handler.
// Non-interference contract:
//   - Never writes meaningful stdout (only the minimum empty success response)
//   - Never blocks, approves, denies, or modifies any tool action
//   - Forwards event to runner over Unix socket for capture, awaits delivery
//   - Exits 0 after delivery confirmed (or timeout) — guarantees payload lands
"use strict";
const net = require("net");
const hookKind = process.argv[2] || "unknown";

let _exited = false;
function exitClean() {
  if (_exited) return;
  _exited = true;
  process.stdout.write("{}");
  process.exit(0);
}

const safetyTimer = setTimeout(exitClean, 1500);
safetyTimer.unref && safetyTimer.unref();

let stdinData = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdinData += chunk; });
process.stdin.on("end", () => {
  try {
    const socketPath = ${JSON.stringify(socketPath)};
    const payload = JSON.stringify({ kind: hookKind, data: stdinData, ts: Date.now() });
    const client = net.createConnection({ path: socketPath }, () => {
      client.write(payload + "\\n", () => {
        client.end();
        clearTimeout(safetyTimer);
        exitClean();
      });
    });
    client.on("error", () => { clearTimeout(safetyTimer); exitClean(); });
  } catch { clearTimeout(safetyTimer); exitClean(); }
});
process.stdin.on("error", () => { clearTimeout(safetyTimer); exitClean(); });
`;

  fs.mkdirSync(path.dirname(handlerPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(handlerPath, handlerCode, { mode: 0o755 });
}

export function validateHandlerNonInterference(handlerPath: string): { ok: boolean; error?: string } {
  const result = spawnSync("node", [handlerPath, "test"], {
    input: "{}",
    encoding: "utf-8",
    timeout: 3000,
  });
  if (result.status !== 0) {
    return { ok: false, error: `handler exited ${result.status}: ${result.stderr}` };
  }
  try {
    JSON.parse(result.stdout);
    return { ok: true };
  } catch {
    return { ok: false, error: `handler produced non-JSON stdout: ${result.stdout.slice(0, 200)}` };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function hashBinary(binaryName: string): string | undefined {
  try {
    const whichResult = spawnSync(
      process.platform === "win32" ? "where" : "which",
      [binaryName],
      { encoding: "utf-8" },
    );
    if (whichResult.status === 0) {
      const binaryPath = whichResult.stdout.trim().split("\n")[0];
      if (binaryPath) {
        const binaryData = fs.readFileSync(binaryPath);
        return createHash("sha256").update(binaryData).digest("hex");
      }
    }
  } catch {}
  return undefined;
}
