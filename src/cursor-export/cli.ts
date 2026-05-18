// Task #1176 (Cursor-first v1, Milestone 6) — `prepsavant upload-cursor-
// export` CLI command. Lets a user manually upload a Cursor session
// export when the auto-discover-at-session-end path missed it (e.g.
// they exported the chat after the runner had already shut down).
//
// Usage:
//   prepsavant upload-cursor-export --session-id <id>
//                                   [--file <path>]
//                                   [--workspace <dir>]
//                                   [--json]
//
// If `--file` is provided we upload that file verbatim; otherwise we
// run the same discovery the auto-upload path uses, scoped to either
// `--workspace` or the cwd.
import * as fs from "node:fs";
import * as path from "node:path";
import { readConfig } from "../config.js";
import { SamApi, ApiError } from "../api.js";
import { discoverCursorExport } from "./discover.js";
import { uploadDiscoveryResult } from "./upload.js";
import { readLastSession } from "../last-session.js";
import {
  findQuestionPackagesNearby,
  renderCdCommand,
} from "../coached/cli-start.js";

export async function runUploadCursorExport(
  flags: Record<string, string | boolean>,
): Promise<void> {
  const isJson = !!flags.json;
  const workspace =
    (flags.workspace as string | undefined) ?? process.cwd();

  // Task #1479 — auto-discover the session id from
  // `.prepsavant/last-session.json` when the user didn't pass
  // `--session-id`. The breadcrumb is written by `prepsavant start`
  // (both coached and ai_assisted) into the question-package folder,
  // so the typical `cd <folder> && prepsavant upload-cursor-export`
  // flow needs zero flags. Explicit `--session-id` still wins so
  // scripts that operate outside the folder keep working.
  let sessionId = flags["session-id"] as string | undefined;
  let sessionIdSource: "flag" | "last-session" | null = sessionId
    ? "flag"
    : null;
  if (!sessionId) {
    const last = readLastSession(workspace);
    if (last) {
      sessionId = last.sessionId;
      sessionIdSource = "last-session";
    }
  }
  if (!sessionId) {
    // Task #1479 — wrong-folder hint. If the user ran us from
    // somewhere that's missing the breadcrumb, sniff the same
    // obvious nearby spots `prepsavant start` checks
    // (~/Downloads, ~/Desktop, CWD's parent/children — one level
    // deep) for unzipped question packages and surface them as
    // copy-paste `cd <dir>` commands. We only ever HINT — never
    // auto-cd or auto-upload — and we use `renderCdCommand` to drop
    // any path whose name can't be rendered safely on one line.
    const baseMessage = [
      "Could not determine which session this export belongs to.",
      "Either pass --session-id <id>, or `cd` into the question-package",
      "folder where you ran `prepsavant start` (the runner stores the",
      "session id in `.prepsavant/last-session.json`).",
    ];
    let nearby: ReturnType<typeof findQuestionPackagesNearby> = [];
    try {
      nearby = findQuestionPackagesNearby(workspace);
    } catch {
      nearby = [];
    }
    if (nearby.length > 0 && !isJson) {
      const hintLines: string[] = [
        ...baseMessage,
        "",
        nearby.length === 1
          ? "Looks like you may be in the wrong folder. I found a question package nearby:"
          : `Looks like you may be in the wrong folder. I found ${nearby.length} question packages nearby:`,
        "",
      ];
      for (const pkg of nearby) {
        const title = pkg.title ? ` — ${pkg.title}` : "";
        const rendered = renderCdCommand(pkg.dir);
        if (rendered === null) {
          hintLines.push(
            `  (folder has an unusual name — cd into it manually) ${pkg.dir}${title}`,
          );
        } else {
          hintLines.push(`  ${rendered}${title}`);
        }
      }
      hintLines.push(
        "",
        "Then re-run `prepsavant upload-cursor-export` (no flags needed).",
      );
      fail(isJson, "missing_session_id", hintLines.join("\n"));
      return;
    }
    fail(isJson, "missing_session_id", baseMessage.join("\n"));
    return;
  }

  const cfg = readConfig();
  if (!cfg.token) {
    fail(
      isJson,
      "not_authenticated",
      "No device token. Run `prepsavant auth` first.",
    );
    return;
  }
  const api = new SamApi(cfg);

  const filePath = flags.file as string | undefined;

  let result;
  if (filePath) {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      fail(isJson, "file_not_found", `File not found: ${resolved}`);
      return;
    }
    let contents: Buffer;
    try {
      contents = fs.readFileSync(resolved);
    } catch (err) {
      fail(
        isJson,
        "read_failed",
        `Could not read file: ${(err as Error).message}`,
      );
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    const mimeType =
      ext === ".json"
        ? "application/json"
        : ext === ".txt"
          ? "text/plain"
          : "text/markdown";
    result = await uploadDiscoveryResult({
      api,
      sessionId,
      source: "manual",
      discovery: {
        status: "uploaded",
        sourcePath: resolved,
        mimeType,
        sizeBytes: contents.byteLength,
        contents,
      },
    });
  } else {
    const discovery = discoverCursorExport({ workspaceDir: workspace });
    result = await uploadDiscoveryResult({
      api,
      sessionId,
      source: "manual",
      discovery,
    });
  }

  if (isJson) {
    process.stdout.write(
      JSON.stringify({ sessionId, sessionIdSource, ...result }) + "\n",
    );
    if (result.status === "failed") process.exitCode = 1;
    return;
  }

  if (result.status === "uploaded") {
    const sourceNote =
      sessionIdSource === "last-session"
        ? ` (session id auto-detected from .prepsavant/last-session.json)`
        : "";
    process.stdout.write(
      `Uploaded ${result.sizeBytes ?? "?"} bytes from ${result.sourcePath}${sourceNote}.\n`,
    );
    return;
  }
  if (result.status === "not_found") {
    // Task #1499 — the discoverer no longer scans ~/Downloads / Desktop
    // / Documents. The fix is to export the chat INTO the question-
    // package folder (or its `.cursor/` / `.prepsavant/` subfolder),
    // not to widen the search. Spell that out instead of pointing at
    // paths we don't actually look in.
    process.stdout.write(
      `Could not locate a Cursor export inside ${workspace} (or its .cursor/ / .prepsavant/ subfolders).\n` +
        "In Cursor: Cmd/Ctrl+Shift+P → 'Cursor Chat: Export', then save the file INTO this folder and re-run.\n" +
        "Escape hatch: re-run with --file <path> to upload from anywhere on disk.\n",
    );
    return;
  }
  process.stderr.write(
    `Upload failed: ${result.reason ?? "unknown"}${result.sourcePath ? ` (file: ${result.sourcePath})` : ""}\n`,
  );
  process.exitCode = 1;
}

function fail(isJson: boolean, code: string, message: string): void {
  if (isJson) {
    process.stderr.write(JSON.stringify({ error: code, message }) + "\n");
  } else {
    process.stderr.write(message + "\n");
  }
  process.exitCode = 1;
}

// Re-export for test convenience.
export { discoverCursorExport };
export { ApiError };
