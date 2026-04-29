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
