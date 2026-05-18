// Task #1176 — local "pending uploads" queue persisted under
// `~/.prepsavant/pending-cursor-exports.json`. When an auto-upload
// fails, the entry is retried at the next runner startup.
// Bounds: 20 entries, 7-day TTL, 5-attempt ceiling.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface PendingEntry {
  sessionId: string;
  // Absolute path on disk to the export file we tried to upload.
  // `null` for `discoveryStatus = "not_found"` retries — those re-run
  // discovery from scratch on next invocation.
  filePath: string | null;
  mimeType?: "text/markdown" | "text/plain" | "application/json";
  // ISO timestamp of when the original attempt failed.
  failedAt: string;
  // Best-effort context for logs / debugging.
  reason?: string;
  attemptCount: number;
}

const MAX_ENTRIES = 20;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function queuePath(home?: string): string {
  return path.join(home ?? os.homedir(), ".prepsavant", "pending-cursor-exports.json");
}

function loadRaw(home?: string): PendingEntry[] {
  const p = queuePath(home);
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is PendingEntry =>
        !!e && typeof e.sessionId === "string" && typeof e.failedAt === "string",
    );
  } catch {
    return [];
  }
}

function writeRaw(entries: PendingEntry[], home?: string): void {
  const p = queuePath(home);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(entries, null, 2));
  } catch {
    /* best-effort — losing the queue file is non-fatal */
  }
}

export function listPending(now: number = Date.now(), home?: string): PendingEntry[] {
  const all = loadRaw(home);
  return all.filter(
    (e) =>
      now - new Date(e.failedAt).getTime() <= MAX_AGE_MS &&
      e.attemptCount < MAX_ATTEMPTS,
  );
}

export function enqueue(entry: Omit<PendingEntry, "attemptCount" | "failedAt"> & {
  failedAt?: string;
  attemptCount?: number;
}, home?: string): void {
  const all = loadRaw(home);
  // De-dupe on sessionId — one pending entry per session is enough.
  const existing = all.find((e) => e.sessionId === entry.sessionId);
  const filtered = all.filter((e) => e.sessionId !== entry.sessionId);
  // Task #1189 — preserve the existing attemptCount so a re-enqueue
  // from the catch branch in upload.ts cannot reset progress toward
  // MAX_ATTEMPTS and trap the entry in an indefinite retry loop.
  const preservedAttempt =
    entry.attemptCount ?? existing?.attemptCount ?? 0;
  filtered.unshift({
    sessionId: entry.sessionId,
    filePath: entry.filePath,
    ...(entry.mimeType ? { mimeType: entry.mimeType } : {}),
    failedAt: entry.failedAt ?? new Date().toISOString(),
    ...(entry.reason ? { reason: entry.reason } : {}),
    attemptCount: preservedAttempt,
  });
  writeRaw(filtered.slice(0, MAX_ENTRIES), home);
}

export function bumpAttempt(sessionId: string, home?: string): void {
  const all = loadRaw(home);
  const next = all.map((e) =>
    e.sessionId === sessionId ? { ...e, attemptCount: e.attemptCount + 1 } : e,
  );
  writeRaw(next, home);
}

export function remove(sessionId: string, home?: string): void {
  const all = loadRaw(home);
  writeRaw(
    all.filter((e) => e.sessionId !== sessionId),
    home,
  );
}
