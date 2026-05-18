// Task #1411 — focused regression for `prepsavant start`'s
// active-session prompt (Task #1388). Covers the three branches the
// CLI exposes when the user re-runs from inside a question-package
// folder while a live session for the same question already exists:
//
//   (a) default-Yes prompt — empty answer, "y", "yes" all confirm;
//       "n", "no" abort. Locked in via promptYesDefault() against a
//       fake TTY input stream.
//   (b) --replace — runCoachedStart calls
//       createSessionFromQuestionPackage with replace:true and the
//       --json branch prints the new sessionId.
//   (c) --no-replace — runCoachedStart aborts with the
//       active_session_exists exit code without ever calling
//       createSessionFromQuestionPackage.
//
// We monkey-patch SamApi.prototype so the test never touches the
// network. The manifest is dropped into a tmpdir whose
// .prepsavant/question.json is what runCoachedStart reads via the
// `cwd` flag.

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";

import { promptYesDefault, runCoachedStart } from "../coached/cli-start.js";
import { SamApi, ApiError } from "../api.js";
import { CONFIG_PATH, ensureConfigDir } from "../config.js";

function makeFakeTtyInput(answer: string): NodeJS.ReadableStream & {
  isTTY: boolean;
} {
  const stream = new PassThrough() as PassThrough & { isTTY: boolean };
  stream.isTTY = true;
  // readline reads line-by-line; one push + end is enough.
  process.nextTick(() => {
    stream.write(answer);
    stream.end();
  });
  return stream;
}

function makeSinkOutput(): NodeJS.WritableStream & { chunks: string[] } {
  const out = new PassThrough() as PassThrough & { chunks: string[] };
  out.chunks = [];
  out.on("data", (c) => out.chunks.push(c.toString("utf-8")));
  return out;
}

test("Task #1411 — promptYesDefault treats empty answer as Yes", async () => {
  const input = makeFakeTtyInput("\n");
  const output = makeSinkOutput();
  const got = await promptYesDefault("End it and start a new one?", {
    input,
    output,
  });
  assert.equal(got, true, "empty answer must default to Yes");
  assert.match(
    output.chunks.join(""),
    /\[Y\/n\]/,
    "prompt should advertise the default with [Y/n]",
  );
});

test("Task #1411 — promptYesDefault accepts y/yes (case-insensitive)", async () => {
  for (const answer of ["y\n", "Y\n", "yes\n", "YES\n", "  y  \n"]) {
    const got = await promptYesDefault("?", {
      input: makeFakeTtyInput(answer),
      output: makeSinkOutput(),
    });
    assert.equal(got, true, `answer ${JSON.stringify(answer)} should be Yes`);
  }
});

test("Task #1411 — promptYesDefault treats n/no as a refusal", async () => {
  for (const answer of ["n\n", "N\n", "no\n", "NO\n"]) {
    const got = await promptYesDefault("?", {
      input: makeFakeTtyInput(answer),
      output: makeSinkOutput(),
    });
    assert.equal(got, false, `answer ${JSON.stringify(answer)} should be No`);
  }
});

test("Task #1411 — promptYesDefault refuses without a TTY", async () => {
  const stream = new PassThrough() as PassThrough & { isTTY?: boolean };
  // No isTTY → must not block on a prompt; default to "no replace".
  const got = await promptYesDefault("?", {
    input: stream,
    output: makeSinkOutput(),
  });
  assert.equal(got, false);
});

// ---------------------------------------------------------------------
// runCoachedStart branch coverage. The two flag branches we exercise
// with --json (so the function exits early, before TerminalCoach):
// --replace + active session, and --no-replace + active session.
// ---------------------------------------------------------------------

interface StubCalls {
  active: string[];
  starts: Array<{ replace: boolean | undefined }>;
}

function installSamApiStubs(opts: {
  active: { id: string; questionId: string } | null;
  // When true, createSessionFromQuestionPackage records the call and
  // then throws an ApiError(500). Used by the interactive-Yes prompt
  // test to short-circuit BEFORE startTerminalCoach takes over the
  // terminal — otherwise the test process would hang on coach.done.
  // We still get to assert that replace:true was propagated because
  // the recording happens before the throw.
  throwOnStart?: boolean;
}): {
  calls: StubCalls;
  restore: () => void;
} {
  const calls: StubCalls = { active: [], starts: [] };
  const origActive = SamApi.prototype.getActiveSessionForQuestion;
  const origStart = SamApi.prototype.createSessionFromQuestionPackage;
  SamApi.prototype.getActiveSessionForQuestion = async function (
    questionId: string,
  ) {
    calls.active.push(questionId);
    if (!opts.active) return { active: null };
    return {
      active: {
        id: opts.active.id,
        questionId: opts.active.questionId,
        mode: "coached",
        status: "active",
        startedAt: new Date().toISOString(),
      },
    };
  };
  SamApi.prototype.createSessionFromQuestionPackage = async function (
    body: { manifest: unknown; replace?: boolean; targetDurationMinutes?: number },
  ) {
    calls.starts.push({ replace: body.replace });
    if (opts.throwOnStart) {
      throw new ApiError(500, "internal_error", "stubbed start failure");
    }
    return {
      session: { id: "ses_t1411_stub_new" },
      kickoffBriefVerbatim: "stub brief",
      hostInstructionsVerbatim: "stub host instructions",
      hintLadderLength: 3,
      replacedSessionId: opts.active?.id ?? null,
      question: {
        id: "q_t1411_stub",
        title: "Stub Question",
        prompt: "stub prompt",
      },
    };
  };
  return {
    calls,
    restore: () => {
      SamApi.prototype.getActiveSessionForQuestion = origActive;
      SamApi.prototype.createSessionFromQuestionPackage = origStart;
    },
  };
}

interface IoCapture {
  stdout: string[];
  stderr: string[];
  restore: () => void;
}

function captureProcessIo(): IoCapture {
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
      // Intentionally NOT restoring process.exitCode here — callers
      // assert on it after restore() returns. Each test is responsible
      // for resetting process.exitCode = 0 before exercising a fail
      // branch.
    },
  };
}

function makePackageDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t1411-pkg-"));
  fs.mkdirSync(path.join(dir, ".prepsavant"), { recursive: true });
  // The CLI only requires { questionId, hmac } to drive the active-session
  // check; the server (mocked here) re-verifies HMAC, so a stub value is
  // fine for these branch tests.
  const manifest = {
    v: 2,
    questionId: "q_t1411_stub",
    questionTitle: "Stub Question",
    reviewKind: "tests" as const,
    language: "python",
    companyId: null,
    jobId: null,
    apiBaseUrl: "http://127.0.0.1.test",
    ownerId: "usr_t1411_stub",
    issuedAt: new Date().toISOString(),
    nonce: "deadbeefcafebabe1234",
    hmac: "0".repeat(64),
  };
  fs.writeFileSync(
    path.join(dir, ".prepsavant", "question.json"),
    JSON.stringify(manifest, null, 2),
  );
  return dir;
}

// readConfig() reads ~/.prepsavant/config.json synchronously each
// invocation, so we back up the user's real config (if any), drop a
// stub in its place, and restore on teardown. Avoids ESM
// monkey-patching which fails on read-only module records.
function stubReadConfig(): () => void {
  ensureConfigDir();
  const backup = fs.existsSync(CONFIG_PATH)
    ? fs.readFileSync(CONFIG_PATH)
    : null;
  fs.writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      apiBaseUrl: "http://127.0.0.1.test",
      token: "ps_dev_t1411_stub_token",
    }),
    { mode: 0o600 },
  );
  return () => {
    if (backup !== null) {
      fs.writeFileSync(CONFIG_PATH, backup, { mode: 0o600 });
    } else {
      try {
        fs.unlinkSync(CONFIG_PATH);
      } catch {
        /* noop */
      }
    }
  };
}

test("Task #1411 — --replace + active session calls createSession with replace:true", async () => {
  const restoreCfg = stubReadConfig();
  const { calls, restore: restoreApi } = installSamApiStubs({
    active: { id: "ses_t1411_stub_old", questionId: "q_t1411_stub" },
  });
  const io = captureProcessIo();
  const dir = makePackageDir();

  try {
    await runCoachedStart({
      json: true,
      replace: true,
      cwd: dir,
    });
  } finally {
    io.restore();
    restoreApi();
    restoreCfg();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  assert.equal(calls.active.length, 1, "should check for an active session");
  assert.equal(calls.starts.length, 1, "should mint a fresh session");
  assert.equal(
    calls.starts[0]!.replace,
    true,
    "--replace must propagate as replace:true to the server",
  );
  const stdout = io.stdout.join("");
  assert.match(
    stdout,
    /ses_t1411_stub_new/,
    "JSON output should report the new sessionId",
  );
  assert.notEqual(
    process.exitCode,
    1,
    "happy --replace path must not set a failure exit code",
  );
});

// Prompt-branch coverage. With an active session and NEITHER --replace
// nor --no-replace and NOT --json, runCoachedStart must consult
// promptYesDefault. We can't inject input/output through the public
// API at this layer, so we temporarily override process.stdin /
// process.stdout the same way promptYesDefault reads them.
function withFakeStdin(answer: string, fn: () => Promise<void>): Promise<void> {
  const origStdinDesc = Object.getOwnPropertyDescriptor(process, "stdin");
  const origStdoutDesc = Object.getOwnPropertyDescriptor(process, "stdout");
  const fakeStdin = makeFakeTtyInput(answer);
  const fakeStdout = makeSinkOutput();
  Object.defineProperty(process, "stdin", {
    configurable: true,
    get: () => fakeStdin,
  });
  Object.defineProperty(process, "stdout", {
    configurable: true,
    get: () => fakeStdout,
  });
  return fn().finally(() => {
    if (origStdinDesc) Object.defineProperty(process, "stdin", origStdinDesc);
    if (origStdoutDesc) Object.defineProperty(process, "stdout", origStdoutDesc);
  });
}

test("Task #1411 — interactive empty-line answer (default Yes) replaces the active session", async () => {
  const restoreCfg = stubReadConfig();
  // throwOnStart short-circuits BEFORE startTerminalCoach takes over
  // the terminal — we'd otherwise hang forever on coach.done. The
  // only thing this branch is asserting is "the prompt confirmed and
  // we propagated replace:true to the server", so failing the create
  // call AFTER it records replace is a faithful proxy.
  const { calls, restore: restoreApi } = installSamApiStubs({
    active: { id: "ses_t1411_stub_old", questionId: "q_t1411_stub" },
    throwOnStart: true,
  });
  const io = captureProcessIo();
  const dir = makePackageDir();
  process.exitCode = 0;

  try {
    await withFakeStdin("\n", async () => {
      await runCoachedStart({ cwd: dir });
    });
  } finally {
    io.restore();
    restoreApi();
    restoreCfg();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  assert.equal(calls.active.length, 1, "should consult the active-session API");
  assert.equal(
    calls.starts.length,
    1,
    "default-Yes prompt should mint a replacement session",
  );
  assert.equal(
    calls.starts[0]!.replace,
    true,
    "default-Yes branch must propagate replace:true",
  );
  process.exitCode = 0;
});

test("Task #1411 — interactive 'n' answer aborts without minting a new session", async () => {
  const restoreCfg = stubReadConfig();
  const { calls, restore: restoreApi } = installSamApiStubs({
    active: { id: "ses_t1411_stub_old", questionId: "q_t1411_stub" },
  });
  const dir = makePackageDir();
  process.exitCode = 0;

  try {
    await withFakeStdin("n\n", async () => {
      await runCoachedStart({ cwd: dir });
    });
  } finally {
    restoreApi();
    restoreCfg();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  assert.equal(calls.active.length, 1, "should still consult the active-session API");
  assert.equal(
    calls.starts.length,
    0,
    "answering 'n' must NOT call createSessionFromQuestionPackage",
  );
  // Refusing the prompt is a graceful abort, not a failure — the CLI
  // prints "Aborted — keeping the existing session." and exits 0.
  assert.notEqual(
    process.exitCode,
    1,
    "interactive abort should not set a failure exit code",
  );
});

test("Task #1411 — --no-replace + active session aborts without minting a new one", async () => {
  const restoreCfg = stubReadConfig();
  const { calls, restore: restoreApi } = installSamApiStubs({
    active: { id: "ses_t1411_stub_old", questionId: "q_t1411_stub" },
  });
  const io = captureProcessIo();
  const dir = makePackageDir();

  // exitCode is process-global; reset before exercising the failure branch.
  process.exitCode = 0;

  try {
    await runCoachedStart({
      json: true,
      "no-replace": true,
      cwd: dir,
    });
  } finally {
    io.restore();
    restoreApi();
    restoreCfg();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  assert.equal(calls.active.length, 1, "should still consult the active-session API");
  assert.equal(
    calls.starts.length,
    0,
    "--no-replace must NOT call createSessionFromQuestionPackage",
  );
  assert.equal(
    process.exitCode,
    1,
    "--no-replace abort must set a non-zero exit code",
  );
  const stderr = io.stderr.join("");
  assert.match(
    stderr,
    /active_session_exists/,
    "--no-replace JSON failure should carry the active_session_exists error code",
  );

  // Reset for downstream tests in the same Node process.
  process.exitCode = 0;
});
