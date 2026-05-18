// Task #1176 (Cursor-first v1, Milestone 6) — runner-side helper that
// runs the discover → upload flow against `POST /runner/sessions/:id/
// cursor-export`. Failure is non-fatal: the runner records a
// telemetry-only row server-side so the dashboard can show "Sam
// couldn't locate a Cursor export" without throwing on session-end.
import * as fs from "node:fs";
import * as path from "node:path";
import { SamApi } from "../api.js";
import { discoverCursorExport, type DiscoveryResult } from "./discover.js";
import { enqueue, remove } from "./pending-queue.js";

// Stderr JSON telemetry. Event names match the server-side log events.
function emitTelemetry(event: string, fields: Record<string, unknown>): void {
  try {
    process.stderr.write(
      JSON.stringify({ event, ts: new Date().toISOString(), ...fields }) + "\n",
    );
  } catch {
    /* swallow */
  }
}

export interface AutoUploadResult {
  status: "uploaded" | "not_found" | "failed";
  sourcePath?: string;
  sizeBytes?: number;
  reason?: string;
}

export async function autoUploadCursorExport(args: {
  api: SamApi;
  sessionId: string;
  workspaceDir?: string;
  source?: "auto" | "manual";
}): Promise<AutoUploadResult> {
  const result = discoverCursorExport(
    args.workspaceDir ? { workspaceDir: args.workspaceDir } : {},
  );
  return uploadDiscoveryResult({
    api: args.api,
    sessionId: args.sessionId,
    source: args.source ?? "auto",
    discovery: result,
  });
}

export async function uploadDiscoveryResult(args: {
  api: SamApi;
  sessionId: string;
  source: "auto" | "manual";
  discovery: DiscoveryResult;
}): Promise<AutoUploadResult> {
  const { api, sessionId, source, discovery } = args;
  if (discovery.status === "uploaded") {
    try {
      await api.uploadCursorExport(sessionId, {
        source,
        discoveryStatus: "uploaded",
        sourcePath: discovery.sourcePath,
        mimeType: discovery.mimeType,
        sizeBytes: discovery.sizeBytes,
        contentBase64: discovery.contents.toString("base64"),
      });
      emitTelemetry("cursor_export_uploaded", {
        sessionId,
        source,
        sourcePath: discovery.sourcePath,
        sizeBytes: discovery.sizeBytes,
      });
      // Successful upload — drop any stale pending entry for this
      // session so retries don't double-upload.
      remove(sessionId); // drop stale pending entry on success
      return {
        status: "uploaded",
        sourcePath: discovery.sourcePath,
        sizeBytes: discovery.sizeBytes,
      };
    } catch (err) {
      const reason = `upload_failed: ${(err as Error).message}`;
      enqueue({
        sessionId,
        filePath: discovery.sourcePath,
        mimeType: discovery.mimeType as
          | "text/markdown"
          | "text/plain"
          | "application/json",
        reason,
      });
      await api
        .uploadCursorExport(sessionId, {
          source,
          discoveryStatus: "failed",
          sourcePath: discovery.sourcePath,
          failureReason: reason,
        })
        .catch(() => {});
      emitTelemetry("cursor_export_upload_failed", {
        sessionId,
        source,
        sourcePath: discovery.sourcePath,
        reason,
      });
      return { status: "failed", reason, sourcePath: discovery.sourcePath };
    }
  }

  if (discovery.status === "not_found") {
    await api
      .uploadCursorExport(sessionId, {
        source,
        discoveryStatus: "not_found",
      })
      .catch(() => {});
    // Queue rediscovery: user often exports the chat after runner shutdown.
    enqueue({ sessionId, filePath: null, reason: "discovery_not_found" });
    emitTelemetry("cursor_export_discovery_failed", {
      sessionId,
      source,
    });
    return { status: "not_found" };
  }

  // status === "failed" (read error during discovery)
  await api
    .uploadCursorExport(sessionId, {
      source,
      discoveryStatus: "failed",
      ...(discovery.sourcePath ? { sourcePath: discovery.sourcePath } : {}),
      failureReason: discovery.reason,
    })
    .catch(() => {});
  enqueue({
    sessionId,
    filePath: discovery.sourcePath ?? null,
    reason: discovery.reason,
  });
  emitTelemetry("cursor_export_upload_failed", {
    sessionId,
    source,
    sourcePath: discovery.sourcePath,
    reason: discovery.reason,
  });
  return {
    status: "failed",
    reason: discovery.reason,
    ...(discovery.sourcePath ? { sourcePath: discovery.sourcePath } : {}),
  };
}

// Drain the local pending queue at runner startup. Failures stay
// queued (attemptCount bumped) until MAX_ATTEMPTS.
export async function retryPendingUploads(args: {
  api: SamApi;
}): Promise<{ retried: number; succeeded: number }> {
  const { listPending, bumpAttempt } = await import("./pending-queue.js");
  const pending = listPending();
  if (pending.length === 0) return { retried: 0, succeeded: 0 };
  let succeeded = 0;
  for (const entry of pending) {
    bumpAttempt(entry.sessionId);
    let discovery: DiscoveryResult;
    if (entry.filePath && fs.existsSync(entry.filePath)) {
      try {
        const contents = fs.readFileSync(entry.filePath);
        const ext = path.extname(entry.filePath).toLowerCase();
        const mimeType: "text/markdown" | "text/plain" | "application/json" =
          entry.mimeType ??
          (ext === ".json"
            ? "application/json"
            : ext === ".txt"
              ? "text/plain"
              : "text/markdown");
        discovery = {
          status: "uploaded",
          sourcePath: entry.filePath,
          mimeType,
          sizeBytes: contents.byteLength,
          contents,
        };
      } catch (err) {
        discovery = {
          status: "failed",
          reason: `read_failed: ${(err as Error).message}`,
          sourcePath: entry.filePath,
        };
      }
    } else {
      discovery = discoverCursorExport();
    }
    const res = await uploadDiscoveryResult({
      api: args.api,
      sessionId: entry.sessionId,
      source: "auto",
      discovery,
    });
    if (res.status === "uploaded") succeeded += 1;
  }
  emitTelemetry("cursor_export_retry_drain", {
    retried: pending.length,
    succeeded,
  });
  return { retried: pending.length, succeeded };
}
