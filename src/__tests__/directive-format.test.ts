// Unit tests for the runner-side directive format and persona-cache constants.
// Verifies that the JSON format emitted by practice_check_in / formatDirective
// is parseable and contains the required contract fields.

import test from "node:test";
import assert from "node:assert/strict";
import { DIRECTIVE_FALLBACK, type DirectiveAction } from "../persona-cache.js";
import type { CheckInDirective } from "../api.js";

// ---------------------------------------------------------------------------
// DIRECTIVE_FALLBACK completeness
// ---------------------------------------------------------------------------

const EXPECTED_NON_QUIET_ACTIONS: Exclude<DirectiveAction, "stay_quiet">[] = [
  "probe",
  "hint_offer",
  "time_warning",
  "wrap_up",
];

for (const action of EXPECTED_NON_QUIET_ACTIONS) {
  test(`DIRECTIVE_FALLBACK has a non-empty entry for "${action}"`, () => {
    const line = DIRECTIVE_FALLBACK[action];
    assert.ok(line, `${action} fallback should be truthy`);
    assert.ok(line.length > 0, `${action} fallback should not be empty`);
  });
}

// ---------------------------------------------------------------------------
// Directive JSON roundtrip
// ---------------------------------------------------------------------------

// Simulate what practice_check_in serializes — strict verbatim pass-through.
// samVoiceLine is passed as-is from the server directive (no fallback in this
// path). Hosts may substitute their own phrasing when samVoiceLine is null.
function serializeDirective(d: CheckInDirective): string {
  const samVoiceLine = d.samVoiceLine ?? null;
  const payload: Record<string, unknown> = {
    action: d.action,
    samVoiceLine,
    reason: d.reason,
  };
  if (d.timeMilestone != null) {
    payload["timeMilestone"] = d.timeMilestone;
  }
  return JSON.stringify(payload);
}

test("directive JSON is parseable and has required fields — probe", () => {
  const d: CheckInDirective = {
    action: "probe",
    samVoiceLine: "Walk me through the last thing you tried.",
    reason: "idle for 7 min",
    timeMilestone: null,
  };
  const json = serializeDirective(d);
  const parsed = JSON.parse(json) as Record<string, unknown>;
  assert.equal(parsed["action"], "probe");
  assert.equal(typeof parsed["samVoiceLine"], "string");
  assert.equal(typeof parsed["reason"], "string");
  assert.ok(!("timeMilestone" in parsed), "timeMilestone must be omitted for probe");
});

test("directive JSON includes timeMilestone for time_warning", () => {
  const d: CheckInDirective = {
    action: "time_warning",
    samVoiceLine: "Check your time.",
    reason: "session at 75% (warning)",
    timeMilestone: "warning",
  };
  const json = serializeDirective(d);
  const parsed = JSON.parse(json) as Record<string, unknown>;
  assert.equal(parsed["action"], "time_warning");
  assert.equal(parsed["timeMilestone"], "warning");
});

test("directive JSON includes timeMilestone=over_time for wrap_up", () => {
  const d: CheckInDirective = {
    action: "wrap_up",
    samVoiceLine: "Time is up.",
    reason: "session at 100%",
    timeMilestone: "over_time",
  };
  const json = serializeDirective(d);
  const parsed = JSON.parse(json) as Record<string, unknown>;
  assert.equal(parsed["action"], "wrap_up");
  assert.equal(parsed["timeMilestone"], "over_time");
});

test("practice_check_in verbatim pass-through for stay_quiet", () => {
  const d: CheckInDirective = {
    action: "stay_quiet",
    samVoiceLine: null,
    reason: "no action needed",
    timeMilestone: null,
  };
  const json = serializeDirective(d);
  const parsed = JSON.parse(json) as Record<string, unknown>;
  assert.equal(parsed["action"], "stay_quiet");
  assert.equal(parsed["samVoiceLine"], null, "samVoiceLine must be null for stay_quiet");
  assert.equal(typeof parsed["reason"], "string");
  assert.ok(!("timeMilestone" in parsed), "timeMilestone must be omitted when null");
});

// ---------------------------------------------------------------------------
// nextAction JSON block format (as appended to attempt/hint responses)
// ---------------------------------------------------------------------------

function formatDirective(d: CheckInDirective | null | undefined): string {
  if (!d || d.action === "stay_quiet") return "";
  const samVoiceLine = d.samVoiceLine ?? DIRECTIVE_FALLBACK[d.action];
  const payload: Record<string, unknown> = {
    action: d.action,
    samVoiceLine,
    reason: d.reason,
  };
  if (d.timeMilestone != null) {
    payload["timeMilestone"] = d.timeMilestone;
  }
  return `\nnextAction: ${JSON.stringify(payload)}`;
}

test("formatDirective returns empty string for stay_quiet", () => {
  const result = formatDirective({
    action: "stay_quiet",
    samVoiceLine: null,
    reason: "no action needed",
    timeMilestone: null,
  });
  assert.equal(result, "");
});

test("formatDirective returns empty string for null", () => {
  assert.equal(formatDirective(null), "");
});

test("formatDirective emits nextAction JSON block for active directive", () => {
  const d: CheckInDirective = {
    action: "hint_offer",
    samVoiceLine: "I have a hint ready.",
    reason: "3 consecutive failures",
    timeMilestone: null,
  };
  const result = formatDirective(d);
  assert.ok(result.startsWith("\nnextAction: "), "must start with nextAction prefix");
  const jsonPart = result.replace("\nnextAction: ", "");
  const parsed = JSON.parse(jsonPart) as Record<string, unknown>;
  assert.equal(parsed["action"], "hint_offer");
  assert.equal(parsed["samVoiceLine"], "I have a hint ready.");
  assert.ok(!("timeMilestone" in parsed), "timeMilestone must be omitted when null");
});

test("formatDirective includes timeMilestone in JSON block for time_warning", () => {
  const d: CheckInDirective = {
    action: "time_warning",
    samVoiceLine: "Check your time.",
    reason: "50%",
    timeMilestone: "midway",
  };
  const result = formatDirective(d);
  const jsonPart = result.replace("\nnextAction: ", "");
  const parsed = JSON.parse(jsonPart) as Record<string, unknown>;
  assert.equal(parsed["timeMilestone"], "midway");
});

test("formatDirective uses DIRECTIVE_FALLBACK when samVoiceLine is null", () => {
  const d: CheckInDirective = {
    action: "probe",
    samVoiceLine: null,
    reason: "idle",
    timeMilestone: null,
  };
  const result = formatDirective(d);
  const jsonPart = result.replace("\nnextAction: ", "");
  const parsed = JSON.parse(jsonPart) as Record<string, unknown>;
  assert.equal(parsed["samVoiceLine"], DIRECTIVE_FALLBACK["probe"]);
});
