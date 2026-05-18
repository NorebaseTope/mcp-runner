# Cursor Cloud Agent HTTPS API (reference)

This is the subset of Cursor's cloud-agent HTTP surface that `@prepsavant/mcp`'s
`CursorSdkAdapter` calls directly (Task #1562). It replaces the `@cursor/sdk`
optional dependency, whose only native dep (`sqlite3`) was the dominant source of
install failures on `win32-arm64` and the long-pole on bundle size for every
other platform.

The contract here was reverse-engineered from `@cursor/sdk@1.0.13`'s bundled
`CloudApiClient` (`dist/cjs/index.js` + `dist/cjs/cloud-api-client.d.ts`) on
2026-05-17. If Cursor publishes an official public spec we should swap to that
as the source of truth; until then, keep this doc in lock-step with whatever
endpoints `cursor-http-client.ts` actually calls.

## Base URL

```
https://api.cursor.com
```

Override with `CURSOR_BACKEND_URL` (mirrors the SDK env var, so an operator
already pointing the SDK at a staging endpoint keeps working after the cutover).

## Auth

Every request:

```
Authorization: Bearer ${CURSOR_API_KEY}
Content-Type: application/json     (only when a request body is present)
x-cursor-client-type: sdk
x-cursor-client-version: <semver>  (our runner version; informational)
Idempotency-Key: <opaque>          (optional; on POST /v1/agents + POST /v1/agents/:id/runs)
```

No cookies, no signed URLs, no per-request signature. A plain `Bearer` token
in the `Authorization` header is the only credential the API needs.

## Endpoints we use

Only these five are touched by `cursor-http-client.ts`:

### `GET /v1/me`

Auth probe. Returns `{ apiKeyName, userId?, userEmail?, ..., createdAt }`. Used
by `prepsavant doctor` and by `CursorSdkAdapter.probe()` so we surface a bad /
missing key BEFORE the first coached cadence beat instead of mid-tick.

### `POST /v1/agents`

Creates a new cloud agent AND its first run in a single call.

Request body (`V1CreateAgentRequest`, trimmed to fields we send):

```jsonc
{
  "prompt": { "text": "<systemPrompt>\n\n---\n\n<userPrompt>" },
  "model":  { "id": "<model-id>" }   // optional; omitted when unset
}
```

Response: `{ "agent": V1Agent & { latestRunId: string }, "run": V1Run }`.
We persist `agent.id` (a `bc-…` cloud id) for the lifetime of the
`CursorSdkAdapter` instance so subsequent user turns reuse the same
conversation context.

### `POST /v1/agents/:agentId/runs`

Follow-up message on an existing agent.

Request body (`V1CreateRunRequest`):

```jsonc
{
  "prompt": { "text": "<systemPrompt>\n\n---\n\n<userPrompt>" },
  "model":  { "id": "<model-id>" }   // optional
}
```

Response: `{ "run": V1Run }`. The returned `run.id` is what we poll.

### `GET /v1/agents/:agentId/runs/:runId`

Poll a run to completion. `V1Run.status` is one of:
`"CREATING" | "RUNNING" | "FINISHED" | "ERROR" | "CANCELLED" | "EXPIRED"`.

When `status === "FINISHED"`, `V1Run.result` carries the assistant text as a
single string. (This differs from the local-Agent SDK path that the pre-2.3
adapter used, where assistant text streamed in via `onStep` callbacks and
`result.result` was empirically empty — see `replit.md` gotcha for context. The
cloud HTTPS path populates `result` directly, which is why we can use simple
polling instead of an SSE stream subscription.)

We poll every `1000ms` (configurable) up to `ask`'s `timeoutMs`
(`DEFAULT_TIMEOUT_MS = 30_000`). A run still running at the deadline returns an
empty Sam line — same shape as the previous SDK path's timeout race.

### `POST /v1/agents/:agentId/runs/:runId/cancel`

Best-effort cancel on `dispose()`. Failure is swallowed (the agent will time
out server-side anyway).

## Error responses

Non-2xx responses return JSON shaped like
`{ error?: { code, message, helpUrl?, provider? } }` or the same fields flat
on the root. Status codes we special-case:

| status | meaning                | adapter behaviour                                  |
|--------|------------------------|----------------------------------------------------|
| 401    | bad / missing API key  | `probe()` returns `not_authenticated`, ask → ""    |
| 429    | rate limited           | exponential backoff up to 3 retries, then ""       |
| 5xx    | transient server error | one retry with backoff, then ""                    |
| other  | non-retryable          | bubble up `CursorHttpError`, ask returns ""        |

`Retry-After` (seconds or HTTP date) is honoured when present on 429.

## What we deliberately don't use

- `mcpServers`, `customSubagents`, `env`, `repos`, `workOnCurrentBranch`,
  `autoCreatePR`, `skipReviewerRequest` on `POST /v1/agents` — we want a
  conversational agent, not a background coding agent that opens PRs. Sending
  none of these spins up a "lone" cloud agent with no repo attached.
- `GET /v1/agents/:id/runs/:runId/stream` (SSE). Polling on `result` is
  sufficient for one-shot coach replies and avoids a long-lived connection
  the runner would have to babysit across `AbortController` plumbing.
- `GET /v1/models`, `GET /v1/repositories`, listing / archiving / deleting
  agents. None of those are on the Sam coach hot path.
