// CLI flow for AI-Assisted mode: `prepsavant start [--ai-assisted]`
// Shows the tool selector, runs preflight checks, obtains consent, then
// starts the AI-Assisted session and shows live status.
//
// `--json` switches the command into a script-friendly mode. All interactive
// banners, prompts, and progress lines are routed to stderr so stdout stays
// clean. On successful session creation, a single JSON line
// `{"sessionId":"…","tool":"…","startedAt":"…"}` is written to stdout. On
// any error, a single-line `{"error":"…"}` is written to stderr. This
// matches the convention established by `prepsavant status --json` and
// `prepsavant doctor --json`, so CI integrations can capture the new
// session id without screen-scraping the human-readable output.
import * as readline from "node:readline";
import { spawnSync, spawn } from "node:child_process";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import { ADAPTER_VERSION, readConfig } from "../config.js";
import { SamApi, ApiError, type AiAssistedHookHealth } from "../api.js";
import { detectStaleHooks, cleanupStaleHooks, type StaleHookInfo } from "./hook-installer.js";
import { startAiAssistedSession, buildCapabilityManifest, ipcSocketPathForSession } from "./session.js";
import type { SupportedTool } from "./session.js";

// ---------------------------------------------------------------------------
// Live status polling (per-channel hook health for beta tools)
//
// The /runner/ai-sessions/:id/status endpoint already returns a per-channel
// `hookHealth` field. The web practice panel renders this for beta tools
// (Cursor / Codex) so users can see at a glance whether each channel
// (prompt / response / edit / shell) is firing or has gone dark. The CLI
// mirrors that surface here for users who run the runner in a terminal next
// to their AI assistant and never look at the practice page.
//
// GA tools (Claude Code) imply full coverage and skip the per-channel line —
// they keep the existing single-line per-event display.
// ---------------------------------------------------------------------------

export const STATUS_POLL_INTERVAL_MS = 5_000;

const HOOK_CHANNEL_LABELS: ReadonlyArray<{
  key: keyof AiAssistedHookHealth;
  label: string;
}> = [
  { key: "prompt", label: "prompt" },
  { key: "response", label: "response" },
  { key: "edit", label: "edit" },
  { key: "shell", label: "shell" },
];

// ANSI color codes used to colorize status markers when stdout is a TTY.
// Green = success ✓; yellow/amber = warning !; red = error.
// Mirrors the green ✓ / amber ? styling used on the web practice panel so
// terminal users get the same at-a-glance signal when a channel goes dark.
const ANSI_GREEN = "\x1b[32m";
const ANSI_YELLOW = "\x1b[33m";
const ANSI_RED = "\x1b[31m";
const ANSI_RESET = "\x1b[0m";

// Decide whether to emit ANSI color codes.
// Honors the NO_COLOR convention (https://no-color.org/): if NO_COLOR is set
// at all (even to an empty string), color is disabled. Otherwise falls back
// to checking whether stdout is a TTY so piping to a log file stays plain.
function shouldUseColor(): boolean {
  if ("NO_COLOR" in process.env) return false;
  return Boolean(process.stdout.isTTY);
}

// Wrap `text` in the green success color when `useColor` is true.
// Exported so callers outside this module and unit tests can use it directly.
export function colorSuccess(text: string, useColor: boolean = shouldUseColor()): string {
  if (!useColor) return text;
  return `${ANSI_GREEN}${text}${ANSI_RESET}`;
}

// Wrap `text` in the yellow/amber warning color when `useColor` is true.
export function colorWarning(text: string, useColor: boolean = shouldUseColor()): string {
  if (!useColor) return text;
  return `${ANSI_YELLOW}${text}${ANSI_RESET}`;
}

// Wrap `text` in the red error color when `useColor` is true.
export function colorError(text: string, useColor: boolean = shouldUseColor()): string {
  if (!useColor) return text;
  return `${ANSI_RED}${text}${ANSI_RESET}`;
}

// ---------------------------------------------------------------------------
// "Pro required" gate detection
//
// The server returns HTTP 403 with `{ error: "entitlement_required", ... }`
// when a free user tries to start an AI-Assisted session. The web UI gates
// this with an upgrade prompt, but the runner CLI bypasses that surface, so
// we detect the specific error here and print a friendly upgrade message
// instead of leaking a raw "POST /api/runner/sessions → 403" stack trace.
// Exported so the detection logic can be unit-tested without making real
// HTTP calls.
// ---------------------------------------------------------------------------

export interface EntitlementRequiredErrorBody {
  error: "entitlement_required";
  currentEntitlement?: string | null;
  requiredEntitlement?: string;
  message?: string;
}

export function isEntitlementRequiredError(
  err: unknown,
): err is ApiError & { body: EntitlementRequiredErrorBody } {
  if (!(err instanceof ApiError)) return false;
  if (err.status !== 403) return false;
  const body = err.body;
  if (!body || typeof body !== "object") return false;
  return (body as { error?: unknown }).error === "entitlement_required";
}

// ---------------------------------------------------------------------------
// --json output helpers
//
// Pure stringifiers for the `--json` mode of `prepsavant start`. Exported so
// they can be unit-tested without spinning up a session or mocking readline.
// The success line carries the new session id plus the resolved tool name and
// a startedAt ISO timestamp so scripts can correlate the start back to a
// specific run; the error line is a single-line `{"error":"..."}` to match
// the status / doctor `--json` convention.
// ---------------------------------------------------------------------------

export function formatStartSuccessJson(
  sessionId: string,
  tool: SupportedTool,
  startedAt: string,
): string {
  return JSON.stringify({ sessionId, tool, startedAt }) + "\n";
}

export function formatStartErrorJson(message: string): string {
  // Trim trailing whitespace/newlines so the line stays single-line and
  // matches the rest of the JSON CLI surface.
  return JSON.stringify({ error: message.trim() }) + "\n";
}

// Format the one-line stderr warning emitted when stale hooks are
// auto-removed in non-interactive mode (e.g. `--json` or
// `--cleanup-stale-hooks`). Surfaces the cleaned-up tool/sessionId so a CI
// log shows exactly which prior session was reaped without the operator
// having to grep through marker files. Always single-line and ends with a
// newline so log collectors don't merge it with the next record. Exported
// for unit tests.
export function formatStaleHookCleanupWarning(stale: StaleHookInfo): string {
  return (
    `prepsavant: removed stale hooks from previous session ` +
    `(tool=${stale.toolId}, sessionId=${stale.sessionId})\n`
  );
}

// ---------------------------------------------------------------------------
// Stale-hook auto-cleanup (non-interactive mode)
//
// In non-interactive mode (`--json` or the explicit `--cleanup-stale-hooks`
// flag) the runner must NOT prompt — the prompt would hang forever on a CI
// runner that was killed mid-run, defeating the whole point of `start --json`
// being scriptable. These helpers encapsulate the decision and the cleanup
// side effect so they can be unit-tested without spinning up the rest of
// runStart (which needs an auth token + HTTP).
// ---------------------------------------------------------------------------

// Pure helper: decide whether stale hooks should be removed automatically
// (no prompt) based on the user-supplied flags. Exported for tests.
export function shouldAutoCleanupStaleHooks(
  flags: Record<string, string | boolean>,
): boolean {
  return !!flags.json || !!flags["cleanup-stale-hooks"];
}

// Dependencies injected into `tryAutoCleanupStaleHooks` so tests can swap in
// fakes without touching the real filesystem or hook installer.
export interface StaleHookCleanupDeps {
  detect: typeof detectStaleHooks;
  cleanup: typeof cleanupStaleHooks;
}

export interface StaleHookCleanupResult {
  // True iff there were stale hooks AND we removed them in this call.
  staleCleaned: boolean;
  // The marker info we acted on (or null if there was nothing to clean).
  stale: StaleHookInfo | null;
  // The one-line warning to surface on stderr (or null when nothing was
  // cleaned). Returned rather than written so the caller controls the
  // destination (always stderr in production, captured by tests in unit
  // tests).
  warning: string | null;
}

// Detect stale hooks and, if present, remove them and produce a warning
// line. Side-effect-free apart from the injected `cleanup` call.
export function tryAutoCleanupStaleHooks(
  workspaceDir: string,
  deps: StaleHookCleanupDeps,
): StaleHookCleanupResult {
  const stale = deps.detect(workspaceDir);
  if (!stale) {
    return { staleCleaned: false, stale: null, warning: null };
  }
  deps.cleanup(workspaceDir);
  return {
    staleCleaned: true,
    stale,
    warning: formatStaleHookCleanupWarning(stale),
  };
}

// Build the user-facing "AI-Assisted requires Pro" message. `apiBaseUrl`
// is used as the origin for the upgrade URL so dev/staging environments
// surface their own pricing page rather than always pointing at production.
// Exported for unit testing.
export function formatEntitlementRequiredMessage(
  apiBaseUrl: string,
  body: EntitlementRequiredErrorBody,
): string {
  const upgradeUrl = `${apiBaseUrl.replace(/\/$/, "")}/pricing`;
  const required = body.requiredEntitlement ?? "pro";
  const tierLabel =
    required === "lifetime" ? "Lifetime" : "Pro";
  const lines = [
    ``,
    `  AI-Assisted requires PrepSavant ${tierLabel}`,
    `  ─────────────────────────────────────────────`,
    ``,
    `  AI-Assisted sessions need a PrepSavant Pro or Lifetime plan.`,
    `  Upgrade at: ${upgradeUrl}`,
    ``,
  ];
  return lines.join("\n") + "\n";
}

// Format a single "Hook channels" line from a hookHealth map.
// Fired channels are prefixed with ✓ (green when colored); not-fired
// channels with ? (yellow/amber when colored).
// Exported so it can be unit-tested without spinning up a session. The
// `useColor` flag is exposed for tests; it defaults to a TTY/NO_COLOR
// check so production callers don't have to pass it.
export function formatHookChannelsLine(
  health: AiAssistedHookHealth,
  useColor: boolean = shouldUseColor(),
): string {
  const parts = HOOK_CHANNEL_LABELS.map(({ key, label }) => {
    const ch = health[key];
    const fired = Boolean(ch?.fired);
    const sym = fired ? "✓" : "?";
    const segment = `${sym} ${label}`;
    if (!useColor) return segment;
    const color = fired ? ANSI_GREEN : ANSI_YELLOW;
    return `${color}${segment}${ANSI_RESET}`;
  });
  return `  Hook channels: ${parts.join("   ")}`;
}

const RUNNER_VERSION = ADAPTER_VERSION;

// Minimum Cursor version that supports project-scoped hooks.
const CURSOR_MIN_VERSION = [0, 45, 0] as const;

// ---------------------------------------------------------------------------
// Tool descriptors — exact labels from the doc
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    id: "claude_code" as const,
    label: "Claude Code — Full support",
    sublabel: "Best capture fidelity. Recommended for AI-Assisted mode.",
    status: "GA" as const,
    available: true,
    detectCmd: "claude",
    versionFlag: "--version",
    supportedPlatforms: ["darwin", "linux", "win32"] as string[],
  },
  {
    id: "cursor" as const,
    label: "Cursor — Beta",
    sublabel: "Good capture fidelity, but report confidence depends on Cursor version and hook health.",
    status: "Beta" as const,
    available: true,
    detectCmd: "cursor",
    versionFlag: "--version",
    supportedPlatforms: ["darwin", "linux", "win32"] as string[],
    minVersion: CURSOR_MIN_VERSION,
  },
  {
    id: "codex_cli" as const,
    label: "Codex CLI — Beta",
    sublabel: "Best for codex exec --json. Interactive CLI sessions may have partial shell/tool coverage.",
    status: "Beta" as const,
    available: true,
    detectCmd: "codex",
    versionFlag: "--version",
    supportedPlatforms: ["darwin", "linux", "win32"] as string[],
  },
] as const;

type ToolId = (typeof TOOLS)[number]["id"];

// ---------------------------------------------------------------------------
// Flag-driven (non-interactive) selection helpers
//
// These resolve the `--tool`, `--codex-mode`, `--question-id`, and
// `--accept-consent` CLI flags into validated selections so scripts can run
// `prepsavant start --ai-assisted --json` end-to-end without piping stdin
// answers. Each helper returns either `{ ok: true, ... }` (with a `null`
// value meaning "flag not supplied — fall through to the interactive
// picker") or `{ ok: false, error }` so the caller can route the message
// through the JSON / plain stderr surface uniformly.
//
// Exported so unit tests can pin the validation contract without spinning
// up the full session flow (which would need a real auth token + HTTP).
// ---------------------------------------------------------------------------

export type FlagResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

// The CLI parser in `cli.ts` collapses `--flag` (no value) into a boolean
// `true`. For value-accepting flags like `--tool`, that means a CI script
// that fat-fingered the value (e.g. `--tool --json`) would silently fall
// back to the interactive picker — and hang waiting on stdin. Treat the
// boolean form as an explicit "missing value" error so scripts get a clear
// signal up front.
type RawFlagValue = string | boolean | undefined;

function asValueFlag(name: string, raw: RawFlagValue): FlagResult<string | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === true) {
    return { ok: false, error: `Missing value for --${name}.` };
  }
  if (typeof raw === "string") return { ok: true, value: raw };
  // Defensive: future parser changes shouldn't slip past this guard.
  return { ok: false, error: `Invalid value for --${name}.` };
}

// Resolve `--tool <id>` against the static TOOLS list. Returns `null` when
// the flag isn't supplied so the caller falls back to the interactive
// picker. Unknown values produce an explicit "expected one of" error so
// scripts get a clear hint. A bare `--tool` (no value) is treated as a
// validation error rather than silently falling back to the picker.
export function resolveToolFlag(
  raw: RawFlagValue,
): FlagResult<(typeof TOOLS)[number] | null> {
  const v = asValueFlag("tool", raw);
  if (!v.ok) return v;
  const value = v.value;
  if (value === undefined) return { ok: true, value: null };
  const found = TOOLS.find((t) => t.id === value);
  if (!found) {
    return {
      ok: false,
      error: `Unknown --tool value: ${value}. Expected one of: ${TOOLS.map((t) => t.id).join(", ")}.`,
    };
  }
  return { ok: true, value: found };
}

// Resolve `--codex-mode <interactive|exec>`. Returns `null` when not set
// so the caller falls back to the interactive 1/2 picker, `true` for exec
// mode (codexExecMode) and `false` for interactive mode. A bare
// `--codex-mode` (no value) is rejected with a missing-value error.
export function resolveCodexModeFlag(
  raw: RawFlagValue,
): FlagResult<boolean | null> {
  const v = asValueFlag("codex-mode", raw);
  if (!v.ok) return v;
  const value = v.value;
  if (value === undefined) return { ok: true, value: null };
  if (value === "interactive") return { ok: true, value: false };
  if (value === "exec") return { ok: true, value: true };
  return {
    ok: false,
    error: `Unknown --codex-mode value: ${value}. Expected one of: interactive, exec.`,
  };
}

// Resolve `--codex-prompt <text-or-file>`. Mirrors the interactive prompt
// the runner shows in codex exec mode ("Enter the prompt for Codex (or path
// to a prompt file)") so scripts can supply that answer up front and run
// `prepsavant start --ai-assisted --json --tool codex_cli --codex-mode exec`
// completely unattended. Returns `null` when the flag is not supplied so
// the caller can decide whether to fall back to the interactive prompt
// (TTY mode) or bail with a JSON error (non-interactive `--json` mode —
// otherwise the run hangs forever waiting on stdin). Empty / whitespace-only
// values are rejected so a fat-fingered `--codex-prompt ""` doesn't silently
// hand codex an empty prompt. The value is passed through verbatim to
// `codex exec --json`, matching the existing interactive flow (codex itself
// understands `@file` style references for prompt-from-file usage).
export function resolveCodexPromptFlag(
  raw: RawFlagValue,
): FlagResult<string | null> {
  const v = asValueFlag("codex-prompt", raw);
  if (!v.ok) return v;
  const value = v.value;
  if (value === undefined) return { ok: true, value: null };
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: false, error: `Empty value for --codex-prompt.` };
  }
  return { ok: true, value: trimmed };
}

// Resolve `--question-id <id>` against the server-driven question list.
// Returns `null` when not set so the caller falls back to the numbered
// picker. An unknown id produces a hint pointing at the interactive flow,
// since the server-driven ordering is what the picker shows. A bare
// `--question-id` (no value) is rejected with a missing-value error.
export function resolveQuestionIdFlag<T extends { id: string }>(
  raw: RawFlagValue,
  items: ReadonlyArray<T>,
): FlagResult<T | null> {
  const v = asValueFlag("question-id", raw);
  if (!v.ok) return v;
  const value = v.value;
  if (value === undefined) return { ok: true, value: null };
  const found = items.find((q) => q.id === value);
  if (!found) {
    return {
      ok: false,
      error: `Unknown --question-id: ${value}. Run without --question-id to see available problems.`,
    };
  }
  return { ok: true, value: found };
}

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

function detectToolVersion(detectCmd: string, versionFlag: string): string {
  const result = spawnSync(detectCmd, [versionFlag], { encoding: "utf-8" });
  if (result.status === 0) {
    return (result.stdout || result.stderr || "").trim().split("\n")[0] ?? "unknown";
  }
  return "not-detected";
}

function detectWorkspaceDir(): string {
  return process.cwd();
}

// Parse a semver-like version string into [major, minor, patch].
function parseVersion(v: string): [number, number, number] {
  const m = v.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1]!), parseInt(m[2]!), parseInt(m[3]!)];
}

function versionAtLeast(v: string, min: readonly [number, number, number]): boolean {
  const [maj, min_, pat] = parseVersion(v);
  if (maj !== min[0]) return maj > min[0];
  if (min_ !== min[1]) return min_ > min[1];
  return pat >= min[2];
}

// Cross-platform preflight check for a given (tool, OS) pair.
// Returns an error string if the pair is unsupported, null if OK.
function checkOsPlatformSupport(toolId: ToolId): string | null {
  const platform = process.platform;
  const tool = TOOLS.find((t) => t.id === toolId);
  if (!tool) return `Unknown tool: ${toolId}`;
  if (!tool.supportedPlatforms.includes(platform)) {
    return `${tool.label} is not yet supported on ${platform}. Supported platforms: ${tool.supportedPlatforms.join(", ")}.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Consent text (verbatim from the doc)
// ---------------------------------------------------------------------------

function renderConsentText(toolLabel: string, captures: string[], notCaptures: string[], osCaveats?: string[]): string {
  const lines: string[] = [
    `  ─────────────────────────────────────────────`,
    `  PrepSavant AI-Assisted Session Consent`,
    `  ─────────────────────────────────────────────`,
    ``,
    `  Tool: ${toolLabel}`,
    ``,
    `  PrepSavant captures your prompts, AI responses, file edits, shell/test`,
    `  results, and workspace diffs into a signed, tamper-evident evidence log`,
    `  for post-session grading. It does not record your screen, microphone, or`,
    `  keystrokes.`,
    ``,
    `  CAPTURED:`,
    ...captures.map((c) => `    • ${c}`),
    ``,
    `  NOT CAPTURED:`,
    ...notCaptures.map((c) => `    • ${c}`),
  ];

  if (osCaveats && osCaveats.length > 0) {
    lines.push(``, `  PLATFORM NOTES:`);
    for (const c of osCaveats) {
      lines.push(`    ! ${c}`);
    }
  }

  lines.push(
    ``,
    `  Your report will show the evidence PrepSavant used, including event IDs`,
    `  and hashes. The trust model is tamper-evident, not tamper-proof —`,
    `  PrepSavant is observational only.`,
    ``,
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main CLI start flow
// ---------------------------------------------------------------------------

export async function runStart(flags: Record<string, string | boolean>): Promise<void> {
  // --json mode: route all interactive UI (banners, prompts, progress lines)
  // to stderr so stdout stays clean for a single JSON success line. Errors
  // are emitted as `{"error":"..."}` to stderr instead of multi-line prose.
  const jsonMode = !!flags.json;
  const uiOut = (s: string): void => {
    if (jsonMode) process.stderr.write(s);
    else process.stdout.write(s);
  };
  const errExit = (msg: string): void => {
    if (jsonMode) {
      process.stderr.write(formatStartErrorJson(msg));
    } else {
      // Non-JSON errors keep their original formatting and destination
      // (most go to stdout as user-visible warnings; the catch handler at
      // the bottom of this function uses stderr explicitly).
      process.stderr.write(msg);
    }
    process.exitCode = 1;
  };

  const cfg = readConfig();
  if (!cfg.token) {
    errExit("Not authorized. Run `prepsavant auth` first.\n");
    return;
  }

  const api = new SamApi(cfg);
  const rl = readline.createInterface({
    input: process.stdin,
    // Route the readline prompt text to stderr in --json mode so stdout
    // stays clean for the JSON success line.
    output: jsonMode ? process.stderr : process.stdout,
  });

  try {
    uiOut("\n  PrepSavant AI-Assisted Mode\n");
    uiOut("  ─────────────────────────────────────────────\n\n");

    // Stale hook detection (all three tools).
    //
    // In interactive mode we prompt `[Y/n]` so a human can decide. In
    // non-interactive mode (`--json` or the explicit `--cleanup-stale-hooks`
    // flag) we default to "yes" and remove the stale hooks automatically —
    // otherwise the prompt would hang forever on a CI runner that was killed
    // mid-run, defeating the whole point of `start --json` being scriptable.
    // The cleaned-up tool/sessionId is surfaced as a one-line stderr warning
    // so it shows up in CI logs without polluting the success JSON line on
    // stdout.
    const workspaceDir = detectWorkspaceDir();
    let staleCleaned = false;
    if (shouldAutoCleanupStaleHooks(flags)) {
      const r = tryAutoCleanupStaleHooks(workspaceDir, {
        detect: detectStaleHooks,
        cleanup: cleanupStaleHooks,
      });
      staleCleaned = r.staleCleaned;
      if (r.warning) process.stderr.write(r.warning);
    } else {
      const stale = detectStaleHooks(workspaceDir);
      if (stale) {
        uiOut(
          `  ${colorWarning("!")} Found stale PrepSavant hooks from a previous session (${stale.sessionId}, tool: ${stale.toolId}).\n` +
          `    This usually means the runner crashed without cleaning up.\n\n`,
        );
        const answer = await prompt(rl, "  Remove stale hooks and continue? [Y/n] ");
        if (answer.trim().toLowerCase() !== "n") {
          cleanupStaleHooks(workspaceDir);
          staleCleaned = true;
          uiOut(`  ${colorSuccess("✓")} Stale hooks removed.\n\n`);
        } else {
          errExit(
            "Aborting. Remove hooks manually:\n" +
            "    • Claude Code: delete .claude/hooks/ in your workspace\n" +
            "    • Cursor: delete .cursor/settings.json hooks section\n" +
            "    • Codex: delete ~/.codex/hooks.json\n",
          );
          return;
        }
      }
    }

    // Tool selector — labels already include support status (e.g. "Cursor — Beta").
    // When --tool is supplied via flag, skip the picker entirely so scripts
    // can run unattended. Unknown ids and missing values emit a JSON error
    // in --json mode (rather than silently falling back to the picker).
    const toolFlagResult = resolveToolFlag(flags.tool);
    if (!toolFlagResult.ok) {
      errExit(`${toolFlagResult.error}\n`);
      return;
    }
    let selected: (typeof TOOLS)[number] | undefined = toolFlagResult.value ?? undefined;
    if (!selected) {
      uiOut("  Select your AI coding assistant:\n\n");
      TOOLS.forEach((t, i) => {
        uiOut(`  [${i + 1}] ${t.label}\n`);
        uiOut(`       ${t.sublabel}\n\n`);
      });

      const toolInput = await prompt(rl, "  Your choice [1]: ");
      const idx = parseInt(toolInput.trim() || "1", 10) - 1;
      selected = TOOLS[idx];
      if (!selected) {
        errExit("Invalid selection.\n");
        return;
      }
    }

    const selectedToolId: ToolId = selected.id;

    // Cross-platform OS gating
    const platformErr = checkOsPlatformSupport(selectedToolId);
    if (platformErr) {
      errExit(`${platformErr}\n`);
      return;
    }

    // Detect tool version
    let toolVersion = "unknown";
    const toolVersion_ = detectToolVersion(selected.detectCmd, selected.versionFlag);

    if (toolVersion_ === "not-detected") {
      const installGuide =
        selectedToolId === "claude_code"
          ? "https://docs.anthropic.com/en/docs/claude-code"
          : selectedToolId === "cursor"
          ? "https://cursor.com"
          : "https://github.com/openai/codex";
      errExit(
        `${selected.label.split(" — ")[0]} not found in PATH. Install it first: ${installGuide}\n`,
      );
      return;
    }
    toolVersion = toolVersion_;

    // Version-specific gating for Cursor
    if (selectedToolId === "cursor" && "minVersion" in selected) {
      if (!versionAtLeast(toolVersion, selected.minVersion)) {
        errExit(
          `Cursor ${toolVersion} is below the minimum supported version ${selected.minVersion.join(".")}. Hook support requires Cursor 0.45.0 or later. Update Cursor at https://cursor.com and try again.\n`,
        );
        return;
      }
    }

    // Codex exec mode selection. When --codex-mode is supplied via flag,
    // skip the prompt; values must be "interactive" or "exec". The flag is
    // ignored for non-codex tools so scripts can pass it unconditionally.
    let codexExecMode = false;
    // The codex exec branch normally asks one more interactive question
    // ("Enter the prompt for Codex (or path to a prompt file)") which would
    // hang an unattended `--json` run forever. `--codex-prompt` lets scripts
    // supply that answer up front; the value is reused later in the codex
    // exec spawn block. Only meaningful when codexExecMode === true; we
    // still validate the flag here so missing-value / empty-string errors
    // surface before the heavier API + consent work runs.
    let codexPromptArg: string | null = null;
    if (selectedToolId === "codex_cli") {
      const codexModeResult = resolveCodexModeFlag(flags["codex-mode"]);
      if (!codexModeResult.ok) {
        errExit(`${codexModeResult.error}\n`);
        return;
      }
      if (codexModeResult.value !== null) {
        codexExecMode = codexModeResult.value;
      } else {
        uiOut(`\n  Codex CLI capture mode:\n\n`);
        uiOut(`    [1] Interactive mode (medium confidence)\n`);
        uiOut(`        Uses Codex hooks (requires CODEX_HOOKS=1). Partial shell/tool coverage.\n\n`);
        uiOut(`    [2] codex exec --json (high confidence)\n`);
        uiOut(`        Runs your session via 'codex exec --json'. Full JSONL event stream.\n\n`);
        const modeInput = await prompt(rl, "  Your choice [1]: ");
        codexExecMode = modeInput.trim() === "2";
      }
      if (codexExecMode) {
        uiOut(`\n  ${colorSuccess("✓")} Using codex exec --json mode (high confidence)\n`);
        uiOut(`    PrepSavant will start Codex and consume the JSONL event stream.\n`);

        // Resolve --codex-prompt early so scripts get the missing-value
        // error before we spend cycles on API/consent work. In
        // non-interactive (`--json`) mode we MUST have the flag, otherwise
        // the run would hang on the prompt-for-Codex stdin question further
        // down. In TTY mode the flag is optional — the existing interactive
        // prompt fires when the flag is omitted.
        const codexPromptResult = resolveCodexPromptFlag(flags["codex-prompt"]);
        if (!codexPromptResult.ok) {
          errExit(`${codexPromptResult.error}\n`);
          return;
        }
        if (codexPromptResult.value !== null) {
          codexPromptArg = codexPromptResult.value;
        } else if (jsonMode) {
          errExit(
            "Missing --codex-prompt. In --json mode with --tool codex_cli --codex-mode exec, " +
            "the Codex prompt must be supplied via --codex-prompt because no interactive prompt is available.\n",
          );
          return;
        }
      } else {
        uiOut(`\n  ${colorSuccess("✓")} Using interactive Codex mode (medium confidence)\n`);
        uiOut(`    Note: set CODEX_HOOKS=1 in your environment before starting Codex.\n`);
      }
    }

    const toolDisplayName =
      selectedToolId === "claude_code" ? "Claude Code" :
      selectedToolId === "cursor" ? `Cursor ${toolVersion}` :
      codexExecMode ? "Codex CLI (exec mode)" : "Codex CLI";

    uiOut(`\n  ${colorSuccess("✓")} Detected ${toolDisplayName}\n`);

    // Preflight: snapshot store writable
    const { SnapshotStore } = await import("./snapshot.js");
    const snap = new SnapshotStore({ sessionId: "preflight-check", workspaceDir });
    if (!snap.isWritable()) {
      errExit("Snapshot store is not writable. Check permissions.\n");
      return;
    }

    // Build capability manifest for the selected tool so consent dialog is accurate
    const internalTool: SupportedTool =
      selectedToolId === "claude_code" ? "claude_code" :
      selectedToolId === "cursor" ? "cursor" :
      "codex";
    const manifest = buildCapabilityManifest(internalTool, codexExecMode);

    // List problems. When --question-id is supplied via flag, look it up
    // directly and skip the interactive picker so scripts don't have to
    // depend on the server-driven ordering.
    uiOut("\n  Fetching available problems…\n");
    const questions = await api.listQuestions();
    if (questions.items.length === 0) {
      errExit("No problems available for practice.\n");
      return;
    }

    const questionResult = resolveQuestionIdFlag(flags["question-id"], questions.items);
    if (!questionResult.ok) {
      errExit(`${questionResult.error}\n`);
      return;
    }
    let selectedQuestion: (typeof questions.items)[number] | undefined =
      questionResult.value ?? undefined;
    if (!selectedQuestion) {
      uiOut("\n  Available problems:\n\n");
      questions.items.forEach((q, i) => {
        uiOut(`  [${i + 1}] ${q.title} [${q.roleFamily}/${q.difficulty}]\n`);
      });

      const qInput = await prompt(rl, "\n  Select a problem [1]: ");
      const qIdx = parseInt(qInput.trim() || "1", 10) - 1;
      selectedQuestion = questions.items[qIdx];
      if (!selectedQuestion) {
        errExit("Invalid selection.\n");
        return;
      }
    }

    uiOut(`\n  Selected: ${selectedQuestion.title}\n`);

    // Consent dialog
    uiOut("\n");
    uiOut(renderConsentText(
      manifest.toolLabel,
      manifest.captures,
      manifest.notCaptures,
      manifest.osCaveats,
    ));

    // Beta-tool caveats
    if (manifest.toolStatus === "beta") {
      uiOut(
        `  Beta tool note: ${manifest.toolLabel} has limited hook coverage compared to\n` +
        `  Claude Code. The report confidence ceiling for this session is "${manifest.confidenceCeiling}".\n` +
        `  Beta labels are visible in the report header.\n\n`,
      );
    }

    // --accept-consent skips the interactive "type yes" prompt so unattended
    // runs (CI, scripts) can proceed without piping stdin. Human users still
    // see the consent text above; only the confirmation step is suppressed.
    const acceptConsentFlag = !!flags["accept-consent"];
    if (acceptConsentFlag) {
      uiOut(`  ${colorSuccess("✓")} Consent auto-accepted (--accept-consent).\n`);
    } else {
      const consentInput = await prompt(rl, "  Type 'yes' to start the session, or press Enter to cancel: ");
      if (consentInput.trim().toLowerCase() !== "yes") {
        // Cancellation is a user choice, not a failure — exit code stays 0.
        // In --json mode there's no JSON output at all on cancel.
        uiOut("  Session cancelled.\n");
        return;
      }
    }

    // Start session
    uiOut("\n  Starting AI-Assisted session…\n");

    // Capture startedAt locally — the start endpoint doesn't echo it back, and
    // the runner is the one initiating the session, so this is the canonical
    // "started" moment for downstream JSON consumers.
    const startedAt = new Date().toISOString();
    const handle = await startAiAssistedSession({
      tool: internalTool,
      toolVersion,
      workspaceDir,
      questionId: selectedQuestion.id,
      runnerVersion: RUNNER_VERSION,
      staleCleaned,
      codexExecMode,
      onEvent: (kind, seq) => {
        uiOut(`  [event #${seq}] ${kind}\n`);
      },
    });

    // --json: emit the single-line success payload to stdout immediately.
    // Scripts can read just the first stdout line and proceed; the runner
    // continues to manage the session in the background as usual.
    if (jsonMode) {
      process.stdout.write(
        formatStartSuccessJson(handle.sessionId, internalTool, startedAt),
      );
    }

    uiOut(`\n  ${colorSuccess("✓")} Session started: ${handle.sessionId}\n`);

    // Per-channel hook health polling — only for beta tools where partial
    // coverage is expected. We poll the cheap status endpoint and re-print
    // the "Hook channels" line whenever the per-channel fired-set changes,
    // so the terminal doesn't churn but users see new channels light up.
    const isBetaTool = internalTool === "cursor" || internalTool === "codex";
    let lastHookChannelsLine = "";
    let statusPollTimer: ReturnType<typeof setInterval> | null = null;
    const pollHookChannelsOnce = async (): Promise<void> => {
      try {
        const status = await api.getAiAssistedSessionStatus(handle.sessionId);
        const line = formatHookChannelsLine(status.hookHealth);
        if (line !== lastHookChannelsLine) {
          lastHookChannelsLine = line;
          uiOut(`${line}\n`);
        }
      } catch {
        // Best-effort: status polling failures must not break the session.
      }
    };
    if (isBetaTool) {
      // Print an initial "all-channels-pending" line right away so users see
      // the channel list before the first event fires.
      void pollHookChannelsOnce();
      statusPollTimer = setInterval(() => {
        void pollHookChannelsOnce();
      }, STATUS_POLL_INTERVAL_MS);
      statusPollTimer.unref();
    }

    const cleanup = async (exitCode = 0) => {
      if (statusPollTimer) {
        clearInterval(statusPollTimer);
        statusPollTimer = null;
      }
      uiOut("\n\n  Ending session and uploading evidence bundle…\n");
      try {
        await handle.stop();
        uiOut(`  ${colorSuccess("✓")} Session ended. Evidence bundle uploaded.\n`);
        uiOut("  View your report on the PrepSavant dashboard.\n\n");
      } catch (err) {
        // Finalization errors stay on stderr; the JSON success line was
        // already emitted earlier so we don't re-emit a JSON error here.
        process.stderr.write(`  ${colorError("!")} Failed to finalize session: ${(err as Error).message}\n`);
      }
      rl.close();
      process.exit(exitCode);
    };

    process.on("SIGINT", () => { void cleanup(0); });
    process.on("SIGTERM", () => { void cleanup(0); });

    // ---------------------------------------------------------------------------
    // Codex exec --json path — spawn the subprocess and consume the JSONL stream
    // ---------------------------------------------------------------------------
    if (internalTool === "codex" && codexExecMode) {
      uiOut(
        `  ${colorSuccess("✓")} Starting Codex in exec mode — PrepSavant will capture the JSONL stream.\n\n`,
      );

      // Prefer the flag value (set by --codex-prompt) so unattended runs
      // never reach the readline prompt. The flag was validated up front
      // (resolveCodexPromptFlag) and required in --json mode, so reaching
      // the readline branch here implies the user is on a TTY.
      let promptArg: string;
      if (codexPromptArg !== null) {
        promptArg = codexPromptArg;
        uiOut(`  ${colorSuccess("✓")} Using Codex prompt from --codex-prompt.\n`);
      } else {
        const codexPrompt = await prompt(
          rl,
          "  Enter the prompt for Codex (or path to a prompt file): ",
        );
        promptArg = codexPrompt.trim();
        if (!promptArg) {
          uiOut("  No prompt provided. Session cancelled.\n");
          await handle.stop();
          return;
        }
      }

      uiOut(`\n  Launching: codex exec --json "${promptArg}"\n`);
      uiOut("  Forwarding JSONL events to PrepSavant capture pipeline…\n\n");

      const codexProc = spawn("codex", ["exec", "--json", promptArg], {
        stdio: ["ignore", "pipe", "inherit"],
        env: { ...process.env },
      });

      // Forward each JSONL line from codex stdout to the runner IPC socket.
      let lineBuffer = "";
      codexProc.stdout.on("data", (chunk: Buffer) => {
        lineBuffer += chunk.toString();
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          // Forward as a "jsonl" IPC event so session.ts dispatches via handleJsonlEvent.
          const ipcPayload = JSON.stringify({
            kind: "jsonl",
            data: trimmed,
            ts: Date.now(),
          }) + "\n";
          const client = net.createConnection({ path: handle.socketPath }, () => {
            client.write(ipcPayload, () => client.end());
          });
          client.on("error", () => {});
        }
      });

      await new Promise<void>((resolve) => {
        codexProc.on("close", (code) => {
          uiOut(
            `\n  Codex process exited (code ${code ?? 0}). Finalizing session…\n`,
          );
          resolve();
        });
        codexProc.on("error", (err) => {
          process.stderr.write(`  ${colorError("!")} Codex process error: ${err.message}\n`);
          resolve();
        });
      });

      await cleanup(0);
      return;
    }

    // ---------------------------------------------------------------------------
    // Hook-based paths (Claude Code, Cursor, Codex interactive)
    // ---------------------------------------------------------------------------
    const toolHint =
      internalTool === "claude_code"
        ? "Open Claude Code and start working on the problem."
        : internalTool === "cursor"
        ? "Open Cursor in this directory and start working on the problem."
        : "Set CODEX_HOOKS=1 and start Codex in this directory.";

    uiOut(`  ${colorSuccess("✓")} Hooks installed — ${toolDisplayName} is now being captured.\n\n`);
    uiOut("  PrepSavant is running silently in the background.\n");
    uiOut(`  ${toolHint}\n`);
    uiOut("  When done, press Ctrl+C to end the session and upload the evidence bundle.\n\n");

    await new Promise<void>(() => {});
  } catch (err) {
    if (isEntitlementRequiredError(err)) {
      if (jsonMode) {
        // Collapse the multi-line "AI-Assisted requires Pro" message into a
        // single-line JSON error so scripts can parse it the same way they
        // parse other --json failures. Include the upgrade URL inline so
        // CI integrations don't lose the actionable hint.
        const upgradeUrl = `${cfg.apiBaseUrl.replace(/\/$/, "")}/pricing`;
        const tier = err.body.requiredEntitlement === "lifetime" ? "Lifetime" : "Pro";
        process.stderr.write(
          formatStartErrorJson(
            `AI-Assisted requires PrepSavant ${tier}. Upgrade at: ${upgradeUrl}`,
          ),
        );
      } else {
        process.stderr.write(
          formatEntitlementRequiredMessage(cfg.apiBaseUrl, err.body),
        );
      }
      process.exitCode = 1;
      return;
    }
    if (jsonMode) {
      process.stderr.write(formatStartErrorJson((err as Error).message));
    } else {
      process.stderr.write(`  ${colorError("Error:")} ${(err as Error).message}\n`);
    }
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}
