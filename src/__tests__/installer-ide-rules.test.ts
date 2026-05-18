// Task #1064 — IDE rules installer is idempotent and managed-block-aware.
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { installIdeRules } from "../skills/installer.js";

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "prepsavant-installer-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("installIdeRules creates Cursor + Claude rule files on a fresh workspace", async () => {
  await withTmp(async (dir) => {
    const r = await installIdeRules(dir);
    const cursor = r.files.find((f) => f.path === ".cursor/rules/prepsavant.mdc");
    const claudeSkill = r.files.find(
      (f) => f.path === ".claude/skills/prepsavant-relay/SKILL.md",
    );
    const claudeMd = r.files.find((f) => f.path === "CLAUDE.md");
    assert.equal(cursor?.result, "created");
    assert.equal(claudeSkill?.result, "created");
    assert.equal(claudeMd?.result, "created");
  });
});

test("installIdeRules is a no-op on the second run with no user edits", async () => {
  await withTmp(async (dir) => {
    await installIdeRules(dir);
    const r2 = await installIdeRules(dir);
    // Task #1119 — files for kinds with no fetched body resolve to
    // "skipped" rather than "noop" since the installer never wrote them.
    for (const f of r2.files) {
      assert.ok(
        f.result === "noop" || f.result === "skipped",
        `${f.path} should be noop or skipped, got ${f.result}`,
      );
    }
  });
});

test("installIdeRules preserves user content in CLAUDE.md outside the managed block", async () => {
  await withTmp(async (dir) => {
    const claudePath = path.join(dir, "CLAUDE.md");
    await fs.writeFile(
      claudePath,
      "# My project\n\nUser-authored notes here.\n",
      "utf8",
    );
    await installIdeRules(dir);
    const after = await fs.readFile(claudePath, "utf8");
    assert.ok(after.includes("# My project"));
    assert.ok(after.includes("User-authored notes here."));
    assert.ok(after.includes("prepsavant:relay-rules:begin"));
    assert.ok(after.includes("prepsavant:relay-rules:end"));
    assert.ok(after.includes("hybrid relay protocol"));

    const r2 = await installIdeRules(dir);
    assert.equal(
      r2.files.find((f) => f.path === "CLAUDE.md")?.result,
      "noop",
    );
  });
});

test("installIdeRules rewrites only the managed block when its body has been mutated", async () => {
  await withTmp(async (dir) => {
    const claudePath = path.join(dir, "CLAUDE.md");
    await installIdeRules(dir);
    const before = await fs.readFile(claudePath, "utf8");
    await fs.writeFile(
      claudePath,
      before.replace("hybrid relay protocol", "OUTDATED"),
      "utf8",
    );
    const r = await installIdeRules(dir);
    assert.equal(
      r.files.find((f) => f.path === "CLAUDE.md")?.result,
      "updated",
    );
    const after = await fs.readFile(claudePath, "utf8");
    assert.ok(after.includes("hybrid relay protocol"));
  });
});
