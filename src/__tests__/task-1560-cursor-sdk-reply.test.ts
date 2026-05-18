// Task #1560 (rewritten for Task #1562) — Regression coverage for the
// CursorSdkAdapter reply parsing on the HTTPS cloud-agent path. The
// pre-2.3 adapter ran against `@cursor/sdk`'s local-Agent transport
// (status === "finished", text via `onStep` callbacks). The post-2.3
// adapter calls Cursor's cloud-agent HTTPS API directly: it `POST`s to
// `/v1/agents` (or `/v1/agents/:id/runs` for follow-up turns), polls
// `GET /v1/agents/:id/runs/:runId`, and reads `run.result` once
// `run.status === "FINISHED"`. These tests pin every branch the
// adapter inspects on the wire.

import test from "node:test";
import assert from "node:assert/strict";

import { CursorSdkAdapter } from "../coached/coding-agent.js";
import type { CursorHttpFetch } from "../coached/cursor-http-client.js";

interface FakeRun {
  id: string;
  status: "CREATING" | "RUNNING" | "FINISHED" | "ERROR" | "CANCELLED" | "EXPIRED";
  result?: string;
}

function mkFetch(opts: {
  initial: FakeRun;
  // Subsequent polls return successive entries until exhausted (then last repeats).
  pollSequence?: FakeRun[];
  errorOnCreate?: { status: number; body?: string };
}): {
  fetchImpl: CursorHttpFetch;
  calls: Array<{ method: string; url: string; body?: string }>;
} {
  const calls: Array<{ method: string; url: string; body?: string }> = [];
  const seq = [...(opts.pollSequence ?? [])];
  const fetchImpl: CursorHttpFetch = async (url, init) => {
    const body = typeof init.body === "string" ? init.body : undefined;
    const entry: { method: string; url: string; body?: string } = { method: init.method, url };
    if (body !== undefined) entry.body = body;
    calls.push(entry);
    const headers = { get: (_n: string) => null };
    if (init.method === "POST" && url.endsWith("/v1/agents")) {
      if (opts.errorOnCreate) {
        const e = opts.errorOnCreate;
        return {
          ok: false,
          status: e.status,
          headers,
          async text() {
            return e.body ?? JSON.stringify({ error: { code: "unauthorized", message: "bad key" } });
          },
        };
      }
      return {
        ok: true,
        status: 200,
        headers,
        async text() {
          return JSON.stringify({
            agent: { id: "bc-fake-1" },
            run: { id: opts.initial.id, status: opts.initial.status },
          });
        },
      };
    }
    if (init.method === "POST" && /\/v1\/agents\/[^/]+\/runs$/.test(url)) {
      return {
        ok: true,
        status: 200,
        headers,
        async text() {
          return JSON.stringify({ run: { id: opts.initial.id, status: "CREATING" } });
        },
      };
    }
    if (init.method === "GET" && /\/v1\/agents\/[^/]+\/runs\/[^/]+$/.test(url)) {
      const next = seq.length > 1 ? seq.shift()! : seq[0] ?? opts.initial;
      return {
        ok: true,
        status: 200,
        headers,
        async text() {
          return JSON.stringify(next);
        },
      };
    }
    if (init.method === "GET" && url.endsWith("/v1/me")) {
      return {
        ok: true,
        status: 200,
        headers,
        async text() {
          return JSON.stringify({ apiKeyName: "test-key", createdAt: "2026-05-01T00:00:00Z" });
        },
      };
    }
    return {
      ok: false,
      status: 404,
      headers,
      async text() {
        return `{"error":{"code":"not_found","message":"${init.method} ${url}"}}`;
      },
    };
  };
  return { fetchImpl, calls };
}

function makeAdapter(opts: Parameters<typeof mkFetch>[0]): {
  adapter: CursorSdkAdapter;
  calls: Array<{ method: string; url: string; body?: string }>;
} {
  const { fetchImpl, calls } = mkFetch(opts);
  const adapter = new CursorSdkAdapter({
    apiKey: "test-key",
    baseUrl: "https://api.cursor.test",
    fetchImplForTests: fetchImpl,
    cliFallback: { invocation: ["/definitely/not/a/real/binary"] },
  });
  return { adapter, calls };
}

test("Task #1562 — status === 'FINISHED' returns run.result as the Sam line", async () => {
  const { adapter } = makeAdapter({
    initial: { id: "run-1", status: "CREATING" },
    pollSequence: [
      { id: "run-1", status: "RUNNING" },
      { id: "run-1", status: "FINISHED", result: "  Hi from cloud agent.  " },
    ],
  });
  const reply = await adapter.ask({ systemPrompt: "sys", userPrompt: "u" });
  assert.equal(reply.text, "Hi from cloud agent.");
});

test("Task #1562 — non-FINISHED terminal statuses yield an empty reply", async () => {
  for (const status of ["ERROR", "CANCELLED", "EXPIRED"] as const) {
    const { adapter } = makeAdapter({
      initial: { id: "r", status: "CREATING" },
      pollSequence: [{ id: "r", status }],
    });
    const reply = await adapter.ask({ systemPrompt: "s", userPrompt: "u" });
    assert.equal(reply.text, "", `status=${status} should map to empty reply`);
  }
});

test("Task #1562 — second ask reuses the agentId via POST /v1/agents/:id/runs", async () => {
  const { adapter, calls } = makeAdapter({
    initial: { id: "run-1", status: "CREATING" },
    pollSequence: [{ id: "run-1", status: "FINISHED", result: "first" }],
  });
  await adapter.ask({ systemPrompt: "s", userPrompt: "u1" });
  // Second turn should reuse the agentId (no new POST /v1/agents).
  const calls2Start = calls.length;
  await adapter.ask({ systemPrompt: "s", userPrompt: "u2" });
  const newCalls = calls.slice(calls2Start);
  const createCalls = newCalls.filter(
    (c) => c.method === "POST" && c.url.endsWith("/v1/agents"),
  );
  const followupCalls = newCalls.filter(
    (c) => c.method === "POST" && /\/v1\/agents\/bc-fake-1\/runs$/.test(c.url),
  );
  assert.equal(createCalls.length, 0, "second ask must NOT POST /v1/agents again");
  assert.equal(followupCalls.length, 1, "second ask must POST /v1/agents/:id/runs");
});

test("Task #1562 — 401 from createAgent trips CLI fallback for subsequent calls", async () => {
  const { adapter, calls } = makeAdapter({
    initial: { id: "r", status: "CREATING" },
    errorOnCreate: { status: 401, body: '{"error":{"code":"unauthorized","message":"bad key"}}' },
  });
  // Silence the stderr breadcrumb for clean test output.
  const origWrite = process.stderr.write.bind(process.stderr);
  let captured = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
    return true;
  };
  try {
    await adapter.ask({ systemPrompt: "s", userPrompt: "u" });
    assert.ok(adapter._didFallBackToCli(), "expected fallback after 401");
    assert.match(captured, /falling back to cursor-agent CLI/);
    const callsBefore = calls.length;
    await adapter.ask({ systemPrompt: "s", userPrompt: "u2" });
    // Second ask must NOT hit the HTTP fetch — fully delegated to CLI fallback.
    assert.equal(calls.length, callsBefore, "post-fallback ask must not call HTTP API");
  } finally {
    process.stderr.write = origWrite;
  }
});

test("Task #1562 — probe() calls GET /v1/me on success path", async () => {
  const { adapter, calls } = makeAdapter({
    initial: { id: "r", status: "FINISHED", result: "ok" },
  });
  const result = await adapter.probe();
  assert.equal(result.ok, true);
  assert.match(result.version ?? "", /cursor-cloud/);
  const meCalls = calls.filter((c) => c.method === "GET" && c.url.endsWith("/v1/me"));
  assert.equal(meCalls.length, 1);
});
