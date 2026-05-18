// Task #1263 — opportunistic sandbox-cache pruning.
//
// Each harness-template bump in cpp/java/go/rust/csharp/kotlin creates a
// brand new `~/.prepsavant/sandbox-cache/<lang>/<harnessHash>/` folder, but
// old folders are never cleaned up. On a long-lived runner install that
// survives many releases, these directories accumulate (rust + go can be
// hundreds of MB each from build cache + rlibs).
//
// `pruneSandboxCache()` deletes per-language hash dirs whose newest mtime
// is older than `maxAgeDays` (default 14) AND, after the age sweep, keeps
// only the `keepRecent` most-recently-touched dirs per language (default
// 2). The combination means a fresh upgrade keeps the previous version
// around for a couple of weeks (so a quick rollback is still warm) but
// long-untouched languages are reaped.
//
// `pruneSandboxCacheOpportunistic()` wraps the above with a debounce stamp
// so we can call it on every CLI invocation without doing real work on each
// grade. The stamp lives at `~/.prepsavant/.sandbox-cache-prune-stamp`.
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR, SANDBOX_CACHE_DIR } from "../config.js";

export interface PrunedEntry {
  language: string;
  harnessHash: string;
  fullPath: string;
  sizeBytes: number;
  lastTouchedMs: number;
  reason: "age" | "lru";
}

export interface PruneSandboxCacheOptions {
  // Hash dirs whose newest file mtime is older than this many days are
  // removed. Default 14.
  maxAgeDays?: number;
  // After the age sweep, keep only the N most-recently-touched dirs per
  // language; older ones are removed. Default 2.
  keepRecent?: number;
  // When true, report what WOULD be removed without touching disk.
  dryRun?: boolean;
}

export interface PruneSandboxCacheResult {
  rootDir: string;
  removed: PrunedEntry[];
  freedBytes: number;
  dryRun: boolean;
}

interface ScannedHashDir {
  language: string;
  harnessHash: string;
  fullPath: string;
  sizeBytes: number;
  lastTouchedMs: number;
}

function dirSizeAndMtime(dir: string): {
  sizeBytes: number;
  lastTouchedMs: number;
} {
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
    // Also consider the dir's own mtime — covers empty dirs created by a
    // restore step that hasn't written any files yet.
    try {
      const dst = fs.lstatSync(current);
      if (dst.mtimeMs > lastTouchedMs) lastTouchedMs = dst.mtimeMs;
    } catch {
      // Ignore — dir vanished mid-scan.
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

function scanHashDirs(rootDir: string): ScannedHashDir[] {
  const out: ScannedHashDir[] = [];
  let langDirs: fs.Dirent[];
  try {
    langDirs = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return out;
  }
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
      out.push({ language, harnessHash, fullPath, sizeBytes, lastTouchedMs });
    }
  }
  return out;
}

export function pruneSandboxCache(
  opts: PruneSandboxCacheOptions = {},
  rootDir: string = SANDBOX_CACHE_DIR,
): PruneSandboxCacheResult {
  const maxAgeDays = opts.maxAgeDays ?? 14;
  const keepRecent = opts.keepRecent ?? 2;
  const dryRun = !!opts.dryRun;
  const ageCutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  const scanned = scanHashDirs(rootDir);
  const removed: PrunedEntry[] = [];

  // Group by language so we can apply the keep-N policy per language.
  const byLang = new Map<string, ScannedHashDir[]>();
  for (const e of scanned) {
    const arr = byLang.get(e.language);
    if (arr) arr.push(e);
    else byLang.set(e.language, [e]);
  }

  for (const [, entries] of byLang) {
    // Age sweep first: anything older than the cutoff is removed regardless
    // of how many siblings there are.
    const survivors: ScannedHashDir[] = [];
    for (const e of entries) {
      if (e.lastTouchedMs > 0 && e.lastTouchedMs < ageCutoffMs) {
        removed.push({ ...e, reason: "age" });
      } else {
        survivors.push(e);
      }
    }
    // LRU cap: keep only the `keepRecent` most-recently-touched survivors.
    if (survivors.length > keepRecent) {
      survivors.sort((a, b) => b.lastTouchedMs - a.lastTouchedMs);
      const evicted = survivors.slice(keepRecent);
      for (const e of evicted) removed.push({ ...e, reason: "lru" });
    }
  }

  if (!dryRun) {
    for (const e of removed) {
      try {
        fs.rmSync(e.fullPath, { recursive: true, force: true });
      } catch {
        // Best-effort: a partial removal still counts toward freed space
        // since the next sweep will retry.
      }
    }
  }

  const freedBytes = removed.reduce((n, e) => n + e.sizeBytes, 0);
  return { rootDir, removed, freedBytes, dryRun };
}

export const SANDBOX_CACHE_PRUNE_STAMP = path.join(
  CONFIG_DIR,
  ".sandbox-cache-prune-stamp",
);

export interface OpportunisticPruneOptions extends PruneSandboxCacheOptions {
  // How long to wait between real prune sweeps. Default 24h. Anything below
  // this returns immediately without scanning the cache.
  debounceHours?: number;
  // Override stamp file path (test hook).
  stampPath?: string;
  // Override "now" (test hook).
  nowMs?: number;
}

export interface OpportunisticPruneOutcome {
  ran: boolean;
  reason: "debounced" | "stamp-missing" | "stamp-stale" | "stamp-unreadable";
  result?: PruneSandboxCacheResult;
}

// Called once per CLI invocation. The debounce stamp ensures we don't pay
// the readdir cost on every short-lived `prepsavant grade` call. Errors
// are swallowed so a flaky filesystem can never break the foreground
// command.
export function pruneSandboxCacheOpportunistic(
  opts: OpportunisticPruneOptions = {},
  rootDir: string = SANDBOX_CACHE_DIR,
): OpportunisticPruneOutcome {
  const debounceHours = opts.debounceHours ?? 24;
  const stampPath = opts.stampPath ?? SANDBOX_CACHE_PRUNE_STAMP;
  const now = opts.nowMs ?? Date.now();
  const debounceMs = debounceHours * 60 * 60 * 1000;

  let reason: OpportunisticPruneOutcome["reason"] = "stamp-missing";
  try {
    const st = fs.statSync(stampPath);
    if (now - st.mtimeMs < debounceMs) {
      return { ran: false, reason: "debounced" };
    }
    reason = "stamp-stale";
  } catch {
    // Stamp missing or unreadable — fall through to a real sweep so
    // first-run installs still get pruned.
    reason = "stamp-missing";
  }

  let result: PruneSandboxCacheResult | undefined;
  try {
    result = pruneSandboxCache(opts, rootDir);
  } catch {
    // Swallow — never break the foreground CLI command.
  }

  // Update the stamp regardless of whether the sweep found anything, so we
  // don't busy-loop scanning an empty cache.
  try {
    fs.mkdirSync(path.dirname(stampPath), { recursive: true });
    const t = now / 1000;
    if (fs.existsSync(stampPath)) {
      fs.utimesSync(stampPath, t, t);
    } else {
      fs.writeFileSync(stampPath, "");
      fs.utimesSync(stampPath, t, t);
    }
  } catch {
    // Best-effort.
  }

  return result !== undefined
    ? { ran: true, reason, result }
    : { ran: false, reason: "stamp-unreadable" };
}
