// Task #1263 — verify the opportunistic sandbox-cache pruner:
//   * pruneSandboxCache removes per-language hash dirs older than maxAgeDays
//   * pruneSandboxCache keeps only the N most-recent surviving dirs per lang
//   * dryRun reports what would be removed without touching disk
//   * pruneSandboxCacheOpportunistic short-circuits when stamp is fresh
//   * pruneSandboxCacheOpportunistic runs and refreshes the stamp when stale
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  pruneSandboxCache,
  pruneSandboxCacheOpportunistic,
} from "../sandbox/cache-prune.js";

function setupTmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-cache-prune-"));
}

function writeCacheDir(
  root: string,
  lang: string,
  hash: string,
  files: Array<{ name: string; bytes: number; mtimeMs?: number }>,
): string {
  const dir = path.join(root, lang, hash);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const f of files) {
    const p = path.join(dir, f.name);
    fs.writeFileSync(p, Buffer.alloc(f.bytes, 0));
    if (f.mtimeMs !== undefined) {
      const t = f.mtimeMs / 1000;
      fs.utimesSync(p, t, t);
    }
  }
  // Also stamp the dir's mtime so dirSizeAndMtime reflects it on filesystems
  // that bump dir mtime on child writes.
  const newest = files.reduce(
    (m, f) => (f.mtimeMs !== undefined && f.mtimeMs > m ? f.mtimeMs : m),
    0,
  );
  if (newest > 0) {
    const t = newest / 1000;
    fs.utimesSync(dir, t, t);
  }
  return dir;
}

describe("pruneSandboxCache (task-1263)", () => {
  it("returns no-op when the cache root is missing", () => {
    const root = path.join(
      os.tmpdir(),
      `nonexistent-prune-${Date.now()}-${Math.random()}`,
    );
    const result = pruneSandboxCache({}, root);
    assert.equal(result.removed.length, 0);
    assert.equal(result.freedBytes, 0);
  });

  it("removes only dirs whose newest mtime is older than maxAgeDays", () => {
    const root = setupTmpRoot();
    try {
      const now = Date.now();
      const day = 24 * 60 * 60 * 1000;
      // Fresh: 1 day old.
      writeCacheDir(root, "rust", "freshhash00000001", [
        { name: "target.bin", bytes: 1024, mtimeMs: now - day },
      ]);
      // Stale: 30 days old.
      writeCacheDir(root, "rust", "stalehash00000002", [
        { name: "target.bin", bytes: 5_000_000, mtimeMs: now - 30 * day },
      ]);
      // Stale: 60 days old, different language.
      writeCacheDir(root, "go", "stalehash00000003", [
        { name: "build.cache", bytes: 2_000_000, mtimeMs: now - 60 * day },
      ]);
      const result = pruneSandboxCache(
        { maxAgeDays: 14, keepRecent: 10 },
        root,
      );
      assert.equal(result.removed.length, 2);
      assert.ok(result.removed.every((e) => e.reason === "age"));
      assert.equal(result.freedBytes, 7_000_000);
      assert.ok(
        fs.existsSync(path.join(root, "rust", "freshhash00000001")),
        "fresh dir must survive",
      );
      assert.ok(
        !fs.existsSync(path.join(root, "rust", "stalehash00000002")),
        "stale rust dir must be removed",
      );
      assert.ok(
        !fs.existsSync(path.join(root, "go", "stalehash00000003")),
        "stale go dir must be removed",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("after the age sweep, keeps only the N most-recent dirs per language", () => {
    const root = setupTmpRoot();
    try {
      const now = Date.now();
      const day = 24 * 60 * 60 * 1000;
      // All four are within the age window but only 2 should survive.
      writeCacheDir(root, "kotlin", "h1", [
        { name: "harness.jar", bytes: 1000, mtimeMs: now - 1 * day },
      ]);
      writeCacheDir(root, "kotlin", "h2", [
        { name: "harness.jar", bytes: 2000, mtimeMs: now - 2 * day },
      ]);
      writeCacheDir(root, "kotlin", "h3", [
        { name: "harness.jar", bytes: 3000, mtimeMs: now - 3 * day },
      ]);
      writeCacheDir(root, "kotlin", "h4", [
        { name: "harness.jar", bytes: 4000, mtimeMs: now - 4 * day },
      ]);
      const result = pruneSandboxCache(
        { maxAgeDays: 30, keepRecent: 2 },
        root,
      );
      assert.equal(result.removed.length, 2);
      const removedHashes = result.removed
        .map((e) => e.harnessHash)
        .sort();
      assert.deepEqual(removedHashes, ["h3", "h4"]);
      assert.ok(result.removed.every((e) => e.reason === "lru"));
      assert.ok(fs.existsSync(path.join(root, "kotlin", "h1")));
      assert.ok(fs.existsSync(path.join(root, "kotlin", "h2")));
      assert.ok(!fs.existsSync(path.join(root, "kotlin", "h3")));
      assert.ok(!fs.existsSync(path.join(root, "kotlin", "h4")));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("dryRun reports the same set without touching disk", () => {
    const root = setupTmpRoot();
    try {
      const now = Date.now();
      const day = 24 * 60 * 60 * 1000;
      writeCacheDir(root, "csharp", "stalexyz00000004", [
        { name: "bin", bytes: 2048, mtimeMs: now - 90 * day },
      ]);
      const result = pruneSandboxCache(
        { dryRun: true, maxAgeDays: 14 },
        root,
      );
      assert.equal(result.dryRun, true);
      assert.equal(result.removed.length, 1);
      assert.equal(result.freedBytes, 2048);
      assert.ok(
        fs.existsSync(path.join(root, "csharp", "stalexyz00000004")),
        "dry-run must not delete the dir",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("pruneSandboxCacheOpportunistic (task-1263)", () => {
  it("short-circuits when the stamp is fresh", () => {
    const root = setupTmpRoot();
    try {
      const now = Date.now();
      const day = 24 * 60 * 60 * 1000;
      writeCacheDir(root, "rust", "stalehashshort01", [
        { name: "target.bin", bytes: 999, mtimeMs: now - 90 * day },
      ]);
      const stampPath = path.join(root, ".prune-stamp");
      fs.writeFileSync(stampPath, "");
      // Stamp is "now" — within the 24h debounce window.
      const t = now / 1000;
      fs.utimesSync(stampPath, t, t);
      const outcome = pruneSandboxCacheOpportunistic(
        { stampPath, debounceHours: 24, nowMs: now },
        root,
      );
      assert.equal(outcome.ran, false);
      assert.equal(outcome.reason, "debounced");
      // Stale dir is still on disk because we short-circuited.
      assert.ok(fs.existsSync(path.join(root, "rust", "stalehashshort01")));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs the sweep and refreshes the stamp when it is stale or missing", () => {
    const root = setupTmpRoot();
    try {
      const now = Date.now();
      const day = 24 * 60 * 60 * 1000;
      writeCacheDir(root, "go", "stalehashlong001", [
        { name: "build.cache", bytes: 2048, mtimeMs: now - 90 * day },
      ]);
      const stampPath = path.join(root, ".prune-stamp");
      // No stamp yet — first run should do real work.
      const outcome = pruneSandboxCacheOpportunistic(
        { stampPath, debounceHours: 24, maxAgeDays: 14, nowMs: now },
        root,
      );
      assert.equal(outcome.ran, true);
      assert.equal(outcome.reason, "stamp-missing");
      assert.ok(outcome.result);
      assert.equal(outcome.result!.removed.length, 1);
      assert.ok(!fs.existsSync(path.join(root, "go", "stalehashlong001")));
      assert.ok(fs.existsSync(stampPath), "stamp file must be created");

      // Second call with the same `nowMs` should be debounced.
      const second = pruneSandboxCacheOpportunistic(
        { stampPath, debounceHours: 24, nowMs: now },
        root,
      );
      assert.equal(second.ran, false);
      assert.equal(second.reason, "debounced");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
