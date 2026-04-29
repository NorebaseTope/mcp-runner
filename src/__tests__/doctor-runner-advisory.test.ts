// Unit tests for the runner-side "update available" advisory rendered at
// the bottom of `prepsavant doctor` output. (task-464)
//
// What we lock in:
//   1. Returns null when the install is current — `prepsavant doctor`
//      shouldn't nudge users who are already running the latest version.
//   2. Returns null on unparseable inputs — first-time runs against a
//      misbehaving server should not crash or print scary copy.
//   3. When outdated, the rendered text mirrors the dashboard advisory
//      copy from artifacts/api-server/src/routes/setup.ts so the user gets
//      a consistent message across surfaces.

import test from "node:test";
import assert from "node:assert/strict";
import { formatRunnerUpdateAdvisory } from "../doctor.js";

test("formatRunnerUpdateAdvisory: returns null when installed == latest", () => {
  assert.equal(formatRunnerUpdateAdvisory("0.4.0", "0.4.0"), null);
});

test("formatRunnerUpdateAdvisory: returns null when installed is newer than latest", () => {
  // Local dev builds may be ahead of the published version while we're
  // staging a release — never nag in that case.
  assert.equal(formatRunnerUpdateAdvisory("1.0.0", "0.4.0"), null);
});

test("formatRunnerUpdateAdvisory: returns null on unparseable versions", () => {
  // Missing / malformed inputs should silently degrade — the doctor command
  // already treats version-check failures as non-fatal.
  assert.equal(formatRunnerUpdateAdvisory("", "0.4.0"), null);
  assert.equal(formatRunnerUpdateAdvisory("0.4.0", "not-a-version"), null);
});

test("formatRunnerUpdateAdvisory: renders the dashboard-equivalent advisory when outdated", () => {
  const out = formatRunnerUpdateAdvisory("0.3.0", "0.4.0");
  assert.ok(out, "expected an advisory string when installed < latest");
  assert.match(out, /Runner update available/);
  // Both versions appear and are prefixed with `v` to match the dashboard
  // copy in artifacts/api-server/src/routes/setup.ts.
  assert.match(out, /v0\.3\.0 installed/);
  assert.match(out, /v0\.4\.0 available/);
  // Includes the same fix command the dashboard surfaces so the CLI nudge
  // and the dashboard nudge resolve to the same action.
  assert.match(out, /npx -y @prepsavant\/mcp install/);
  // Wording matches the dashboard advisory verbatim — see setup.ts.
  assert.match(
    out,
    /v0\.3\.0 installed; v0\.4\.0 available — re-run the install command to update\./,
  );
});

test("formatRunnerUpdateAdvisory: handles minor and patch bumps", () => {
  // Minor bump
  assert.ok(formatRunnerUpdateAdvisory("0.4.0", "0.5.0"));
  // Patch bump
  assert.ok(formatRunnerUpdateAdvisory("0.4.0", "0.4.1"));
  // Major bump
  assert.ok(formatRunnerUpdateAdvisory("0.4.0", "1.0.0"));
});
