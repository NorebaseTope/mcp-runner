// Task #1562 — Thin HTTPS client for Cursor's cloud-agent API. Replaces
// the runner's prior dependency on `@cursor/sdk` (and `@cursor/sdk`'s
// only native sub-dep, `sqlite3`), which was the dominant source of
// install failures on `win32-arm64` and ~12 MB of dead weight on every
// platform. Built on `node:fetch` (built in to Node 18+) — zero
// native deps, zero optional deps.
//
// Endpoints are documented in `packages/mcp-runner/docs/cursor-http-api.md`.
// Keep that doc in lock-step with whatever this file actually calls.

const DEFAULT_BASE_URL = "https://api.cursor.com";
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;

// Subset of fields we actually read off the V1Run response shape; the
// server returns more, but we only need status + result text + id.
export interface CursorHttpRun {
  id: string;
  status: "CREATING" | "RUNNING" | "FINISHED" | "ERROR" | "CANCELLED" | "EXPIRED";
  result?: string;
  durationMs?: number;
}

export interface CursorHttpAgent {
  id: string;
  latestRunId?: string;
}

export interface CursorHttpMe {
  apiKeyName: string;
  userEmail?: string;
  userId?: number;
  createdAt: string;
}

export type CursorHttpFetch = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  headers: { get(name: string): string | null };
}>;

export interface CursorHttpClientOptions {
  apiKey: string;
  baseUrl?: string;
  clientVersion?: string;
  pollIntervalMs?: number;
  maxRetries?: number;
  /** @internal Injection seam for unit tests. Defaults to global `fetch`. */
  fetchImpl?: CursorHttpFetch;
}

export class CursorHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly endpoint: string;
  readonly retryable: boolean;
  constructor(args: {
    status: number;
    code: string;
    endpoint: string;
    message: string;
    retryable: boolean;
  }) {
    super(`[${args.code}] ${args.message}`);
    this.name = "CursorHttpError";
    this.status = args.status;
    this.code = args.code;
    this.endpoint = args.endpoint;
    this.retryable = args.retryable;
  }
}

export class CursorHttpClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly clientVersion: string;
  private readonly pollIntervalMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: CursorHttpFetch;

  constructor(opts: CursorHttpClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? process.env["CURSOR_BACKEND_URL"] ?? DEFAULT_BASE_URL).replace(
      /\/$/,
      "",
    );
    this.clientVersion = opts.clientVersion ?? "prepsavant-runner";
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    // Node 18+ exposes `fetch` as a global. We accept an explicit injection
    // for unit tests and fall through to the global at construction time so
    // a missing `fetch` (older Node, embedded runtime) surfaces with a
    // clear error instead of a runtime `undefined is not a function`.
    const injected = opts.fetchImpl;
    if (injected) {
      this.fetchImpl = injected;
    } else {
      const globalFetch = (globalThis as { fetch?: unknown }).fetch;
      if (typeof globalFetch !== "function") {
        throw new Error(
          "CursorHttpClient requires global fetch (Node 18+) or an explicit fetchImpl",
        );
      }
      this.fetchImpl = globalFetch as unknown as CursorHttpFetch;
    }
  }

  private buildHeaders(hasBody: boolean, idempotencyKey?: string): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "x-cursor-client-type": "sdk",
      "x-cursor-client-version": this.clientVersion,
    };
    if (hasBody) h["Content-Type"] = "application/json";
    if (idempotencyKey) h["Idempotency-Key"] = idempotencyKey;
    return h;
  }

  private async request<T>(args: {
    method: "GET" | "POST";
    path: string;
    body?: unknown;
    idempotencyKey?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<T> {
    const endpoint = `${args.method} ${args.path}`;
    const url = `${this.baseUrl}${args.path}`;
    const hasBody = args.body !== undefined;
    const headers = this.buildHeaders(hasBody, args.idempotencyKey);
    const bodyJson = hasBody ? JSON.stringify(args.body) : undefined;

    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      // Per-attempt AbortController honouring an optional outer signal +
      // per-request timeout. Without it, a hung connection would block
      // the entire ask() until the wrapping Promise.race timeout fires.
      const ac = new AbortController();
      const onOuterAbort = (): void => ac.abort();
      if (args.signal) args.signal.addEventListener("abort", onOuterAbort, { once: true });
      const timer = args.timeoutMs
        ? setTimeout(() => ac.abort(), args.timeoutMs)
        : null;
      try {
        const init: {
          method: string;
          headers: Record<string, string>;
          body?: string;
          signal?: AbortSignal;
        } = { method: args.method, headers, signal: ac.signal };
        if (bodyJson !== undefined) init.body = bodyJson;
        const res = await this.fetchImpl(url, init);
        if (res.ok) {
          const text = await res.text();
          if (!text) return {} as T;
          try {
            return JSON.parse(text) as T;
          } catch (parseErr) {
            throw new CursorHttpError({
              status: res.status,
              code: "parse_error",
              endpoint,
              message: `Failed to parse JSON response: ${(parseErr as Error).message}`,
              retryable: false,
            });
          }
        }
        const text = await res.text().catch(() => "");
        const err = this.parseError(res.status, text, endpoint);
        // 429 → honour Retry-After if present, otherwise exponential.
        if (res.status === 429 && attempt < this.maxRetries) {
          const retryAfter = res.headers.get("retry-after");
          const delay = parseRetryAfter(retryAfter) ?? backoffDelay(attempt);
          await sleep(delay);
          lastErr = err;
          continue;
        }
        // 5xx → one retry per remaining attempt with exponential backoff.
        if (res.status >= 500 && res.status <= 599 && attempt < this.maxRetries) {
          await sleep(backoffDelay(attempt));
          lastErr = err;
          continue;
        }
        throw err;
      } catch (e) {
        if (e instanceof CursorHttpError) {
          if (e.retryable && attempt < this.maxRetries) {
            lastErr = e;
            await sleep(backoffDelay(attempt));
            continue;
          }
          throw e;
        }
        // fetch-level network failure / abort. Treat aborts as
        // non-retryable so an outer timeout doesn't get burned through
        // by retries; treat everything else as retryable.
        const aborted = (e as { name?: string }).name === "AbortError";
        if (aborted) {
          throw new CursorHttpError({
            status: 0,
            code: "aborted",
            endpoint,
            message: "Request aborted",
            retryable: false,
          });
        }
        if (attempt < this.maxRetries) {
          lastErr = e;
          await sleep(backoffDelay(attempt));
          continue;
        }
        throw new CursorHttpError({
          status: 0,
          code: "network_error",
          endpoint,
          message: (e as Error).message ?? "network error",
          retryable: false,
        });
      } finally {
        if (timer) clearTimeout(timer);
        if (args.signal) args.signal.removeEventListener("abort", onOuterAbort);
      }
    }
    // All retries consumed.
    throw lastErr instanceof Error
      ? lastErr
      : new CursorHttpError({
          status: 0,
          code: "exhausted_retries",
          endpoint,
          message: "All retries exhausted",
          retryable: false,
        });
  }

  private parseError(status: number, text: string, endpoint: string): CursorHttpError {
    let code = "unknown";
    let message = text || `Request failed with status ${status}`;
    try {
      const parsed = JSON.parse(text) as { error?: { code?: string; message?: string }; code?: string; message?: string };
      const errBlock = parsed.error ?? parsed;
      if (typeof errBlock.code === "string") code = errBlock.code;
      if (typeof errBlock.message === "string") message = errBlock.message;
    } catch {
      /* non-JSON error body; keep raw text as message */
    }
    const retryable = status === 429 || (status >= 500 && status <= 599);
    return new CursorHttpError({ status, code, endpoint, message, retryable });
  }

  // ----- Public API ------------------------------------------------------

  /** Auth probe. Resolves on 200, throws CursorHttpError otherwise. */
  async getMe(opts: { timeoutMs?: number } = {}): Promise<CursorHttpMe> {
    const out: { timeoutMs?: number } = {};
    if (opts.timeoutMs !== undefined) out.timeoutMs = opts.timeoutMs;
    return this.request<CursorHttpMe>({ method: "GET", path: "/v1/me", ...out });
  }

  /**
   * Create a new cloud agent AND its first run in one call. Returns the
   * persistent `agentId` (used for subsequent `sendMessage` calls) and the
   * first `runId` (used by the caller to poll for the assistant reply).
   */
  async createAgent(args: {
    prompt: string;
    model?: string;
    idempotencyKey?: string;
    timeoutMs?: number;
  }): Promise<{ agentId: string; runId: string }> {
    const body: Record<string, unknown> = { prompt: { text: args.prompt } };
    if (args.model) body["model"] = { id: args.model };
    const reqOpts: {
      method: "POST";
      path: string;
      body: unknown;
      idempotencyKey?: string;
      timeoutMs?: number;
    } = { method: "POST", path: "/v1/agents", body };
    if (args.idempotencyKey) reqOpts.idempotencyKey = args.idempotencyKey;
    if (args.timeoutMs !== undefined) reqOpts.timeoutMs = args.timeoutMs;
    const res = await this.request<{ agent: CursorHttpAgent & { latestRunId?: string }; run: CursorHttpRun }>(reqOpts);
    const agentId = res.agent?.id;
    const runId = res.run?.id ?? res.agent?.latestRunId;
    if (!agentId || !runId) {
      throw new CursorHttpError({
        status: 0,
        code: "malformed_response",
        endpoint: "POST /v1/agents",
        message: `Missing agent.id or run.id in createAgent response`,
        retryable: false,
      });
    }
    return { agentId, runId };
  }

  /** Send a follow-up message on an existing agent. */
  async sendMessage(args: {
    agentId: string;
    prompt: string;
    model?: string;
    idempotencyKey?: string;
    timeoutMs?: number;
  }): Promise<{ runId: string }> {
    const body: Record<string, unknown> = { prompt: { text: args.prompt } };
    if (args.model) body["model"] = { id: args.model };
    const reqOpts: {
      method: "POST";
      path: string;
      body: unknown;
      idempotencyKey?: string;
      timeoutMs?: number;
    } = {
      method: "POST",
      path: `/v1/agents/${encodeURIComponent(args.agentId)}/runs`,
      body,
    };
    if (args.idempotencyKey) reqOpts.idempotencyKey = args.idempotencyKey;
    if (args.timeoutMs !== undefined) reqOpts.timeoutMs = args.timeoutMs;
    const res = await this.request<{ run: CursorHttpRun }>(reqOpts);
    if (!res.run?.id) {
      throw new CursorHttpError({
        status: 0,
        code: "malformed_response",
        endpoint: `POST /v1/agents/:id/runs`,
        message: "Missing run.id in sendMessage response",
        retryable: false,
      });
    }
    return { runId: res.run.id };
  }

  /** Fetch a single run snapshot. */
  async getRun(agentId: string, runId: string, opts: { timeoutMs?: number } = {}): Promise<CursorHttpRun> {
    const reqOpts: { method: "GET"; path: string; timeoutMs?: number } = {
      method: "GET",
      path: `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`,
    };
    if (opts.timeoutMs !== undefined) reqOpts.timeoutMs = opts.timeoutMs;
    return this.request<CursorHttpRun>(reqOpts);
  }

  /**
   * Poll `getRun` until it reaches a terminal status or the overall
   * `timeoutMs` budget is exhausted. Resolves with the final run snapshot
   * (the caller decides what to do based on `status`). Throws on
   * non-retryable HTTP errors.
   */
  async waitForRun(
    agentId: string,
    runId: string,
    opts: { timeoutMs: number; pollIntervalMs?: number; signal?: AbortSignal },
  ): Promise<CursorHttpRun> {
    const deadline = Date.now() + opts.timeoutMs;
    const pollMs = opts.pollIntervalMs ?? this.pollIntervalMs;
    while (true) {
      if (opts.signal?.aborted) {
        throw new CursorHttpError({
          status: 0,
          code: "aborted",
          endpoint: `GET /v1/agents/:id/runs/:runId`,
          message: "Polling aborted",
          retryable: false,
        });
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        // Return the last snapshot we can grab; caller treats a non-
        // finished status as an empty reply.
        return this.getRun(agentId, runId, { timeoutMs: 5_000 });
      }
      const run = await this.getRun(agentId, runId, {
        timeoutMs: Math.min(remaining, 10_000),
      });
      if (isTerminal(run.status)) return run;
      await sleep(Math.min(pollMs, remaining));
    }
  }

  /** Best-effort cancel — failures are swallowed. */
  async cancelRun(agentId: string, runId: string): Promise<void> {
    try {
      await this.request<unknown>({
        method: "POST",
        path: `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/cancel`,
        timeoutMs: 3_000,
      });
    } catch {
      /* swallow — the cloud agent will time out server-side */
    }
  }
}

function isTerminal(status: CursorHttpRun["status"]): boolean {
  return status === "FINISHED" || status === "ERROR" || status === "CANCELLED" || status === "EXPIRED";
}

function backoffDelay(attempt: number): number {
  // 500ms, 1s, 2s, 4s, ... — bounded retries means this never explodes.
  return RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const asSeconds = Number(header);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) return Math.min(asSeconds * 1000, 30_000);
  const asDate = Date.parse(header);
  if (Number.isFinite(asDate)) {
    return Math.max(0, Math.min(asDate - Date.now(), 30_000));
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, Math.max(0, ms));
    (t as { unref?: () => void }).unref?.();
  });
}
