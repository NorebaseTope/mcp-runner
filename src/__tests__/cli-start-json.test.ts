// Unit tests for the `prepsavant start --json` output path.
//
// `prepsavant start --ai-assisted --json` is the script-friendly mode that
// scripts and CI integrations use to capture a new session id without
// screen-scraping the human-readable interactive output. These tests pin
// the success and error JSON shapes so the convention stays stable across
// releases (and matches the existing `status --json` / `doctor --json`
// surface).

import test from "node:test";
import assert from "node:assert/strict";
import {
  formatStartSuccessJson,
  formatStartErrorJson,
  formatStaleHookCleanupWarning,
  shouldAutoCleanupStaleHooks,
  tryAutoCleanupStaleHooks,
  resolveToolFlag,
  resolveCodexModeFlag,
  resolveCodexPromptFlag,
  resolveQuestionIdFlag,
} from "../ai-assisted/cli-start.js";
import type { StaleHookInfo } from "../ai-assisted/hook-installer.js";

// ---------------------------------------------------------------------------
// Success payload
// ---------------------------------------------------------------------------

test("formatStartSuccessJson: produces valid JSON with the documented fields", () => {
  const out = formatStartSuccessJson(
    "sess_abc123",
    "claude_code",
    "2026-04-29T12:00:00.000Z",
  );
  // Must end with a newline so callers see one record per line.
  assert.ok(out.endsWith("\n"), "output ends with newline");

  let parsed: unknown;
  assert.doesNotThrow(() => { parsed = JSON.parse(out); }, "output is valid JSON");
  const p = parsed as { sessionId: string; tool: string; startedAt: string };
  assert.equal(p.sessionId, "sess_abc123");
  assert.equal(p.tool, "claude_code");
  assert.equal(p.startedAt, "2026-04-29T12:00:00.000Z");
});

test("formatStartSuccessJson: success line is single-line (no embedded newlines)", () => {
  const out = formatStartSuccessJson(
    "sess_xyz",
    "cursor",
    "2026-04-29T12:00:00.000Z",
  );
  // Strip the trailing newline; the rest must contain no line breaks so the
  // payload survives line-buffered consumers like `head -n 1` and `read`.
  const body = out.replace(/\n$/, "");
  assert.equal(body.includes("\n"), false, "no internal newlines in JSON body");
});

test("formatStartSuccessJson: tool field carries the internal SupportedTool name", () => {
  // We expect codex (not codex_cli) because cli-start passes the internal
  // SupportedTool value into formatStartSuccessJson, matching what the
  // session.ts surface uses elsewhere in the runner.
  const out = formatStartSuccessJson(
    "sess_codex",
    "codex",
    "2026-04-29T12:00:00.000Z",
  );
  const parsed = JSON.parse(out) as { tool: string };
  assert.equal(parsed.tool, "codex");
});

test("formatStartSuccessJson: startedAt round-trips ISO-8601 timestamps", () => {
  const ts = new Date("2026-04-29T08:30:00.123Z").toISOString();
  const out = formatStartSuccessJson("sess_iso", "claude_code", ts);
  const parsed = JSON.parse(out) as { startedAt: string };
  assert.equal(parsed.startedAt, ts);
  // Re-parsing as a Date should yield the same instant.
  assert.equal(new Date(parsed.startedAt).toISOString(), ts);
});

// ---------------------------------------------------------------------------
// Error payload
// ---------------------------------------------------------------------------

test("formatStartErrorJson: wraps message in {error: ...} and ends with newline", () => {
  const out = formatStartErrorJson("Not authorized. Run `prepsavant auth` first.");
  assert.ok(out.endsWith("\n"), "ends with newline");
  const parsed = JSON.parse(out) as { error: string };
  assert.equal(typeof parsed.error, "string");
  assert.equal(parsed.error, "Not authorized. Run `prepsavant auth` first.");
});

test("formatStartErrorJson: trims trailing whitespace and newlines from the input", () => {
  // Many call sites pass strings that already end in "\n" because they were
  // designed for plain stderr. The JSON wrapper must collapse those so the
  // emitted record stays single-line.
  const out = formatStartErrorJson("Invalid selection.\n");
  const parsed = JSON.parse(out) as { error: string };
  assert.equal(parsed.error, "Invalid selection.");
  // The whole record (body + trailing newline) must contain exactly one
  // newline — at the very end.
  const newlines = (out.match(/\n/g) ?? []).length;
  assert.equal(newlines, 1, "exactly one trailing newline");
});

test("formatStartErrorJson: trims multi-line trailing whitespace", () => {
  const out = formatStartErrorJson("Snapshot store is not writable. Check permissions.\n\n  ");
  const parsed = JSON.parse(out) as { error: string };
  assert.equal(parsed.error, "Snapshot store is not writable. Check permissions.");
});

test("formatStartErrorJson: produces a single line even for long messages", () => {
  const out = formatStartErrorJson(
    "Cursor 0.40.0 is below the minimum supported version 0.45.0. Hook support requires Cursor 0.45.0 or later. Update Cursor at https://cursor.com and try again.",
  );
  const body = out.replace(/\n$/, "");
  assert.equal(body.includes("\n"), false, "no embedded newlines in long error");
  // Still valid JSON.
  assert.doesNotThrow(() => JSON.parse(out));
});

test("formatStartErrorJson: escapes embedded quotes correctly", () => {
  // Defensive: error messages occasionally include quoted tokens. The JSON
  // encoder must escape them so the line stays parseable.
  const out = formatStartErrorJson('No prompt provided for "codex exec".');
  const parsed = JSON.parse(out) as { error: string };
  assert.equal(parsed.error, 'No prompt provided for "codex exec".');
});

// ---------------------------------------------------------------------------
// runStart flow tests (--json stream-routing)
//
// These exercise the actual `runStart` entry point on the simplest exit path
// (no auth token in ~/.prepsavant/config.json) so we can pin the runtime
// stream-routing contract: in --json mode the only stdout writes happen for
// the success line, and any error must land on stderr as a single JSON line.
// The test environment in the runner repo has no ~/.prepsavant config, so
// `readConfig()` returns no token and `runStart` falls through to errExit.
// ---------------------------------------------------------------------------

import { runStart } from "../ai-assisted/cli-start.js";

interface CapturedStreams {
  stdout: string[];
  stderr: string[];
  restore: () => void;
}

function captureStreams(): CapturedStreams {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  // Cast to any: process.stdout.write has overloads we don't care about here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout.write as any) = (chunk: string | Uint8Array): boolean => {
    stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr.write as any) = (chunk: string | Uint8Array): boolean => {
    stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  };
  return {
    stdout,
    stderr,
    restore: () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stdout.write as any) = origStdout;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stderr.write as any) = origStderr;
    },
  };
}

test("runStart --json: missing token writes a single JSON error to stderr and nothing to stdout", async () => {
  // Reset exitCode so we can assert what runStart sets.
  const origExitCode = process.exitCode;
  process.exitCode = 0;
  const cap = captureStreams();
  try {
    await runStart({ json: true });
  } finally {
    cap.restore();
    const finalExit = process.exitCode;
    process.exitCode = origExitCode;
    // Assert AFTER restoring streams so failures are visible.
    assert.equal(cap.stdout.length, 0, "no stdout writes in JSON mode on auth failure");
    assert.equal(cap.stderr.length, 1, "exactly one stderr write");
    const line = cap.stderr[0]!;
    assert.ok(line.endsWith("\n"), "stderr line ends with newline");
    let parsed: unknown;
    assert.doesNotThrow(() => { parsed = JSON.parse(line); }, "stderr is valid JSON");
    assert.match((parsed as { error: string }).error, /Not authorized/);
    assert.match((parsed as { error: string }).error, /prepsavant auth/);
    assert.equal(finalExit, 1, "exit code is 1");
  }
});

test("runStart (no --json): missing token writes plain text to stderr, no JSON wrapper", async () => {
  // Companion test: confirms the non-JSON path is unchanged. Same auth-missing
  // setup, but without --json the stderr write is a plain "Not authorized..."
  // line, not a JSON object.
  const origExitCode = process.exitCode;
  process.exitCode = 0;
  const cap = captureStreams();
  try {
    await runStart({});
  } finally {
    cap.restore();
    const finalExit = process.exitCode;
    process.exitCode = origExitCode;
    assert.equal(cap.stdout.length, 0, "no stdout writes in non-JSON mode on auth failure");
    assert.equal(cap.stderr.length, 1, "exactly one stderr write");
    const line = cap.stderr[0]!;
    assert.match(line, /^Not authorized\./, "plain-text auth error");
    // Should NOT be JSON.
    let parseErr: unknown = null;
    try { JSON.parse(line); } catch (e) { parseErr = e; }
    assert.ok(parseErr !== null, "plain text is not parseable as JSON");
    assert.equal(finalExit, 1);
  }
});

// ---------------------------------------------------------------------------
// Flag-driven (non-interactive) selection helpers
//
// These tests pin the validation contract for the four new CLI flags
// (`--tool`, `--codex-mode`, `--question-id`, `--accept-consent`) that let
// `prepsavant start --ai-assisted --json` run end-to-end without piping
// stdin answers. Pure helpers are tested here directly so we don't need a
// real auth token + HTTP mocks just to verify the flag surface.
// ---------------------------------------------------------------------------

test("resolveToolFlag: undefined falls back to interactive (returns null value)", () => {
  const r = resolveToolFlag(undefined);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value, null);
});

test("resolveToolFlag: each documented tool id maps to its TOOLS entry", () => {
  for (const id of ["claude_code", "cursor", "codex_cli"] as const) {
    const r = resolveToolFlag(id);
    assert.equal(r.ok, true, `${id} should be ok`);
    if (r.ok && r.value) assert.equal(r.value.id, id);
  }
});

test("resolveToolFlag: unknown ids produce a JSON-friendly error mentioning valid options", () => {
  const r = resolveToolFlag("vscode");
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.error, /Unknown --tool value: vscode/);
    // Hint must enumerate the valid choices so scripts get a useful message.
    assert.match(r.error, /claude_code/);
    assert.match(r.error, /cursor/);
    assert.match(r.error, /codex_cli/);
    // Single-line so it survives wrapping into formatStartErrorJson.
    assert.equal(r.error.includes("\n"), false);
  }
});

test("resolveToolFlag: empty string is rejected as unknown (not silently coerced)", () => {
  const r = resolveToolFlag("");
  assert.equal(r.ok, false);
});

test("resolveCodexModeFlag: undefined falls back to interactive (returns null value)", () => {
  const r = resolveCodexModeFlag(undefined);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value, null);
});

test("resolveCodexModeFlag: 'interactive' maps to false (codexExecMode=false)", () => {
  const r = resolveCodexModeFlag("interactive");
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value, false);
});

test("resolveCodexModeFlag: 'exec' maps to true (codexExecMode=true)", () => {
  const r = resolveCodexModeFlag("exec");
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value, true);
});

test("resolveCodexModeFlag: unknown value produces JSON-friendly single-line error", () => {
  const r = resolveCodexModeFlag("hooks");
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.error, /Unknown --codex-mode value: hooks/);
    assert.match(r.error, /interactive/);
    assert.match(r.error, /exec/);
    assert.equal(r.error.includes("\n"), false);
  }
});

// ---------------------------------------------------------------------------
// resolveCodexPromptFlag — pin the validation contract for the new
// `--codex-prompt <text-or-file>` flag so `start --json --tool codex_cli
// --codex-mode exec --codex-prompt "..."` runs end-to-end without piping
// stdin answers (the readline prompt would otherwise hang an unattended
// run forever).
// ---------------------------------------------------------------------------

test("resolveCodexPromptFlag: undefined falls back to interactive (returns null value)", () => {
  const r = resolveCodexPromptFlag(undefined);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value, null);
});

test("resolveCodexPromptFlag: inline prompt text is returned verbatim", () => {
  const r = resolveCodexPromptFlag("Implement the two-sum function in TypeScript.");
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value, "Implement the two-sum function in TypeScript.");
});

test("resolveCodexPromptFlag: leading/trailing whitespace is trimmed", () => {
  // Defensive: shells sometimes leave stray whitespace around quoted args.
  // The codex exec spawn uses the value verbatim, so trimming here keeps
  // the launched command tidy.
  const r = resolveCodexPromptFlag("   solve it please   ");
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value, "solve it please");
});

test("resolveCodexPromptFlag: codex @file references survive verbatim", () => {
  // The interactive prompt advertises "or path to a prompt file" — codex
  // itself supports `@file` references, so the flag must pass them through
  // unchanged.
  const r = resolveCodexPromptFlag("@./prompts/two-sum.md");
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value, "@./prompts/two-sum.md");
});

test("resolveCodexPromptFlag: empty string is rejected (would hand codex an empty prompt)", () => {
  const r = resolveCodexPromptFlag("");
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.error, /Empty value for --codex-prompt\./);
    assert.equal(r.error.includes("\n"), false);
  }
});

test("resolveCodexPromptFlag: whitespace-only string is rejected", () => {
  const r = resolveCodexPromptFlag("   \t  ");
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.error, /Empty value for --codex-prompt\./);
  }
});

test("resolveCodexPromptFlag: bare --codex-prompt (boolean true) returns a Missing value error", () => {
  // Mirrors the pattern of the other value-accepting flags: a script that
  // fat-fingers the value (e.g. `--codex-prompt --json`) gets a clear
  // signal up front instead of silently falling back to the readline
  // prompt and hanging forever.
  const r = resolveCodexPromptFlag(true);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.error, /Missing value for --codex-prompt\./);
    assert.equal(r.error.includes("\n"), false);
  }
});

test("resolveCodexPromptFlag: error message round-trips through formatStartErrorJson cleanly", () => {
  // The runtime code path is `errExit(`${result.error}\n`)` which in JSON
  // mode wraps via formatStartErrorJson. Re-create that here so any
  // future drift trips the assertion.
  const r = resolveCodexPromptFlag("");
  assert.equal(r.ok, false);
  if (!r.ok) {
    const out = formatStartErrorJson(`${r.error}\n`);
    assert.ok(out.endsWith("\n"));
    const parsed = JSON.parse(out) as { error: string };
    assert.equal(parsed.error, r.error);
    const newlines = (out.match(/\n/g) ?? []).length;
    assert.equal(newlines, 1, "exactly one trailing newline");
  }
});

test("resolveQuestionIdFlag: undefined falls back to picker (returns null value)", () => {
  const items = [{ id: "q_1" }, { id: "q_2" }];
  const r = resolveQuestionIdFlag(undefined, items);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value, null);
});

test("resolveQuestionIdFlag: matching id returns the full question object", () => {
  const items = [
    { id: "q_1", title: "First" },
    { id: "q_2", title: "Second" },
  ];
  const r = resolveQuestionIdFlag("q_2", items);
  assert.equal(r.ok, true);
  if (r.ok && r.value) {
    assert.equal(r.value.id, "q_2");
    assert.equal(r.value.title, "Second");
  }
});

test("resolveQuestionIdFlag: unknown id produces a single-line JSON-friendly error", () => {
  const items = [{ id: "q_1" }, { id: "q_2" }];
  const r = resolveQuestionIdFlag("q_missing", items);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.error, /Unknown --question-id: q_missing/);
    // Hint at the interactive recovery path so users can figure out what's
    // available without scraping the server.
    assert.match(r.error, /without --question-id/);
    assert.equal(r.error.includes("\n"), false);
  }
});

test("resolveQuestionIdFlag: round-trips through formatStartErrorJson cleanly", () => {
  // Defensive: the error string is fed straight into formatStartErrorJson
  // by the JSON-mode branch in runStart, so confirm the wrapper produces a
  // valid single-line JSON record.
  const items = [{ id: "q_1" }];
  const r = resolveQuestionIdFlag("q_404", items);
  assert.equal(r.ok, false);
  if (!r.ok) {
    const out = formatStartErrorJson(r.error);
    assert.ok(out.endsWith("\n"));
    const parsed = JSON.parse(out) as { error: string };
    assert.equal(parsed.error, r.error.trim());
    const newlines = (out.match(/\n/g) ?? []).length;
    assert.equal(newlines, 1, "exactly one trailing newline");
  }
});

// ---------------------------------------------------------------------------
// runStart with invalid flag values
//
// These exercise the actual `runStart` entry point on the simplest invalid
// flag path so we can pin the runtime stream-routing contract: in --json
// mode, an invalid flag value is reported as a single-line JSON error to
// stderr with no stdout writes. Falls through the auth check first because
// the test environment has no ~/.prepsavant config — but the error message
// in that case is auth-related, so we use a plain-text path for the flag
// validation runtime test below by checking that helpers are reused.
// ---------------------------------------------------------------------------

test("runStart --json: --tool unknown short-circuits to JSON error if auth is configured", async () => {
  // We can't reliably set up auth in the unit test environment, so instead
  // assert the *helper* output matches the runtime errExit contract: both
  // sides expect the helper's error message to be wrapped via
  // formatStartErrorJson and written to stderr verbatim.
  const r = resolveToolFlag("not-a-tool");
  assert.equal(r.ok, false);
  if (!r.ok) {
    // The runtime code path is `errExit(`${result.error}\n`)` which in
    // JSON mode passes through `formatStartErrorJson`. Re-create that here
    // so any future drift trips the assertion.
    const json = formatStartErrorJson(`${r.error}\n`);
    const parsed = JSON.parse(json) as { error: string };
    assert.equal(parsed.error, r.error);
  }
});

// ---------------------------------------------------------------------------
// Missing-value detection for value-accepting flags
//
// The CLI parser collapses a bare `--flag` (no value, or followed by another
// flag) into a boolean `true`. For value-accepting flags like `--tool` that
// would otherwise silently fall back to the interactive picker, we want an
// explicit "Missing value" error so a CI script that fat-fingered the value
// gets a clear signal up front instead of hanging.
// ---------------------------------------------------------------------------

test("resolveToolFlag: bare --tool (boolean true) returns a Missing value error", () => {
  const r = resolveToolFlag(true);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.error, /Missing value for --tool\./);
    assert.equal(r.error.includes("\n"), false);
  }
});

test("resolveCodexModeFlag: bare --codex-mode (boolean true) returns a Missing value error", () => {
  const r = resolveCodexModeFlag(true);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.error, /Missing value for --codex-mode\./);
  }
});

test("resolveQuestionIdFlag: bare --question-id (boolean true) returns a Missing value error", () => {
  const r = resolveQuestionIdFlag(true, [{ id: "q_1" }]);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.error, /Missing value for --question-id\./);
  }
});

// ---------------------------------------------------------------------------
// runStart --json + --accept-consent: stream-routing on the auth-failure
// path. The auth check still fires first (so we exit before reaching consent),
// but we also confirm that passing `--accept-consent` does not perturb the
// JSON-mode error contract — i.e. extra flags don't leak into stdout or
// double-print errors.
// ---------------------------------------------------------------------------

test("runStart --json --accept-consent: auth-missing path still emits a single JSON error", async () => {
  const origExitCode = process.exitCode;
  process.exitCode = 0;
  const cap = captureStreams();
  try {
    await runStart({ json: true, "accept-consent": true });
  } finally {
    cap.restore();
    const finalExit = process.exitCode;
    process.exitCode = origExitCode;
    assert.equal(cap.stdout.length, 0, "no stdout writes when bailing on auth");
    assert.equal(cap.stderr.length, 1, "exactly one stderr write");
    const parsed = JSON.parse(cap.stderr[0]!) as { error: string };
    assert.match(parsed.error, /Not authorized/);
    assert.equal(finalExit, 1);
  }
});

// ---------------------------------------------------------------------------
// Stale-hook auto-cleanup warning (non-interactive mode)
//
// When `start --json` (or the explicit `--cleanup-stale-hooks` flag) is used
// and stale hooks from a prior crashed session are present, the runner must
// NOT prompt — it must auto-remove the hooks and surface what was reaped via
// a one-line stderr warning. These tests pin the warning shape so log
// collectors and CI pipelines can rely on the format.
// ---------------------------------------------------------------------------

test("formatStaleHookCleanupWarning: includes tool and sessionId, single line, ends with newline", () => {
  const out = formatStaleHookCleanupWarning({
    toolId: "codex",
    sessionId: "sess_abc123",
    installedAt: "2026-04-29T12:00:00.000Z",
  });
  assert.ok(out.endsWith("\n"), "ends with newline");
  // Must be single-line so log collectors don't merge it with the next line.
  const body = out.replace(/\n$/, "");
  assert.equal(body.includes("\n"), false, "no embedded newlines");
  // Surfaces the cleaned-up tool and sessionId so CI logs are self-explanatory.
  assert.match(body, /tool=codex/);
  assert.match(body, /sessionId=sess_abc123/);
  // Prefixed with `prepsavant:` so it's grep-able in mixed output.
  assert.match(body, /^prepsavant:/);
  // Mentions "stale hooks" so the operator can tell what was cleaned.
  assert.match(body, /stale hooks/);
});

test("formatStaleHookCleanupWarning: works for all three tool ids", () => {
  for (const toolId of ["claude_code", "cursor", "codex"] as const) {
    const out = formatStaleHookCleanupWarning({
      toolId,
      sessionId: "sess_x",
      installedAt: "2026-04-29T00:00:00.000Z",
    });
    assert.match(out, new RegExp(`tool=${toolId}`));
  }
});

// ---------------------------------------------------------------------------
// shouldAutoCleanupStaleHooks — flag → boolean decision
//
// Pure helper exported so the runtime control-flow ("do we prompt or do we
// auto-clean?") is pinned without needing to spin up the rest of runStart.
// Both `--json` and the explicit `--cleanup-stale-hooks` flag must trigger
// auto-cleanup so scripted/CI runs never hang on the [Y/n] prompt.
// ---------------------------------------------------------------------------

test("shouldAutoCleanupStaleHooks: --json triggers auto-cleanup", () => {
  assert.equal(shouldAutoCleanupStaleHooks({ json: true }), true);
});

test("shouldAutoCleanupStaleHooks: --cleanup-stale-hooks triggers auto-cleanup (non-JSON unattended)", () => {
  assert.equal(shouldAutoCleanupStaleHooks({ "cleanup-stale-hooks": true }), true);
});

test("shouldAutoCleanupStaleHooks: both flags together still trigger auto-cleanup", () => {
  assert.equal(
    shouldAutoCleanupStaleHooks({ json: true, "cleanup-stale-hooks": true }),
    true,
  );
});

test("shouldAutoCleanupStaleHooks: no flags → interactive (returns false)", () => {
  assert.equal(shouldAutoCleanupStaleHooks({}), false);
});

test("shouldAutoCleanupStaleHooks: unrelated flags don't trigger auto-cleanup", () => {
  assert.equal(
    shouldAutoCleanupStaleHooks({ "accept-consent": true, tool: "claude_code" }),
    false,
  );
});

// ---------------------------------------------------------------------------
// tryAutoCleanupStaleHooks — integration-style with injected fakes
//
// Exercises the actual control flow runStart uses for the auto-cleanup
// branch. The dependency-injection seam (`detect`, `cleanup`) lets these
// tests assert that:
//   1. when stale hooks exist, `cleanup` is called exactly once and a
//      warning is produced — guaranteeing `start --json` cannot hang on
//      the [Y/n] prompt;
//   2. when no stale hooks exist, `cleanup` is NOT called and no warning
//      is produced — guaranteeing the happy path stays quiet.
// ---------------------------------------------------------------------------

test("tryAutoCleanupStaleHooks: stale hooks present → cleanup called, warning returned, staleCleaned=true", () => {
  const stale: StaleHookInfo = {
    toolId: "codex",
    sessionId: "sess_prev",
    installedAt: "2026-04-29T11:00:00.000Z",
  };
  let detectCalls = 0;
  let cleanupCalls = 0;
  let cleanupArg: string | null = null;
  const r = tryAutoCleanupStaleHooks("/tmp/ws", {
    detect: (workspaceDir) => {
      detectCalls++;
      assert.equal(workspaceDir, "/tmp/ws", "detect receives the workspaceDir");
      return stale;
    },
    cleanup: (workspaceDir) => {
      cleanupCalls++;
      cleanupArg = workspaceDir;
    },
  });
  assert.equal(detectCalls, 1, "detect called exactly once");
  assert.equal(cleanupCalls, 1, "cleanup called exactly once");
  assert.equal(cleanupArg, "/tmp/ws", "cleanup receives the same workspaceDir");
  assert.equal(r.staleCleaned, true);
  assert.deepEqual(r.stale, stale);
  assert.ok(r.warning, "warning is non-null when stale hooks were cleaned");
  // Warning carries the cleaned tool/sessionId so a CI log shows what was reaped.
  assert.match(r.warning!, /tool=codex/);
  assert.match(r.warning!, /sessionId=sess_prev/);
  assert.ok(r.warning!.endsWith("\n"), "warning ends with newline");
});

test("tryAutoCleanupStaleHooks: no stale hooks → cleanup NOT called, no warning, staleCleaned=false", () => {
  let cleanupCalls = 0;
  const r = tryAutoCleanupStaleHooks("/tmp/ws", {
    detect: () => null,
    cleanup: () => {
      cleanupCalls++;
    },
  });
  assert.equal(cleanupCalls, 0, "cleanup must not run on a clean workspace");
  assert.equal(r.staleCleaned, false);
  assert.equal(r.stale, null);
  assert.equal(r.warning, null);
});

test("tryAutoCleanupStaleHooks: warning round-trips the marker tool id (claude_code)", () => {
  const stale: StaleHookInfo = {
    toolId: "claude_code",
    sessionId: "sess_cc",
    installedAt: "2026-04-29T10:00:00.000Z",
  };
  const r = tryAutoCleanupStaleHooks("/tmp/ws", {
    detect: () => stale,
    cleanup: () => {},
  });
  assert.match(r.warning!, /tool=claude_code/);
  assert.match(r.warning!, /sessionId=sess_cc/);
});

// ---------------------------------------------------------------------------
// runStart end-to-end: stale hooks + --json must NOT prompt
//
// A true integration test that spawns the real CLI as a subprocess with a
// controlled HOME (so readConfig() finds a fake token without us mutating
// the user's actual ~/.prepsavant/config.json) and a controlled workspace
// directory containing a real stale-hook marker. The test asserts that:
//   1. the process exits within a short timeout (it would hang forever
//      without the fix because of the [Y/n] prompt);
//   2. the auto-cleanup warning is written to stderr, including tool and
//      sessionId from the marker;
//   3. the marker file is actually removed on disk.
//
// Bails out via `--tool <bogus>` so the run aborts cleanly AFTER the
// stale-hook block — we don't need a working API or the whole session
// startup, just proof that the prompt is bypassed and the warning surfaces.
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// packages/mcp-runner/src/__tests__/ → packages/mcp-runner
const MCP_RUNNER_ROOT = path.resolve(__dirname, "..", "..");
const CLI_SRC = path.join(MCP_RUNNER_ROOT, "src", "cli.ts");
const TSX_BIN = path.join(MCP_RUNNER_ROOT, "node_modules", ".bin", "tsx");

test("runStart --json: stale hook marker is auto-removed without prompting", () => {
  // Spin up an isolated HOME + workspace so the test never touches the
  // user's real config or hook files.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prepsavant-task443-"));
  const fakeHome = path.join(tmpRoot, "home");
  const fakeWs = path.join(tmpRoot, "ws");
  fs.mkdirSync(fakeHome, { recursive: true });
  fs.mkdirSync(fakeWs, { recursive: true });

  // Fake config with a token so readConfig() doesn't bail at the auth gate.
  const cfgDir = path.join(fakeHome, ".prepsavant");
  fs.mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(cfgDir, "config.json"),
    JSON.stringify({
      apiBaseUrl: "https://example.invalid",
      token: "fake-test-token",
    }),
    { mode: 0o600 },
  );

  // Plant a Claude Code stale hook marker in the workspace. detectStaleHooks
  // walks the workspace-local marker filenames first, so this is enough to
  // trigger the auto-cleanup branch without touching any global Codex paths.
  const claudeHooksDir = path.join(fakeWs, ".claude", "hooks");
  fs.mkdirSync(claudeHooksDir, { recursive: true });
  const markerPath = path.join(claudeHooksDir, ".prepsavant-hook-meta.json");
  fs.writeFileSync(
    markerPath,
    JSON.stringify({
      toolId: "claude_code",
      sessionId: "sess_crashed_run",
      installedAt: "2026-04-29T08:00:00.000Z",
    }),
  );

  try {
    const result = spawnSync(
      TSX_BIN,
      [CLI_SRC, "start", "--json", "--tool", "definitely-not-a-real-tool"],
      {
        env: {
          ...process.env,
          HOME: fakeHome,
          // Point tsx at the runner's own tsconfig.json so the spawned
          // subprocess can resolve TypeScript `paths` aliases (e.g. the
          // vendored `@workspace/*` modules in the standalone public
          // mcp-runner repo). Without this, tsx walks up from `cwd`
          // (fakeWs) and never finds a tsconfig that knows about the
          // aliases. In the private pnpm monorepo this env var is a
          // harmless no-op — the workspace symlinks under node_modules
          // already make the imports resolvable.
          TSX_TSCONFIG_PATH: path.join(MCP_RUNNER_ROOT, "tsconfig.json"),
        },
        cwd: fakeWs,
        encoding: "utf-8",
        // Hard cap so a regression that re-introduces the prompt fails fast
        // (the prompt would otherwise hang until the test runner's own
        // timeout, which is much longer).
        timeout: 10_000,
      },
    );

    assert.notEqual(
      result.signal,
      "SIGTERM",
      "subprocess must not be killed by timeout — that would mean the prompt is back",
    );
    assert.equal(result.status, 1, "exits 1 on the bogus --tool error after cleanup");

    const stderr = result.stderr ?? "";
    // The auto-cleanup warning must appear on stderr with tool/sessionId.
    assert.match(
      stderr,
      /prepsavant: removed stale hooks from previous session/,
      "stderr carries the cleanup warning",
    );
    assert.match(stderr, /tool=claude_code/, "warning carries the tool id from the marker");
    assert.match(
      stderr,
      /sessionId=sess_crashed_run/,
      "warning carries the sessionId from the marker",
    );
    // And the JSON error from the bogus --tool flag must also be on stderr,
    // proving control-flow proceeded past the stale-hook block.
    assert.match(stderr, /Unknown --tool value/, "bogus tool error surfaces after cleanup");

    // The marker file must actually be removed from disk.
    assert.equal(
      fs.existsSync(markerPath),
      false,
      "stale hook marker is removed by the auto-cleanup",
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
