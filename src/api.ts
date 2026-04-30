// Minimal typed fetch client over the Sam HTTP API. We deliberately don't
// depend on the generated client here so the published runner package stays
// self-contained.
import { ADAPTER_VERSION, type RunnerConfig } from "./config.js";
import type { DoctorResult } from "./doctor.js";

export interface CheckInDirective {
  action: "probe" | "hint_offer" | "time_warning" | "wrap_up" | "stay_quiet";
  samVoiceLine: string | null;
  reason: string;
  // Only set for time_warning / wrap_up. Hosts dedup by milestone.
  timeMilestone?: "midway" | "warning" | "final_stretch" | "over_time" | null;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
    msg: string,
  ) {
    super(msg);
  }
}

export interface DeviceLinkStartResponse {
  deviceCode: string;
  userCode: string;
  // Already includes ?code=<userCode> when minted from the server.
  verificationUri: string;
  expiresInSeconds: number;
  pollIntervalSeconds: number;
}

export interface DeviceLinkPollResponse {
  status: "pending" | "authorized" | "expired" | "denied";
  token?: string;
  deviceId?: string;
}

export interface RunnerHandshakeResponse {
  user: { id: string; email: string };
  device: { id: string; label: string };
  server: { version: string; adapterVersionMin: string };
}

export interface RunnerLanguageTests {
  entry: string;
  timeoutMs?: number;
  cases: Array<{ id: string; args: unknown; expected: unknown }>;
}

export interface StudyMessageDto {
  id: string;
  role: "user" | "sam";
  body: string;
  createdAt: string;
}

export interface StudyConversationDetail {
  id: string;
  questionId: string;
  mode: "study" | "post_session";
  sessionId?: string;
  messages: StudyMessageDto[];
  question: {
    id: string;
    title: string;
    prompt: string;
    difficulty: string;
    estimatedMinutes: number;
  };
}

// Wire shape emitted by the runner's streaming study endpoint. Mirrors
// the StudyStreamEvent union in artifacts/api-server/src/lib/study-conversations-core.ts.
export type StudyStreamEvent =
  | { type: "user_persisted"; message: StudyMessageDto }
  // Emitted exactly once after `user_persisted` and before the first
  // `delta`, so the runner can surface a "Sam is thinking…" indicator
  // during the model warm-up gap. Phrasing lives in the runner — the
  // server intentionally does not pin a string.
  | { type: "thinking" }
  | { type: "delta"; text: string }
  | { type: "complete"; message: StudyMessageDto }
  | { type: "error"; error: string };

export interface RunnerQuestionDetail {
  question: {
    id: string;
    title: string;
    roleFamily: string;
    difficulty: string;
    estimatedMinutes?: number;
    languages: string[];
  };
  prompt?: string;
  tags?: string[];
  signatures: Record<string, string>;
  tests: Record<string, RunnerLanguageTests>;
}

export class SamApi {
  constructor(private readonly cfg: RunnerConfig) {}

  private url(p: string): string {
    return this.cfg.apiBaseUrl.replace(/\/$/, "") + p;
  }

  private async request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; auth?: boolean } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-prepsavant-adapter": ADAPTER_VERSION,
    };
    const auth = opts.auth ?? true;
    if (auth) {
      if (!this.cfg.token) {
        throw new ApiError(
          401,
          null,
          "No device token. Run `prepsavant auth` first.",
        );
      }
      headers["authorization"] = `Bearer ${this.cfg.token}`;
    }
    const res = await fetch(this.url(path), {
      method,
      headers,
      body: opts.body == null ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) {
      throw new ApiError(
        res.status,
        parsed,
        `${method} ${path} → ${res.status}`,
      );
    }
    return parsed as T;
  }

  // --- Device link flow ---------------------------------------------------
  startDeviceLink(meta: {
    hostKind?: string;
    platform: string;
    suggestedLabel: string;
  }): Promise<DeviceLinkStartResponse> {
    return this.request<DeviceLinkStartResponse>(
      "POST",
      "/api/devices/link/start",
      {
        auth: false,
        body: { ...meta, adapterVersion: ADAPTER_VERSION },
      },
    );
  }

  pollDeviceLink(deviceCode: string): Promise<DeviceLinkPollResponse> {
    return this.request<DeviceLinkPollResponse>(
      "POST",
      "/api/devices/link/poll",
      { auth: false, body: { deviceCode } },
    );
  }

  // --- Runner endpoints ---------------------------------------------------
  handshake(): Promise<RunnerHandshakeResponse> {
    return this.request<RunnerHandshakeResponse>(
      "POST",
      "/api/runner/handshake",
      { body: { adapterVersion: ADAPTER_VERSION } },
    );
  }

  // Lightweight entitlement probe used by `prepsavant doctor` to surface the
  // user's plan tier without a full handshake round-trip.
  getMe(): Promise<{ plan: "free" | "pro" | "lifetime" }> {
    return this.request<{ plan: "free" | "pro" | "lifetime" }>(
      "GET",
      "/api/runner/me",
    );
  }

  // Latest published runner version, exposed by the API for `prepsavant
  // doctor` so the CLI can render the same "runner is out of date" advisory
  // the dashboard shows. Public — does not require a device token, so it
  // works on a fresh install before `prepsavant auth`. (task-464)
  getRunnerVersion(): Promise<{ version: string }> {
    return this.request<{ version: string }>(
      "GET",
      "/api/runner/version",
      { auth: false },
    );
  }

  listQuestions(): Promise<{ items: RunnerQuestionDetail["question"][] }> {
    return this.request("GET", "/api/runner/questions");
  }

  getQuestion(id: string): Promise<RunnerQuestionDetail> {
    return this.request("GET", `/api/runner/questions/${encodeURIComponent(id)}`);
  }

  async startSession(body: {
    questionId: string;
    companyId?: string;
    targetDurationMinutes?: number;
  }): Promise<{ sessionId: string }> {
    // The server returns the full RunnerStartSessionResponse shape
    // (`{ session: { id, ... }, kickoffBriefVerbatim, hintLadderLength }`),
    // not a flat `{ sessionId }`. Normalize here so callers in the MCP server
    // can rely on a stable shape regardless of upstream changes.
    const res = await this.request<{
      session: { id: string };
    }>("POST", "/api/runner/sessions", { body });
    return { sessionId: res.session.id };
  }

  getSession(id: string): Promise<unknown> {
    return this.request("GET", `/api/runner/sessions/${encodeURIComponent(id)}`);
  }

  pushAttempt(
    sessionId: string,
    body: {
      language: string;
      code: string;
      outcome: "pass" | "fail" | "error" | "timeout";
      timedOut?: boolean;
      durationMs: number;
      adapterVersion: string;
      runtimeVersion: string;
      cases: Array<{
        id: string;
        status: "pass" | "fail" | "error" | "timeout";
        durationMs?: number;
        stderrExcerpt?: string;
      }>;
    },
  ): Promise<{
    attempt: { id: string };
    reviewVerbatim: string;
    probeVerbatim: string;
    nextAllowedActions: string[];
    nextAction?: CheckInDirective | null;
  }> {
    return this.request(
      "POST",
      `/api/runner/sessions/${encodeURIComponent(sessionId)}/attempts`,
      { body },
    );
  }

  pushReview(
    sessionId: string,
    body: {
      attemptId: string;
      reviewText: string;
      probeText?: string;
      source: "runner_sampling" | "runner_fallback";
    },
  ): Promise<{ ok: true }> {
    return this.request(
      "POST",
      `/api/runner/sessions/${encodeURIComponent(sessionId)}/review`,
      { body },
    );
  }

  requestHint(
    sessionId: string,
  ): Promise<{
    level: number;
    totalLevels: number;
    hintText: string;
    exhausted: boolean;
    nextAction?: CheckInDirective | null;
  }> {
    return this.request(
      "POST",
      `/api/runner/sessions/${encodeURIComponent(sessionId)}/hint`,
    );
  }

  checkIn(sessionId: string): Promise<CheckInDirective> {
    return this.request(
      "POST",
      `/api/runner/sessions/${encodeURIComponent(sessionId)}/check-in`,
    );
  }

  endSession(sessionId: string): Promise<unknown> {
    return this.request(
      "POST",
      `/api/runner/sessions/${encodeURIComponent(sessionId)}/end`,
    );
  }

  pushCoachedAiAssist(
    sessionId: string,
    body: { count: number; summary?: string },
  ): Promise<{ ok: boolean }> {
    return this.request(
      "POST",
      `/api/runner/sessions/${encodeURIComponent(sessionId)}/coached-events`,
      { body: { ...body, kind: "ai_assist" as const } },
    );
  }

  // Report a runner-driven stall escalation back to the server (Task #564).
  // Called whenever the local stall watchdog upgrades a server `stay_quiet`
  // directive into a Sam-voice probe because the user stopped editing files.
  // Same endpoint as AI-assist; discriminated by `kind`.
  pushCoachedStallNudge(
    sessionId: string,
    body: { count: number; summary?: string },
  ): Promise<{ ok: boolean }> {
    return this.request(
      "POST",
      `/api/runner/sessions/${encodeURIComponent(sessionId)}/coached-events`,
      { body: { ...body, kind: "stall_nudge" as const } },
    );
  }

  pushJobEnrichment(
    jobId: string,
    body: {
      whyYouFit: string;
      applicationAngle: string;
      source: "runner_sampling" | "runner_fallback";
    },
  ): Promise<{ ok: true }> {
    return this.request(
      "POST",
      `/api/runner/enrichment/jobs/${encodeURIComponent(jobId)}`,
      { body },
    );
  }

  // POST the local `prepsavant doctor` snapshot to the API. The server
  // upserts on the calling deviceId, so calling this on every doctor run
  // keeps a single per-device row that the dashboard can read for the
  // Health tile and /setup/doctor page. (task-349)
  pushDoctor(
    result: DoctorResult,
  ): Promise<{ ok: true; deviceId: string; receivedAt: string }> {
    return this.request("POST", "/api/runner/doctor", { body: result });
  }

  pushShortlistAnnotation(
    shortlistItemId: string,
    body: {
      annotation: string;
      source: "runner_sampling" | "runner_fallback";
    },
  ): Promise<{ ok: true }> {
    return this.request(
      "POST",
      `/api/runner/enrichment/shortlist/${encodeURIComponent(shortlistItemId)}`,
      { body },
    );
  }

  // --- Sam persona + enrichment cache ------------------------------------
  // The dashboard reads from `samEnrichmentTable` keyed by surface×subject
  // and prefers it over the static template, but no client pushes there
  // unless the runner does. These three endpoints are the contract:
  //
  //   GET    /sam/persona              -> persona body + composite version
  //   PUT    /sam/enrichment           -> upsert one (surface, subject) row
  //   DELETE /sam/enrichment?...       -> forget one (surface, subject) row
  //
  // The composite `version` returned from /sam/persona is monotonic; the
  // runner caches the last value and only re-renders its system prompt when
  // it bumps.
  getSamPersona(): Promise<{
    version: number;
    persona: { body: string; version: number; updatedAt: string };
    toneRules: { body: string; version: number; updatedAt: string };
    boundaryConstraints: {
      body: string;
      version: number;
      updatedAt: string;
    };
  }> {
    return this.request("GET", "/api/sam/persona");
  }

  putSamEnrichment(body: {
    surface: string;
    subject?: string;
    body: string;
    modelLabel?: string;
  }): Promise<{
    id: string;
    surface: string;
    subject: string;
    body: string;
    source: string;
    modelLabel: string | null;
    generatedAt: string;
    updatedAt: string;
  }> {
    return this.request("PUT", "/api/sam/enrichment", { body });
  }

  deleteSamEnrichment(args: {
    surface: string;
    subject?: string;
  }): Promise<{ ok: boolean }> {
    const params = new URLSearchParams({ surface: args.surface });
    if (args.subject) params.set("subject", args.subject);
    return this.request("DELETE", `/api/sam/enrichment?${params.toString()}`);
  }

  // --- Job research ingestion --------------------------------------------
  startResearchRun(body: {
    runnerVersion?: string;
    modelHint?: string;
    notes?: string;
  }): Promise<{
    id: string;
    ownerId: string;
    source: string;
    startedAt: string;
  }> {
    return this.request("POST", "/api/jobs/research/start", {
      body: { source: "runner", ...body },
    });
  }

  recordResearchResult(
    runId: string,
    body: {
      jobs: Array<{
        companyName: string;
        companySlug?: string;
        industry?: string;
        careersUrl?: string;
        title: string;
        canonicalUrl: string;
        source?: string;
        roleFamily: string;
        seniority: string;
        location: string;
        remotePolicy: string;
        postingExcerpt: string;
        team?: string;
        summary?: string;
        postedAt?: string;
      }>;
      // Optional explicit company descriptor for this batch. When set, the
      // server appends a per-company outcome row to the run even if jobs[]
      // is empty (refusal / fetch-error case) so /admin/research can show
      // the full breakdown rather than just aggregate counters.
      company?: {
        name: string;
        slug?: string;
        careersUrl?: string;
      };
      complete?: boolean;
      errorText?: string;
      // Per-company outcome metadata used by the careers-page cache so the
      // server can short-circuit duplicate work and the admin UI can tell
      // "skipped (unchanged)" apart from "skipped (error)".
      careersUrl?: string;
      companyName?: string;
      contentHash?: string;
      skipReason?: "unchanged" | "error";
    },
  ): Promise<{
    id: string;
    added: number;
    updated: number;
    skipped: number;
    companiesScanned: number;
    complete: boolean;
    cacheUpdated?: boolean;
  }> {
    return this.request(
      "POST",
      `/api/jobs/research/${encodeURIComponent(runId)}/record`,
      { body },
    );
  }

  // Look up the cached content hash + fetch timestamp for a careers page so
  // the runner can decide whether to skip the host-model extraction. Returns
  // `null` when nothing is cached yet (HTTP 404).
  async getResearchCache(careersUrl: string): Promise<{
    careersUrl: string;
    contentHash: string;
    fetchedAt: string;
    lastResearchRunId?: string;
  } | null> {
    try {
      return await this.request(
        "GET",
        `/api/jobs/research/cache?careersUrl=${encodeURIComponent(careersUrl)}`,
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  }

  listResearchTargets(): Promise<{
    targets: Array<{
      slug?: string;
      companyName: string;
      careersUrl: string;
      industry?: string;
      updatedAt?: string;
    }>;
  }> {
    return this.request("GET", "/api/jobs/research/targets");
  }

  listResearchRuns(): Promise<{
    runs: Array<{
      id: string;
      source: string;
      runnerVersion?: string;
      modelHint?: string;
      companiesScanned: number;
      jobsAdded: number;
      jobsUpdated: number;
      jobsSkipped: number;
      errorText?: string;
      notes?: string;
      startedAt: string;
      completedAt?: string;
    }>;
  }> {
    return this.request("GET", "/api/jobs/research");
  }

  // --- AI-Assisted mode ---------------------------------------------------

  async startAiAssistedSession(body: {
    questionId: string;
    companyId?: string;
    targetDurationMinutes?: number;
    aiAssisted: {
      tool: string;
      toolVersion: string;
      adapterVersion: string;
      runnerVersion: string;
      runnerPublicKey: string;
      capabilityManifest: unknown;
    };
  }): Promise<{ sessionId: string; certificateJwt: string }> {
    const res = await this.request<{
      session: { id: string };
      certificateJwt: string;
    }>("POST", "/api/runner/sessions", { body });
    return { sessionId: res.session.id, certificateJwt: res.certificateJwt };
  }

  appendAiAssistedEvents(
    sessionId: string,
    events: unknown[],
  ): Promise<{ accepted: number; rejected: number }> {
    return this.request(
      "POST",
      `/api/runner/ai-sessions/${encodeURIComponent(sessionId)}/events`,
      { body: { events } },
    );
  }

  uploadAiAssistedSnapshot(
    sessionId: string,
    snapshot: {
      shadowCommitSha: string;
      parentSha: string | null;
      filesChanged: number;
      snapshotKind: string;
      capturedAt: string;
    },
  ): Promise<{ ok: true }> {
    return this.request(
      "POST",
      `/api/runner/ai-sessions/${encodeURIComponent(sessionId)}/snapshots`,
      { body: snapshot },
    );
  }

  finalizeAiAssistedBundle(
    sessionId: string,
    manifest: {
      session_id: string;
      event_count: number;
      final_event_hash: string;
      log_hash: string;
      snapshot_count: number;
      trust_gap_count: number;
      ended_at: string;
      runner_version: string;
      adapter_version: string;
    },
  ): Promise<{ ok: true; integrityStatus: string }> {
    return this.request(
      "POST",
      `/api/runner/ai-sessions/${encodeURIComponent(sessionId)}/bundle`,
      { body: manifest },
    );
  }

  anchorAiAssistedEvents(
    sessionId: string,
    anchors: Array<{ seq: number; eventHash: string }>,
  ): Promise<{ ok: true; anchored: number }> {
    return this.request(
      "POST",
      `/api/runner/ai-sessions/${encodeURIComponent(sessionId)}/anchor`,
      { body: { anchors } },
    );
  }

  recordAiAssistedConsent(sessionId: string): Promise<{ ok: true }> {
    return this.request(
      "POST",
      `/api/runner/ai-sessions/${encodeURIComponent(sessionId)}/consent`,
    );
  }

  // --- Study mode (task-531) ----------------------------------------------
  // Runner-driven study chats with Sam, persisted into the same
  // study_conversations / study_conversation_messages tables that the
  // dashboard uses. The runner endpoints are intentionally write-only for
  // messages: the host model generates Sam's reply locally, then both the
  // user message and the Sam reply are persisted via append. No sessions /
  // attempts / hint_events rows are ever written by this flow.

  createStudyConversation(body: {
    questionId: string;
    mode: "study" | "post_session";
    sessionId?: string;
  }): Promise<StudyConversationDetail> {
    return this.request<StudyConversationDetail>(
      "POST",
      "/api/runner/study-conversations",
      { body },
    );
  }

  getStudyConversation(id: string): Promise<StudyConversationDetail> {
    return this.request<StudyConversationDetail>(
      "GET",
      `/api/runner/study-conversations/${encodeURIComponent(id)}`,
    );
  }

  appendStudyMessage(
    conversationId: string,
    body: { role: "user" | "sam"; body: string },
  ): Promise<{ message: StudyMessageDto }> {
    return this.request<{ message: StudyMessageDto }>(
      "POST",
      `/api/runner/study-conversations/${encodeURIComponent(conversationId)}/messages`,
      { body },
    );
  }

  // Streams Sam's reply for a study conversation as NDJSON events. The
  // server persists both the user turn and (on completion) Sam's full
  // generated reply into study_conversation_messages, so the runner does
  // NOT need to call appendStudyMessage afterwards. Yields events in the
  // same shape the API emits — see study-conversations-core.ts.
  streamStudyMessage(
    conversationId: string,
    body: { body: string },
  ): AsyncGenerator<StudyStreamEvent> {
    return this.openStudyStream(
      `/api/runner/study-conversations/${encodeURIComponent(conversationId)}/messages/stream`,
      body,
    );
  }

  // Re-runs Sam's reply for the conversation's trailing (unanswered) user
  // turn. Use after `streamStudyMessage` returned an `error` event or the
  // request was aborted mid-stream — the user message is still persisted
  // server-side, and this call asks Sam to try again without inserting a
  // duplicate user row. See task-571.
  retryStudyMessage(
    conversationId: string,
  ): AsyncGenerator<StudyStreamEvent> {
    return this.openStudyStream(
      `/api/runner/study-conversations/${encodeURIComponent(conversationId)}/messages/retry/stream`,
      // Retry endpoint takes no body; the trailing user turn already
      // lives in study_conversation_messages.
      undefined,
    );
  }

  private async *openStudyStream(
    path: string,
    body: unknown,
  ): AsyncGenerator<StudyStreamEvent> {
    if (!this.cfg.token) {
      throw new ApiError(
        401,
        null,
        "No device token. Run `prepsavant auth` first.",
      );
    }
    const res = await fetch(this.url(path), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-prepsavant-adapter": ADAPTER_VERSION,
        authorization: `Bearer ${this.cfg.token}`,
      },
      body: body == null ? undefined : JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        /* keep raw text */
      }
      throw new ApiError(res.status, parsed, `POST ${path} → ${res.status}`);
    }
    const decoder = new TextDecoder();
    let buf = "";
    const reader = res.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // Frame on `\n`; the API emits one JSON object per line.
        let nl = buf.indexOf("\n");
        while (nl !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line.length > 0) {
            try {
              yield JSON.parse(line) as StudyStreamEvent;
            } catch {
              // Skip un-parseable lines rather than killing the stream.
            }
          }
          nl = buf.indexOf("\n");
        }
      }
      // Drain any trailing partial line.
      const tail = buf.trim();
      if (tail.length > 0) {
        try {
          yield JSON.parse(tail) as StudyStreamEvent;
        } catch {
          /* ignore */
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* noop */
      }
    }
  }

  // GET /runner/ai-sessions/:id/status
  // Cheap polling endpoint for the live CLI/web status display. Returns the
  // aggregate hooksConnected flag, event count, integrity status, and a
  // per-channel `hookHealth` map (prompt / response / edit / shell). Used by
  // the runner CLI to render the "Hook channels" line for beta tools where
  // partial coverage is expected.
  getAiAssistedSessionStatus(
    sessionId: string,
  ): Promise<AiAssistedSessionStatus> {
    return this.request<AiAssistedSessionStatus>(
      "GET",
      `/api/runner/ai-sessions/${encodeURIComponent(sessionId)}/status`,
    );
  }
}

export interface AiAssistedHookChannelHealth {
  fired: boolean;
  eventCount: number;
  lastEventAt?: string;
}

export interface AiAssistedHookHealth {
  prompt: AiAssistedHookChannelHealth;
  response: AiAssistedHookChannelHealth;
  edit: AiAssistedHookChannelHealth;
  shell: AiAssistedHookChannelHealth;
}

export interface AiAssistedSessionStatus {
  sessionId: string;
  tool: string;
  eventCount: number;
  hooksConnected: boolean;
  integrityStatus: "pending" | "ok" | "degraded";
  integrityStatusDetail: string;
  startedAt: string;
  elapsedMs: number;
  lastEventAt: string | null;
  hookHealth: AiAssistedHookHealth;
  consentRecordedAt: string | null;
  bundleReceivedAt: string | null;
}
