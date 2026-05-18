// Minimal typed fetch client over the Sam HTTP API. We deliberately don't
// depend on the generated client here so the published runner package stays
// self-contained.
import { MCP_RUNNER_VERSION } from "@workspace/mcp-runner-version";

import { ADAPTER_VERSION, type RunnerConfig } from "./config.js";
import type { DoctorResult } from "./doctor.js";

export interface CheckInDirective {
  action:
    | "probe"
    | "hint_offer"
    | "time_warning"
    | "wrap_up"
    | "stay_quiet"
    // Task #795 — surfaced when the candidate pasted code in chat instead
    // of editing the declared scratch file. Sam asks first ("Want me to
    // submit it now?"), the runner does NOT auto-submit.
    | "submit_pasted_code"
    // Task #1064 — server-issued corrective when the host has fallen
    // out of the 90s check-in cadence. The voice line tells the host
    // to resume calling coached_check_in after every user message and
    // to relay verbatim between the SAM_VERBATIM markers.
    | "missed_heartbeat";
  reason: string;
  // Only set for time_warning / wrap_up. Hosts dedup by milestone.
  timeMilestone?: "midway" | "warning" | "final_stretch" | "over_time" | null;
  // Task #1075 — hybrid directive + suggested-wording protocol.
  // `intent` describes what Sam wants the host to accomplish on its
  // next assistant turn; `constraints` are short imperatives the host
  // MUST honour while paraphrasing; `suggestedWording` is Sam's
  // drafted line (sentinel-wrapped when `mustBeVerbatim === true`).
  // Hosts MAY paraphrase `suggestedWording` to match their own
  // conversational tone unless `mustBeVerbatim` is true, in which case
  // they MUST relay it byte-for-byte (sentinels included).
  intent: string;
  constraints: string[];
  // Task #1126 (Phase 2) — `suggestedWording` is now ABSENT (not null)
  // on the wire when `mode === "host_reasoning"`. Optional in the
  // TypeScript surface so runner builds parsing a host_reasoning
  // directive don't have to guard against `undefined` separately from
  // `null`. Verbatim_relay directives still carry the field with the
  // server-drafted line (or `null` for `stay_quiet`).
  suggestedWording?: string | null;
  mustBeVerbatim: boolean;
  // Task #1107 — Phase 1 host-reasoning mode (opt-in via per-session
  // `coachedFeatureFlags.host_reasoning_enabled`). Defaults to
  // `verbatim_relay` on every directive (full backwards compatibility).
  // When `mode === "host_reasoning"`, `suggestedWording` is null,
  // `mustBeVerbatim` is false, and the host MUST author its own line
  // grounded in `evidence`. Optional in the wire shape so older runner
  // builds reading from a server that has not yet bumped continue to
  // parse the directive unchanged.
  mode?: "verbatim_relay" | "host_reasoning";
  evidence?: {
    diffSnippet?: string | null;
    lastFailingTest?: string | null;
    currentHintRungText?: string | null;
    nextHintRungText?: string | null;
  } | null;
}

// Task #1119 — `AiAssistedCheckInDirective` retired alongside the
// `aiAssistedCheckIn` client method in runner v1.0.0. The split-loop
// pair (`getAiAssistedContext` / `recordAiAssistedFeedback`) carries
// its own payload shapes below.

// Task #1111 (Phase 3a) — pure-read coaching context returned by
// `getCoachedContext`. The host SHOULD ground its next assistant turn
// in `evidence` and MUST echo `contextSnapshotId` when posting the
// matching `recordCoachedTurn` so the server can flag stale-context
// turns instead of silently classifying them as `off_script`.
export interface CoachedContextResponse {
  sessionId: string;
  status: "active" | "completed" | "abandoned";
  generatedAt: string;
  contextSnapshotId: string;
  activeConstraints: string[];
  evidence: {
    recentAttempts: Array<{
      id: string;
      outcome: "pass" | "fail" | "error" | "timeout";
      passedCount: number | null;
      totalCases: number | null;
      submittedAt: string;
      lastFailingTest: string | null;
    }>;
    diffSnippet: string | null;
    diffSummary: { filesChanged: string[]; truncated: boolean } | null;
    hintLadder: {
      rungs: string[];
      hintsUsed: number;
      currentRungText: string | null;
      nextRungText: string | null;
    };
    timeElapsedSec: number;
    timeRemainingSec: number | null;
    recentAssistantTurns: Array<{
      recordedAt: string;
      text: string;
      complianceBucket?:
        | "verbatim_relay"
        | "host_authored_from_signals"
        | "off_script"
        | "stale_context";
    }>;
    priorTurnFeedback: {
      bucket:
        | "verbatim_relay"
        | "host_authored_from_signals"
        | "off_script"
        | "stale_context";
      signalsHit?: string[];
      classifiedAt: string;
    } | null;
    // Task #1112 (Phase 3b) — capability-gating signals.
    verbatimTokens: Array<{
      tokenId: string;
      label: string;
      action: "time_warning" | "wrap_up" | "missed_heartbeat";
      expiresAt: string | null;
    }>;
    wrapUpRequired: boolean;
    missedHeartbeatRequired: boolean;
  };
  // Task #1112 (Phase 3b) — dynamic per-session tool list. Tools NOT
  // listed here are gated for the current phase; the server rejects
  // calls to them.
  availableTools: string[];
  capabilitySetVersion: number;
}

// Task #1112 (Phase 3b) — `coached_say_exactly` response.
export interface CoachedSayExactlyResponse {
  expanded: boolean;
  rejectReason: "unknown_token" | "consumed" | "stale_context" | null;
  text: string | null;
  recordedAt: string;
}

// Task #1112 (Phase 3b) — capability-gated phase ack responses.
export interface CoachedWrapUpNowResponse {
  ok: boolean;
  rejectReason: "not_in_wrap_up_phase" | null;
  sessionId: string;
  message?: string | null;
}

export interface CoachedContinuePracticeResponse {
  ok: boolean;
  rejectReason: "wrap_up_required" | null;
  sessionId: string;
}

// Task #1111 (Phase 3a) — pure-write coaching turn response.
export interface CoachedRecordTurnResponse {
  recordedAt: string;
  contextSnapshotId: string;
  staleContext: boolean;
  complianceBucket:
    | "verbatim_relay"
    | "host_authored_from_signals"
    | "off_script"
    | "stale_context"
    | null;
}

// Task #1117 (Phase 3a) — pure-read AI-Assisted context returned by
// `getAiAssistedContext`. AI-Assisted analog of `CoachedContextResponse`.
export interface AiAssistedContextResponse {
  sessionId: string;
  status: "active" | "completed" | "abandoned";
  generatedAt: string;
  contextSnapshotId: string;
  activeConstraints: string[];
  evidence: {
    eventLogSlice: string | null;
    recentAttempts: Array<{
      seq: number;
      kind: string;
      ts: string;
      outcome: string | null;
      failingTest: string | null;
    }>;
    recentSnapshots: Array<{
      shadowCommitSha: string;
      parentSha: string | null;
      filesChanged: number;
      snapshotKind: string;
      capturedAt: string;
    }>;
    diffSnippet: string | null;
    lastFailingTest: string | null;
    attemptsInRecentWindow: number;
    distinctFailingTestsInRecentWindow: number;
    timeElapsedSec: number;
    timeRemainingSec: number | null;
    recentAssistantFeedback: Array<{
      recordedAt: string;
      text: string;
      feedbackKind?: string;
      complianceBucket?:
        | "verbatim_relay"
        | "host_authored_from_signals"
        | "off_script"
        | "stale_context";
    }>;
    priorFeedbackCorrection: {
      bucket:
        | "verbatim_relay"
        | "host_authored_from_signals"
        | "off_script"
        | "stale_context";
      signalsHit?: string[];
      classifiedAt: string;
    } | null;
    // Task #1118 (Phase 3b) — capability-gating signals.
    verbatimTokens: Array<{
      tokenId: string;
      label: string;
      action: "time_warning" | "wrap_up";
      expiresAt: string | null;
    }>;
    wrapUpRequired: boolean;
  };
  // Task #1118 (Phase 3b) — dynamic per-session tool list. Tools NOT
  // listed here are gated for the current phase; the server rejects
  // calls to them.
  availableTools: string[];
  capabilitySetVersion: number;
}

// Task #1118 (Phase 3b) — `ai_assisted_say_exactly` response.
export interface AiAssistedSayExactlyResponse {
  expanded: boolean;
  rejectReason: "unknown_token" | "consumed" | "stale_context" | null;
  text: string | null;
  recordedAt: string;
}

// Task #1118 (Phase 3b) — capability-gated phase ack responses.
export interface AiAssistedWrapUpNowResponse {
  ok: boolean;
  rejectReason: "not_in_wrap_up_phase" | null;
  sessionId: string;
  message?: string | null;
}

export interface AiAssistedContinuePracticeResponse {
  ok: boolean;
  rejectReason: "wrap_up_required" | null;
  sessionId: string;
}

// Task #1117 (Phase 3a) — pure-write AI-Assisted feedback response.
export interface AiAssistedRecordFeedbackResponse {
  recordedAt: string;
  contextSnapshotId: string;
  staleContext: boolean;
  complianceBucket:
    | "verbatim_relay"
    | "host_authored_from_signals"
    | "off_script"
    | "stale_context"
    | null;
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
    opts: {
      body?: unknown;
      auth?: boolean;
      headers?: Record<string, string>;
    } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-prepsavant-adapter": ADAPTER_VERSION,
      // Task #1115 (Phase 4) — surface the runner package version on
      // every API call so the server can enforce
      // `MIN_SUPPORTED_RUNNER_VERSION` at session-start and so
      // `last_seen_runner_version` on the user row stays fresh without
      // requiring a separate handshake. `MCP_RUNNER_VERSION` is the
      // hand-maintained constant in @workspace/mcp-runner-version that
      // tracks the published version of @prepsavant/mcp.
      "x-prepsavant-runner": MCP_RUNNER_VERSION,
      // Task #1510 — surface whether `CURSOR_API_KEY` is exported in
      // the runner's shell on every API call. The server stamps
      // `users.cursor_api_key_configured_at` at session-start when
      // this header is `1`, which lets the dashboard Mode Picker
      // suppress the `cursor_api_key_tip` section for users who have
      // already configured the key. Kept cheap (single env read per
      // request) and benign: server only consumes the header on
      // session-start handlers, ignores it everywhere else.
      ...(typeof process.env["CURSOR_API_KEY"] === "string" &&
      process.env["CURSOR_API_KEY"].length > 0
        ? { "x-prepsavant-cursor-api-key-set": "1" }
        : {}),
      ...(opts.headers ?? {}),
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

  // Task #794 — server-side filters on /runner/questions. `topic` is a
  // case-insensitive substring match against topicTags and `difficulty`
  // is an exact slug, both honoured by the API. `roleFamily` and
  // `language` are filtered client-side from the returned items so this
  // method preserves the full filter surface a Coached host needs to
  // answer "give me an easy backend Python question" without pulling the
  // whole bank twice.
  async listQuestions(filters?: {
    roleFamily?: string;
    language?: string;
    topic?: string;
    difficulty?: string;
    company?: string;
  }): Promise<{ items: RunnerQuestionDetail["question"][] }> {
    const qs = new URLSearchParams();
    if (filters?.topic) qs.set("topic", filters.topic);
    if (filters?.difficulty) qs.set("difficulty", filters.difficulty);
    // Task #1061 — `company` is forwarded server-side rather than filtered
    // here because the API resolves the input ("anthropic", "co_xyz",
    // "Stripe Inc") against the canonical companies table; the questions
    // payload only carries opaque companyIds and would not allow the
    // candidate-friendly name match we need for the MCP host.
    if (filters?.company) qs.set("company", filters.company);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    const raw = await this.request<{
      items: RunnerQuestionDetail["question"][];
    }>("GET", `/api/runner/questions${suffix}`);
    if (!filters?.roleFamily && !filters?.language) return raw;
    const items = raw.items.filter((q) => {
      if (filters.roleFamily && q.roleFamily !== filters.roleFamily) return false;
      if (filters.language && !(q.languages ?? []).includes(filters.language)) {
        return false;
      }
      return true;
    });
    return { items };
  }

  // Task #1061 — discover companies that have at least one tagged
  // question, so the MCP host can suggest "give me an Anthropic question"
  // without guessing the company slug. Sorted by questionCount desc on the
  // server side; the runner just forwards the payload.
  listCompanies(): Promise<{
    items: Array<{
      id: string;
      name: string;
      slug: string;
      questionCount: number;
    }>;
  }> {
    return this.request("GET", "/api/runner/companies");
  }

  // Task #794 — coached_orient. Mode-framing turn for the Coached cold-open.
  // Returns the verbatim Sam voice line plus the three mode summaries so the
  // host can either render them as prose or surface a picker. Mirrors the
  // MCP tool of the same name.
  coachedOrient(): Promise<{
    /** @deprecated Removed by API server in Task #1115 (Phase 4). The
     *  field is retained in this client type for one minor so older
     *  consumers compile, but the server no longer emits it — read
     *  `framing.suggestedWording` instead. */
    samVoiceLine?: string;
    /** Task #1115 — host-authored opener contract. Hosts SHOULD read
     *  this and author their own opener turn that satisfies every
     *  constraint, instead of byte-for-byte relaying any single
     *  string. `mustBeVerbatim` is always `false` here; the field is
     *  modelled on the Hybrid Relay Protocol shape so the runner's
     *  framing-rendering helper can stay symmetric with check-in
     *  directives. */
    framing?: {
      action: string;
      intent: string;
      constraints: string[];
      suggestedWording: string;
      mustBeVerbatim: false;
    };
    modes: Array<{
      slug: "coached" | "study" | "ai_assisted";
      oneLineSummary: string;
      // Task #1061 — canonical follow-up tool slug for each mode. Hosts
      // should branch on this rather than always defaulting to the
      // `coached_*` family (which carries the "do not write code" posture
      // and would break AI-Assisted on the very next tool call).
      nextTool:
        | "coached_start_session"
        | "study_start"
        | "ai_assisted_start_session";
    }>;
  }> {
    return this.request("GET", "/api/runner/coached-orient");
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

  // Task #1113 (Phase 3c) — `checkIn` retired. Hosts now exclusively
  // use the split-loop pair `coached_get_context` + `coached_record_turn`
  // (see `coachedGetContext` / `coachedRecordTurn` below).

  // Task #1113 (Phase 3c) — fetch the active standing-frame body so the
  // installer can write it into the candidate's IDE-rules files. Returns
  // `null` on 404 / network failure so callers can fall back to a
  // cached payload or a baked-in default.
  // Task #1119 — `kind` selects which active-row namespace to fetch
  // ("coached" vs "ai_assisted"). The server defaults to "coached" so
  // older runner builds that don't pass a kind continue to receive
  // the coached body unchanged.
  async fetchActiveStandingFrame(
    kind: "coached" | "ai_assisted" = "coached",
  ): Promise<{
    id: string;
    frameKind: "coached" | "ai_assisted";
    version: number;
    label: string;
    bodyMd: string;
    constraints: string[];
    forbiddenContent: string[];
  } | null> {
    try {
      return (await this.request(
        "GET",
        `/api/runner/standing-frame/active?kind=${encodeURIComponent(kind)}`,
      )) as {
        id: string;
        frameKind: "coached" | "ai_assisted";
        version: number;
        label: string;
        bodyMd: string;
        constraints: string[];
        forbiddenContent: string[];
      };
    } catch {
      return null;
    }
  }

  // Task #1197 — fetch the active supported-languages catalog so the
  // doctor can probe exactly the languages the API currently treats as
  // runnable / published. Returns `null` on 404 / network failure so
  // the doctor can fall back to a cached payload (or finally to the
  // baked-in `RUNNABLE_LANGUAGES` shipped with the runner).
  async fetchSupportedLanguages(): Promise<{
    items: Array<{
      id: string;
      label: string;
      status: "published" | "beta" | "blocked";
      runtimeRequirement: string;
      installHint?: string;
    }>;
  } | null> {
    try {
      return (await this.request("GET", "/api/setup/languages")) as {
        items: Array<{
          id: string;
          label: string;
          status: "published" | "beta" | "blocked";
          runtimeRequirement: string;
          installHint?: string;
        }>;
      };
    } catch {
      return null;
    }
  }

  // Task #1169 (Cursor-first M4) — accepts an optional `recapDraft`
  // payload so the runner can post its rolling local view (attempts,
  // hint usage, file-edit timeline, stall events, time-warning
  // acknowledgements) alongside the existing end-session POST. The
  // api-server's grading is unchanged — unknown fields are ignored
  // server-side until M5 wires the draft into the post-mortem
  // surface, so this is an additive rollout.
  endSession(
    sessionId: string,
    body?: { recapDraft?: unknown },
  ): Promise<unknown> {
    return this.request(
      "POST",
      `/api/runner/sessions/${encodeURIComponent(sessionId)}/end`,
      body ? { body } : undefined,
    );
  }

  // Task #1176 (Cursor-first v1, Milestone 6) — runner-driven Cursor
  // export upload. Body shape mirrors `RunnerCursorExportBody` in the
  // OpenAPI spec: either an `uploaded` row (carries contentBase64 +
  // mimeType + sizeBytes + sourcePath) or a telemetry-only `not_found`
  // / `failed` row. Best-effort — callers swallow errors so a failed
  // upload never blocks session-end.
  uploadCursorExport(
    sessionId: string,
    body: {
      source: "auto" | "manual";
      discoveryStatus: "uploaded" | "not_found" | "failed";
      sourcePath?: string;
      mimeType?: string;
      sizeBytes?: number;
      contentBase64?: string;
      failureReason?: string;
    },
  ): Promise<{
    id: string;
    sessionId: string;
    discoveryStatus: "uploaded" | "not_found" | "failed";
    createdAt: string;
  }> {
    return this.request(
      "POST",
      `/api/runner/sessions/${encodeURIComponent(sessionId)}/cursor-export`,
      { body },
    );
  }

  // Task #1388 — Reusable per-question packages.
  // GET /api/runner/sessions/active?questionId= returns the current
  // active coached session for (this user, this question), or {active:null}.
  getActiveSessionForQuestion(
    questionId: string,
  ): Promise<{
    active: null | {
      id: string;
      questionId: string;
      questionTitle?: string;
      mode: string;
      status: string;
      startedAt: string;
    };
  }> {
    return this.request(
      "GET",
      `/api/runner/sessions/active?questionId=${encodeURIComponent(questionId)}`,
    );
  }

  // POST /api/runner/sessions/from-question-package — mints a fresh
  // session each invocation. Pass { manifest, replace, targetDurationMinutes? }.
  // The server HMAC-verifies the manifest, confirms ownerId matches
  // the authed user, and (if replace=true) ends any in-flight session
  // for the same (ownerId, questionId) with endedReason="user_replaced"
  // before creating the new row.
  createSessionFromQuestionPackage(body: {
    manifest: unknown;
    replace?: boolean;
    targetDurationMinutes?: number;
    // Task #1479 — folder-driven AI-Assisted parity. When the
    // manifest's `mode` is `ai_assisted`, the runner mints an
    // ephemeral key pair + capability manifest exactly like the
    // chat-driven `ai_assisted_start_session` tool and forwards
    // them here. The server uses these to issue a session
    // certificate JWT bound to the runner's public key.
    aiAssisted?: {
      tool: string;
      toolVersion: string;
      adapterVersion: string;
      runnerVersion: string;
      runnerPublicKey: string;
      capabilityManifest: {
        captures: string[];
        notCaptures: string[];
        toolLabel: string;
        consentVersion: string;
      };
    };
  }): Promise<{
    session: { id: string };
    kickoffBriefVerbatim: string;
    // Task #1400 — host-only directive block split out server-side.
    // Optional during the deprecation window for `stripHostInstructions`.
    hostInstructionsVerbatim?: string;
    hintLadderLength: number;
    replacedSessionId?: string | null;
    question: { id: string; title: string; prompt: string };
    // Task #1479 — present only when the manifest mode is
    // `ai_assisted`. The runner persists both to
    // `.prepsavant/last-session.json` so subsequent
    // `prepsavant upload-cursor-export` invocations from the same
    // folder can auto-resolve the session id without flags.
    mode?: "coached" | "ai_assisted";
    certificateJwt?: string | null;
  }> {
    return this.request(
      "POST",
      "/api/runner/sessions/from-question-package",
      { body },
    );
  }

  // Task #1388 — explicitly end a live coached session as part of the
  // CLI replace flow. The runner calls this with endedReason="user_replaced"
  // when the user accepts the prompt.
  endSessionAsReplaced(sessionId: string): Promise<unknown> {
    return this.request(
      "POST",
      `/api/runner/sessions/${encodeURIComponent(sessionId)}/end`,
      { body: { endedReason: "user_replaced" } },
    );
  }

  // Task #1111 (Phase 3a) — pure-read coaching context. Fetches the
  // evidence the host needs to author its next assistant turn (recent
  // attempts, diff snippet, hint-ladder rungs with currentRungText /
  // nextRungText, time remaining, recent assistant turns,
  // priorTurnFeedback, activeConstraints) plus an opaque
  // `contextSnapshotId` the host MUST echo on the matching
  // `recordCoachedTurn` write.
  getCoachedContext(sessionId: string): Promise<CoachedContextResponse> {
    return this.request<CoachedContextResponse>(
      "GET",
      `/api/runner/sessions/${encodeURIComponent(sessionId)}/context`,
    );
  }

  // Task #1111 (Phase 3a) — pure-write coaching turn. Records the
  // host-authored assistant turn (and optionally the user message that
  // prompted it). The server runs the directive-mode compliance
  // classifier and stamps `priorTurnFeedback` so the next
  // `getCoachedContext` carries the bucket the host should self-correct
  // against. Echo `contextSnapshotId` so the server can flag stale
  // turns.
  recordCoachedTurn(
    sessionId: string,
    body: {
      assistantText: string;
      userText?: string;
      contextSnapshotId?: string;
    },
  ): Promise<CoachedRecordTurnResponse> {
    return this.request<CoachedRecordTurnResponse>(
      "POST",
      `/api/runner/sessions/${encodeURIComponent(sessionId)}/turns`,
      { body },
    );
  }

  // Task #1112 (Phase 3b) — verbatim token expansion. Echo the
  // `contextSnapshotId` you read alongside the token so the server can
  // reject stale calls with `rejectReason: "stale_context"`.
  coachedSayExactly(
    sessionId: string,
    body: { tokenId: string; contextSnapshotId?: string },
  ): Promise<CoachedSayExactlyResponse> {
    return this.request<CoachedSayExactlyResponse>(
      "POST",
      `/api/runner/sessions/${encodeURIComponent(sessionId)}/say-exactly`,
      { body },
    );
  }

  // Task #1112 (Phase 3b) — capability-gated wrap-up. Available only
  // when `coachedWrapUpRequired === true` on the latest context.
  coachedWrapUpNow(
    sessionId: string,
    body?: { message?: string },
  ): Promise<CoachedWrapUpNowResponse> {
    return this.request<CoachedWrapUpNowResponse>(
      "POST",
      `/api/runner/sessions/${encodeURIComponent(sessionId)}/wrap-up-now`,
      body && body.message !== undefined ? { body } : {},
    );
  }

  // Task #1112 (Phase 3b) — capability-gated still-in-practice ack.
  coachedContinuePractice(
    sessionId: string,
  ): Promise<CoachedContinuePracticeResponse> {
    return this.request<CoachedContinuePracticeResponse>(
      "POST",
      `/api/runner/sessions/${encodeURIComponent(sessionId)}/continue-practice`,
    );
  }

  // Task #800 — fetch the candidate profile (just the bits the runner
  // cares about for end-of-session memory rewrite). The server route is
  // `GET /api/profile` and returns the full serialized profile; we
  // narrow to `sessionMemory` here because that's all the runner reads.
  // Returns `null` when the user has no profile row yet (404) so the
  // caller can no-op instead of fabricating an empty memory.
  async getCandidateProfile(): Promise<{ sessionMemory: string | null } | null> {
    try {
      const res = await this.request<{ sessionMemory?: string | null }>(
        "GET",
        "/api/profile",
      );
      return { sessionMemory: res.sessionMemory ?? null };
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  }

  // Task #800 — replace the rolling session-memory Markdown without
  // round-tripping the entire profile body. Server enforces the
  // 2000-char cap with a 413 + `code: "session_memory_too_long"` error
  // shape; callers should treat 413 as "host model produced something
  // too big — keep prior memory and move on" rather than retry.
  updateSessionMemory(body: { sessionMemory: string }): Promise<unknown> {
    return this.request("PATCH", "/api/profile/session-memory", { body });
  }

  // Task #1119 — `aiAssistedCheckIn` retired in runner v1.0.0. Hosts
  // now exclusively use the split pair below
  // (`getAiAssistedContext` + `recordAiAssistedFeedback`).

  // Task #1117 (Phase 3a) — pure-read AI-Assisted context. Fetches
  // the evidence the host needs to author its next feedback turn
  // (event-log slice, recent snapshots, diff snippet, attempts and
  // distinct failing tests in the recent window, time elapsed/
  // remaining, recent assistant feedback, prior feedback correction)
  // plus an opaque `contextSnapshotId` the host MUST echo on the
  // matching `recordAiAssistedFeedback` write.
  // Task #1416 — `frameInstalled` lets the runner tell the api-server
  // that the AI-Assisted standing-frame rule files
  // (`.cursor/rules/prepsavant-ai-assisted.mdc` etc.) are already on
  // disk in the candidate's workspace. When `true`, the api-server
  // suppresses the duplicated HOST INSTRUCTIONS guardrails from the
  // `activeConstraints` payload and only ships the per-directive
  // constraints (avoiding double-delivery to the AI host).
  getAiAssistedContext(
    sessionId: string,
    opts: { frameInstalled?: boolean } = {},
  ): Promise<AiAssistedContextResponse> {
    const headers: Record<string, string> = {};
    if (opts.frameInstalled) {
      headers["x-prepsavant-ai-assisted-frame-installed"] = "1";
    }
    return this.request<AiAssistedContextResponse>(
      "GET",
      `/api/runner/ai-sessions/${encodeURIComponent(sessionId)}/context`,
      { headers },
    );
  }

  // Task #1117 (Phase 3a) — pure-write AI-Assisted feedback turn.
  // Records the host-authored feedback line. The server runs the
  // directive-mode compliance classifier and stamps
  // `priorFeedbackCorrection` so the next `getAiAssistedContext`
  // carries the bucket the host should self-correct against. Echo
  // `contextSnapshotId` so the server can flag stale turns.
  recordAiAssistedFeedback(
    sessionId: string,
    body: {
      feedbackText: string;
      feedbackKind?: string;
      contextSnapshotId?: string;
    },
  ): Promise<AiAssistedRecordFeedbackResponse> {
    return this.request<AiAssistedRecordFeedbackResponse>(
      "POST",
      `/api/runner/ai-sessions/${encodeURIComponent(sessionId)}/feedback`,
      { body },
    );
  }

  // Task #1118 (Phase 3b) — AI-Assisted verbatim-token expansion.
  // AI-Assisted analog of `coachedSayExactly`. Echo the
  // `contextSnapshotId` you read alongside the token so the server can
  // reject stale calls with `rejectReason: "stale_context"`.
  aiAssistedSayExactly(
    sessionId: string,
    body: { tokenId: string; contextSnapshotId: string },
  ): Promise<AiAssistedSayExactlyResponse> {
    return this.request<AiAssistedSayExactlyResponse>(
      "POST",
      `/api/runner/ai-sessions/${encodeURIComponent(sessionId)}/say-exactly`,
      { body },
    );
  }

  // Task #1118 (Phase 3b) — capability-gated AI-Assisted wrap-up.
  // Available only when `wrapUpRequired === true` on the latest context.
  aiAssistedWrapUpNow(
    sessionId: string,
    body?: { message?: string },
  ): Promise<AiAssistedWrapUpNowResponse> {
    return this.request<AiAssistedWrapUpNowResponse>(
      "POST",
      `/api/runner/ai-sessions/${encodeURIComponent(sessionId)}/wrap-up-now`,
      body && body.message !== undefined ? { body } : {},
    );
  }

  // Task #1118 (Phase 3b) — capability-gated AI-Assisted still-in-
  // practice acknowledgement.
  aiAssistedContinuePractice(
    sessionId: string,
  ): Promise<AiAssistedContinuePracticeResponse> {
    return this.request<AiAssistedContinuePracticeResponse>(
      "POST",
      `/api/runner/ai-sessions/${encodeURIComponent(sessionId)}/continue-practice`,
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

  pushNudgeOutcome(body: {
    outcome: string;
    action: string;
  }): Promise<{ ok: true }> {
    return this.request("POST", "/api/runner/nudge-outcome", { body });
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

  // Fetch one Sam-voice registry entry by key (Task #832). Used by the
  // runner so the diff-aware Coached nudge instruction stays the
  // server's single source of truth — admins can re-tune the directive
  // line wording without shipping a runner update. Caller is expected
  // to cache via `PersonaCache.getVoice` rather than fetching on every
  // hot check-in.
  getSamVoice(key: string): Promise<{
    key: string;
    surface: string;
    text: string;
  }> {
    return this.request("GET", `/api/voice/${encodeURIComponent(key)}`);
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

}
