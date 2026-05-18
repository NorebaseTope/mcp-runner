// Task #1399 — focused tests for the AI-Assisted polish work. Mirrors
// the contracts already locked down for the coached banner (Task #1390):
//
//   (a) HOST INSTRUCTIONS prose is stripped from the user-facing
//       render (the original payload is untouched);
//   (b) no ANSI escape codes when NO_COLOR=1 or stdout is not a TTY
//       (CI / piping to a file → plain text);
//   (c) the banner contains the three obvious-at-a-glance signals:
//       "session started", a "Next steps" header, and a "session
//       live" footer pointing at the cursor-export upload path;
//   (d) the `ai_assisted_start_session` MCP tool registration in
//       server.ts uses the renderer (and no longer hand-rolls a
//       HOST INSTRUCTIONS list in the response body);
//   (e) the cli.ts AI-Assisted exit path goes through `--json`
//       guard before invoking the colored banner so machine-readable
//       output stays a single ANSI-free line.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { makeColors } from "../cli-ui/index.js";
import { renderAiAssistedStartupBanner } from "../cli-ui/ai-assisted-banner.js";

const SAMPLE_PROMPT = [
  "# Two Sum",
  "",
  "Given an array of integers, return indices of the two numbers…",
  "",
  "Example I/O: nums=[2,7,11,15], target=9 -> [0,1]",
  "",
  "HOST INSTRUCTIONS (AI-Assisted mode — follow exactly):",
  "1. The candidate WANTS you to write, edit, and run code.",
  "2. Drive the coaching split loop via ai_assisted_get_context.",
].join("\n");

const ANSI_ESCAPE_RE = /\u001b\[/;

// Task #1499 — mirrors the SAM_VOICE `practice_ai_assisted_guide`
// payload shape: bold section headers + dash bullets, separated by
// blank lines. We don't import the live registry here so the runner
// suite stays decoupled from the api-server package boundary.
const SAMPLE_AI_GUIDE = [
  "**How to start**",
  "- Unzip the package and `cd` in.",
  "",
  "**How to end — export your Cursor chat into this folder**",
  "- In Cursor: Cmd/Ctrl+Shift+P → \"Cursor Chat: Export\".",
  "- Run `prepsavant upload-cursor-export` from the same folder.",
].join("\n");

test("Task #1499 — banner injects the practice_ai_assisted_guide section between Next steps and the question brief", () => {
  const out = renderAiAssistedStartupBanner(
    {
      adapterVersion: "9.9.9-test",
      sessionId: "sess_t1499_guide",
      questionTitle: "Two Sum",
      questionPrompt: SAMPLE_PROMPT,
      instructionGuide: SAMPLE_AI_GUIDE,
    },
    makeColors({ isTTY: false }),
  );
  assert.match(out, /How this session works/);
  assert.match(out, /How to end — export your Cursor chat into this folder/);
  // Folder-scoped export instruction (the whole point of the task)
  // must appear verbatim in the terminal banner.
  assert.match(out, /prepsavant upload-cursor-export/);
  // Ordering: guide → Session notes → Question block. (Task #1499
  // dropped the hand-rolled "Next steps" body in favour of the
  // server-rendered guide so the page and terminal can't drift.)
  const idxGuide = out.indexOf("How this session works");
  const idxNotes = out.indexOf("Session notes");
  const idxQ = out.indexOf("── Question");
  assert.ok(
    idxGuide < idxNotes && idxNotes < idxQ,
    "ordering must be guide → Session notes → Question",
  );
});

test("Task #1499 — banner omits the guide section when instructionGuide is null/empty", () => {
  const out = renderAiAssistedStartupBanner(
    {
      adapterVersion: "9.9.9-test",
      sessionId: "sess_t1499_noguide",
      questionTitle: "Two Sum",
      questionPrompt: SAMPLE_PROMPT,
      instructionGuide: null,
    },
    makeColors({ isTTY: false }),
  );
  assert.doesNotMatch(out, /How this session works/);
});

test("Task #1399 — renderAiAssistedStartupBanner strips HOST INSTRUCTIONS", () => {
  const colors = makeColors({ isTTY: false }, {});
  const out = renderAiAssistedStartupBanner(
    {
      adapterVersion: "9.9.9",
      sessionId: "ses_t1399_strip",
      questionTitle: "Two Sum",
      questionPrompt: SAMPLE_PROMPT,
    },
    colors,
  );
  assert.ok(!out.includes("HOST INSTRUCTIONS"));
  assert.ok(!out.includes("split loop via ai_assisted_get_context"));
  // Pre-host content survives.
  assert.ok(out.includes("Two Sum"));
  assert.ok(out.includes("Example I/O"));
});

test("Task #1399 — renderAiAssistedStartupBanner emits no ANSI under NO_COLOR=1", () => {
  const colors = makeColors({ isTTY: true }, { NO_COLOR: "1" });
  const out = renderAiAssistedStartupBanner(
    {
      adapterVersion: "9.9.9",
      sessionId: "ses_t1399_no_color",
      questionTitle: "Two Sum",
      questionPrompt: SAMPLE_PROMPT,
    },
    colors,
  );
  assert.ok(!ANSI_ESCAPE_RE.test(out), "no ANSI escapes when NO_COLOR=1");
});

test("Task #1399 — renderAiAssistedStartupBanner emits no ANSI when stdout is not a TTY", () => {
  const colors = makeColors({ isTTY: false }, {});
  const out = renderAiAssistedStartupBanner(
    {
      adapterVersion: "9.9.9",
      sessionId: "ses_t1399_non_tty",
      questionTitle: "Two Sum",
      questionPrompt: SAMPLE_PROMPT,
    },
    colors,
  );
  assert.ok(!ANSI_ESCAPE_RE.test(out));
});

test("Task #1399 — renderAiAssistedStartupBanner emits ANSI on a TTY (positive control)", () => {
  const colors = makeColors({ isTTY: true }, {});
  const out = renderAiAssistedStartupBanner(
    {
      adapterVersion: "9.9.9",
      sessionId: "ses_t1399_color",
      questionTitle: "Two Sum",
      questionPrompt: SAMPLE_PROMPT,
    },
    colors,
  );
  assert.ok(
    ANSI_ESCAPE_RE.test(out),
    "ANSI escapes must be present on a TTY without NO_COLOR",
  );
});

test("Task #1399 — banner surfaces success / next-steps / live footer signals", () => {
  const colors = makeColors({ isTTY: false }, {});
  const out = renderAiAssistedStartupBanner(
    {
      adapterVersion: "9.9.9",
      sessionId: "ses_t1399_signals",
      questionTitle: "Two Sum",
      questionPrompt: SAMPLE_PROMPT,
      targetDurationMinutes: 45,
    },
    colors,
  );
  assert.match(out, /AI-Assisted session started/);
  assert.ok(out.includes("ses_t1399_signals"));
  assert.ok(out.includes("9.9.9"));
  // Task #1499 — banner header for the runtime-conditional notes
  // block (the previous hardcoded "Next steps" body moved into the
  // SAM_VOICE guide and is no longer rendered when no
  // instructionGuide is supplied).
  assert.match(out, /Session notes/);
  assert.match(out, /session live/);
  // Timer line is the only per-session content that stays in code,
  // because the SAM_VOICE guide can't know the question's duration.
  assert.match(out, /Timer: .*45 min/);
  // Question body survives, host directives don't.
  assert.ok(out.includes("Two Sum"));
  assert.ok(!out.includes("HOST INSTRUCTIONS"));
});

test("Task #1399 — banner omits the timer line when no targetDurationMinutes", () => {
  const colors = makeColors({ isTTY: false }, {});
  const out = renderAiAssistedStartupBanner(
    {
      adapterVersion: "9.9.9",
      sessionId: "ses_t1399_open_ended",
      questionTitle: "Two Sum",
      questionPrompt: "Just the body.",
    },
    colors,
  );
  // Task #1499 — without a duration, the timer line says
  // "No fixed timer" (capital N matches the new Session-notes block).
  assert.ok(!/\d+ min/.test(out), "no minute-count line when no duration");
  assert.match(out, /No fixed timer/);
});

test("Task #1399 — banner falls back gracefully when prompt is empty", () => {
  const colors = makeColors({ isTTY: false }, {});
  const out = renderAiAssistedStartupBanner(
    {
      adapterVersion: "9.9.9",
      sessionId: "ses_t1399_empty",
      questionTitle: "Untitled",
      questionPrompt: "",
    },
    colors,
  );
  assert.match(out, /no question prompt returned/);
});

test("Task #1399 — server.ts ai_assisted_start_session uses the renderer and drops HOST INSTRUCTIONS prose", () => {
  // Static-analysis lock-in: a future refactor that re-introduces the
  // HOST INSTRUCTIONS list in the tool response body should trip this
  // test immediately.
  const here = dirname(fileURLToPath(import.meta.url));
  const serverPath = resolve(here, "..", "server.ts");
  const src = readFileSync(serverPath, "utf-8");
  const re =
    /registerTool\(\s*"ai_assisted_start_session"[\s\S]*?\n  \);/m;
  const m = src.match(re);
  assert.ok(m, "expected ai_assisted_start_session registerTool block");
  const block = m[0];
  assert.match(
    block,
    /renderAiAssistedStartupBanner\(/,
    "ai_assisted_start_session must call renderAiAssistedStartupBanner",
  );
  assert.ok(
    !/HOST INSTRUCTIONS \(AI-Assisted mode/.test(block),
    "ai_assisted_start_session response body must not hand-roll the HOST INSTRUCTIONS list — it's stripped from the user-facing render and conveyed to the host via IDE rules + ai_assisted_get_context",
  );
});

test("Task #1399 — cli.ts AI-Assisted exit path renders the colored banner only on the non-JSON branch", () => {
  // Same shape as the coached banner JSON-guard lock-in
  // (coached-startup-banner.test.ts): require the JSON branch to
  // appear before the makeColors invocation so a future refactor
  // that accidentally moves the colored output above the guard
  // breaks --json output for scripts/CI.
  const here = dirname(fileURLToPath(import.meta.url));
  const cliPath = resolve(here, "..", "cli.ts");
  const src = readFileSync(cliPath, "utf-8");
  const jsonGuardIdx = src.indexOf('"ai_assisted_cli_retired"');
  const colorsIdx = src.indexOf('makeColors(process.stderr)');
  assert.ok(jsonGuardIdx > -1, "expected JSON-mode guard for AI-Assisted exit path");
  assert.ok(colorsIdx > -1, "expected makeColors invocation in AI-Assisted exit path");
  assert.ok(
    colorsIdx > jsonGuardIdx,
    "makeColors must sit AFTER the `if (flags.json)` guard so --json output stays a single ANSI-free machine-readable line",
  );
});
