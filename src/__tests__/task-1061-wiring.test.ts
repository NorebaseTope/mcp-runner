// Task #1061 — wiring tests for company-aware question search and the
// AI-Assisted MCP tool family. Mirrors the static-analysis convention
// established by coached-task-794-wiring.test.ts: we read server.ts
// directly and assert on tool registrations + arg forwarding so a future
// refactor that drops one of these contracts trips the suite immediately.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { SamApi } from "../api.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SERVER_PATH = resolve(__dirname, "..", "server.ts");
const SERVER_SRC = readFileSync(SERVER_PATH, "utf8");

function toolBlock(toolName: string): string {
  const escaped = toolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `registerTool\\(\\s*"${escaped}"[\\s\\S]*?\\n  \\);`,
    "m",
  );
  const m = SERVER_SRC.match(re);
  if (!m) throw new Error(`could not find registerTool block for ${toolName}`);
  return m[0];
}

test("Task #1061 — coached_pick_question accepts and forwards `company`", () => {
  const block = toolBlock("coached_pick_question");
  assert.ok(
    block.includes("company"),
    "coached_pick_question must declare `company` in its inputSchema",
  );
  assert.match(
    block,
    /api\.listQuestions\(\s*\{[\s\S]*company:\s*args\.company[\s\S]*\}\s*\)/,
    "coached_pick_question must forward args.company into api.listQuestions",
  );
});

test("Task #1061 — coached_list_companies tool is registered and calls api.listCompanies", () => {
  const block = toolBlock("coached_list_companies");
  assert.match(
    block,
    /api\.listCompanies\s*\(\s*\)/,
    "coached_list_companies must call api.listCompanies()",
  );
});

test("Task #1061 — ai_assisted_* tool family is registered", () => {
  // `ai_assisted_log_event` and `ai_assisted_snapshot` were retired in
  // @prepsavant/mcp@2.0.0 (Task #1193) when the in-process Cursor hook
  // capture path was deleted. Evidence now flows from the Cursor chat
  // export uploaded at end-of-session.
  for (const tool of [
    "ai_assisted_start_session",
    "ai_assisted_end_session",
  ]) {
    // Throws on missing — assert.doesNotThrow gives a clearer failure
    // surface than letting the test crash mid-run.
    assert.doesNotThrow(
      () => toolBlock(tool),
      `expected tool ${tool} to be registered in server.ts`,
    );
  }
});

test("Task #1061 — ai_assisted_start_session description forbids host-side refusal", () => {
  // The whole point of the AI-Assisted family is that the host actually
  // writes / runs the code. A refusal-friendly description would let a
  // future edit invert that contract by accident, so pin it.
  const block = toolBlock("ai_assisted_start_session");
  assert.match(
    block,
    /DO NOT refuse/,
    "ai_assisted_start_session description must explicitly tell the host not to refuse",
  );
});

test("Task #1061 — ai_assisted_start_session calls api.startAiAssistedSession with the runner public key + capability manifest", () => {
  const block = toolBlock("ai_assisted_start_session");
  assert.match(block, /api\.startAiAssistedSession\(/);
  assert.match(block, /runnerPublicKey/);
  assert.match(block, /capabilityManifest/);
});

test("Task #1061 — ai_assisted_end_session finalizes the bundle via api.finalizeAiAssistedBundle", () => {
  const block = toolBlock("ai_assisted_end_session");
  assert.match(block, /api\.finalizeAiAssistedBundle\(/);
  assert.match(block, /log_hash/);
  assert.match(block, /event_count/);
});

test("Task #1061 — SamApi.listQuestions forwards `company` as a query-string param", async () => {
  const seenUrls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    seenUrls.push(url);
    return new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const api = new SamApi({
      apiBaseUrl: "http://example.test",
      token: "tok",
    });
    await api.listQuestions({ company: "Anthropic" });
    const lastUrl = seenUrls[seenUrls.length - 1] ?? "";
    assert.ok(
      lastUrl.includes("company=Anthropic"),
      `company filter must be sent as a query-string param; got ${lastUrl}`,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Task #1061 — SamApi.listCompanies hits /api/runner/companies", async () => {
  const seenUrls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    seenUrls.push(url);
    return new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const api = new SamApi({
      apiBaseUrl: "http://example.test",
      token: "tok",
    });
    await api.listCompanies();
    assert.ok(
      seenUrls.some((u) => u.endsWith("/api/runner/companies")),
      `expected request to /api/runner/companies; got ${seenUrls.join(", ")}`,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Task #1061 — coached_pick_question empty-state directs host to coached_list_companies when `company` was provided", () => {
  const block = toolBlock("coached_pick_question");
  // Empty-state branch must mention coached_list_companies AND forbid
  // silently dropping the company filter — both are the explicit
  // requirements from the code-review feedback for #1061.
  assert.match(
    block,
    /args\.company[\s\S]{0,400}coached_list_companies/,
    "empty-state branch for `company` queries must call out coached_list_companies",
  );
  assert.match(
    block,
    /do NOT silently drop|do not silently drop/i,
    "empty-state branch must explicitly forbid silently dropping the company filter",
  );
});

// HOST INSTRUCTIONS canonical-event-kind pin retired with the in-process
// Cursor hook capture path in @prepsavant/mcp@2.0.0 (Task #1193): the
// host no longer logs typed events; the Cursor chat export carries the
// evidence trail.

// Strip TS/JS comments from a tool block so the host-instruction guard
// only inspects prose that actually reaches the host. Developer comments
// like `// Same retry/queue/stderr semantics as coached_end_session.`
// are not host-facing and must not trip the forbiddance regex.
function stripCodeComments(src: string): string {
  // Drop /* ... */ blocks (non-greedy, multi-line).
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, "");
  // Drop full-line // comments.
  return noBlock
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

function lineViolatesCoachedGuard(line: string, coachedTool: string): boolean {
  if (!line.includes(coachedTool)) return false;
  return !/(do not|don't|never)/i.test(line);
}

test("Task #1061 — AI-Assisted family does not route the host into coached_check_in / coached_end_session", () => {
  // Behavioral guard: in AI-Assisted, the host MUST NOT be told to call
  // coached_check_in (which would re-trigger the no-code Coached posture)
  // or coached_end_session (recap pipeline is different). Either must
  // appear ONLY inside an explicit "Do NOT call" forbiddance, never as
  // an instruction.
  for (const tool of [
    "ai_assisted_start_session",
    "ai_assisted_end_session",
  ]) {
    const block = stripCodeComments(toolBlock(tool));
    const lines = block.split("\n");
    for (const coachedTool of ["coached_check_in", "coached_end_session"]) {
      for (const line of lines) {
        if (!line.includes(coachedTool)) continue;
        assert.ok(
          !lineViolatesCoachedGuard(line, coachedTool),
          `${tool}: line referencing ${coachedTool} must be a forbiddance, got: ${line.trim()}`,
        );
      }
    }
  }

  // Positive control: the helper MUST still flag a real host-facing
  // instruction. If someone weakens the regex, this trips immediately.
  assert.ok(
    lineViolatesCoachedGuard(
      '"Then call coached_end_session next."',
      "coached_end_session",
    ),
    "guard regression: helper must flag a host instruction that tells the host to call coached_end_session",
  );
  assert.ok(
    lineViolatesCoachedGuard(
      '"After each turn, call coached_check_in."',
      "coached_check_in",
    ),
    "guard regression: helper must flag a host instruction that tells the host to call coached_check_in",
  );
  // And after stripping comments, a developer-comment line that merely
  // names the tool must disappear entirely (so it can't trip the guard).
  const commentBlock = stripCodeComments(
    "// Same retry/queue/stderr semantics as coached_end_session.\nconst x = 1;",
  );
  assert.ok(
    !commentBlock.includes("coached_end_session"),
    "stripCodeComments must drop full-line // comments that name coached_*",
  );
});

test("Task #1061 — coached_orient surfaces the per-mode `nextTool` slug", () => {
  const block = toolBlock("coached_orient");
  assert.match(
    block,
    /nextTool/,
    "coached_orient must surface the per-mode `nextTool` slug from the API response",
  );
});
