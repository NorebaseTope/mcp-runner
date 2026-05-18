// Coached session state manager.
// Tracks in-memory state for active Coached sessions:
//   - File-system watcher for stall detection (no edits in STALL_WINDOW_MS)
//   - AI-assist event accumulation (reported by the host via coached_check_in)
//   - Hint-ladder level tracking so stronger hints only fire after weaker ones
//   - Shadow-git snapshot store (Task #832) so check-in nudges can be grounded
//     in the diff vs the session-start baseline. The snapshot infrastructure
//     is the same one AI-Assisted mode uses (`SnapshotStore`); the shadow
//     repo lives in the user's data dir, the candidate's working tree is
//     never modified.
//
// All state is process-local and ephemeral: it lasts for the lifetime of the
// MCP server process. The server-side session row is the durable record.
import * as fs from "node:fs";

import { SnapshotStore } from "../ai-assisted/snapshot.js";
import type { CadenceDriver } from "./cadence-loop.js";

// Path segments that look like editor/build noise rather than the user
// editing real source files. Writes whose relative path contains any of
// these segments must NOT advance `lastEditAt` — otherwise a `dist/`
// rebuild or a coverage report silently masks the user actually being idle.
//
// Centralized here so it's easy to extend in one place. Segment matching
// is exact per path component (so a real file called `coverage.ts` is
// still treated as a real edit).
export const IGNORED_WATCH_SEGMENTS: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  ".git",
]);

export function shouldIgnoreWatchedPath(filename: string | null): boolean {
  if (!filename) return true;
  const segments = filename.split(/[\\/]/);
  for (const seg of segments) {
    if (!seg) continue;
    if (IGNORED_WATCH_SEGMENTS.has(seg)) return true;
    // Catch-all for dotfile-only writes (e.g. `.eslintcache`, `.DS_Store`,
    // editor/LSP cache flushes under `.vscode/`, `.idea/`, etc).
    if (seg.startsWith(".")) return true;
  }
  return false;
}

export interface CoachedSessionState {
  sessionId: string;
  questionId: string;
  questionTitle: string;
  questionPrompt: string;
  workspaceDir: string | null;
  startedAt: number;
  lastEditAt: number;
  aiAssistCount: number;
  aiAssistSummaries: string[];
  hintLevelFired: number;
  watcher: fs.FSWatcher | null;
  // Tracks the `lastEditAt` value the runner-side stall nudge most recently
  // fired against. Hosts call `coached_check_in` on every user message and on
  // a ~3 min heartbeat, so without this flag the same Sam-voice probe would
  // be re-emitted on every check-in for as long as the user stayed idle. By
  // pinning the fired-marker to a specific `lastEditAt`, any later file edit
  // bumps `lastEditAt`, the marker no longer matches, and the next stall
  // window can fire its probe again. `null` means the nudge has never fired
  // (or has been re-armed by an edit).
  stallNudgeFiredForEditAt: number | null;
  // Last-known server-side progress signal, used to pick the variant of the
  // runner-driven stall probe (Task #803). The runner refreshes these
  // best-effort during `coached_check_in` so the stall escalation can speak
  // a "you have a working draft — what tradeoff are you weighing?" probe
  // instead of always defaulting to "where did you get stuck?". `null`
  // means the runner has never managed to refresh them; in that case the
  // stall escalation falls back to the historical (blank-page) phrasing.
  attemptsTotal: number | null;
  passedLatest: boolean | null;
  consecutiveFailingTestCount: number | null;
  // Shadow-git snapshot store + session-start baseline SHA. Both are nullable
  // because (a) snapshotting is best-effort — git may be unavailable on the
  // user's box — and (b) the runner must keep working even if the baseline
  // commit step fails. When `snapshot` or `baselineSha` is null, the
  // diff-aware nudge enrichment short-circuits and the runner falls back to
  // today's static `STALL_PROBE_LINES` / `DIRECTIVE_VOICE` text.
  snapshot: SnapshotStore | null;
  baselineSha: string | null;
  // SHA of the most recent fresh-snapshot commit taken on a check-in.
  // Useful for surfacing a "files-changed since last check-in" delta in
  // future tasks; tracked here so we don't have to re-derive it.
  lastSnapshotSha: string | null;
  lastDiffSummary: { filesChanged: string[]; truncated: boolean } | null;
  // Task #1126 (Phase 2) — captured unified-diff text from the most
  // recent diff-aware enrichment pass, capped at MAX_CHECKIN_DIFF_BYTES.
  // Forwarded as `diffSnippet` on the NEXT `coached_check_in` so the
  // server-side `host_reasoning` evidence payload can carry the actual
  // diff (not just the summary) for runner-originated coached sessions.
  // Mirrors the existing one-cycle lag pattern of `lastDiffSummary`.
  // Null until the first enrichment pass produces a diff or after a
  // session-end clears it.
  lastDiffSnippet: string | null;
  // Task #1412 — most recent failing test name observed for this session.
  // Mirrors the one-cycle-lag pattern of `lastDiffSnippet`: written by the
  // same code path that captures a diff snippet (today only the HTTP
  // `coached_check_in` enrichment pass populates either field; the runner-
  // driven terminal coach surfaces them through `buildAskPrompt` evidence
  // when present and silently omits the slot when null). Kept null until a
  // producer wires it; see follow-up #1415.
  lastFailingTest: string | null;
  // Accumulated diff summaries from each check-in where enrichment fired
  // (Task #877). Collected during the session and forwarded to the
  // post-mortem builder at end-of-session so coaches can see which files
  // Sam reviewed.
  checkInDiffSummaries: Array<{ filesChanged: string[]; truncated: boolean }>;
  // Distinct file paths the watcher has seen edited since the most recent
  // `coached_check_in` call (Task #1086). Drives the
  // `filesChangedSinceLastCheckIn` progress signal that feeds the
  // server-side stuck-shape classifier (`editing_without_testing`). The
  // set is cleared at the end of every check-in handler. Editor noise
  // (`node_modules`, `dist`, dotfiles, etc.) is filtered by
  // `shouldIgnoreWatchedPath` before the path lands here.
  editedFilesSinceLastCheckIn: Set<string>;
  // High-water mark of `passedCount` across all attempts the runner has
  // observed in this session (Task #1086). Used to compute
  // `regressedFromBest` for the progress-signals payload — a fresh
  // attempt with a smaller `passedCount` than this value indicates the
  // candidate broke something they had working.
  bestPassedCount: number | null;
  // Task #1169 — local cadence-loop driver. Owns the per-session
  // setInterval that proactively emits stall nudges + 50/75/90% time
  // warnings without waiting for the host to call `coached_check_in`.
  // Set when the session starts, stopped + nulled on
  // `endCoachedSession` so the timer doesn't leak past the session.
  cadence: CadenceDriver | null;
  // Task #1169 (Cursor-first M4) — target session duration in ms,
  // forwarded from `coached_start_session` so the local cadence loop
  // can fire 50/75/90% time warnings without re-asking the server.
  // null when the session is open-ended.
  targetDurationMs: number | null;
  // Task #1169 — per-shape hint-ladder bookkeeping. Mirrors the
  // server-side `ProbeLadderState.perShape` map (see
  // `artifacts/api-server/src/lib/coached-probes.ts`) so the runner-
  // owned cadence loop escalates the SAME shape-aware ladder the
  // server used to drive from the check-in flow. `null` for a shape
  // means we have not issued any rung for it in this session yet;
  // the cadence decider calls `nextRung(null)` -> "open_ended" for
  // the first hint and walks the ladder from there.
  shapeLadderState: Partial<
    Record<import("./stuck-shape.js").StuckShape, import("./stuck-shape.js").LadderRung>
  >;
  // Task #1169 — rolling local recap draft. The runner accumulates
  // attempts, hint usage, file-edit timeline, stall events, and
  // time-warning acknowledgements as the session runs and posts the
  // final draft to the api-server at end-of-session (additive payload
  // on the existing /runner/sessions/:id/end POST). The api-server
  // post-mortem grading is unchanged — this draft surfaces the
  // runner's local view alongside it.
  recapEvents: RecapEvent[];
}

// Task #1169 — rolling recap event entry. Each event captures one
// timeline beat the runner observed locally. Kept structurally simple
// so it serialises cleanly into the end-of-session POST without a
// schema migration.
export interface RecapEvent {
  ts: number;
  kind:
    | "session_started"
    | "file_edited"
    | "ai_assist_detected"
    | "hint_level_advanced"
    | "stall_nudge_fired"
    | "time_warning_fired";
  detail?: string;
}

const activeSessions = new Map<string, CoachedSessionState>();

export const STALL_WINDOW_MS = 5 * 60 * 1000;

export function startCoachedSession(opts: {
  sessionId: string;
  questionId: string;
  questionTitle: string;
  questionPrompt: string;
  workspaceDir?: string;
  // Task #1169 — forwarded from `coached_start_session` so the local
  // cadence loop can fire 50/75/90% time warnings without re-asking
  // the server.
  targetDurationMinutes?: number;
}): CoachedSessionState {
  // Default the watch directory to the runner's current working directory so
  // stall detection is live by default — hosts that don't surface a workspace
  // path still get nudged when the user stops editing files.
  const workspaceDir = opts.workspaceDir ?? process.cwd();

  const state: CoachedSessionState = {
    sessionId: opts.sessionId,
    questionId: opts.questionId,
    questionTitle: opts.questionTitle,
    questionPrompt: opts.questionPrompt,
    workspaceDir,
    startedAt: Date.now(),
    lastEditAt: Date.now(),
    aiAssistCount: 0,
    aiAssistSummaries: [],
    hintLevelFired: 0,
    watcher: null,
    stallNudgeFiredForEditAt: null,
    attemptsTotal: null,
    passedLatest: null,
    consecutiveFailingTestCount: null,
    lastDiffSummary: null,
    lastDiffSnippet: null,
    lastFailingTest: null,
    snapshot: null,
    baselineSha: null,
    lastSnapshotSha: null,
    checkInDiffSummaries: [],
    editedFilesSinceLastCheckIn: new Set<string>(),
    bestPassedCount: null,
    cadence: null,
    targetDurationMs:
      typeof opts.targetDurationMinutes === "number" &&
      opts.targetDurationMinutes > 0
        ? opts.targetDurationMinutes * 60 * 1000
        : null,
    shapeLadderState: {},
    recapEvents: [
      {
        ts: Date.now(),
        kind: "session_started",
        detail: opts.questionTitle,
      },
    ],
  };

  // Best-effort shadow-git baseline so check-in nudges can later be grounded
  // in what the candidate actually changed (Task #832). Failures here must
  // never break session creation — `git` may be unavailable, the data dir
  // may be unwritable, or the workspace may not exist yet — so the
  // diff-aware enrichment in `coached_check_in` simply short-circuits and
  // the runner falls back to today's static `STALL_PROBE_LINES` /
  // `DIRECTIVE_VOICE` text.
  //
  // For empty-workspace sessions we use `ensureBaselineCommit`, which
  // forces an `--allow-empty` commit so the baseline SHA is real even
  // when there are no files yet. Without this anchor, the candidate's
  // first edit would have nothing to diff against and every subsequent
  // check-in would short-circuit through `skipped:no_baseline`, defeating
  // the diff-aware nudge for greenfield interview-prep sessions.
  try {
    const snapshot = new SnapshotStore({
      sessionId: opts.sessionId,
      workspaceDir,
    });
    snapshot.initialize();
    const baselineSha = snapshot.ensureBaselineCommit("coached_baseline");
    if (baselineSha) {
      state.snapshot = snapshot;
      state.baselineSha = baselineSha;
      state.lastSnapshotSha = baselineSha;
    }
  } catch {
    // Degrade silently. Diff-aware enrichment will be skipped for this
    // session; the static fallback path is already exercised in tests.
  }

  try {
    state.watcher = fs.watch(
      workspaceDir,
      { recursive: true },
      (_event, filename) => {
        if (shouldIgnoreWatchedPath(filename)) return;
        state.lastEditAt = Date.now();
        if (filename) {
          // Track distinct paths so the next `coached_check_in` can
          // emit `filesChangedSinceLastCheckIn` (Task #1086). The set
          // is reset by the check-in handler after the directive is
          // returned to the host.
          state.editedFilesSinceLastCheckIn.add(filename);
          // Task #1169 — append a sparse file-edit beat to the
          // rolling recap draft. Cap so a long noisy session
          // doesn't blow up memory before end_session POSTs the
          // payload.
          appendRecapEvent(state, {
            ts: Date.now(),
            kind: "file_edited",
            detail: filename,
          });
        }
      },
    );
    state.watcher.unref();
  } catch {
    // fs.watch can fail if the directory doesn't exist or recursive isn't
    // supported on the platform — degrade gracefully and run without stall
    // detection rather than failing the session.
  }

  activeSessions.set(opts.sessionId, state);
  return state;
}

export function getCoachedSession(sessionId: string): CoachedSessionState | null {
  return activeSessions.get(sessionId) ?? null;
}

export function recordAiAssist(sessionId: string, summary: string): void {
  const state = activeSessions.get(sessionId);
  if (!state) return;
  state.aiAssistCount++;
  if (summary) {
    state.aiAssistSummaries.push(summary.slice(0, 200));
  }
  appendRecapEvent(state, {
    ts: Date.now(),
    kind: "ai_assist_detected",
    detail: summary ? summary.slice(0, 200) : undefined,
  });
}

export function updateHintLevel(sessionId: string, level: number): void {
  const state = activeSessions.get(sessionId);
  if (!state) return;
  if (level > state.hintLevelFired) {
    state.hintLevelFired = level;
    appendRecapEvent(state, {
      ts: Date.now(),
      kind: "hint_level_advanced",
      detail: `level=${level}`,
    });
  }
}

// Task #1169 — bounded append for the rolling recap event log. The
// runner posts the events to the api-server at end-of-session, so we
// must keep the array small enough to fit a single POST body even
// after a 2-hour session of noisy file edits.
const MAX_RECAP_EVENTS = 500;
export function appendRecapEvent(
  state: CoachedSessionState,
  event: RecapEvent,
): void {
  state.recapEvents.push(event);
  if (state.recapEvents.length > MAX_RECAP_EVENTS) {
    // Drop the oldest events first; the most recent activity is what
    // grading + the recap text care about.
    state.recapEvents.splice(0, state.recapEvents.length - MAX_RECAP_EVENTS);
  }
}


export function stalledSeconds(
  state: CoachedSessionState,
  now: number = Date.now(),
): number {
  return Math.floor((now - state.lastEditAt) / 1000);
}

// `now` is injectable so cadence-loop callers can pass their own
// time source (the same `now()` they hand to `CadenceDriver`) and
// keep the stall decision deterministic under faked clocks. Default
// to wall-clock for code paths that aren't running inside the driver
// (Task #1169 code-review pass 3).
export function isStalled(
  state: CoachedSessionState,
  now: number = Date.now(),
): boolean {
  return now - state.lastEditAt > STALL_WINDOW_MS;
}

export function endCoachedSession(sessionId: string): CoachedSessionState | null {
  const state = activeSessions.get(sessionId);
  if (!state) return null;
  // Task #1169 — stop the local cadence timer FIRST so a tick
  // mid-shutdown can't enqueue a stale directive into a session that's
  // about to be deleted from the map.
  if (state.cadence) {
    try {
      state.cadence.stop();
    } catch {
      /* noop */
    }
    state.cadence = null;
  }
  if (state.watcher) {
    try {
      state.watcher.close();
    } catch {
    }
    state.watcher = null;
  }
  // Clean up the shadow-git store so we don't leak per-session repos under
  // the user's data dir. Cleanup is best-effort — the store itself swallows
  // fs errors — but we still null the reference so any stray references
  // can't accidentally re-snapshot after the session ends.
  if (state.snapshot) {
    try {
      state.snapshot.cleanup();
    } catch {
    }
    state.snapshot = null;
  }
  activeSessions.delete(sessionId);
  return state;
}
