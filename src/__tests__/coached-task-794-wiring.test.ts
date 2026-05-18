// Task #794 — MCP-level wiring test for the Coached mode-framing and
// question-selection turn.
//
// We verify by static analysis of server.ts (mirroring the convention
// established by coached-tool-aliases.test.ts) plus a runtime check on
// SamApi.listQuestions that the runner-side wiring honours the
// requirements set by the API-server contract:
//
//   1. `coached_pick_question` accepts and forwards the full filter
//      surface (roleFamily, language, topic, difficulty), including
//      `topic`, so the candidate's "easy backend Python" preference
//      reaches the API. (The `practice_list_questions` compatibility
//      alias was removed in mcp-runner 0.5.0; coached_pick_question is
//      its 1:1 replacement and the only surviving carrier of these
//      filters.)
//   2. `coached_start_session` surfaces the API's kickoffBriefVerbatim
//      (which carries the structured Title / Problem / API shape /
//      Example I/O / Constraints / Edge cases / First move sections
//      and HOST INSTRUCTIONS clauses 1–13) instead of a handcrafted
//      brief that would lose those Task #794 sections.
//   3. `SamApi.listQuestions` actually performs roleFamily and language
//      filtering on the items returned by /runner/questions (the API
//      only filters by topic + difficulty server-side).

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
  // Capture from `registerTool("<name>",` up to the closing `);` that
  // terminates the registration. The body of every tool registration
  // ends with `},\n  );` in this file, so we anchor on that.
  const re = new RegExp(
    `registerTool\\(\\s*"${escaped}"[\\s\\S]*?\\n  \\);`,
    "m",
  );
  const m = SERVER_SRC.match(re);
  if (!m) throw new Error(`could not find registerTool block for ${toolName}`);
  return m[0];
}

test("Task #794 — practice_list_questions alias was removed in 0.5.0 (filters now live on coached_pick_question)", () => {
  // Sanity-check the rebase resolution: if a future change ever
  // re-introduces the legacy alias, we want this test to scream so we
  // remember to reconcile it with the canonical coached_* surface.
  assert.ok(
    !/registerTool\(\s*"practice_list_questions"/.test(SERVER_SRC),
    "practice_list_questions was removed in mcp-runner 0.5.0; do not re-register it",
  );
});

test("Task #794 — coached_pick_question accepts topic in addition to roleFamily/language/difficulty", () => {
  const block = toolBlock("coached_pick_question");
  for (const key of ["roleFamily", "language", "topic", "difficulty"]) {
    assert.ok(
      block.includes(key),
      `coached_pick_question must declare "${key}" in its inputSchema/forwarding`,
    );
  }
  assert.match(
    block,
    /api\.listQuestions\(\s*\{[\s\S]*topic:\s*args\.topic[\s\S]*\}\s*\)/,
    "coached_pick_question must forward args.topic into api.listQuestions",
  );
});

test("Task #794 — coached_start_session surfaces kickoffBriefVerbatim (not a handcrafted brief) when present", () => {
  const block = toolBlock("coached_start_session");
  assert.ok(
    block.includes("kickoffBriefVerbatim"),
    "coached_start_session must read detail.kickoffBriefVerbatim",
  );
  // The verbatim brief must be returned as the canonical session brief
  // (not just inspected and discarded). We assert that a `verbatim`
  // value derived from kickoffBriefVerbatim is interpolated into the
  // response that asText() ultimately receives.
  assert.match(
    block,
    /verbatim\s*=\s*detail\.kickoffBriefVerbatim/,
    "coached_start_session must bind a `verbatim` value from detail.kickoffBriefVerbatim",
  );
  assert.match(
    block,
    /verbatim\s*\?[\s\S]*verbatim[\s\S]*:[\s\S]*questionTitle/,
    "coached_start_session must prefer the verbatim brief when present and only fall back to a handcrafted brief otherwise",
  );
});

test("Task #794 — SamApi.listQuestions filters items by roleFamily and language client-side", async () => {
  const items = [
    { id: "a", roleFamily: "swe", languages: ["python", "typescript"] },
    { id: "b", roleFamily: "data", languages: ["python"] },
    { id: "c", roleFamily: "swe", languages: ["javascript"] },
  ];
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
    return new Response(JSON.stringify({ items }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const api = new SamApi({
      apiBaseUrl: "http://example.test",
      token: "tok",
    });

    // roleFamily filter (no topic/difficulty, so no query string).
    const sweOnly = (await api.listQuestions({ roleFamily: "swe" })) as {
      items: { id: string }[];
    };
    assert.deepEqual(
      sweOnly.items.map((q) => q.id).sort(),
      ["a", "c"],
      "roleFamily=swe must be filtered client-side",
    );

    // language filter intersects.
    const sweAndJs = (await api.listQuestions({
      roleFamily: "swe",
      language: "javascript",
    })) as { items: { id: string }[] };
    assert.deepEqual(
      sweAndJs.items.map((q) => q.id),
      ["c"],
      "roleFamily=swe AND language=javascript must intersect to {c}",
    );

    // topic + difficulty are forwarded as query-string params.
    await api.listQuestions({ topic: "Hashing", difficulty: "easy" });
    const lastUrl = seenUrls[seenUrls.length - 1] ?? "";
    assert.ok(
      lastUrl.includes("topic=Hashing") && lastUrl.includes("difficulty=easy"),
      `topic + difficulty must be sent as query-string params; got ${lastUrl}`,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});
