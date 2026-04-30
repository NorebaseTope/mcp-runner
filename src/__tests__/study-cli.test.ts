// Unit tests for the `prepsavant study` CLI flow (task-531).
//
// Pins the user-visible contracts that scripts and CI rely on:
//   * --help prints the expected sections (so doc references stay valid)
//   * Unauthenticated --json emits a single-line {error:"not_authenticated"}
//   * Unauthenticated human-mode emits a plain-text error and sets exitCode=1
//
// Network-bearing paths (the JSON preflight that would call
// createStudyConversation) are exercised in
// artifacts/api-server/src/__tests__/runnerStudyConversation.test.ts —
// here we stay out-of-process and only assert local behaviour.
//
// We point HOME at a temp dir BEFORE importing the CLI module so that the
// config module — which captures `os.homedir()` at module-load time — sees
// our throwaway path and doesn't pick up the developer's real
// ~/.prepsavant/config.json (which would have a real token).

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "prepsavant-study-cli-"));
process.env["HOME"] = tmpHome;
process.env["USERPROFILE"] = tmpHome; // Windows fallback for os.homedir()

const { runStudyStart } = await import("../study/cli-start.js");

function captureStreams(): {
  stdout: string[];
  stderr: string[];
  restore: () => void;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: unknown) => {
    stdout.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderr.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return {
    stdout,
    stderr,
    restore: () => {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    },
  };
}

test("study --help prints sections describing study mode and the MCP tools", async () => {
  const cap = captureStreams();
  try {
    await runStudyStart({ help: true });
  } finally {
    cap.restore();
  }
  const out = cap.stdout.join("");
  assert.match(out, /prepsavant study/);
  assert.match(out, /--question/);
  assert.match(out, /--post-session/);
  assert.match(out, /study_start/);
  assert.match(out, /study_send_message/);
  assert.match(out, /study_get_history/);
});

test("study --json without auth emits {error:'not_authenticated'} on stderr", async () => {
  const cap = captureStreams();
  const prevExitCode = process.exitCode;
  try {
    await runStudyStart({ json: true });
  } finally {
    cap.restore();
  }
  assert.equal(cap.stdout.join(""), "", "no stdout output on error path");
  const err = cap.stderr.join("").trim();
  const parsed = JSON.parse(err) as { error: string };
  assert.equal(parsed.error, "not_authenticated");
  assert.equal(process.exitCode, 1, "exit code should be 1 on auth failure");
  process.exitCode = prevExitCode;
});

test("study (human mode) without auth emits a plain-text instruction", async () => {
  const cap = captureStreams();
  const prevExitCode = process.exitCode;
  try {
    await runStudyStart({});
  } finally {
    cap.restore();
  }
  assert.equal(cap.stdout.join(""), "", "no stdout output on error path");
  const err = cap.stderr.join("");
  assert.match(err, /No device token/);
  assert.match(err, /prepsavant auth/);
  assert.equal(process.exitCode, 1);
  process.exitCode = prevExitCode;
});
