// Coached session state manager.
// Tracks in-memory state for active Coached sessions:
//   - File-system watcher for stall detection (no edits in STALL_WINDOW_MS)
//   - AI-assist event accumulation (reported by the host via coached_check_in)
//   - Hint-ladder level tracking so stronger hints only fire after weaker ones
//
// All state is process-local and ephemeral: it lasts for the lifetime of the
// MCP server process. The server-side session row is the durable record.
import * as fs from "node:fs";

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
}

const activeSessions = new Map<string, CoachedSessionState>();

export const STALL_WINDOW_MS = 5 * 60 * 1000;

export function startCoachedSession(opts: {
  sessionId: string;
  questionId: string;
  questionTitle: string;
  questionPrompt: string;
  workspaceDir?: string;
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
  };

  try {
    state.watcher = fs.watch(
      workspaceDir,
      { recursive: true },
      (_event, filename) => {
        if (shouldIgnoreWatchedPath(filename)) return;
        state.lastEditAt = Date.now();
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
}

export function updateHintLevel(sessionId: string, level: number): void {
  const state = activeSessions.get(sessionId);
  if (!state) return;
  if (level > state.hintLevelFired) {
    state.hintLevelFired = level;
  }
}

export function stalledSeconds(state: CoachedSessionState): number {
  return Math.floor((Date.now() - state.lastEditAt) / 1000);
}

export function isStalled(state: CoachedSessionState): boolean {
  return Date.now() - state.lastEditAt > STALL_WINDOW_MS;
}

export function endCoachedSession(sessionId: string): CoachedSessionState | null {
  const state = activeSessions.get(sessionId);
  if (!state) return null;
  if (state.watcher) {
    try {
      state.watcher.close();
    } catch {
    }
    state.watcher = null;
  }
  activeSessions.delete(sessionId);
  return state;
}
