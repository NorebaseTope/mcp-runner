// Unit tests for the end-of-session memory rewrite (Tasks #800, #804).
//
// At end-of-session the runner samples the host model with the prior
// rolling memory + this session's outcome, asks for a rewritten body
// under the 2,000-char cap, and PATCHes the result back to
// /profile/session-memory. Without a cap that body grows unbounded
// across sessions and eats the kickoff prompt budget.
//
// These tests pin the full contract `coached_end_session` relies on:
//
//   - Prompt: includes the cap, "drop oldest first" guidance, the
//     prior memory verbatim, and this session's outcome.
//   - Sampling: called EXACTLY ONCE with
//     `SESSION_MEMORY_REWRITE_INSTRUCTION` as the system directive.
//   - PATCH: called once with the trimmed sampling output on the happy
//     path; SKIPPED on host refusal (so the runner fallback never
//     erases the candidate's memory); SKIPPED on whitespace-only
//     output; SKIPPED when the rewritten body still exceeds the cap
//     (we keep the prior memory rather than hard-trimming a half-cut
//     bullet); 413 from PATCH is caught and logged.
//   - The cap stays pinned at 2,000 — the api-server route, the
//     OpenAPI maxLength, and this constant must move together.

import test from "node:test";
import assert from "node:assert/strict";
import {
  SESSION_MEMORY_MAX_CHARS,
  SESSION_MEMORY_REWRITE_INSTRUCTION,
  buildSessionMemoryRewritePrompt,
  rewriteSessionMemoryWithDeps,
  type SessionMemoryRewriteContext,
  type SessionMemoryRewriteDeps,
} from "../coached/post-mortem.js";

const BASE_CTX: SessionMemoryRewriteContext = {
  priorMemory: "- Earlier: struggled with two-pointer template",
  questionTitle: "Two Sum",
  attemptsTotal: 2,
  hintsUsed: 1,
  passedLatest: true,
  aiAssistDetected: false,
};

interface Recorder {
  sampleCalls: Array<{ systemPrompt: string; userPrompt: string }>;
  patchCalls: string[];
  logs: string[];
}

function makeDeps(
  overrides: {
    sampleResult?: {
      text: string;
      source: "runner_sampling" | "runner_fallback";
    };
    sampleError?: unknown;
    patchError?: unknown;
  } = {},
): { deps: SessionMemoryRewriteDeps; rec: Recorder } {
  const rec: Recorder = { sampleCalls: [], patchCalls: [], logs: [] };
  const sampleResult =
    overrides.sampleResult ??
    ({
      text: "- Two Sum: passed in 2 attempts after 1 hint — drill index-arithmetic next",
      source: "runner_sampling",
    } as const);
  const deps: SessionMemoryRewriteDeps = {
    sample: async (args) => {
      rec.sampleCalls.push(args);
      if (overrides.sampleError) throw overrides.sampleError;
      return sampleResult;
    },
    patch: async (memory) => {
      rec.patchCalls.push(memory);
      if (overrides.patchError) throw overrides.patchError;
      return { ok: true };
    },
    log: (line) => rec.logs.push(line),
  };
  return { deps, rec };
}

// --- Prompt contract -----------------------------------------------------

test("buildSessionMemoryRewritePrompt: includes the 2000-char cap and oldest-first guidance", () => {
  const prompt = buildSessionMemoryRewritePrompt(BASE_CTX);
  assert.ok(
    prompt.includes(SESSION_MEMORY_REWRITE_INSTRUCTION),
    "prompt must embed SESSION_MEMORY_REWRITE_INSTRUCTION verbatim",
  );
  assert.ok(
    prompt.includes(String(SESSION_MEMORY_MAX_CHARS)),
    "prompt must mention the SESSION_MEMORY_MAX_CHARS cap",
  );
  assert.match(prompt, /OLDEST/, "prompt must tell the model to drop oldest first");
  assert.match(prompt, /recent/i, "prompt must tell the model to prefer recent learnings");
});

test("buildSessionMemoryRewritePrompt: includes prior memory and this session's outcome", () => {
  const prompt = buildSessionMemoryRewritePrompt({
    priorMemory: "- prior bullet about graphs",
    questionTitle: "Course Schedule",
    attemptsTotal: 3,
    hintsUsed: 2,
    passedLatest: false,
    aiAssistDetected: true,
  });
  assert.match(prompt, /- prior bullet about graphs/);
  assert.match(prompt, /Course Schedule/);
  assert.match(prompt, /Attempts: 3/);
  assert.match(prompt, /Hints used: 2/);
  assert.match(prompt, /Latest attempt: failed/);
  assert.match(prompt, /AI assist detected: yes/);
});

test("buildSessionMemoryRewritePrompt: handles empty prior memory and undefined outcome", () => {
  const prompt = buildSessionMemoryRewritePrompt({
    priorMemory: "",
    questionTitle: "Q",
    attemptsTotal: 0,
    hintsUsed: 0,
    passedLatest: undefined,
    aiAssistDetected: false,
  });
  assert.match(prompt, /\(empty\)/);
  assert.match(prompt, /Latest attempt: incomplete/);
  assert.match(prompt, /AI assist detected: no/);
});

test("SESSION_MEMORY_MAX_CHARS stays at 2000 (aligned with OpenAPI + api-server)", () => {
  // If anyone bumps this, they must also bump the OpenAPI
  // `UpdateSessionMemoryBody.sessionMemory.maxLength` and the
  // api-server `SESSION_MEMORY_MAX_CHARS` constant in the same change.
  assert.equal(SESSION_MEMORY_MAX_CHARS, 2000);
});

// --- End-session contract -----------------------------------------------

test("rewriteSessionMemoryWithDeps: samples once with SESSION_MEMORY_REWRITE_INSTRUCTION as system prompt", async () => {
  const { deps, rec } = makeDeps();
  await rewriteSessionMemoryWithDeps(BASE_CTX, deps);
  assert.equal(rec.sampleCalls.length, 1, "sample must be called exactly once");
  assert.equal(
    rec.sampleCalls[0]!.systemPrompt,
    SESSION_MEMORY_REWRITE_INSTRUCTION,
    "system prompt must be the canonical rewrite instruction (NOT the live Sam-voice persona)",
  );
  assert.ok(
    rec.sampleCalls[0]!.userPrompt.includes("Two Sum"),
    "user prompt must embed this session's outcome",
  );
  assert.ok(
    rec.sampleCalls[0]!.userPrompt.includes(BASE_CTX.priorMemory),
    "user prompt must embed the prior memory verbatim",
  );
});

test("rewriteSessionMemoryWithDeps: PATCHes the rewritten body on the happy path", async () => {
  const { deps, rec } = makeDeps();
  const out = await rewriteSessionMemoryWithDeps(BASE_CTX, deps);
  assert.equal(rec.patchCalls.length, 1, "PATCH must be called exactly once");
  assert.match(rec.patchCalls[0]!, /Two Sum/);
  assert.equal(out.kind, "patched");
});

test("rewriteSessionMemoryWithDeps: SKIPS PATCH when the host refuses sampling (runner_fallback)", async () => {
  const { deps, rec } = makeDeps({
    sampleResult: { text: BASE_CTX.priorMemory, source: "runner_fallback" },
  });
  const out = await rewriteSessionMemoryWithDeps(BASE_CTX, deps);
  assert.equal(rec.sampleCalls.length, 1);
  assert.equal(
    rec.patchCalls.length,
    0,
    "PATCH must be skipped — pushing the runner fallback would silently overwrite the candidate's memory",
  );
  assert.equal(out.kind, "skipped_refused");
  assert.ok(
    rec.logs.some((l) => /host refused sampling/i.test(l)),
    "host refusal must be logged on stderr",
  );
});

test("rewriteSessionMemoryWithDeps: SKIPS PATCH when the host returns whitespace only", async () => {
  const { deps, rec } = makeDeps({
    sampleResult: { text: "   \n  \n", source: "runner_sampling" },
  });
  const out = await rewriteSessionMemoryWithDeps(BASE_CTX, deps);
  assert.equal(rec.patchCalls.length, 0);
  assert.equal(out.kind, "skipped_refused");
});

test("rewriteSessionMemoryWithDeps: SKIPS PATCH when the rewritten body equals the prior memory", async () => {
  const { deps, rec } = makeDeps({
    sampleResult: { text: BASE_CTX.priorMemory, source: "runner_sampling" },
  });
  const out = await rewriteSessionMemoryWithDeps(BASE_CTX, deps);
  assert.equal(rec.patchCalls.length, 0, "no-op rewrites must not touch the server");
  assert.equal(out.kind, "skipped_no_change");
});

test("rewriteSessionMemoryWithDeps: SKIPS PATCH when the rewritten body still exceeds the cap (does NOT trim)", async () => {
  const oversize = "x".repeat(SESSION_MEMORY_MAX_CHARS + 1);
  const { deps, rec } = makeDeps({
    sampleResult: { text: oversize, source: "runner_sampling" },
  });
  const out = await rewriteSessionMemoryWithDeps(BASE_CTX, deps);
  assert.equal(
    rec.patchCalls.length,
    0,
    "must NOT hard-trim and PATCH a partial bullet — keep prior memory unchanged",
  );
  assert.equal(out.kind, "skipped_too_long");
  assert.ok(
    rec.logs.some((l) => /\d+ chars.*cap 2000/.test(l)),
    "skip reason must include the body size and cap",
  );
});

test("rewriteSessionMemoryWithDeps: catches a 413 (session_memory_too_long) from PATCH without throwing", async () => {
  const apiError = Object.assign(
    new Error("PATCH /profile/session-memory → 413"),
    { status: 413, body: { code: "session_memory_too_long" } },
  );
  const { deps, rec } = makeDeps({ patchError: apiError });
  const out = await rewriteSessionMemoryWithDeps(BASE_CTX, deps);
  assert.equal(rec.patchCalls.length, 1, "PATCH was attempted");
  assert.equal(out.kind, "skipped_too_long_server");
  assert.ok(
    rec.logs.some((l) => /session_memory_too_long/.test(l)),
    "413 must be logged with the server's error code",
  );
});

test("rewriteSessionMemoryWithDeps: catches a generic PATCH failure without throwing", async () => {
  const { deps, rec } = makeDeps({ patchError: new Error("network down") });
  const out = await rewriteSessionMemoryWithDeps(BASE_CTX, deps);
  assert.equal(out.kind, "skipped_error");
  assert.ok(
    rec.logs.some((l) => /PATCH failed.*network down/.test(l)),
    "error reason must be logged",
  );
});

test("rewriteSessionMemoryWithDeps: catches a sampling throw without throwing", async () => {
  const { deps, rec } = makeDeps({
    sampleError: new Error("sampling exploded"),
  });
  const out = await rewriteSessionMemoryWithDeps(BASE_CTX, deps);
  assert.equal(out.kind, "skipped_error");
  assert.equal(rec.patchCalls.length, 0);
  assert.ok(
    rec.logs.some((l) => /sampling threw.*sampling exploded/.test(l)),
    "sampling errors must be logged",
  );
});
