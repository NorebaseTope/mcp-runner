// Task #1533 — Runner patch 2.2.1: stop Sam from misusing the Cursor
// editor as the coding-agent CLI.
//
// Three regressions are pinned here:
//   (a) The probe positively identifies a real `cursor-agent --version`
//       response and REJECTS the Cursor editor's `--version` output
//       (multi-line / help-line / Electron dump), surfacing an
//       actionable "install the standalone CLI" remediation instead of
//       silently caching the editor as if it were the agent CLI.
//   (b) On Windows the `["cursor", "agent"]` candidate is no longer
//       attempted, because `cursor.cmd` IS the editor launcher there
//       (`cursor-agent.cmd` is the separate, agent-CLI install).
//   (c) The TerminalRenderer's first footer reservation defensively
//       normalises cursor state, so the in-process Q#1 → Y-restart →
//       Q#2 path can't inherit a stale cursor offset from the previous
//       row's contents (the same input-stomp class of bug Task #1505
//       fixed for the happy path).

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";

import {
  CursorAgentAdapter,
  defaultAgentCandidatesFor,
  looksLikeCursorAgentVersion,
  looksLikeCursorEditor,
} from "../coached/coding-agent.js";
import { TerminalRenderer } from "../coached/terminal-renderer.js";
import type { CoachStream } from "../coached/coach-stream.js";

async function withPlatform<T>(p: NodeJS.Platform, fn: () => Promise<T> | T): Promise<T> {
  const desc = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: p, configurable: true });
  try {
    return await fn();
  } finally {
    if (desc) Object.defineProperty(process, "platform", desc);
  }
}

// ---------------------------------------------------------------------
// (a) Probe positively identifies the agent and rejects editor output.
// ---------------------------------------------------------------------

test("Task #1533 — looksLikeCursorAgentVersion accepts bare semver / `cursor-agent X.Y.Z`", () => {
  assert.equal(looksLikeCursorAgentVersion("0.45.7"), true);
  assert.equal(looksLikeCursorAgentVersion("cursor-agent 0.45.7"), true);
  assert.equal(looksLikeCursorAgentVersion("cursor-agent 1.2.3\n"), true);
});

test("Task #1555 — looksLikeCursorAgentVersion accepts Cursor 3.x `cursor agent --version` 3-line output", () => {
  // Real win32-arm64 output captured from a 2026-05-17 user report:
  //   3.0.12
  //   a80ff7dfcaa45d7750f6e30be457261379c29b00
  //   arm64
  // This is the genuine cursor-agent CLI (shipped as a subcommand of
  // the editor launcher on Cursor 3.x). The 2.2.2 gate rejected it
  // because the 3-line cardinality heuristic incorrectly classified
  // it as editor-shaped, leaving the user stuck in offline mode.
  assert.equal(
    looksLikeCursorAgentVersion(
      "3.0.12\na80ff7dfcaa45d7750f6e30be457261379c29b00\narm64",
    ),
    true,
    "Cursor 3.x 3-line agent reply (semver / commit-sha / arch) must be accepted",
  );
  // Other plausible 3.x shapes that follow the same `<semver>\n<sha>\n<arch>` template.
  assert.equal(
    looksLikeCursorAgentVersion("3.0.12\nabcd1234\nx64"),
    true,
  );
  assert.equal(
    looksLikeCursorAgentVersion("v3.0.12\nabcd1234\narm64"),
    true,
  );
  // First line with extra descriptive text MUST still be rejected —
  // we want the line to be ONLY a semver token, not "Cursor 3.0.12".
  assert.equal(
    looksLikeCursorAgentVersion("Cursor 3.0.12\nabcd1234\narm64"),
    false,
    "first line with a human label (`Cursor 3.0.12`) is editor-shaped, not agent-shaped",
  );
});

test("Task #1555 — looksLikeCursorEditor still catches the editor's 5+ line version dump", () => {
  // The editor's full version banner on Windows is typically 5+ lines
  // (Cursor / VSCode / Commit / Date / Electron / Chromium / Node /
  // V8 / OS). The cardinality fallback must still fire on a banner
  // that happens to drop the explicit fingerprint strings.
  assert.equal(
    looksLikeCursorEditor(
      "Cursor 1.4.2\nVSCode 1.95.3\nCommit abc123\nDate 2026-05-01\nNode 20.11.1\nOS Windows_NT",
    ),
    true,
    "6-line editor banner must still be rejected even without explicit fingerprint",
  );
  // 3-line Cursor 3.x agent reply must NOT trip the cardinality rule.
  assert.equal(
    looksLikeCursorEditor(
      "3.0.12\na80ff7dfcaa45d7750f6e30be457261379c29b00\narm64",
    ),
    false,
    "3-line agent reply must NOT be mis-classified as editor output",
  );
  // 4-line edge case — still under threshold, must pass through.
  assert.equal(
    looksLikeCursorEditor("3.0.12\nsha\narm64\nextra"),
    false,
  );
});

test("Task #1533 — looksLikeCursorEditor catches the editor's tell-tale `--version` shapes", () => {
  // Editor help line emitted when args don't match a known subcommand.
  assert.equal(
    looksLikeCursorEditor(
      "Run with 'cursor -' to read output from another program (e.g. 'echo Hello World | cursor -')",
    ),
    true,
  );
  // Editor multi-line version dump.
  assert.equal(
    looksLikeCursorEditor(
      "Cursor 1.4.2\nCommit: abc123\nElectron: 30.0.0\nChromium: 124.0.6367.78\nNode.js: 20.11.1\nV8: 12.4.254.20\nOS: Windows_NT x64 10.0.22631",
    ),
    true,
  );
  // A real cursor-agent semver line is NOT editor-shaped.
  assert.equal(looksLikeCursorEditor("0.45.7"), false);
  assert.equal(looksLikeCursorEditor("cursor-agent 0.45.7"), false);
});

test("Task #1533 — looksLikeCursorAgentVersion rejects editor-shaped output even when it contains a semver", () => {
  // Editor version dumps DO contain semver tokens (Electron 30.0.0,
  // etc.) — the positive-id helper must still reject them so a probe
  // doesn't latch on to the editor.
  assert.equal(
    looksLikeCursorAgentVersion(
      "Cursor 1.4.2\nCommit: abc123\nElectron: 30.0.0\nChromium: 124.0.6367.78",
    ),
    false,
  );
  assert.equal(
    looksLikeCursorAgentVersion(
      "Run with 'cursor -' to read output from another program (cursor 1.4.2)",
    ),
    false,
  );
});

test("Task #1533 — CursorAgentAdapter.probe() rejects an editor-shaped --version with a standalone-CLI remediation", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "task1533-editor-"));
  try {
    // Simulated `cursor-agent` shim that actually behaves like the
    // editor: exits 0 but prints the Electron-style multi-line block.
    const shim = path.join(tmp, "cursor-agent-shim");
    fs.writeFileSync(
      shim,
      "#!/bin/sh\n" +
        "cat <<'EOF'\n" +
        "Cursor 1.4.2\n" +
        "Commit: deadbeef\n" +
        "Electron: 30.0.0\n" +
        "Chromium: 124.0.6367.78\n" +
        "Node.js: 20.11.1\n" +
        "EOF\n",
    );
    fs.chmodSync(shim, 0o755);

    const adapter = new CursorAgentAdapter({ binPath: shim });
    const probe = await adapter.probe();
    assert.equal(probe.ok, false, `probe should reject editor output, got ${JSON.stringify(probe)}`);
    assert.equal(probe.reason, "not_installed");
    assert.match(probe.remediation ?? "", /standalone `cursor-agent` CLI/);
    assert.match(probe.remediation ?? "", /https:\/\/cursor\.com/);
    assert.match(probe.remediation ?? "", /editor output/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("Task #1533 — CursorAgentAdapter.probe() rejects the editor's help-line `--version` output", async () => {
  // Repro of the in-the-wild Windows-with-editor-only-on-PATH scenario:
  // `cursor.cmd agent --version` exits 0 and prints the editor's
  // built-in help line. Before #1533 the probe cached this as a
  // working agent CLI; with the positive-id check we reject it.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "task1533-helpline-"));
  try {
    const shim = path.join(tmp, "cursor-editor-shim");
    fs.writeFileSync(
      shim,
      "#!/bin/sh\n" +
        "echo \"Run with 'cursor -' to read output from another program (e.g. 'echo Hello World | cursor -')\"\n",
    );
    fs.chmodSync(shim, 0o755);
    const adapter = new CursorAgentAdapter({ binPath: shim });
    const probe = await adapter.probe();
    assert.equal(probe.ok, false);
    assert.equal(probe.reason, "not_installed");
    assert.match(probe.remediation ?? "", /standalone `cursor-agent` CLI/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("Task #1533 — CursorAgentAdapter.probe() still accepts a real cursor-agent semver response", async () => {
  // Belt-and-braces: the positive-id rejection MUST NOT regress the
  // happy path — a single-line bare semver still latches.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "task1533-happy-"));
  try {
    const shim = path.join(tmp, "cursor-agent-shim");
    fs.writeFileSync(shim, "#!/bin/sh\necho 'cursor-agent 0.45.7'\n");
    fs.chmodSync(shim, 0o755);
    const adapter = new CursorAgentAdapter({ binPath: shim });
    const probe = await adapter.probe();
    assert.equal(probe.ok, true, `probe should succeed, got ${JSON.stringify(probe)}`);
    assert.match(probe.version ?? "", /0\.45\.7/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------
// (b) Task #1544 — `["cursor", "agent"]` candidate is tried on EVERY
//     platform (Cursor 3.x reaches the agent via this subcommand
//     form even on Windows, where there's no separate `cursor-agent.cmd`).
//     The editor-shim protection comes from positive identification
//     of the `--version` reply, not from dropping the candidate.
// ---------------------------------------------------------------------

test("Task #1544 — defaultAgentCandidatesFor keeps `cursor agent` fallback on every platform", () => {
  for (const p of ["win32", "linux", "darwin"] as NodeJS.Platform[]) {
    const got = defaultAgentCandidatesFor(p).map((c) => Array.from(c));
    assert.deepEqual(
      got,
      [["cursor-agent"], ["cursor", "agent"]],
      `${p} must try both candidates so Cursor 3.x users can reach the agent`,
    );
  }
});

test("Task #1544 — CursorAgentAdapter rejects an editor shim via positive identification, even when it answers `agent --version`", async () => {
  // PATH contains ONLY a `cursor.cmd` (the editor) that responds to
  // `cursor agent --version` by printing its built-in help line.
  // Pre-#1544's win32 gate dropped the candidate entirely (breaking
  // Cursor 3.x). Post-#1544 the candidate IS tried, but the
  // `looksLikeCursorEditor` gate rejects the editor's help-text reply
  // and surfaces the "install the standalone CLI" remediation instead
  // of latching onto the editor.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "task1544-editor-reject-"));
  try {
    const editorShim = path.join(tmp, "cursor.cmd");
    fs.writeFileSync(
      editorShim,
      "#!/bin/sh\n" +
        "echo \"Run with 'cursor -' to read output from another program\"\n",
    );
    fs.chmodSync(editorShim, 0o755);

    const origPath = process.env["PATH"];
    const origPathExt = process.env["PATHEXT"];
    process.env["PATH"] = tmp;
    process.env["PATHEXT"] = ".com;.exe;.bat;.cmd";
    process.env["PREPSAVANT_WIN_SPAWN_NO_SHELL"] = "1";
    try {
      await withPlatform("win32", async () => {
        const adapter = new CursorAgentAdapter({ invocation: ["cursor", "agent"] });
        const probe = await adapter.probe();
        assert.equal(probe.ok, false);
        // The editor IS reached and IS rejected via positive ID — not
        // silently cached. The remediation must point at the
        // standalone CLI install.
        assert.match(
          probe.remediation ?? "",
          /editor|standalone|cursor-agent/i,
          "remediation must guide user to install the standalone agent CLI",
        );
      });
    } finally {
      if (origPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = origPath;
      if (origPathExt === undefined) delete process.env["PATHEXT"];
      else process.env["PATHEXT"] = origPathExt;
      delete process.env["PREPSAVANT_WIN_SPAWN_NO_SHELL"];
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("Task #1544 — Windows Cursor 3.x happy path: `cursor.cmd agent --version` returning a real semver is accepted via the fallback candidate", async () => {
  // No `cursor-agent.cmd` on PATH (Cursor 3.x doesn't ship one); the
  // editor binary at `cursor.cmd` IS the agent multitool and responds
  // to `cursor agent --version` with a bare semver. Pre-#1544's
  // win32 gate dropped candidate 2 entirely so this user got a
  // not_installed error; post-#1544 the candidate is tried, positive
  // ID accepts the semver, and the adapter caches the fallback form.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "task1544-win-happy-"));
  try {
    const agentShim = path.join(tmp, "cursor.cmd");
    fs.writeFileSync(agentShim, "#!/bin/sh\necho 'cursor-agent 3.0.1'\n");
    fs.chmodSync(agentShim, 0o755);

    const origPath = process.env["PATH"];
    const origPathExt = process.env["PATHEXT"];
    process.env["PATH"] = tmp;
    process.env["PATHEXT"] = ".com;.exe;.bat;.cmd";
    process.env["PREPSAVANT_WIN_SPAWN_NO_SHELL"] = "1";
    try {
      await withPlatform("win32", async () => {
        const adapter = new CursorAgentAdapter({ invocation: ["cursor", "agent"] });
        const probe = await adapter.probe();
        assert.equal(probe.ok, true, `probe should succeed; got: ${JSON.stringify(probe)}`);
        assert.deepEqual(
          Array.from(adapter._chosenInvocation() ?? []),
          ["cursor", "agent"],
          "adapter must cache the `cursor agent` fallback invocation for subsequent ask() calls",
        );
      });
    } finally {
      if (origPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = origPath;
      if (origPathExt === undefined) delete process.env["PATHEXT"];
      else process.env["PATHEXT"] = origPathExt;
      delete process.env["PREPSAVANT_WIN_SPAWN_NO_SHELL"];
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("Task #1544 — silent 0-byte `--version` success is rejected, not cached as a working agent", async () => {
  // An editor (or any unrelated binary) might respond to a bogus
  // `--version` invocation by exiting 0 with no output. The positive-
  // ID gate must reject this — caching it would re-introduce the
  // #1533 bug (every ask() call spawns the wrong binary, leaking
  // garbage as Sam's voice).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "task1544-silent-"));
  try {
    const silentShim = path.join(tmp, "cursor-agent");
    fs.writeFileSync(silentShim, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(silentShim, 0o755);

    const origPath = process.env["PATH"];
    process.env["PATH"] = tmp;
    try {
      const adapter = new CursorAgentAdapter({ invocation: ["cursor-agent"] });
      const probe = await adapter.probe();
      assert.equal(probe.ok, false, "silent 0-byte output must not be cached as a working agent");
      assert.equal(adapter._chosenInvocation(), null, "no invocation must be cached");
    } finally {
      if (origPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = origPath;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------
// (c) Renderer: a second, in-process session must not inherit a stale
//     cursor-row offset from a previous render's input row.
// ---------------------------------------------------------------------

function makeFakeStream(): {
  stream: CoachStream;
  emit: { sam: (l: { text: string }) => void; tick: (t: unknown) => void; end: () => void };
} {
  const samHandlers: Array<(l: { text: string }) => void> = [];
  const tickHandlers: Array<(t: unknown) => void> = [];
  const endHandlers: Array<() => void> = [];
  const stream = {
    onSam(cb: (l: { text: string }) => void) {
      samHandlers.push(cb);
    },
    onUser(_cb: unknown) {},
    onStatus(_cb: unknown) {},
    onTick(cb: (t: unknown) => void) {
      tickHandlers.push(cb);
    },
    onEnd(cb: () => void) {
      endHandlers.push(cb);
    },
  } as unknown as CoachStream;
  return {
    stream,
    emit: {
      sam: (l) => samHandlers.forEach((h) => h(l)),
      tick: (t) => tickHandlers.forEach((h) => h(t)),
      end: () => endHandlers.forEach((h) => h()),
    },
  };
}

test("Task #1533 — TerminalRenderer's first footer reservation defensively wipes the input row (in-process Q#1→Q#2 restart)", () => {
  // Simulate the in-process flow: the user answers Y to the
  // "active session exists" prompt — readline closes, leaving the
  // cursor at the end of the prompt line with `> y` still drawn.
  // Then the new session's renderer initialises and ticks. The
  // pre-#1533 renderer wrote `\n` against that non-empty row, so the
  // footer landed on the same row as `> y` and every subsequent
  // repaint stomped any input the user typed on Q#2.
  const captured: string[] = [];
  const fakeOut = new PassThrough();
  // Add the `columns` getter and `isTTY` flag the renderer reaches
  // for; without them it skips footer painting entirely.
  Object.assign(fakeOut, { columns: 120, isTTY: true });
  fakeOut.on("data", (chunk: Buffer) => captured.push(chunk.toString("utf-8")));

  const { stream, emit } = makeFakeStream();
  const r = new TerminalRenderer({
    stream,
    out: fakeOut as unknown as NodeJS.WritableStream as never,
    isTTY: true,
    noColor: true,
    footerMaxWidth: 80,
  });

  // First tick — the renderer must wipe the current row BEFORE
  // emitting its reservation "\n". We assert this by inspecting the
  // ANSI sequences emitted on the first tick.
  emit.tick({
    sessionId: "sess_t1533_q1",
    elapsedMs: 1_000,
    remainingMs: 600_000,
    hintRung: null,
  });

  const firstTickOutput = captured.join("");
  captured.length = 0;
  // The defensive cleanup writes `cursorTo(0)` (ESC[G or ESC[0G) and
  // `clearLine(0)` (ESC[2K) before any "\n" reservation. Confirm
  // both are present and that the LAST occurrence of clearLine before
  // the reservation "\n" precedes it (i.e. we cleaned BEFORE we
  // reserved, not just as part of the post-reservation paint).
  assert.match(firstTickOutput, /\x1b\[2K/, "first tick must emit a clearLine");
  const firstNewlineIdx = firstTickOutput.indexOf("\n");
  assert.ok(firstNewlineIdx > 0, "first tick must reserve via a \\n");
  const beforeReservation = firstTickOutput.slice(0, firstNewlineIdx);
  assert.match(
    beforeReservation,
    /\x1b\[2K/,
    "input-row wipe must happen BEFORE the reservation \\n so Q#2 starts from a clean row",
  );

  // End the first session — detach() restores the cursor.
  emit.end();

  // Second session: fresh renderer over the same stdout (the in-process
  // restart path). The new renderer must ALSO wipe its row on the
  // first tick — the bug class is "first reservation paints over
  // residual chars", which is true on every fresh renderer that
  // inherits a non-empty cursor row.
  const { stream: s2, emit: e2 } = makeFakeStream();
  const r2 = new TerminalRenderer({
    stream: s2,
    out: fakeOut as unknown as NodeJS.WritableStream as never,
    isTTY: true,
    noColor: true,
    footerMaxWidth: 80,
  });
  e2.tick({
    sessionId: "sess_t1533_q2",
    elapsedMs: 1_000,
    remainingMs: 600_000,
    hintRung: null,
  });
  const secondTickOutput = captured.join("");
  const secondNewlineIdx = secondTickOutput.indexOf("\n");
  assert.ok(secondNewlineIdx > 0, "Q#2 first tick must reserve via a \\n");
  assert.match(
    secondTickOutput.slice(0, secondNewlineIdx),
    /\x1b\[2K/,
    "Q#2 renderer must also wipe the row before reserving — no stale offset inherited from Q#1",
  );
  // Quiet unused-var lint for the renderer handles — keeping them in
  // scope guards against the GC closing the stream listeners before
  // the assertions run.
  void r;
  void r2;
});

test("Task #1554 — TerminalRenderer.renderFooter() calls refreshInput on EVERY tick, not just the first (PowerShell input-stomp fix)", () => {
  // Reproduces the Windows PowerShell input-stomp the user hit on
  // 2.2.2. The renderer correctly called refreshInput on the first
  // tick (so the user's prompt was repainted after the reservation)
  // and on resize / scrollIntoTranscript, but NOT on subsequent
  // cadence ticks. Each subsequent footer repaint parked the cursor
  // at col 0 of the input row without resyncing readline's visual
  // state to its in-memory (prompt + buffer + cursor) tuple. On
  // POSIX terminals readline's echo timing usually hid this; on
  // PowerShell (win32-arm64 conhost especially) the next keystroke
  // was echoed at col 0, overwriting the first char of the user's
  // typed text — visible to the user as "my typing keeps getting
  // deleted".
  const captured: string[] = [];
  const fakeOut = new PassThrough();
  Object.assign(fakeOut, { columns: 120, isTTY: true });
  fakeOut.on("data", (chunk: Buffer) => captured.push(chunk.toString("utf-8")));

  let refreshInputCalls = 0;
  const { stream, emit } = makeFakeStream();
  const r = new TerminalRenderer({
    stream,
    out: fakeOut as unknown as NodeJS.WritableStream as never,
    isTTY: true,
    noColor: true,
    footerMaxWidth: 80,
    refreshInput: () => {
      refreshInputCalls += 1;
    },
  });

  emit.tick({
    sessionId: "sess_t1554",
    elapsedMs: 1_000,
    remainingMs: 600_000,
    hintRung: null,
  });
  assert.equal(refreshInputCalls, 1, "first tick must call refreshInput (existing behaviour)");

  // Three subsequent ticks — each MUST call refreshInput to resync
  // readline's visual state after the footer repaint parks the cursor
  // at col 0. Pre-#1554 only the first tick called it; ticks 2+ left
  // the cursor stranded.
  for (let i = 2; i <= 4; i += 1) {
    emit.tick({
      sessionId: "sess_t1554",
      elapsedMs: i * 1_000,
      remainingMs: 600_000 - i * 1_000,
      hintRung: null,
    });
  }
  assert.equal(
    refreshInputCalls,
    4,
    "subsequent ticks (2, 3, 4) must each call refreshInput so the next keystroke isn't echoed at col 0",
  );
  void r;
});
