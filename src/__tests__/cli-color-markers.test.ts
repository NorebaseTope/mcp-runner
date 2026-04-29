// Unit tests for the runner CLI's shared color helpers: colorSuccess,
// colorWarning, and colorError. These wrap status markers (✓, !, Error:)
// in ANSI escape codes when color is enabled, and pass text through
// unchanged when color is disabled, mirroring the hook-channels line tests.

import test from "node:test";
import assert from "node:assert/strict";
import { colorSuccess, colorWarning, colorError } from "../ai-assisted/cli-start.js";

const ANSI_GREEN = "\x1b[32m";
const ANSI_YELLOW = "\x1b[33m";
const ANSI_RED = "\x1b[31m";
const ANSI_RESET = "\x1b[0m";
const ANSI_RE = /\x1b\[[0-9;]*m/;

// ---------------------------------------------------------------------------
// colorSuccess
// ---------------------------------------------------------------------------

test("colorSuccess: color off → returns text unchanged", () => {
  assert.equal(colorSuccess("✓", false), "✓");
  assert.equal(colorSuccess("✓ Session started", false), "✓ Session started");
});

test("colorSuccess: color off → no ANSI codes in output", () => {
  assert.equal(ANSI_RE.test(colorSuccess("✓", false)), false);
});

test("colorSuccess: color on → wraps text in green ANSI codes", () => {
  const out = colorSuccess("✓", true);
  assert.equal(out, `${ANSI_GREEN}✓${ANSI_RESET}`);
});

test("colorSuccess: color on → output includes ANSI green opener and reset", () => {
  const out = colorSuccess("✓ Stale hooks removed", true);
  assert.ok(out.startsWith(ANSI_GREEN), "should start with green ANSI code");
  assert.ok(out.endsWith(ANSI_RESET), "should end with ANSI reset");
  assert.ok(out.includes("✓ Stale hooks removed"), "should preserve the text");
});

test("colorSuccess: color on → no yellow or red ANSI codes", () => {
  const out = colorSuccess("✓", true);
  assert.equal(out.includes(ANSI_YELLOW), false);
  assert.equal(out.includes(ANSI_RED), false);
});

test("colorSuccess: every ANSI opener is paired with a reset", () => {
  const out = colorSuccess("✓", true);
  const opens = (out.match(new RegExp(ANSI_GREEN.replace(/\[/, "\\["), "g")) ?? []).length;
  const resets = (out.match(new RegExp(ANSI_RESET.replace(/\[/, "\\["), "g")) ?? []).length;
  assert.equal(opens, 1);
  assert.equal(resets, 1);
});

// ---------------------------------------------------------------------------
// colorWarning
// ---------------------------------------------------------------------------

test("colorWarning: color off → returns text unchanged", () => {
  assert.equal(colorWarning("!", false), "!");
  assert.equal(colorWarning("! Snapshot store is not writable", false), "! Snapshot store is not writable");
});

test("colorWarning: color off → no ANSI codes in output", () => {
  assert.equal(ANSI_RE.test(colorWarning("!", false)), false);
});

test("colorWarning: color on → wraps text in yellow ANSI codes", () => {
  const out = colorWarning("!", true);
  assert.equal(out, `${ANSI_YELLOW}!${ANSI_RESET}`);
});

test("colorWarning: color on → output includes ANSI yellow opener and reset", () => {
  const out = colorWarning("! Cursor is below minimum version", true);
  assert.ok(out.startsWith(ANSI_YELLOW), "should start with yellow ANSI code");
  assert.ok(out.endsWith(ANSI_RESET), "should end with ANSI reset");
  assert.ok(out.includes("! Cursor is below minimum version"), "should preserve the text");
});

test("colorWarning: color on → no green or red ANSI codes", () => {
  const out = colorWarning("!", true);
  assert.equal(out.includes(ANSI_GREEN), false);
  assert.equal(out.includes(ANSI_RED), false);
});

test("colorWarning: every ANSI opener is paired with a reset", () => {
  const out = colorWarning("!", true);
  const opens = (out.match(new RegExp(ANSI_YELLOW.replace(/\[/, "\\["), "g")) ?? []).length;
  const resets = (out.match(new RegExp(ANSI_RESET.replace(/\[/, "\\["), "g")) ?? []).length;
  assert.equal(opens, 1);
  assert.equal(resets, 1);
});

// ---------------------------------------------------------------------------
// colorError
// ---------------------------------------------------------------------------

test("colorError: color off → returns text unchanged", () => {
  assert.equal(colorError("Error:", false), "Error:");
  assert.equal(colorError("! Failed to finalize session", false), "! Failed to finalize session");
});

test("colorError: color off → no ANSI codes in output", () => {
  assert.equal(ANSI_RE.test(colorError("Error:", false)), false);
});

test("colorError: color on → wraps text in red ANSI codes", () => {
  const out = colorError("Error:", true);
  assert.equal(out, `${ANSI_RED}Error:${ANSI_RESET}`);
});

test("colorError: color on → output includes ANSI red opener and reset", () => {
  const out = colorError("! Codex process error", true);
  assert.ok(out.startsWith(ANSI_RED), "should start with red ANSI code");
  assert.ok(out.endsWith(ANSI_RESET), "should end with ANSI reset");
  assert.ok(out.includes("! Codex process error"), "should preserve the text");
});

test("colorError: color on → no green or yellow ANSI codes", () => {
  const out = colorError("Error:", true);
  assert.equal(out.includes(ANSI_GREEN), false);
  assert.equal(out.includes(ANSI_YELLOW), false);
});

test("colorError: every ANSI opener is paired with a reset", () => {
  const out = colorError("Error:", true);
  const opens = (out.match(new RegExp(ANSI_RED.replace(/\[/, "\\["), "g")) ?? []).length;
  const resets = (out.match(new RegExp(ANSI_RESET.replace(/\[/, "\\["), "g")) ?? []).length;
  assert.equal(opens, 1);
  assert.equal(resets, 1);
});

// ---------------------------------------------------------------------------
// Default TTY / NO_COLOR gating (shared shouldUseColor logic)
// ---------------------------------------------------------------------------

test("colorSuccess: NO_COLOR env var disables color even when TTY", () => {
  const prevIsTTY = process.stdout.isTTY;
  const prevNoColor = process.env.NO_COLOR;
  try {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    process.env.NO_COLOR = "1";
    assert.equal(ANSI_RE.test(colorSuccess("✓")), false);
  } finally {
    Object.defineProperty(process.stdout, "isTTY", { value: prevIsTTY, configurable: true });
    if (prevNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = prevNoColor;
  }
});

test("colorWarning: NO_COLOR env var disables color even when TTY", () => {
  const prevIsTTY = process.stdout.isTTY;
  const prevNoColor = process.env.NO_COLOR;
  try {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    process.env.NO_COLOR = "1";
    assert.equal(ANSI_RE.test(colorWarning("!")), false);
  } finally {
    Object.defineProperty(process.stdout, "isTTY", { value: prevIsTTY, configurable: true });
    if (prevNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = prevNoColor;
  }
});

test("colorError: NO_COLOR env var disables color even when TTY", () => {
  const prevIsTTY = process.stdout.isTTY;
  const prevNoColor = process.env.NO_COLOR;
  try {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    process.env.NO_COLOR = "1";
    assert.equal(ANSI_RE.test(colorError("Error:")), false);
  } finally {
    Object.defineProperty(process.stdout, "isTTY", { value: prevIsTTY, configurable: true });
    if (prevNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = prevNoColor;
  }
});

test("colorSuccess: default uses color when stdout is a TTY and NO_COLOR is unset", () => {
  const prevIsTTY = process.stdout.isTTY;
  const prevNoColor = process.env.NO_COLOR;
  try {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    delete process.env.NO_COLOR;
    assert.ok(ANSI_RE.test(colorSuccess("✓")), "expected ANSI codes when TTY and no NO_COLOR");
  } finally {
    Object.defineProperty(process.stdout, "isTTY", { value: prevIsTTY, configurable: true });
    if (prevNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = prevNoColor;
  }
});

test("colorWarning: default stays plain when stdout is not a TTY (piped)", () => {
  const prevIsTTY = process.stdout.isTTY;
  const prevNoColor = process.env.NO_COLOR;
  try {
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    delete process.env.NO_COLOR;
    assert.equal(ANSI_RE.test(colorWarning("!")), false);
  } finally {
    Object.defineProperty(process.stdout, "isTTY", { value: prevIsTTY, configurable: true });
    if (prevNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = prevNoColor;
  }
});

test("colorError: default stays plain when stdout is not a TTY (piped)", () => {
  const prevIsTTY = process.stdout.isTTY;
  const prevNoColor = process.env.NO_COLOR;
  try {
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    delete process.env.NO_COLOR;
    assert.equal(ANSI_RE.test(colorError("Error:")), false);
  } finally {
    Object.defineProperty(process.stdout, "isTTY", { value: prevIsTTY, configurable: true });
    if (prevNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = prevNoColor;
  }
});
