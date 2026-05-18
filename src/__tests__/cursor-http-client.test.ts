// Task #1562 — Direct unit coverage for the HTTP cloud-agent client
// that replaced `@cursor/sdk`. The CursorSdkAdapter tests
// (task-1560-cursor-sdk-reply.test.ts) exercise the integration path;
// these tests pin the client's wire contract: auth header shape,
// request/response JSON, 429/Retry-After handling, 5xx retry, abort.

import test from "node:test";
import assert from "node:assert/strict";

import {
  CursorHttpClient,
  CursorHttpError,
  type CursorHttpFetch,
} from "../coached/cursor-http-client.js";

type Call = { method: string; url: string; headers: Record<string, string>; body?: string };

function mkFetch(
  handler: (call: Call, attempt: number) => {
    ok: boolean;
    status: number;
    body: string;
    headers?: Record<string, string>;
  },
): { fetchImpl: CursorHttpFetch; calls: Call[] } {
  const calls: Call[] = [];
  let attempt = 0;
  const fetchImpl: CursorHttpFetch = async (url, init) => {
    const body = typeof init.body === "string" ? init.body : undefined;
    const call: Call = { method: init.method, url, headers: init.headers };
    if (body !== undefined) call.body = body;
    calls.push(call);
    const res = handler(call, attempt++);
    const headerMap = res.headers ?? {};
    return {
      ok: res.ok,
      status: res.status,
      headers: { get: (n: string) => headerMap[n.toLowerCase()] ?? null },
      async text() {
        return res.body;
      },
    };
  };
  return { fetchImpl, calls };
}

test("createAgent sends Bearer auth + JSON body and parses agent.id + run.id", async () => {
  const { fetchImpl, calls } = mkFetch(() => ({
    ok: true,
    status: 200,
    body: JSON.stringify({ agent: { id: "bc-abc" }, run: { id: "run-xyz", status: "CREATING" } }),
  }));
  const client = new CursorHttpClient({ apiKey: "k-test", baseUrl: "https://api.test", fetchImpl });
  const out = await client.createAgent({ prompt: "hello", model: "composer-2" });
  assert.equal(out.agentId, "bc-abc");
  assert.equal(out.runId, "run-xyz");
  assert.equal(calls.length, 1);
  const c = calls[0]!;
  assert.equal(c.method, "POST");
  assert.equal(c.url, "https://api.test/v1/agents");
  assert.equal(c.headers["Authorization"], "Bearer k-test");
  assert.equal(c.headers["Content-Type"], "application/json");
  assert.equal(c.headers["x-cursor-client-type"], "sdk");
  const parsed = JSON.parse(c.body ?? "{}") as { prompt: { text: string }; model: { id: string } };
  assert.equal(parsed.prompt.text, "hello");
  assert.equal(parsed.model.id, "composer-2");
});

test("malformed createAgent response throws CursorHttpError(malformed_response)", async () => {
  const { fetchImpl } = mkFetch(() => ({
    ok: true,
    status: 200,
    body: JSON.stringify({ agent: { id: "bc-abc" } }), // missing run
  }));
  const client = new CursorHttpClient({ apiKey: "k", baseUrl: "https://api.test", fetchImpl });
  await assert.rejects(
    () => client.createAgent({ prompt: "x" }),
    (e: unknown) => e instanceof CursorHttpError && e.code === "malformed_response",
  );
});

test("429 with Retry-After backs off then succeeds within maxRetries", async () => {
  const { fetchImpl, calls } = mkFetch((_c, attempt) => {
    if (attempt === 0) {
      return { ok: false, status: 429, body: '{"error":{"code":"rate_limited","message":"slow down"}}', headers: { "retry-after": "0" } };
    }
    return { ok: true, status: 200, body: JSON.stringify({ apiKeyName: "k", createdAt: "2026-05-17" }) };
  });
  const client = new CursorHttpClient({ apiKey: "k", baseUrl: "https://api.test", fetchImpl, maxRetries: 3 });
  const me = await client.getMe();
  assert.equal(me.apiKeyName, "k");
  assert.equal(calls.length, 2);
});

test("5xx retries and ultimately throws after maxRetries", async () => {
  const { fetchImpl, calls } = mkFetch(() => ({
    ok: false,
    status: 503,
    body: '{"error":{"code":"unavailable","message":"down"}}',
  }));
  const client = new CursorHttpClient({ apiKey: "k", baseUrl: "https://api.test", fetchImpl, maxRetries: 2 });
  await assert.rejects(
    () => client.getMe(),
    (e: unknown) => e instanceof CursorHttpError && e.status === 503,
  );
  assert.equal(calls.length, 3); // initial + 2 retries
});

test("401 is non-retryable and surfaces typed error immediately", async () => {
  const { fetchImpl, calls } = mkFetch(() => ({
    ok: false,
    status: 401,
    body: '{"error":{"code":"unauthorized","message":"bad key"}}',
  }));
  const client = new CursorHttpClient({ apiKey: "k", baseUrl: "https://api.test", fetchImpl, maxRetries: 3 });
  await assert.rejects(
    () => client.getMe(),
    (e: unknown) => e instanceof CursorHttpError && e.status === 401 && e.code === "unauthorized",
  );
  assert.equal(calls.length, 1);
});

test("waitForRun polls until FINISHED", async () => {
  const sequence: Array<{ status: string; result?: string }> = [
    { status: "CREATING" },
    { status: "RUNNING" },
    { status: "FINISHED", result: "done" },
  ];
  const { fetchImpl } = mkFetch(() => {
    const next = sequence.shift() ?? { status: "FINISHED", result: "done" };
    return { ok: true, status: 200, body: JSON.stringify({ id: "r", ...next }) };
  });
  const client = new CursorHttpClient({
    apiKey: "k",
    baseUrl: "https://api.test",
    fetchImpl,
    pollIntervalMs: 1,
  });
  const run = await client.waitForRun("bc-1", "r", { timeoutMs: 5_000 });
  assert.equal(run.status, "FINISHED");
  assert.equal(run.result, "done");
});

test("waitForRun returns last snapshot at deadline (no throw)", async () => {
  const { fetchImpl } = mkFetch(() => ({
    ok: true,
    status: 200,
    body: JSON.stringify({ id: "r", status: "RUNNING" }),
  }));
  const client = new CursorHttpClient({
    apiKey: "k",
    baseUrl: "https://api.test",
    fetchImpl,
    pollIntervalMs: 20,
  });
  const run = await client.waitForRun("bc-1", "r", { timeoutMs: 50 });
  assert.equal(run.status, "RUNNING");
});
