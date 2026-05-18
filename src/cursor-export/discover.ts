// Task #1176 — best-effort discovery of a Cursor session export on the
// local filesystem.
//
// Task #1499 — search scope was narrowed to the question-package
// folder ONLY (its root + `.cursor/` + `.prepsavant/` subfolders).
// The previous fallbacks (Cursor's per-workspace storage, the User
// data root, ~/Downloads / ~/Desktop / ~/Documents) were removed so
// the runner's behavior matches what the practice page tells users:
// "export the chat into this folder". Power users can still pass
// `--file <path>` to upload from anywhere on disk.
//
// Files must match a `cursor-*` / `prepsavant-cursor-*` name pattern,
// be markdown / txt / json, and have an mtime within `maxAgeMs`.
// Returns the chosen file's contents so the caller is a pure HTTP step.
import * as fs from "node:fs";
import * as path from "node:path";

export type DiscoveryResult =
  | {
      status: "uploaded";
      sourcePath: string;
      mimeType: string;
      sizeBytes: number;
      contents: Buffer;
    }
  | {
      status: "not_found";
      searchedPaths: string[];
    }
  | {
      status: "failed";
      reason: string;
      sourcePath?: string;
    };

export interface DiscoverOptions {
  workspaceDir?: string;
  maxAgeMs?: number;
  maxBytes?: number;
  now?: () => number;
}

const DEFAULT_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

const NAME_PATTERN =
  /(cursor[-_ ]?(chat|export|session|conversation)|prepsavant[-_ ]?cursor[-_ ]?export)/i;
const ALLOWED_EXT = new Set([".md", ".markdown", ".txt", ".json"]);

interface Candidate {
  fullPath: string;
  mtimeMs: number;
  sizeBytes: number;
  /** Higher = matched workspace.json identity, scanned first. */
  priority: number;
}

function listCandidates(
  dir: string,
  maxBytes: number,
  priority: number,
): Candidate[] {
  const out: Candidate[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) continue;
    if (!NAME_PATTERN.test(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }
    if (stat.size > maxBytes) continue;
    out.push({
      fullPath,
      mtimeMs: stat.mtimeMs,
      sizeBytes: stat.size,
      priority,
    });
  }
  return out;
}

function pickMimeType(p: string): string {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".json") return "application/json";
  if (ext === ".txt") return "text/plain";
  return "text/markdown";
}

export function discoverCursorExport(
  opts: DiscoverOptions = {},
): DiscoveryResult {
  const now = (opts.now ?? Date.now)();
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  // Task #1499 — workspace-folder-only search. Without a workspace
  // dir there is nothing meaningful to search; surface that clearly
  // rather than silently scanning the user's home tree.
  const dirs: Array<[string, number]> = [];
  if (opts.workspaceDir) {
    dirs.push([opts.workspaceDir, 30]);
    dirs.push([path.join(opts.workspaceDir, ".cursor"), 30]);
    dirs.push([path.join(opts.workspaceDir, ".prepsavant"), 30]);
  }

  const seen = new Set<string>();
  const all: Candidate[] = [];
  const searched: string[] = [];
  for (const [dir, priority] of dirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    searched.push(dir);
    for (const c of listCandidates(dir, maxBytes, priority)) all.push(c);
  }

  if (all.length === 0) return { status: "not_found", searchedPaths: searched };

  const fresh = all.filter((c) => now - c.mtimeMs <= maxAgeMs);
  fresh.sort(
    (a, b) => b.priority - a.priority || b.mtimeMs - a.mtimeMs,
  );
  const pick = fresh[0];
  if (!pick) return { status: "not_found", searchedPaths: searched };

  let contents: Buffer;
  try {
    contents = fs.readFileSync(pick.fullPath);
  } catch (err) {
    return {
      status: "failed",
      reason: `read_failed: ${(err as Error).message}`,
      sourcePath: pick.fullPath,
    };
  }
  return {
    status: "uploaded",
    sourcePath: pick.fullPath,
    mimeType: pickMimeType(pick.fullPath),
    sizeBytes: pick.sizeBytes,
    contents,
  };
}
