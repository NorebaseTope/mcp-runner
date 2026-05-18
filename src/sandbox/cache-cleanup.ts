// Task #1230 — sandbox-cache cleanup utility.
//
// Task #1211 introduced a long-lived per-language build cache at
// `~/.prepsavant/sandbox-cache/<lang>/<harnessHash>/`. Whenever a
// harness template is bumped (csharp, kotlin), a new hash dir is
// created and the previous one is left behind — each holding ~5MB
// of compiled artefacts (`bin/`, `obj/`, `harness.jar`). Over time
// this can quietly consume hundreds of MB.
//
// This module scans the cache, identifies stale hash dirs (whose
// hash does not match the currently-shipped HARNESS_VERSION) and
// optionally evicts active-hash dirs that haven't been touched in
// `staleAgeDays` days. It is invoked by `prepsavant doctor` (read-only
// summary) and `prepsavant clean-sandbox-cache` (mutation).
import * as fs from "node:fs";
import * as path from "node:path";
import { SANDBOX_CACHE_DIR } from "../config.js";
import { __csharpCacheInternals } from "./csharp.js";
import { __kotlinCacheInternals } from "./kotlin.js";

export interface SandboxCacheEntry {
  language: string;
  harnessHash: string;
  fullPath: string;
  sizeBytes: number;
  // Most-recent mtime of any file in the dir, in ms since epoch.
  // Used for age-based eviction of the active-hash dir.
  lastTouchedMs: number;
  // True when this dir's hash matches the harness version the
  // currently-installed runner ships. Stale dirs are always safe
  // to remove; active dirs are only removed when age-evicted.
  isActive: boolean;
}

export interface SandboxCacheScan {
  rootDir: string;
  totalSizeBytes: number;
  entries: SandboxCacheEntry[];
}

export interface CleanSandboxCacheOptions {
  // When defined, also remove ACTIVE-hash dirs whose newest file
  // mtime is older than `staleAgeDays * 24h` ago. Stale-hash dirs
  // are always removed regardless of age. Defaults to undefined
  // (no age-based eviction).
  staleAgeDays?: number;
  // When true, report what WOULD be removed without touching disk.
  dryRun?: boolean;
}

export interface CleanSandboxCacheResult {
  rootDir: string;
  removed: SandboxCacheEntry[];
  kept: SandboxCacheEntry[];
  freedBytes: number;
  remainingBytes: number;
  dryRun: boolean;
}

// The set of (language, activeHash) pairs the runner currently knows
// about. Languages without versioned caches (no entry here) are
// treated as fully-stale — every hash dir under that language is a
// candidate for removal — but in practice only csharp and kotlin
// emit subdirectories at all today.
export function activeHarnessHashes(): Record<string, string> {
  return {
    csharp: __csharpCacheInternals.HARNESS_VERSION,
    kotlin: __kotlinCacheInternals.HARNESS_VERSION,
  };
}

function dirSizeAndMtime(dir: string): { sizeBytes: number; lastTouchedMs: number } {
  let sizeBytes = 0;
  let lastTouchedMs = 0;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const p = path.join(current, ent.name);
      try {
        const st = fs.lstatSync(p);
        if (st.mtimeMs > lastTouchedMs) lastTouchedMs = st.mtimeMs;
        if (ent.isDirectory()) {
          stack.push(p);
        } else if (ent.isFile()) {
          sizeBytes += st.size;
        }
      } catch {
        // Skip files that disappear mid-scan.
      }
    }
  }
  return { sizeBytes, lastTouchedMs };
}

export function scanSandboxCache(
  rootDir: string = SANDBOX_CACHE_DIR,
): SandboxCacheScan {
  const out: SandboxCacheScan = { rootDir, totalSizeBytes: 0, entries: [] };
  let langDirs: fs.Dirent[];
  try {
    langDirs = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return out;
  }
  const active = activeHarnessHashes();
  for (const langEnt of langDirs) {
    if (!langEnt.isDirectory()) continue;
    const language = langEnt.name;
    const langPath = path.join(rootDir, language);
    let hashDirs: fs.Dirent[];
    try {
      hashDirs = fs.readdirSync(langPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const hashEnt of hashDirs) {
      if (!hashEnt.isDirectory()) continue;
      const harnessHash = hashEnt.name;
      const fullPath = path.join(langPath, harnessHash);
      const { sizeBytes, lastTouchedMs } = dirSizeAndMtime(fullPath);
      const isActive = active[language] === harnessHash;
      out.entries.push({
        language,
        harnessHash,
        fullPath,
        sizeBytes,
        lastTouchedMs,
        isActive,
      });
      out.totalSizeBytes += sizeBytes;
    }
  }
  return out;
}

export function cleanSandboxCache(
  opts: CleanSandboxCacheOptions = {},
  rootDir: string = SANDBOX_CACHE_DIR,
): CleanSandboxCacheResult {
  const dryRun = !!opts.dryRun;
  const scan = scanSandboxCache(rootDir);
  const ageCutoffMs =
    opts.staleAgeDays !== undefined && opts.staleAgeDays >= 0
      ? Date.now() - opts.staleAgeDays * 24 * 60 * 60 * 1000
      : null;
  const removed: SandboxCacheEntry[] = [];
  const kept: SandboxCacheEntry[] = [];
  for (const entry of scan.entries) {
    let shouldRemove = !entry.isActive;
    if (
      !shouldRemove &&
      ageCutoffMs !== null &&
      entry.lastTouchedMs > 0 &&
      entry.lastTouchedMs < ageCutoffMs
    ) {
      shouldRemove = true;
    }
    if (shouldRemove) {
      if (!dryRun) {
        try {
          fs.rmSync(entry.fullPath, { recursive: true, force: true });
        } catch {
          // Best-effort: a partial removal still counts toward freed space
          // since the next sweep will retry. Surface via `kept` if the
          // dir still exists after the rm attempt.
          if (fs.existsSync(entry.fullPath)) {
            kept.push(entry);
            continue;
          }
        }
      }
      removed.push(entry);
    } else {
      kept.push(entry);
    }
  }
  const freedBytes = removed.reduce((n, e) => n + e.sizeBytes, 0);
  const remainingBytes = kept.reduce((n, e) => n + e.sizeBytes, 0);
  return { rootDir, removed, kept, freedBytes, remainingBytes, dryRun };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
