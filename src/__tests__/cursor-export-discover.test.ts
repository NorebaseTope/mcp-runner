// Task #1185 — hermetic coverage of `discoverCursorExport` across the
// three branches the runner cares about: `uploaded` (a fresh, name-
// matched file is found), `not_found` (no candidate dirs hold a
// matching file) and `failed` (a candidate file exists but its read
// blows up). Uses tmpdir + clock injection so the test never touches
// the host's real Cursor User dir / ~/Downloads.
//
// Task #1499 — search scope was narrowed to the question-package
// folder ONLY (its root + `.cursor/` + `.prepsavant/`). The previous
// fallbacks (Cursor User dir, workspaceStorage, ~/Downloads, ~/Desktop,
// ~/Documents) were removed so the runner's behavior matches what the
// practice page tells users: "export the chat into this folder".
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverCursorExport } from "../cursor-export/discover.js";

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "prepsavant-cursor-discover-"),
  );
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("discoverCursorExport → 'uploaded' when a fresh name-matched file lives in the workspace dir", async () => {
  await withTmp(async (root) => {
    const ws = path.join(root, "ws");
    await fs.mkdir(ws, { recursive: true });
    const target = path.join(ws, "cursor-chat-export.md");
    const body = "# Cursor session\n\nhello";
    await fs.writeFile(target, body, "utf8");

    // Pin "now" to the file's mtime so the freshness window cannot
    // race the test on slow disks.
    const stat = await fs.stat(target);
    const result = discoverCursorExport({
      workspaceDir: ws,
      now: () => stat.mtimeMs,
    });

    assert.equal(result.status, "uploaded");
    if (result.status !== "uploaded") return;
    assert.equal(result.sourcePath, target);
    assert.equal(result.mimeType, "text/markdown");
    assert.equal(result.sizeBytes, Buffer.byteLength(body, "utf8"));
    assert.equal(result.contents.toString("utf8"), body);
  });
});

test("discoverCursorExport → also finds matches under .cursor/ and .prepsavant/ subfolders", async () => {
  await withTmp(async (root) => {
    const ws = path.join(root, "ws");
    await fs.mkdir(path.join(ws, ".cursor"), { recursive: true });
    await fs.mkdir(path.join(ws, ".prepsavant"), { recursive: true });
    const target = path.join(ws, ".prepsavant", "prepsavant-cursor-export.md");
    await fs.writeFile(target, "ok", "utf8");
    const stat = await fs.stat(target);
    const result = discoverCursorExport({
      workspaceDir: ws,
      now: () => stat.mtimeMs,
    });
    assert.equal(result.status, "uploaded");
    if (result.status !== "uploaded") return;
    assert.equal(result.sourcePath, target);
  });
});

test("discoverCursorExport → 'not_found' when no candidate dir holds a matching file", async () => {
  await withTmp(async (root) => {
    const ws = path.join(root, "ws");
    await fs.mkdir(ws, { recursive: true });
    // Decoy file that does NOT match the name pattern.
    await fs.writeFile(path.join(ws, "notes.md"), "irrelevant", "utf8");

    const result = discoverCursorExport({
      workspaceDir: ws,
      now: () => Date.now(),
    });

    assert.equal(result.status, "not_found");
    if (result.status !== "not_found") return;
    // Task #1499 — searched paths must be the workspace root plus its
    // `.cursor/` and `.prepsavant/` subfolders, and ONLY those. The
    // previous home-tree fallbacks were intentionally removed.
    assert.deepEqual(result.searchedPaths, [
      ws,
      path.join(ws, ".cursor"),
      path.join(ws, ".prepsavant"),
    ]);
  });
});

test("discoverCursorExport → does NOT scan ~/Downloads / ~/Desktop / ~/Documents (Task #1499)", async () => {
  await withTmp(async (root) => {
    const home = path.join(root, "home");
    const ws = path.join(root, "ws");
    await fs.mkdir(ws, { recursive: true });
    for (const sub of ["Downloads", "Desktop", "Documents"]) {
      await fs.mkdir(path.join(home, sub), { recursive: true });
      await fs.writeFile(
        path.join(home, sub, "cursor-export.md"),
        "stray",
        "utf8",
      );
    }
    const stat = await fs.stat(
      path.join(home, "Downloads", "cursor-export.md"),
    );

    // Task #1499 — discovery is workspace-folder-only. A fresh,
    // name-matched file in ~/Downloads (or anywhere outside the
    // workspace + .cursor/ + .prepsavant/) must NOT be uploaded.
    const result = discoverCursorExport({
      workspaceDir: ws,
      now: () => stat.mtimeMs,
    });
    assert.equal(result.status, "not_found");
    if (result.status !== "not_found") return;
    for (const p of result.searchedPaths) {
      assert.ok(
        !p.startsWith(home),
        `searched paths must not include anything under ${home}, got ${p}`,
      );
    }
  });
});

test("discoverCursorExport → 'not_found' when the only matching file is older than maxAgeMs", async () => {
  await withTmp(async (root) => {
    const ws = path.join(root, "ws");
    await fs.mkdir(ws, { recursive: true });
    const target = path.join(ws, "cursor-export.md");
    await fs.writeFile(target, "stale", "utf8");
    const stat = await fs.stat(target);

    // "now" is 10 minutes after mtime, but maxAge is 1 minute, so the
    // file is filtered out as stale and the result is `not_found`.
    const result = discoverCursorExport({
      workspaceDir: ws,
      maxAgeMs: 60_000,
      now: () => stat.mtimeMs + 10 * 60_000,
    });

    assert.equal(result.status, "not_found");
  });
});

test("discoverCursorExport → 'failed' when the chosen file's read throws (chmod 000)", async (t) => {
  // Skip when the test is run as root, since root bypasses POSIX read
  // permission checks and `readFileSync` would succeed regardless.
  const getuid = (process as { getuid?: () => number }).getuid;
  if (typeof getuid === "function" && getuid() === 0) {
    t.skip("requires non-root uid to enforce 0o000 read permission");
    return;
  }
  await withTmp(async (root) => {
    const ws = path.join(root, "ws");
    await fs.mkdir(ws, { recursive: true });
    const target = path.join(ws, "cursor-export.md");
    await fs.writeFile(target, "ok", "utf8");
    const stat = await fs.stat(target);
    // chmod 000 → stat still succeeds (parent dir is readable) but the
    // read inside discoverCursorExport throws EACCES, hitting the
    // "failed" branch with `reason: read_failed: …`.
    await fs.chmod(target, 0o000);
    try {
      const result = discoverCursorExport({
        workspaceDir: ws,
        now: () => stat.mtimeMs,
      });
      assert.equal(result.status, "failed");
      if (result.status !== "failed") return;
      assert.equal(result.sourcePath, target);
      assert.match(result.reason, /read_failed/);
    } finally {
      await fs.chmod(target, 0o600).catch(() => {});
    }
  });
});
