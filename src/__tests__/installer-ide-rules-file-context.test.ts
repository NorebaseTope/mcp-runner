// Regression test for task #1074: the IDE rule files Sam installs into
// the user's workspace (Cursor, Claude Code skill, CLAUDE.md managed
// block) must restate the no-open-file / editor-context prohibition that
// task #1065 added to the live MCP tool descriptions.
//
// Hosts re-read these installed rule files between turns and after a
// context reset. If a host has dropped the live tool descriptions from
// its window, the rule files are the only place left where the
// prohibition survives — so they MUST contain it. Mirrors
// `coached-file-context-guardrails.test.ts`, which pins the same
// prohibition into the tool descriptions and the fallback HOST
// INSTRUCTIONS brief.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { installIdeRules } from "../skills/installer.js";

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "prepsavant-installer-file-context-"),
  );
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const RULE_FILES = [
  ".cursor/rules/prepsavant.mdc",
  ".claude/skills/prepsavant-relay/SKILL.md",
  "CLAUDE.md",
];

test("each installed IDE rule file restates the open-file / editor-context prohibition", async () => {
  await withTmp(async (dir) => {
    await installIdeRules(dir);
    for (const rel of RULE_FILES) {
      const body = await fs.readFile(path.join(dir, rel), "utf8");
      assert.match(
        body,
        /open file/i,
        `${rel} must mention 'open file' so a host that has dropped the live tool descriptions still sees the prohibition`,
      );
      assert.match(
        body,
        /editor (tabs|context)/i,
        `${rel} must mention 'editor tabs' or 'editor context' alongside the open-file prohibition`,
      );
      assert.match(
        body,
        /(infer|pre-select|proxy for question selection)/i,
        `${rel} must explicitly forbid inferring or pre-selecting a question from editor context`,
      );
    }
  });
});

test("updating an existing installation rewrites stale rule bodies that lack the file-context clause", async () => {
  // Simulate an older installation that predates task #1074 by writing a
  // rule file with the verbatim-relay text but no open-file clause. The
  // installer must replace it on the next run so existing users get the
  // new wording without needing to uninstall first.
  await withTmp(async (dir) => {
    const stale = `# PrepSavant Sam — hybrid relay protocol

(stale rule body from before task #1074 — no file-context clause)
`;
    const cursorPath = path.join(dir, ".cursor/rules/prepsavant.mdc");
    await fs.mkdir(path.dirname(cursorPath), { recursive: true });
    await fs.writeFile(cursorPath, stale, "utf8");

    const r = await installIdeRules(dir);
    assert.equal(
      r.files.find((f) => f.path === ".cursor/rules/prepsavant.mdc")?.result,
      "updated",
    );
    const after = await fs.readFile(cursorPath, "utf8");
    assert.match(after, /open file/i);
    assert.match(after, /editor (tabs|context)/i);
  });
});
