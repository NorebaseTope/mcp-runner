// Task #1538 — `prepsavant doctor` proactively flags the
// "Cursor editor on PATH, agent CLI missing" install layout BEFORE
// the user starts their first coached session.
//
// Two regressions are pinned here:
//   (a) `probeCursorAgentSync` returns `editor_only` when only the
//       editor responds to `--version`, and `ok` when a real
//       cursor-agent semver line is found.
//   (b) `runDoctor()` surfaces a `fail`-status check in the [host]
//       section (so the dashboard banner and `process.exitCode = 1`
//       both pick it up) when the probe reports `editor_only`.

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { runDoctor } from "../doctor.js";
import { probeCursorAgentSync } from "../coached/coding-agent.js";

function makeShim(dir: string, name: string, body: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(p, 0o755);
  return p;
}

test("Task #1538 — probeCursorAgentSync returns editor_only when only the editor responds", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "task1538-editor-only-"));
  try {
    // Editor shim emits the editor's tell-tale help line.
    const editorShim = makeShim(
      tmp,
      "cursor-editor",
      "echo \"Run with 'cursor -' to read output from another program\"",
    );
    // No cursor-agent shim — agent CLI is "missing".
    const result = probeCursorAgentSync({
      candidates: [["/nonexistent/cursor-agent-does-not-exist"]],
      editorCandidate: [editorShim],
    });
    assert.equal(result.kind, "editor_only");
    if (result.kind === "editor_only") {
      assert.match(result.remediation, /standalone `cursor-agent` CLI/);
      assert.match(result.remediation, /https:\/\/cursor\.com/);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("Task #1538 — probeCursorAgentSync returns ok when a real cursor-agent semver responds", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "task1538-agent-ok-"));
  try {
    const agentShim = makeShim(tmp, "cursor-agent", "echo 'cursor-agent 0.45.7'");
    const result = probeCursorAgentSync({
      candidates: [[agentShim]],
      editorCandidate: ["/nonexistent/cursor-editor"],
    });
    assert.equal(result.kind, "ok");
    if (result.kind === "ok") {
      assert.match(result.version ?? "", /0\.45\.7/);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("Task #1538 — probeCursorAgentSync returns missing when neither editor nor agent CLI is on PATH", () => {
  const result = probeCursorAgentSync({
    candidates: [["/nonexistent/cursor-agent-xyz"]],
    editorCandidate: ["/nonexistent/cursor-xyz"],
  });
  assert.equal(result.kind, "missing");
});

test("Task #1538 — runDoctor surfaces a fail-status check in [host] when editor is on PATH but agent CLI is missing", () => {
  // Use PATH manipulation to simulate the real-world install:
  // only `cursor` is on PATH and it responds with editor-shaped output.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "task1538-doctor-"));
  try {
    makeShim(
      tmp,
      "cursor",
      "echo \"Run with 'cursor -' to read output from another program\"",
    );
    // Crucially, NO cursor-agent shim in `tmp`.
    const origPath = process.env["PATH"];
    // Restrict PATH to the temp dir so the test host's real cursor /
    // cursor-agent (if any) can't interfere with the assertion.
    process.env["PATH"] = tmp;
    try {
      const result = runDoctor({
        workspaceDir: tmp,
        sandboxCacheRootDir: path.join(tmp, ".sandbox-cache"),
      });
      const cliMissing = result.host.find(
        (c) => c.id === "coaching.cursor_agent_cli_missing",
      );
      assert.ok(
        cliMissing,
        `expected coaching.cursor_agent_cli_missing in host, got: ${result.host.map((c) => c.id).join(", ")}`,
      );
      assert.equal(cliMissing.status, "fail");
      assert.match(cliMissing.detail ?? "", /standalone `cursor-agent` CLI/);
      assert.equal(result.overallStatus, "fail");
    } finally {
      if (origPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = origPath;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("Task #1538 — runDoctor does NOT surface the editor warning when a real cursor-agent is on PATH", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "task1538-doctor-ok-"));
  try {
    makeShim(tmp, "cursor-agent", "echo 'cursor-agent 0.45.7'");
    // Editor shim too — but the agent CLI takes precedence.
    makeShim(
      tmp,
      "cursor",
      "echo \"Run with 'cursor -' to read output from another program\"",
    );
    const origPath = process.env["PATH"];
    process.env["PATH"] = tmp;
    try {
      const result = runDoctor({
        workspaceDir: tmp,
        sandboxCacheRootDir: path.join(tmp, ".sandbox-cache"),
      });
      const cliMissing = result.host.find(
        (c) => c.id === "coaching.cursor_agent_cli_missing",
      );
      assert.equal(
        cliMissing,
        undefined,
        "must NOT emit the editor warning when the agent CLI resolves",
      );
    } finally {
      if (origPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = origPath;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
