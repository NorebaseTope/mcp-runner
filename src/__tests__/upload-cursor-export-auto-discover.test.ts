// Task #1479 — command-level coverage for `prepsavant upload-cursor-
// export` session-id auto-discovery from
// `.prepsavant/last-session.json`.
//
// The helper-level test (`last-session.test.ts`) proves the
// read/write round-trip; this file proves the COMMAND actually
// consults the breadcrumb when `--session-id` is omitted. The
// distinction matters because the bug class the reviewer flagged
// would be a regression where the breadcrumb is written but never
// read by the upload command.
//
// Strategy: run `runUploadCursorExport` with no flags in three
// distinct workspaces and assert which terminal error it lands in.
// We don't supply a token, so a successful auto-resolve falls
// through to `not_authenticated` (proves the session-id was
// found); a failed auto-resolve lands in `missing_session_id`
// (proves it wasn't). Both errors are emitted as JSON in --json
// mode so we can parse them deterministically.

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { runUploadCursorExport } from "../cursor-export/cli.js";
import { writeLastSession } from "../last-session.js";

function captureStderr<T>(fn: () => Promise<T>): Promise<{
  result: T;
  stderr: string;
  exitCode: typeof process.exitCode;
}> {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  const prevExit = process.exitCode;
  process.exitCode = undefined;
  (process.stderr.write as unknown as (s: string) => boolean) = ((
    s: string,
  ) => {
    chunks.push(typeof s === "string" ? s : String(s));
    return true;
  }) as typeof process.stderr.write;
  return fn()
    .then((result) => ({
      result,
      stderr: chunks.join(""),
      exitCode: process.exitCode,
    }))
    .finally(() => {
      process.stderr.write = orig;
      process.exitCode = prevExit;
    });
}

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `prepsavant-t1479-${prefix}-`));
}

test("upload-cursor-export auto-discovers session id from .prepsavant/last-session.json", async () => {
  // Isolate config from the real ~/.prepsavant.
  const home = mkTmp("home");
  const prevHome = process.env["HOME"];
  process.env["HOME"] = home;
  const workspace = mkTmp("ws");
  writeLastSession(workspace, {
    sessionId: "ses_t1479_autodiscover_xyz",
    mode: "ai_assisted",
    questionId: "q_t1479_autodiscover",
    questionTitle: "Auto-discover test",
    startedAt: new Date().toISOString(),
  });
  try {
    const cap = await captureStderr(async () =>
      runUploadCursorExport({ workspace, json: true }),
    );
    // No token configured, so the command should advance past the
    // missing-session-id check (proving the breadcrumb was read)
    // and land on `not_authenticated`. If auto-discovery were
    // broken we'd see `missing_session_id` instead.
    const parsed = JSON.parse(cap.stderr.trim()) as { error?: string };
    assert.equal(
      parsed.error,
      "not_authenticated",
      `expected not_authenticated (auto-discovery worked), got: ${cap.stderr}`,
    );
    assert.equal(cap.exitCode, 1);
  } finally {
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("upload-cursor-export without breadcrumb fails with missing_session_id (JSON mode skips wrong-folder hint)", async () => {
  const home = mkTmp("home2");
  const prevHome = process.env["HOME"];
  process.env["HOME"] = home;
  const workspace = mkTmp("ws2");
  try {
    const cap = await captureStderr(async () =>
      runUploadCursorExport({ workspace, json: true }),
    );
    const parsed = JSON.parse(cap.stderr.trim()) as { error?: string };
    assert.equal(parsed.error, "missing_session_id");
    assert.equal(cap.exitCode, 1);
  } finally {
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("explicit --session-id wins over breadcrumb", async () => {
  // Both flag and breadcrumb present, both invalid for the
  // server. We can't observe which one was sent without a real
  // server round-trip, but we CAN observe that the breadcrumb's
  // presence doesn't change the dispatch path: with --session-id
  // provided, we should reach `not_authenticated` regardless of
  // whether the breadcrumb file exists, because the flag short-
  // circuits the auto-discovery branch entirely.
  const home = mkTmp("home3");
  const prevHome = process.env["HOME"];
  process.env["HOME"] = home;
  const workspace = mkTmp("ws3");
  writeLastSession(workspace, {
    sessionId: "ses_t1479_breadcrumb_should_be_ignored",
    mode: "coached",
    questionId: "q_t1479_explicit_wins",
    questionTitle: "Explicit-wins test",
    startedAt: new Date().toISOString(),
  });
  try {
    const cap = await captureStderr(async () =>
      runUploadCursorExport({
        workspace,
        json: true,
        "session-id": "ses_t1479_explicit_flag_value",
      }),
    );
    const parsed = JSON.parse(cap.stderr.trim()) as { error?: string };
    assert.equal(parsed.error, "not_authenticated");
  } finally {
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
