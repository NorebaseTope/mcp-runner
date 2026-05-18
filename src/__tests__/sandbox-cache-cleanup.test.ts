// Task #1230 — verify the sandbox-cache cleanup helper:
//   * scanSandboxCache reports per-dir size, mtime, isActive
//   * cleanSandboxCache removes stale-hash dirs always
//   * cleanSandboxCache removes active-hash dirs only when --stale-age-days
//     is set AND the dir's newest file is older than the cutoff
//   * dryRun reports what would be removed without touching disk
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  cleanSandboxCache,
  scanSandboxCache,
  activeHarnessHashes,
} from "../sandbox/cache-cleanup.js";
import { runDoctor } from "../doctor.js";

function setupTmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-cache-clean-"));
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
  return dir;
}

describe("scanSandboxCache + cleanSandboxCache (task-1230)", () => {
  it("returns zero-entry scan when the cache root is missing", () => {
    const root = path.join(os.tmpdir(), `nonexistent-${Date.now()}-${Math.random()}`);
    const scan = scanSandboxCache(root);
    assert.equal(scan.entries.length, 0);
    assert.equal(scan.totalSizeBytes, 0);
  });

  it("scans sizes, mtimes, and isActive against current harness hashes", () => {
    const root = setupTmpRoot();
    try {
      const active = activeHarnessHashes();
      const activeCsharp = active["csharp"]!;
      // Active csharp dir
      writeCacheDir(root, "csharp", activeCsharp, [{ name: "Program.cs", bytes: 200 }]);
      // Stale csharp dir
      writeCacheDir(root, "csharp", "deadbeef0badf00d", [
        { name: "bin", bytes: 1024 },
      ]);
      const scan = scanSandboxCache(root);
      assert.equal(scan.entries.length, 2);
      const activeEntry = scan.entries.find((e) => e.harnessHash === activeCsharp);
      const staleEntry = scan.entries.find((e) => e.harnessHash === "deadbeef0badf00d");
      assert.ok(activeEntry?.isActive, "active hash should be flagged");
      assert.ok(staleEntry && !staleEntry.isActive, "stale hash should not be active");
      assert.equal(activeEntry!.sizeBytes, 200);
      assert.equal(staleEntry!.sizeBytes, 1024);
      assert.equal(scan.totalSizeBytes, 1224);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes stale-hash dirs and keeps the active-hash dir by default", () => {
    const root = setupTmpRoot();
    try {
      const active = activeHarnessHashes();
      const activeKotlin = active["kotlin"]!;
      writeCacheDir(root, "kotlin", activeKotlin, [{ name: "harness.jar", bytes: 4096 }]);
      writeCacheDir(root, "kotlin", "stalehash00000001", [
        { name: "harness.jar", bytes: 5_000_000 },
      ]);
      writeCacheDir(root, "kotlin", "stalehash00000002", [
        { name: "harness.jar", bytes: 1_000_000 },
      ]);
      const result = cleanSandboxCache({}, root);
      assert.equal(result.removed.length, 2);
      assert.equal(result.kept.length, 1);
      assert.equal(result.kept[0]!.harnessHash, activeKotlin);
      assert.equal(result.freedBytes, 6_000_000);
      assert.equal(result.remainingBytes, 4096);
      // On-disk verification: active dir survives, stale dirs are gone.
      assert.ok(fs.existsSync(path.join(root, "kotlin", activeKotlin)));
      assert.ok(!fs.existsSync(path.join(root, "kotlin", "stalehash00000001")));
      assert.ok(!fs.existsSync(path.join(root, "kotlin", "stalehash00000002")));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("dryRun reports the same set without touching disk", () => {
    const root = setupTmpRoot();
    try {
      writeCacheDir(root, "csharp", "stalexyz00000003", [
        { name: "bin", bytes: 2048 },
      ]);
      const result = cleanSandboxCache({ dryRun: true }, root);
      assert.equal(result.dryRun, true);
      assert.equal(result.removed.length, 1);
      assert.equal(result.freedBytes, 2048);
      assert.ok(
        fs.existsSync(path.join(root, "csharp", "stalexyz00000003")),
        "dry-run must not delete the dir",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("runDoctor auto-prunes stale-hash dirs by default and reports freed bytes (task-1259)", () => {
    const root = setupTmpRoot();
    try {
      const active = activeHarnessHashes();
      const activeKotlin = active["kotlin"]!;
      // One active dir (must survive) + two stale dirs (must be removed).
      writeCacheDir(root, "kotlin", activeKotlin, [
        { name: "harness.jar", bytes: 4096 },
      ]);
      writeCacheDir(root, "kotlin", "stalehashaaaaaaaa", [
        { name: "harness.jar", bytes: 5_000_000 },
      ]);
      writeCacheDir(root, "csharp", "stalehashbbbbbbbb", [
        { name: "bin", bytes: 1_000_000 },
      ]);

      const result = runDoctor({ sandboxCacheRootDir: root });
      const sandboxCheck = result.sandboxCache[0];
      assert.ok(sandboxCheck, "sandbox cache check must be present");
      assert.equal(sandboxCheck!.id, "sandbox_cache.size");
      assert.equal(sandboxCheck!.status, "pass");
      assert.match(
        sandboxCheck!.detail ?? "",
        /Auto-pruned 2 stale dir\(s\); freed/,
      );
      // Active dir survives, stale dirs are gone on disk.
      assert.ok(fs.existsSync(path.join(root, "kotlin", activeKotlin)));
      assert.ok(!fs.existsSync(path.join(root, "kotlin", "stalehashaaaaaaaa")));
      assert.ok(!fs.existsSync(path.join(root, "csharp", "stalehashbbbbbbbb")));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("runDoctor honors autoPruneSandboxCache=false and leaves stale dirs in place (task-1259)", () => {
    const root = setupTmpRoot();
    try {
      const active = activeHarnessHashes();
      const activeKotlin = active["kotlin"]!;
      writeCacheDir(root, "kotlin", activeKotlin, [
        { name: "harness.jar", bytes: 4096 },
      ]);
      writeCacheDir(root, "kotlin", "stalehashcccccccc", [
        { name: "harness.jar", bytes: 2_000_000 },
      ]);

      const result = runDoctor({
        sandboxCacheRootDir: root,
        autoPruneSandboxCache: false,
      });
      const sandboxCheck = result.sandboxCache[0];
      assert.ok(sandboxCheck, "sandbox cache check must be present");
      assert.equal(sandboxCheck!.status, "warn");
      assert.equal(sandboxCheck!.fixCommand, "prepsavant clean-sandbox-cache");
      // Stale dir is NOT removed — opt-out preserves the inspect-first flow.
      assert.ok(fs.existsSync(path.join(root, "kotlin", "stalehashcccccccc")));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("runDoctor auto-prune never touches the active-hash dir even when no stale dirs exist (task-1259)", () => {
    const root = setupTmpRoot();
    try {
      const active = activeHarnessHashes();
      const activeKotlin = active["kotlin"]!;
      // Old active dir (60d) — would be evicted by `--stale-age-days 30`,
      // but doctor's auto-prune must NEVER age-evict (stale-hash only).
      const oldMs = Date.now() - 60 * 24 * 60 * 60 * 1000;
      writeCacheDir(root, "kotlin", activeKotlin, [
        { name: "harness.jar", bytes: 4096, mtimeMs: oldMs },
      ]);

      const result = runDoctor({ sandboxCacheRootDir: root });
      const sandboxCheck = result.sandboxCache[0];
      assert.ok(sandboxCheck, "sandbox cache check must be present");
      assert.equal(sandboxCheck!.status, "pass");
      assert.match(
        sandboxCheck!.detail ?? "",
        /no stale dirs to clean/,
      );
      // Active dir is still on disk despite being old.
      assert.ok(fs.existsSync(path.join(root, "kotlin", activeKotlin)));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("staleAgeDays evicts the active-hash dir only when its newest file is older than the cutoff", () => {
    const root = setupTmpRoot();
    try {
      const active = activeHarnessHashes();
      const activeKotlin = active["kotlin"]!;
      // Old active dir — newest file is 60 days old.
      const oldMs = Date.now() - 60 * 24 * 60 * 60 * 1000;
      writeCacheDir(root, "kotlin", activeKotlin, [
        { name: "harness.jar", bytes: 4096, mtimeMs: oldMs },
      ]);
      // Recent active csharp dir
      const activeCsharp = active["csharp"]!;
      writeCacheDir(root, "csharp", activeCsharp, [
        { name: "Program.cs", bytes: 100, mtimeMs: Date.now() },
      ]);
      // Without staleAgeDays — both kept.
      const noEvict = cleanSandboxCache({ dryRun: true }, root);
      assert.equal(noEvict.removed.length, 0);
      // With 30-day cutoff — only the kotlin (60d old) is evicted.
      const evict = cleanSandboxCache({ staleAgeDays: 30, dryRun: true }, root);
      assert.equal(evict.removed.length, 1);
      assert.equal(evict.removed[0]!.language, "kotlin");
      assert.equal(evict.removed[0]!.harnessHash, activeKotlin);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
