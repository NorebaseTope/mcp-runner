// Unit tests for the runner CLI's "Hook channels" status line.
// The line is rendered for beta tools (Cursor / Codex) where partial hook
// coverage is expected and users need a quick at-a-glance view of which
// channels are firing.

import test from "node:test";
import assert from "node:assert/strict";
import { formatHookChannelsLine } from "../ai-assisted/cli-start.js";
import type { AiAssistedHookHealth } from "../api.js";

function emptyHealth(): AiAssistedHookHealth {
  return {
    prompt: { fired: false, eventCount: 0 },
    response: { fired: false, eventCount: 0 },
    edit: { fired: false, eventCount: 0 },
    shell: { fired: false, eventCount: 0 },
  };
}

test("formatHookChannelsLine: all channels pending shows ? for each", () => {
  const line = formatHookChannelsLine(emptyHealth());
  assert.match(line, /Hook channels:/);
  assert.match(line, /\? prompt/);
  assert.match(line, /\? response/);
  assert.match(line, /\? edit/);
  assert.match(line, /\? shell/);
  // No ✓ markers when nothing has fired.
  assert.equal(line.includes("✓"), false);
});

test("formatHookChannelsLine: fired channels show ✓, pending channels show ?", () => {
  const health: AiAssistedHookHealth = {
    prompt: { fired: true, eventCount: 3, lastEventAt: "2026-01-01T00:00:00Z" },
    response: { fired: true, eventCount: 2 },
    edit: { fired: false, eventCount: 0 },
    shell: { fired: true, eventCount: 1 },
  };
  const line = formatHookChannelsLine(health);
  assert.match(line, /✓ prompt/);
  assert.match(line, /✓ response/);
  assert.match(line, /\? edit/);
  assert.match(line, /✓ shell/);
});

test("formatHookChannelsLine: channel order is prompt, response, edit, shell", () => {
  const line = formatHookChannelsLine(emptyHealth());
  const promptIdx = line.indexOf("prompt");
  const responseIdx = line.indexOf("response");
  const editIdx = line.indexOf("edit");
  const shellIdx = line.indexOf("shell");
  assert.ok(promptIdx >= 0 && responseIdx > promptIdx);
  assert.ok(editIdx > responseIdx);
  assert.ok(shellIdx > editIdx);
});

test("formatHookChannelsLine: line is single-line (no embedded newlines)", () => {
  const line = formatHookChannelsLine(emptyHealth());
  assert.equal(line.includes("\n"), false);
});

test("formatHookChannelsLine: stable output for same input (used to dedupe re-prints)", () => {
  const a = formatHookChannelsLine(emptyHealth());
  const b = formatHookChannelsLine(emptyHealth());
  assert.equal(a, b);
});

test("formatHookChannelsLine: line changes when a channel transitions to fired", () => {
  const before = formatHookChannelsLine(emptyHealth());
  const after = formatHookChannelsLine({
    ...emptyHealth(),
    edit: { fired: true, eventCount: 1 },
  });
  assert.notEqual(before, after);
});

// ---------------------------------------------------------------------------
// ANSI color rendering. Fired channels render in green (\x1b[32m); pending
// channels render in amber/yellow (\x1b[33m). Color is gated on a TTY check
// and the NO_COLOR env var convention so piping to a log file stays plain.
// ---------------------------------------------------------------------------

const ANSI_GREEN = "\x1b[32m";
const ANSI_YELLOW = "\x1b[33m";
const ANSI_RESET = "\x1b[0m";
const ANSI_RE = /\x1b\[[0-9;]*m/;

test("formatHookChannelsLine: color off → no ANSI escape codes in output", () => {
  const line = formatHookChannelsLine(emptyHealth(), false);
  assert.equal(ANSI_RE.test(line), false);
});

test("formatHookChannelsLine: color on → pending channels wrapped in yellow ANSI", () => {
  const line = formatHookChannelsLine(emptyHealth(), true);
  // Each of the four pending channels gets its own yellow+reset wrap.
  assert.ok(line.includes(`${ANSI_YELLOW}? prompt${ANSI_RESET}`));
  assert.ok(line.includes(`${ANSI_YELLOW}? response${ANSI_RESET}`));
  assert.ok(line.includes(`${ANSI_YELLOW}? edit${ANSI_RESET}`));
  assert.ok(line.includes(`${ANSI_YELLOW}? shell${ANSI_RESET}`));
  // No green wrappers when nothing has fired.
  assert.equal(line.includes(ANSI_GREEN), false);
});

test("formatHookChannelsLine: color on → fired channels wrapped in green ANSI", () => {
  const line = formatHookChannelsLine(
    {
      prompt: { fired: true, eventCount: 3 },
      response: { fired: true, eventCount: 1 },
      edit: { fired: false, eventCount: 0 },
      shell: { fired: true, eventCount: 2 },
    },
    true,
  );
  assert.ok(line.includes(`${ANSI_GREEN}✓ prompt${ANSI_RESET}`));
  assert.ok(line.includes(`${ANSI_GREEN}✓ response${ANSI_RESET}`));
  // The one pending channel stays yellow so it visually pops.
  assert.ok(line.includes(`${ANSI_YELLOW}? edit${ANSI_RESET}`));
  assert.ok(line.includes(`${ANSI_GREEN}✓ shell${ANSI_RESET}`));
});

test("formatHookChannelsLine: color on output is still single-line", () => {
  const line = formatHookChannelsLine(emptyHealth(), true);
  assert.equal(line.includes("\n"), false);
});

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) return count;
    count += 1;
    pos = idx + needle.length;
  }
}

test("formatHookChannelsLine: every ANSI open is paired with a reset", () => {
  const line = formatHookChannelsLine(
    {
      prompt: { fired: true, eventCount: 1 },
      response: { fired: false, eventCount: 0 },
      edit: { fired: true, eventCount: 1 },
      shell: { fired: false, eventCount: 0 },
    },
    true,
  );
  const opens =
    countOccurrences(line, ANSI_GREEN) + countOccurrences(line, ANSI_YELLOW);
  const resets = countOccurrences(line, ANSI_RESET);
  assert.equal(opens, 4);
  assert.equal(resets, 4);
});

test("formatHookChannelsLine: NO_COLOR env var disables color even when TTY", () => {
  // Simulate a TTY by stubbing process.stdout.isTTY, then set NO_COLOR.
  // The default-arg path inside formatHookChannelsLine should pick up both.
  const prevIsTTY = process.stdout.isTTY;
  const prevNoColor = process.env.NO_COLOR;
  try {
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
    });
    process.env.NO_COLOR = "1";
    const line = formatHookChannelsLine(emptyHealth());
    assert.equal(ANSI_RE.test(line), false);
  } finally {
    Object.defineProperty(process.stdout, "isTTY", {
      value: prevIsTTY,
      configurable: true,
    });
    if (prevNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = prevNoColor;
    }
  }
});

test("formatHookChannelsLine: default uses color when stdout is a TTY and NO_COLOR is unset", () => {
  const prevIsTTY = process.stdout.isTTY;
  const prevNoColor = process.env.NO_COLOR;
  try {
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
    });
    delete process.env.NO_COLOR;
    const line = formatHookChannelsLine(emptyHealth());
    assert.ok(ANSI_RE.test(line), "expected ANSI codes when TTY and no NO_COLOR");
  } finally {
    Object.defineProperty(process.stdout, "isTTY", {
      value: prevIsTTY,
      configurable: true,
    });
    if (prevNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = prevNoColor;
    }
  }
});

test("formatHookChannelsLine: default stays plain when stdout is not a TTY (piped)", () => {
  const prevIsTTY = process.stdout.isTTY;
  const prevNoColor = process.env.NO_COLOR;
  try {
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      configurable: true,
    });
    delete process.env.NO_COLOR;
    const line = formatHookChannelsLine(emptyHealth());
    assert.equal(ANSI_RE.test(line), false);
  } finally {
    Object.defineProperty(process.stdout, "isTTY", {
      value: prevIsTTY,
      configurable: true,
    });
    if (prevNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = prevNoColor;
    }
  }
});
