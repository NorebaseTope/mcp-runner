// Unit tests for the manifest.study_mode doctor check (task-531).
//
// The check is purely local: it inspects the on-disk runner config (token
// presence) and the detected host configs. We point HOME at a throwaway
// tempdir so the developer's real ~/.prepsavant config and any installed
// host configs can't influence the result.

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "prepsavant-doctor-study-"));
process.env["HOME"] = tmpHome;
process.env["USERPROFILE"] = tmpHome;
process.env["XDG_CONFIG_HOME"] = path.join(tmpHome, ".config");
process.env["LOCALAPPDATA"] = path.join(tmpHome, "AppData", "Local");
process.env["APPDATA"] = path.join(tmpHome, "AppData", "Roaming");

const { runDoctor, formatDoctor } = await import("../doctor.js");
const { writeConfig } = await import("../config.js");

function findStudyCheck(result: ReturnType<typeof runDoctor>) {
  return result.manifest.find((c) => c.id === "manifest.study_mode");
}

// Pull a rendered mode tile out of formatDoctor's preamble so tests can
// assert on its position (must appear above the [host] section) and on its
// hint copy. `tileLabel` matches against the literal label text in the
// tile (e.g. "Study mode", "Coached mode", "AI-Assisted mode"). Returns
// null when no matching tile line is found. Generalized in task-567 from
// the original `findStudyTileLine` helper so the same harness can cover
// every quickstart tile.
function findTileLine(rendered: string, tileLabel: string): string | null {
  const preamble = rendered.split("\n[host]")[0] ?? "";
  // Anchor on the " — " separator the renderer always emits between the
  // label and the hint so we don't accidentally match the section header
  // or any later mention of the same words.
  const needle = `${tileLabel} — `;
  for (const line of preamble.split("\n")) {
    if (line.includes(needle)) return line;
  }
  return null;
}

test("manifest.study_mode is warn when device token is missing", () => {
  // Throwaway HOME has no config file → readConfig returns no token.
  const result = runDoctor({ workspaceDir: tmpHome });
  const study = findStudyCheck(result);
  assert.ok(study, "study_mode check should always be present");
  assert.equal(study!.label, "Study mode (in-IDE teaching chat)");
  assert.equal(study!.status, "warn");
  assert.match(study!.detail ?? "", /prepsavant auth/);
  assert.equal(study!.fixCommand, "prepsavant auth");

  // formatDoctor should surface a quickstart Study tile in its preamble
  // (above [host]) with the warn symbol and an actionable auth hint.
  const tile = findTileLine(formatDoctor(result), "Study mode");
  assert.ok(tile, "formatDoctor should render a Study mode tile");
  assert.match(tile!, /^ {2}! Study mode — /);
  assert.match(tile!, /prepsavant auth/);
  // Stay under the existing line-length budget.
  assert.ok(tile!.length <= 80, `tile too long (${tile!.length}): ${tile}`);
});

test("manifest.study_mode is warn when token exists but no host is installed", () => {
  // Write a token into the throwaway config dir; do NOT install any host
  // configs (they would live under XDG/LOCALAPPDATA paths we redirected).
  writeConfig({
    apiBaseUrl: "https://prepsavant.com",
    token: "fake-test-token",
    label: "test-device",
  });
  const result = runDoctor({ workspaceDir: tmpHome });
  const study = findStudyCheck(result);
  assert.ok(study);
  assert.equal(study!.status, "warn");
  // With a token present, the auth-fix hint should not be set.
  assert.equal(study!.fixCommand, undefined);
  // Detail should mention the host install gap.
  assert.match(study!.detail ?? "", /AI chat host/);

  // Quickstart tile should now point users at `prepsavant install --host
  // cursor` so the next step is unambiguous.
  const tile = findTileLine(formatDoctor(result), "Study mode");
  assert.ok(tile, "formatDoctor should render a Study mode tile");
  assert.match(tile!, /^ {2}! Study mode — /);
  assert.match(tile!, /prepsavant install --host cursor/);
  assert.ok(tile!.length <= 80, `tile too long (${tile!.length}): ${tile}`);
});

test("manifest.study_mode is pass when token is present AND a host is installed", () => {
  // Re-use the token from the previous test and stand up a fake host config
  // at the path detectHosts() inspects. We drop the file at every plausible
  // location so the assertion holds on linux/mac/windows hosts.
  const dropConfig = (p: string) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ mcpServers: {} }, null, 2));
  };
  // Cursor (~/.cursor/mcp.json on every platform)
  dropConfig(path.join(tmpHome, ".cursor", "mcp.json"));
  // Claude Desktop — drop on every platform's path so the test passes on
  // any host runner (CI is linux, but the same suite should work on dev mac).
  dropConfig(
    path.join(
      tmpHome,
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    ),
  );
  dropConfig(path.join(tmpHome, ".config", "Claude", "claude_desktop_config.json"));
  // Codex (~/.codex/config.toml — write empty toml so the existence check passes)
  fs.mkdirSync(path.join(tmpHome, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(tmpHome, ".codex", "config.toml"), "# empty\n");

  const result = runDoctor({ workspaceDir: tmpHome });
  const study = findStudyCheck(result);
  assert.ok(study);
  assert.equal(
    study!.status,
    "pass",
    `expected pass; got ${study!.status}; detail=${study!.detail}`,
  );
  assert.match(study!.detail ?? "", /MCP study_\* tools are reachable/);
  assert.equal(study!.fixCommand, undefined);

  // The pass-state tile uses the ✓ symbol and tells the user the in-IDE
  // command is ready to run.
  const tile = findTileLine(formatDoctor(result), "Study mode");
  assert.ok(tile, "formatDoctor should render a Study mode tile");
  assert.match(tile!, /^ {2}✓ Study mode — /);
  assert.match(tile!, /prepsavant study/);
  assert.ok(tile!.length <= 80, `tile too long (${tile!.length}): ${tile}`);
});

// ---------------------------------------------------------------------------
// Coached + AI-Assisted tiles (task-567)
//
// These run after the Study tests above, so the tmpHome already has a token
// written by test #2 and host configs (Cursor, Claude Desktop, Codex)
// dropped by test #3. That gives us the "happy path" baseline; individual
// tests below override `opts.plan` or rewrite parts of HOME to drive the
// other branches.
// ---------------------------------------------------------------------------

test("Coached tile renders alongside Study with the same token+host gating", () => {
  // Baseline: token present (test #2) AND host configs present (test #3).
  // Both Study and Coached should pass.
  const result = runDoctor({ workspaceDir: tmpHome });
  const coached = result.manifest.find((c) => c.id === "manifest.coached_mode");
  assert.ok(coached, "coached_mode check should be present");
  assert.equal(coached!.label, "Coached mode (`prepsavant start`)");
  assert.equal(
    coached!.status,
    "pass",
    `expected pass; got ${coached!.status}; detail=${coached!.detail}`,
  );

  const tile = findTileLine(formatDoctor(result), "Coached mode");
  assert.ok(tile, "formatDoctor should render a Coached mode tile");
  assert.match(tile!, /^ {2}✓ Coached mode — /);
  assert.match(tile!, /prepsavant start/);
  assert.ok(tile!.length <= 80, `tile too long (${tile!.length}): ${tile}`);
});

test("Coached tile warns with install hint when no host is installed", () => {
  // Remove the host configs we wrote in test #3 to simulate a user who has
  // authorized but not yet installed any MCP host. Token stays put.
  fs.rmSync(path.join(tmpHome, ".cursor"), { recursive: true, force: true });
  fs.rmSync(path.join(tmpHome, ".codex"), { recursive: true, force: true });
  fs.rmSync(path.join(tmpHome, "Library"), { recursive: true, force: true });
  fs.rmSync(path.join(tmpHome, ".config", "Claude"), {
    recursive: true,
    force: true,
  });

  const result = runDoctor({ workspaceDir: tmpHome });
  const coached = result.manifest.find((c) => c.id === "manifest.coached_mode");
  assert.ok(coached);
  assert.equal(coached!.status, "warn");
  assert.match(coached!.detail ?? "", /AI chat host/);

  const tile = findTileLine(formatDoctor(result), "Coached mode");
  assert.ok(tile, "formatDoctor should render a Coached mode tile");
  assert.match(tile!, /^ {2}! Coached mode — /);
  assert.match(tile!, /prepsavant install --host cursor/);
  assert.ok(tile!.length <= 80, `tile too long (${tile!.length}): ${tile}`);
});

test("AI-Assisted tile warns and surfaces the upgrade URL on the Free plan", () => {
  // Plan is supplied to runDoctor by the CLI after fetching GET /runner/me.
  // Wire it through here so the AI-Assisted tile takes the free-plan branch.
  const result = runDoctor({ workspaceDir: tmpHome, plan: "free" });
  const ai = result.manifest.find((c) => c.id === "manifest.ai_assisted_mode");
  assert.ok(ai, "ai_assisted_mode check should be present");
  assert.equal(ai!.status, "warn");
  assert.match(ai!.detail ?? "", /Free plan/);
  // The upgrade URL should be the same one license.plan exposes so the
  // user only has to click one link.
  assert.equal(ai!.fixCommand, "https://prepsavant.com/pricing");

  const tile = findTileLine(formatDoctor(result), "AI-Assisted mode");
  assert.ok(tile, "formatDoctor should render an AI-Assisted mode tile");
  assert.match(tile!, /^ {2}! AI-Assisted mode — /);
  assert.match(tile!, /upgrade at https:\/\/prepsavant\.com\/pricing/);
  assert.ok(tile!.length <= 80, `tile too long (${tile!.length}): ${tile}`);
});

test("AI-Assisted tile warns with install hint when no hook-capable host present", () => {
  // No host configs (test #4 cleared them); plan is Pro so the gating
  // collapses to "no hook-capable host installed".
  const result = runDoctor({ workspaceDir: tmpHome, plan: "pro" });
  const ai = result.manifest.find((c) => c.id === "manifest.ai_assisted_mode");
  assert.ok(ai);
  assert.equal(ai!.status, "warn");
  assert.match(ai!.detail ?? "", /hook-capable host/);

  const tile = findTileLine(formatDoctor(result), "AI-Assisted mode");
  assert.ok(tile, "formatDoctor should render an AI-Assisted mode tile");
  assert.match(tile!, /^ {2}! AI-Assisted mode — /);
  assert.match(tile!, /prepsavant install --host cursor/);
  assert.ok(tile!.length <= 80, `tile too long (${tile!.length}): ${tile}`);
});

test("AI-Assisted tile passes when Pro plan + only Claude Code is installed (task-572)", () => {
  // Claude Code (the CLI sibling of Claude Desktop) wires into the same hook
  // surface AI-Assisted relies on, so a Claude-Code-only install should
  // unlock the tile just like Cursor or Codex would. We've confirmed via
  // test #4 / #5 that no other host is present at this point — drop only
  // ~/.claude.json (Claude Code's user-level config) and verify the tile
  // flips to pass without any Cursor/Codex/Claude-Desktop config in sight.
  const claudeCodeConfig = path.join(tmpHome, ".claude.json");
  fs.writeFileSync(claudeCodeConfig, JSON.stringify({ projects: {} }, null, 2));

  const result = runDoctor({ workspaceDir: tmpHome, plan: "pro" });

  // Sanity check: the [host] section should now show Claude Code as pass
  // and every other host as warn so we know the gating really is being
  // driven by Claude Code alone.
  const claudeCodeHost = result.host.find((c) => c.id === "host.claude_code");
  assert.ok(claudeCodeHost, "host.claude_code should appear in detected hosts");
  assert.equal(claudeCodeHost!.label, "Claude Code");
  assert.equal(claudeCodeHost!.status, "pass");
  for (const otherId of ["host.cursor", "host.codex", "host.claude"]) {
    const other = result.host.find((c) => c.id === otherId);
    assert.ok(other, `${otherId} should appear in detected hosts`);
    assert.equal(
      other!.status,
      "warn",
      `${otherId} should still be warn so this test really exercises the Claude-Code-only path`,
    );
  }

  const ai = result.manifest.find((c) => c.id === "manifest.ai_assisted_mode");
  assert.ok(ai);
  assert.equal(
    ai!.status,
    "pass",
    `expected pass; got ${ai!.status}; detail=${ai!.detail}`,
  );

  const tile = findTileLine(formatDoctor(result), "AI-Assisted mode");
  assert.ok(tile, "formatDoctor should render an AI-Assisted mode tile");
  assert.match(tile!, /^ {2}✓ AI-Assisted mode — /);
  assert.match(tile!, /prepsavant start --ai-assisted/);
  assert.ok(tile!.length <= 80, `tile too long (${tile!.length}): ${tile}`);

  // Clean up so subsequent tests start from the no-hook-capable-host state
  // they expect.
  fs.rmSync(claudeCodeConfig, { force: true });
});

test("AI-Assisted tile passes when Pro plan + a hook-capable host are present", () => {
  // Re-install the Cursor MCP config (a hook-capable host) and mark plan as
  // Pro. This is the green-light state the new tile should celebrate.
  const cursorConfig = path.join(tmpHome, ".cursor", "mcp.json");
  fs.mkdirSync(path.dirname(cursorConfig), { recursive: true });
  fs.writeFileSync(cursorConfig, JSON.stringify({ mcpServers: {} }, null, 2));

  const result = runDoctor({ workspaceDir: tmpHome, plan: "pro" });
  const ai = result.manifest.find((c) => c.id === "manifest.ai_assisted_mode");
  assert.ok(ai);
  assert.equal(
    ai!.status,
    "pass",
    `expected pass; got ${ai!.status}; detail=${ai!.detail}`,
  );

  const tile = findTileLine(formatDoctor(result), "AI-Assisted mode");
  assert.ok(tile, "formatDoctor should render an AI-Assisted mode tile");
  assert.match(tile!, /^ {2}✓ AI-Assisted mode — /);
  assert.match(tile!, /prepsavant start --ai-assisted/);
  assert.ok(tile!.length <= 80, `tile too long (${tile!.length}): ${tile}`);
});

test("formatDoctor renders all three quickstart tiles together in the preamble", () => {
  // After the previous test the Cursor config is back, so plan=pro yields
  // pass tiles for Coached and AI-Assisted while Study (which is also gated
  // on token + any host) passes too. Verify all three appear above [host]
  // and stay within the line-length budget.
  const rendered = formatDoctor(runDoctor({ workspaceDir: tmpHome, plan: "pro" }));
  for (const label of ["Study mode", "Coached mode", "AI-Assisted mode"]) {
    const tile = findTileLine(rendered, label);
    assert.ok(tile, `expected a ${label} tile in the preamble`);
    assert.ok(
      tile!.length <= 80,
      `${label} tile too long (${tile!.length}): ${tile}`,
    );
  }
});
