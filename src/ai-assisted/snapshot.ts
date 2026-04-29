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
