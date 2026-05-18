// Sidecar workspace snapshot store.
// Uses a shadow git repository *outside* the candidate's working tree so
// nothing is written into their repo. The shadow repo is initialized with
// git init --bare equivalent and snapshots are committed via:
//   git --git-dir=<shadow>/shadow.git --work-tree=<workspace> add -A
//   git --git-dir=<shadow>/shadow.git --work-tree=<workspace> commit -m <msg>
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";

export interface SnapshotStoreOptions {
  sessionId: string;
  workspaceDir: string;
}

export interface SnapshotResult {
  commitSha: string;
  parentSha: string | null;
  filesChanged: number;
  kind: string;
}

const MAX_FILE_SIZE_BYTES = 512 * 1024; // 512 KB

// Path segments that look like editor/build noise rather than the user
// editing real source files. Mirrored from `coached/session.ts`'s
// `IGNORED_WATCH_SEGMENTS` so the diff-aware nudge (Task #832) and the
// fs-watcher stall detector agree on what counts as a "real" edit.
// Keeping the set here lets `SnapshotStore.getDiffSince` filter
// generated-file noise out of the prompt the host model sees, even
// when the user's repo doesn't have a `.gitignore` for them.
const IGNORED_DIFF_SEGMENTS: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  ".git",
]);

function isIgnoredDiffPath(filename: string): boolean {
  if (!filename) return true;
  const segments = filename.split(/[\\/]/);
  for (const seg of segments) {
    if (!seg) continue;
    if (IGNORED_DIFF_SEGMENTS.has(seg)) return true;
    // Catch-all for dotfile-only writes (`.eslintcache`, `.DS_Store`,
    // editor/LSP cache flushes under `.vscode/`, `.idea/`, etc).
    if (seg.startsWith(".")) return true;
  }
  return false;
}

export class SnapshotStore {
  private readonly gitDir: string;
  private readonly workDir: string;
  private parentSha: string | null = null;
  private initialized = false;

  constructor(opts: SnapshotStoreOptions) {
    this.gitDir = SnapshotStore.shadowGitDir(opts.sessionId);
    this.workDir = opts.workspaceDir;
  }

  static shadowGitDir(sessionId: string): string {
    if (process.platform === "darwin") {
      return path.join(
        os.homedir(),
        "Library", "Application Support", "PrepSavant", "sessions", sessionId, "shadow.git",
      );
    }
    if (process.platform === "win32") {
      return path.join(
        process.env.LOCALAPPDATA ?? os.homedir(),
        "PrepSavant", "sessions", sessionId, "shadow.git",
      );
    }
    return path.join(
      os.homedir(),
      ".local", "share", "prepsavant", "sessions", sessionId, "shadow.git",
    );
  }

  // Initialize the shadow git repo. Must be called before snapshot().
  initialize(): void {
    if (this.initialized) return;
    fs.mkdirSync(this.gitDir, { recursive: true, mode: 0o700 });
    this.git(["init", "--bare"]);
    // Write Sam-specific gitignore via git config
    this.git(["config", "user.email", "sam@prepsavant.com"]);
    this.git(["config", "user.name", "Sam (PrepSavant)"]);
    this.initialized = true;
  }

  isWritable(): boolean {
    try {
      this.initialize();
      return true;
    } catch {
      return false;
    }
  }

  // Commit an empty baseline for sessions that start in an empty workspace
  // (Task #832). The Coached check-in flow needs *some* baseline SHA so
  // that diffs taken after the candidate's first edit have an anchor; if
  // we leave `baselineSha` null, every subsequent check-in short-circuits
  // through `skipped:no_baseline` and the diff-aware nudge never fires.
  // Uses `commit --allow-empty` so the resulting tree is empty but the
  // commit is real, and any later snapshot can diff against it normally.
  // Returns the commit SHA on success, null on failure (caller falls back
  // to the static directive line — same path as a missing baseline).
  ensureBaselineCommit(kind: string): string | null {
    if (!this.initialized) return null;
    // First try a normal staged commit — if there are files in the
    // workspace, prefer that so the baseline reflects pre-existing code.
    const staged = this.snapshot(kind);
    if (staged) return staged.commitSha;
    // Empty workspace path: force an empty commit so we still anchor a SHA.
    const commitResult = spawnSync(
      "git",
      [
        "--git-dir", this.gitDir, "--work-tree", this.workDir,
        "commit", "--allow-empty", "-m", `sam: ${kind} (empty)`,
      ],
      { encoding: "utf-8" },
    );
    if (commitResult.status !== 0) return null;
    const shaResult = spawnSync(
      "git",
      ["--git-dir", this.gitDir, "rev-parse", "HEAD"],
      { encoding: "utf-8" },
    );
    if (shaResult.status !== 0) return null;
    const sha = shaResult.stdout.trim();
    this.parentSha = sha;
    return sha;
  }

  // Take a snapshot of the workspace. Returns null when there are no changes.
  snapshot(kind: string): SnapshotResult | null {
    if (!this.initialized) this.initialize();

    // Stage all files (respects .gitignore in the work-tree)
    const addResult = spawnSync(
      "git",
      ["--git-dir", this.gitDir, "--work-tree", this.workDir, "add", "-A"],
      { encoding: "utf-8" },
    );
    if (addResult.status !== 0) return null;

    // Enforce file-size cap: un-stage any file larger than MAX_FILE_SIZE_BYTES
    // to prevent oversized generated/binary artifacts from bloating the shadow repo.
    const stagedFilesResult = spawnSync(
      "git",
      ["--git-dir", this.gitDir, "--work-tree", this.workDir, "diff", "--cached", "--name-only"],
      { encoding: "utf-8" },
    );
    const stagedFiles = (stagedFilesResult.stdout ?? "").trim().split("\n").filter(Boolean);
    for (const relPath of stagedFiles) {
      const absPath = path.join(this.workDir, relPath);
      try {
        const stat = fs.statSync(absPath);
        if (stat.size > MAX_FILE_SIZE_BYTES) {
          spawnSync(
            "git",
            ["--git-dir", this.gitDir, "--work-tree", this.workDir, "rm", "--cached", relPath],
            { encoding: "utf-8" },
          );
        }
      } catch {
        // File may have been deleted after staging — ignore
      }
    }

    // Check if there is anything to commit
    const statusResult = spawnSync(
      "git",
      ["--git-dir", this.gitDir, "--work-tree", this.workDir, "status", "--porcelain"],
      { encoding: "utf-8" },
    );
    const statusLines = (statusResult.stdout ?? "").trim().split("\n").filter(Boolean);
    if (statusLines.length === 0) return null;

    const commitMsg = `sam: ${kind} snapshot`;
    const commitResult = spawnSync(
      "git",
      ["--git-dir", this.gitDir, "--work-tree", this.workDir, "commit", "-m", commitMsg],
      { encoding: "utf-8" },
    );
    if (commitResult.status !== 0) return null;

    // Get the commit SHA
    const shaResult = spawnSync(
      "git",
      ["--git-dir", this.gitDir, "rev-parse", "HEAD"],
      { encoding: "utf-8" },
    );
    const commitSha = shaResult.stdout.trim();
    const result: SnapshotResult = {
      commitSha,
      parentSha: this.parentSha,
      filesChanged: statusLines.length,
      kind,
    };
    this.parentSha = commitSha;
    return result;
  }

  // Textual diff between `baseSha` and `HEAD` in the shadow repo, capped at
  // a byte budget. Used by the Coached runner to ground Sam's check-in voice
  // line in what the candidate actually changed (Task #832). Trims by
  // dropping the largest per-file patches first so we never return a partial
  // hunk — partial diffs would mislead the model more than no diff at all.
  //
  // Behaviour:
  //   - returns `{ diff: "", truncated: false, filesChanged: 0 }` when the
  //     store isn't initialized or there is nothing to diff.
  //   - filters out generated-file noise paths (node_modules, dist, .git,
  //     dotfiles, etc.) so the host model sees only candidate-authored
  //     code — matches the fs-watcher ignore rules in `coached/session.ts`.
  //   - skips binary files (detected via `git diff --numstat` reporting
  //     `-` for added/deleted lines) so we never ship base64-style blobs
  //     or git's "Binary files … differ" stubs to the model.
  //   - if a single file's diff alone exceeds the budget, we drop it; if
  //     after dropping every oversized file we are still over budget,
  //     `truncated` is true and `diff` is the largest prefix of remaining
  //     files (in original order) that fits.
  //   - never throws; on any git failure returns the empty result.
  getDiffSince(
    baseSha: string,
    opts: { maxBytes?: number } = {},
  ): { diff: string; truncated: boolean; filesChanged: number; fileNames: string[] } {
    const empty = { diff: "", truncated: false, filesChanged: 0, fileNames: [] as string[] };
    if (!this.initialized) return empty;
    if (!baseSha) return empty;
    const maxBytes = Math.max(0, opts.maxBytes ?? 32 * 1024);
    if (maxBytes === 0) return empty;
    try {
      // Use --numstat so we get added/deleted line counts AND a binary
      // marker (`-\t-\t<file>`) in one call. We then filter out:
      //   - paths matching IGNORED_DIFF_SEGMENTS (node_modules, dist,
      //     .git, dotfiles) — generated-file noise the host model can't
      //     reason about and that crowds out real code changes.
      //   - binary files — their patch is either useless ("Binary files
      //     differ") or huge (when git is forced to emit base64), so we
      //     just drop them entirely.
      const numstatResult = spawnSync(
        "git",
        ["--git-dir", this.gitDir, "diff", "--numstat", baseSha, "HEAD"],
        { encoding: "utf-8" },
      );
      if (numstatResult.status !== 0) return empty;
      const files: string[] = [];
      for (const line of (numstatResult.stdout ?? "").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // numstat columns are tab-separated: `<added>\t<deleted>\t<path>`.
        const parts = trimmed.split("\t");
        if (parts.length < 3) continue;
        const [added, deleted, ...rest] = parts;
        const file = rest.join("\t").trim();
        if (!file) continue;
        // Binary files report `-` for both counts.
        if (added === "-" && deleted === "-") continue;
        if (isIgnoredDiffPath(file)) continue;
        files.push(file);
      }
      if (files.length === 0) return empty;

      // Pull each file's diff individually so we can size-budget without
      // ever splitting inside a hunk. Diffs use the standard unified
      // format with file headers ("diff --git a/x b/x ...").
      const perFile: Array<{ path: string; patch: string; size: number }> = [];
      for (const f of files) {
        const r = spawnSync(
          "git",
          [
            "--git-dir", this.gitDir,
            "diff", baseSha, "HEAD", "--", f,
          ],
          { encoding: "utf-8" },
        );
        const patch = r.status === 0 ? (r.stdout ?? "") : "";
        if (!patch) continue;
        perFile.push({ path: f, patch, size: Buffer.byteLength(patch, "utf-8") });
      }
      if (perFile.length === 0) return empty;

      // Compute total budget. If everything fits, no trimming needed.
      const total = perFile.reduce((a, p) => a + p.size, 0);
      if (total <= maxBytes) {
        return {
          diff: perFile.map((p) => p.patch).join(""),
          truncated: false,
          filesChanged: perFile.length,
          fileNames: perFile.map((p) => p.path),
        };
      }

      // Over budget. Drop largest files first until the remaining patches
      // fit. Preserve original file order in the output for stability.
      const survivorPaths = new Set(perFile.map((p) => p.path));
      const bySize = [...perFile].sort((a, b) => b.size - a.size);
      let running = total;
      for (const candidate of bySize) {
        if (running <= maxBytes) break;
        survivorPaths.delete(candidate.path);
        running -= candidate.size;
      }
      const kept = perFile.filter((p) => survivorPaths.has(p.path));
      const truncated = kept.length < perFile.length;
      const diff = kept.map((p) => p.patch).join("");
      // After dropping oversized files everything that survived fits by
      // construction, but defensively re-check and slice if not.
      if (Buffer.byteLength(diff, "utf-8") > maxBytes) {
        return {
          diff: diff.slice(0, maxBytes),
          truncated: true,
          filesChanged: kept.length,
          fileNames: kept.map((p) => p.path),
        };
      }
      return { diff, truncated, filesChanged: kept.length, fileNames: kept.map((p) => p.path) };
    } catch {
      return empty;
    }
  }

  // Return list of file paths that changed in the shadow repo since baseSha
  // (or since the beginning if baseSha is null). Used for Cursor edit-hook
  // reconciliation — compares snapshot authority against hook-observed edits.
  getChangedFilesSince(baseSha: string | null): string[] {
    if (!this.initialized) return [];
    try {
      const args = baseSha
        ? ["--git-dir", this.gitDir, "diff", "--name-only", baseSha, "HEAD"]
        : ["--git-dir", this.gitDir, "log", "--name-only", "--format=", "HEAD"];
      const r = spawnSync("git", args, { encoding: "utf-8" });
      if (r.status !== 0) return [];
      return r.stdout.trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  // Get the tree hash of the latest commit.
  getTreeHash(): string | null {
    const result = spawnSync(
      "git",
      ["--git-dir", this.gitDir, "rev-parse", "HEAD^{tree}"],
      { encoding: "utf-8" },
    );
    if (result.status !== 0) return null;
    return result.stdout.trim();
  }

  // Clean up the shadow git repo on session end.
  cleanup(): void {
    try {
      fs.rmSync(path.dirname(this.gitDir), { recursive: true, force: true });
    } catch {
      // Best-effort
    }
  }

  private git(args: string[]): void {
    const result = spawnSync("git", args, {
      cwd: this.gitDir,
      encoding: "utf-8",
    });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
  }
}
