// Task #1401 — runner-driven terminal coach unit coverage.
//
// We assert the small pure functions that drive the renderer / agent
// adapter / input loop, and stand up a single end-to-end mock-agent
// session to prove the cadence sink → CoachStream → renderer fan-out
// is wired without touching real timers, real stdin, or `cursor-agent`.
import test from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";

import {
  parseAndSanitizeReply,
  sanitizeCoachLine,
  MockAgent,
  resolveCodingAgent,
  CursorAgentAdapter,
  CursorSdkAdapter,
} from "../coached/coding-agent.js";
import { stripHostInstructions } from "../coached/cli-start.js";
import {
  formatDuration,
  shortenSessionId,
  TerminalRenderer,
} from "../coached/terminal-renderer.js";
import { CoachStream } from "../coached/coach-stream.js";
import {
  buildAskPrompt,
  classifySamLineKind,
  parseUtterance,
  renderDirectiveAsSamLine,
} from "../coached/terminal-coach.js";
import type { CadenceDirective } from "../coached/cadence-loop.js";

test("Task #1401 — sanitizeCoachLine strips quotes, prefixes, fences, multi-line", () => {
  assert.equal(
    sanitizeCoachLine('  "Sam › Take a beat — what test fails?"  '),
    "Take a beat — what test fails?",
  );
  assert.equal(
    sanitizeCoachLine("Coach: keep going\n\nignored second paragraph"),
    "keep going",
  );
  assert.equal(
    sanitizeCoachLine("Try this: ```ts\nconst x=1;\n```"),
    "Try this:",
  );
  // Cap at 600 chars + ellipsis.
  const long = "a".repeat(700);
  const out = sanitizeCoachLine(long);
  assert.ok(out.length <= 601, "expected sanitized length capped to ~600");
  assert.ok(out.endsWith("…"), "expected ellipsis suffix on truncation");
});

test("Task #1401 — parseAndSanitizeReply handles cursor-agent --json envelope", () => {
  const json = JSON.stringify({ reply: '"Sam › what shape is the input?"', model: "x" });
  assert.equal(parseAndSanitizeReply(json), "what shape is the input?");
  // Plaintext mode falls through.
  assert.equal(parseAndSanitizeReply("hello"), "hello");
  assert.equal(parseAndSanitizeReply(""), "");
});

test("Task #1401 — stripHostInstructions cuts the legacy block but keeps the brief", () => {
  const brief =
    "# Two Sum\n\nFind two numbers that sum to target.\n\nHOST INSTRUCTIONS — SPLIT-LOOP RELAY PROTOCOL (Coached mode):\n0. Some prose.\n1. More prose.\n";
  const stripped = stripHostInstructions(brief);
  assert.ok(stripped.includes("Two Sum"));
  assert.ok(stripped.includes("Find two numbers"));
  assert.ok(!stripped.includes("HOST INSTRUCTIONS"));
  // Briefs without the marker are returned untouched (modulo trim).
  assert.equal(stripHostInstructions("plain brief\n"), "plain brief");
});

test("Task #1401 — parseUtterance recognises commands; free text falls through", () => {
  assert.equal(parseUtterance("quit", 0).command, "quit");
  assert.equal(parseUtterance("/hint", 0).command, "hint");
  assert.equal(parseUtterance("submit", 0).command, "submit");
  assert.equal(parseUtterance("hello sam", 0).command, undefined);
});

test("Task #1401 — formatDuration / shortenSessionId render correctly", () => {
  assert.equal(formatDuration(0), "00:00");
  assert.equal(formatDuration(65_000), "01:05");
  assert.equal(formatDuration(-1), "00:00");
  assert.equal(shortenSessionId("sess_abcdef1234"), "sess_abc…");
  assert.equal(shortenSessionId("short"), "short");
});

test("Task #1401 — TerminalRenderer NO_COLOR + non-TTY produces plain transcript without footer", () => {
  const chunks: string[] = [];
  const out = new Writable({
    write(buf, _enc, cb) {
      chunks.push(buf.toString("utf-8"));
      cb();
    },
  });
  const stream = new CoachStream();
  const renderer = new TerminalRenderer({
    stream,
    out,
    isTTY: false,
    noColor: true,
  });
  stream.emitSam({ kind: "kickoff", text: "hello", emittedAt: 0 });
  stream.emitTick({
    sessionId: "sess_x",
    elapsedMs: 0,
    remainingMs: 60_000,
    hintRung: null,
  });
  stream.emitStatus({ text: "you saved foo.ts", emittedAt: 0 });
  stream.emitEnd("user_quit");
  const transcript = chunks.join("");
  assert.match(transcript, /Sam › hello/);
  assert.match(transcript, /· you saved foo\.ts/);
  // No ANSI escapes.
  assert.ok(!/\u001b\[/.test(transcript), "expected no ANSI escapes when NO_COLOR + non-TTY");
  // No footer (footer is TTY-only).
  assert.ok(!transcript.includes("Ctrl+C"), "footer must be skipped on non-TTY");
  void renderer;
});

test("Task #1401 — TerminalRenderer formatFooter trims to footerMaxWidth", () => {
  const stream = new CoachStream();
  const r = new TerminalRenderer({
    stream,
    out: new Writable({ write(_b, _e, cb) { cb(); } }),
    isTTY: true,
    noColor: true,
    footerMaxWidth: 30,
  });
  const footer = r.formatFooter({
    sessionId: "sess_supersuperlongidentifier",
    elapsedMs: 0,
    remainingMs: 60_000,
    hintRung: "directive",
  });
  assert.ok(footer.length <= 30, `footer ${footer.length} > 30: ${footer}`);
  assert.ok(footer.endsWith("…"));
});

test("Task #1401 — buildAskPrompt + classifySamLineKind format directives", () => {
  const d: CadenceDirective = {
    kind: "hint_offer:dataStructureChoice:probe",
    action: "hint_offer",
    reason: "x",
    intent: "Nudge the candidate to think about the data structure.",
    constraints: ["Stay in Sam's coach voice."],
    suggestedWording: null,
    mustBeVerbatim: false,
    mode: "host_reasoning",
    emittedAt: 0,
    sessionId: "sess_a",
    hintShape: "spinning",
    hintRung: "focused",
  };
  const prompt = buildAskPrompt(d);
  assert.match(prompt, /Directive intent:/);
  assert.match(prompt, /Constraints:/);
  assert.match(prompt, /Hint rung: focused/);
  assert.equal(classifySamLineKind(d), "hint_offer");
  assert.equal(
    classifySamLineKind({ ...d, kind: "time_warning:over_time" }),
    "wrap_up",
  );
  assert.equal(
    classifySamLineKind({ ...d, kind: "stall_nudge:123" }),
    "stall_nudge",
  );
});

test("Task #1401 — MockAgent.ask returns a sanitized Sam line derived from the intent", async () => {
  const agent = new MockAgent();
  const probe = await agent.probe();
  assert.equal(probe.ok, true);
  const reply = await agent.ask({
    systemPrompt: "Sam persona",
    userPrompt: "Directive intent: Probe the candidate about complexity\nConstraints:\n- short",
  });
  assert.match(reply.text, /Probe the candidate about complexity/);
});

test("Task #1401 — resolveCodingAgent honours forceMock and PREPSAVANT_MOCK_AGENT", () => {
  const a = resolveCodingAgent({ forceMock: true });
  assert.equal(a.id, "mock");
  const prev = process.env["PREPSAVANT_MOCK_AGENT"];
  process.env["PREPSAVANT_MOCK_AGENT"] = "1";
  try {
    assert.equal(resolveCodingAgent({}).id, "mock");
  } finally {
    if (prev === undefined) delete process.env["PREPSAVANT_MOCK_AGENT"];
    else process.env["PREPSAVANT_MOCK_AGENT"] = prev;
  }
  // Default resolves to a CursorAgentAdapter (no environment).
  const c = resolveCodingAgent({});
  assert.ok(c instanceof CursorAgentAdapter);
});

test("Task #1401 — renderDirectiveAsSamLine prefers verbatim wording, falls back to mock agent for host_reasoning", async () => {
  const stream = new CoachStream();
  const lines: string[] = [];
  stream.onSam((s) => lines.push(s.text));

  const verbatim: CadenceDirective = {
    kind: "stall_nudge:1",
    action: "probe",
    reason: "x",
    intent: "nudge",
    constraints: [],
    suggestedWording: "Take a moment — what's the next step?",
    mustBeVerbatim: false,
    mode: "verbatim_relay",
    emittedAt: 0,
    sessionId: "sess_a",
  };
  await renderDirectiveAsSamLine(verbatim, stream, new MockAgent());
  assert.equal(lines[0], "Take a moment — what's the next step?");

  const reasoning: CadenceDirective = {
    ...verbatim,
    kind: "hint_offer:dataStructureChoice:probe",
    suggestedWording: null,
    mode: "host_reasoning",
    intent: "Probe data structure choice",
  };
  await renderDirectiveAsSamLine(reasoning, stream, new MockAgent());
  assert.match(lines[1] ?? "", /Probe data structure choice/);
});

test("Task #1401 — resolveCodingAgent picks CursorSdkAdapter when CURSOR_API_KEY is set", () => {
  const a = resolveCodingAgent({ env: { CURSOR_API_KEY: "test-key" } });
  assert.ok(a instanceof CursorSdkAdapter, `expected CursorSdkAdapter, got ${a.id}`);
  assert.equal(a.id, "cursor-sdk");
  // Without the key, resolver picks the CLI shell-out — proves we
  // didn't accidentally make SDK the unconditional default.
  const b = resolveCodingAgent({ env: {} });
  assert.ok(b instanceof CursorAgentAdapter);
});

test("Task #1401 — resolveCodingAgent honours explicit kind=cursor-sdk + falls back with breadcrumb when no key", () => {
  // Explicit opt-in with key → SDK.
  const a = resolveCodingAgent({
    config: { kind: "cursor-sdk", model: "composer-2" },
    env: { CURSOR_API_KEY: "k" },
  });
  assert.ok(a instanceof CursorSdkAdapter);
  // Explicit opt-in WITHOUT key → falls back to CLI; should write a
  // single stderr breadcrumb instead of crashing.
  const origWrite = process.stderr.write.bind(process.stderr);
  let captured = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
    return true;
  };
  try {
    const b = resolveCodingAgent({ config: { kind: "cursor-sdk" }, env: {} });
    assert.ok(b instanceof CursorAgentAdapter);
    assert.match(captured, /CURSOR_API_KEY is not set/);
  } finally {
    process.stderr.write = origWrite;
  }
});

test("Task #1401 — CursorSdkAdapter.dispose is a no-op when the agent was never constructed", async () => {
  const adapter = new CursorSdkAdapter({ apiKey: "k", cwd: process.cwd() });
  // Should not throw and should be safe to call multiple times.
  await adapter.dispose();
  await adapter.dispose();
  assert.equal(adapter.id, "cursor-sdk");
});
test("Task #1401 — CursorSdkAdapter falls back to the CLI adapter when the cloud-agent API rejects the key", async () => {
  // Task #1562 — the SDK adapter now calls Cursor's cloud-agent HTTPS
  // API directly. A 401 on the auth probe (e.g. invalid key) MUST trip
  // the same fallback path that an SDK load failure used to: subsequent
  // probe()/ask() calls delegate to the CursorAgentAdapter instead of
  // emitting empty replies. We exercise the path with an injected
  // fetch that always returns 401, then assert via the test-only seam
  // `_didFallBackToCli()` plus a stderr breadcrumb capture.
  const adapter = new CursorSdkAdapter({
    apiKey: "definitely-not-a-real-key",
    cliFallback: { invocation: ["/definitely/not/a/real/binary"] },
    fetchImplForTests: async () => ({
      ok: false,
      status: 401,
      headers: { get: () => null },
      async text() {
        return '{"error":{"code":"unauthorized","message":"bad key"}}';
      },
    }),
  });
  const origWrite = process.stderr.write.bind(process.stderr);
  let captured = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
    return true;
  };
  try {
    const probe = await adapter.probe();
    // Probe is delegated to the CLI fallback, which sees a missing
    // binary and reports `not_installed` with the CLI's remediation —
    // NOT the dead-end "@cursor/sdk could not be loaded" message.
    assert.equal(probe.ok, false);
    assert.equal(probe.reason, "not_installed");
    assert.ok(adapter._didFallBackToCli(), "expected fallback flag to be set after ensureAgent failed");
    assert.match(captured, /falling back to cursor-agent CLI/);
  } finally {
    process.stderr.write = origWrite;
  }
});
