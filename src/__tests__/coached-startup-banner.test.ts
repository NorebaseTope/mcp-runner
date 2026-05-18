// Task #1507 — focused tests for the polished coached startup
// banner: (a) the full markdown brief is no longer dumped — the
// banner points the user at `<packRoot>/PROBLEM.md` plus a short
// summary; (b) the CURSOR_API_KEY tip is conditional and
// informative, sourced from the SAM_VOICE `cursor_api_key_tip`
// payload the runner fetches at session start.

import test from "node:test";
import assert from "node:assert/strict";

import { makeColors } from "../cli-ui/index.js";
import { renderStartupBanner } from "../coached/startup-banner.js";

const SAMPLE_BRIEF = [
  "# Two Sum",
  "",
  "Given an array of integers, return indices of the two numbers that add up to a specific target.",
  "",
  "Example: nums=[2,7,11,15], target=9 -> [0,1]",
  "",
  "HOST INSTRUCTIONS (coached mode — follow exactly):",
  "1. Call coached_record_turn after every user message.",
].join("\n");

const SAMPLE_API_KEY_TIP = [
  "**Optional — persistent multi-turn context for the runner**",
  "- Without a `CURSOR_API_KEY`, the runner shells out per turn.",
  "- Get a key at https://cursor.com/dashboard → Settings → API Keys.",
  "- macOS / Linux (zsh): `echo 'export CURSOR_API_KEY=sk-...' >> ~/.zshrc`",
  "- Windows (PowerShell, persistent): `setx CURSOR_API_KEY \"sk-...\"`",
].join("\n");

test("Task #1507 — banner points at <packRoot>/PROBLEM.md instead of dumping the full brief", () => {
  const out = renderStartupBanner(
    {
      adapterVersion: "9.9.9-test",
      sessionId: "sess_t1507_pointer",
      packRoot: "/tmp/prepsavant-pack-abc",
      scratchRelPath: "scaffolding/python/solution.py",
      kickoffBrief: SAMPLE_BRIEF,
      questionTitle: "Two Sum",
    },
    makeColors({ isTTY: false }),
  );
  // File path is the headline — must appear verbatim.
  assert.match(out, /Full statement: /);
  assert.ok(
    out.includes("/tmp/prepsavant-pack-abc/PROBLEM.md"),
    "banner must point at the on-disk PROBLEM.md inside the unzipped package",
  );
  // Question title is rendered, short preview is rendered.
  assert.match(out, /Two Sum/);
  assert.match(out, /return indices of the two numbers/);
  // Full markdown body is NOT dumped — host instructions and the
  // separator/heading chrome from the previous banner are both gone.
  assert.ok(
    !out.includes("HOST INSTRUCTIONS"),
    "banner must strip HOST INSTRUCTIONS prose from the brief",
  );
  assert.ok(
    !out.includes("Kickoff brief"),
    "banner must drop the old `── Kickoff brief ──` header so the file pointer is what the user sees",
  );
});

test("Task #1507 — banner omits the CURSOR_API_KEY tip when the persistent agent is in use", () => {
  const out = renderStartupBanner(
    {
      adapterVersion: "9.9.9-test",
      sessionId: "sess_t1507_keyset",
      packRoot: "/tmp/pack",
      scratchRelPath: null,
      kickoffBrief: SAMPLE_BRIEF,
      questionTitle: "Two Sum",
      usingPersistentAgent: true,
      cursorApiKeyTip: SAMPLE_API_KEY_TIP,
    },
    makeColors({ isTTY: false }),
  );
  assert.ok(
    !out.includes("CURSOR_API_KEY"),
    "tip block must be suppressed when usingPersistentAgent === true",
  );
  assert.ok(
    !out.includes("Optional setup"),
    "no 'Optional setup' heading when the tip is suppressed",
  );
});

test("Task #1507 — banner renders the informative CURSOR_API_KEY tip when on the shell-out adapter and tip text is supplied", () => {
  const out = renderStartupBanner(
    {
      adapterVersion: "9.9.9-test",
      sessionId: "sess_t1507_keymissing",
      packRoot: "/tmp/pack",
      scratchRelPath: null,
      kickoffBrief: SAMPLE_BRIEF,
      questionTitle: "Two Sum",
      usingPersistentAgent: false,
      cursorApiKeyTip: SAMPLE_API_KEY_TIP,
    },
    makeColors({ isTTY: false }),
  );
  assert.match(out, /Optional setup/);
  assert.match(out, /CURSOR_API_KEY/);
  // Informative content survives — both the where-to-get-key URL and
  // platform-specific persistent-set commands must be reachable from
  // the terminal, not just the dashboard.
  assert.match(out, /cursor\.com\/dashboard/);
  assert.match(out, /\.zshrc/);
  assert.match(out, /setx CURSOR_API_KEY/);
});

test("Task #1507 — banner falls back to a one-line hint when tip fetch failed (cursorApiKeyTip is null)", () => {
  const out = renderStartupBanner(
    {
      adapterVersion: "9.9.9-test",
      sessionId: "sess_t1507_tipfail",
      packRoot: "/tmp/pack",
      scratchRelPath: null,
      kickoffBrief: SAMPLE_BRIEF,
      questionTitle: "Two Sum",
      usingPersistentAgent: false,
      cursorApiKeyTip: null,
    },
    makeColors({ isTTY: false }),
  );
  // Even without the rich tip, the user still gets the env-var name
  // and a pointer to the dashboard so the hint is actionable.
  assert.match(out, /Optional setup/);
  assert.match(out, /CURSOR_API_KEY/);
  assert.match(out, /cursor\.com\/dashboard/);
});
