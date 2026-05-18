// Task #1188 — hermetic coverage of the runner's local pending-upload
// queue + `retryPendingUploads` drain. The queue lives at
// `~/.prepsavant/pending-cursor-exports.json`; tests redirect `HOME`
// to a tmpdir so the host filesystem is never touched. The drain test
// uses a stub `SamApi` to exercise the failure-then-success path and
// the MAX_ATTEMPTS cap.
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SamApi } from "../api.js";
import {
  bumpAttempt,
  enqueue,
  listPending,
  remove,
  type PendingEntry,
} from "../cursor-export/pending-queue.js";
import { retryPendingUploads } from "../cursor-export/upload.js";

async function withTmpHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await fsp.mkdtemp(
    path.join(os.tmpdir(), "prepsavant-pending-queue-"),
  );
  const prevHome = process.env.HOME;
  const prevUserprofile = process.env.USERPROFILE;
  process.env.HOME = home;
  // Node's os.homedir() prefers HOME on POSIX but USERPROFILE on win32.
  // Pinning both keeps the test cross-platform safe.
  process.env.USERPROFILE = home;
  try {
    return await fn(home);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserprofile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserprofile;
    await fsp.rm(home, { recursive: true, force: true });
  }
}

function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (chunk: unknown) => boolean }).write =
    (chunk: unknown) => {
      const text =
        typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      for (const line of text.split("\n")) {
        if (line) lines.push(line);
      }
      return true;
    };
  return {
    lines,
    restore: () => {
      (process.stderr as unknown as { write: typeof original }).write = original;
    },
  };
}

test("enqueue / listPending / bumpAttempt / remove round-trip against tmp HOME", async () => {
  await withTmpHome(async (home) => {
    assert.deepEqual(listPending(), [], "fresh tmp HOME starts empty");

    enqueue({
      sessionId: "ses_a",
      filePath: "/tmp/a.md",
      mimeType: "text/markdown",
      reason: "first",
    });
    enqueue({
      sessionId: "ses_b",
      filePath: null,
      reason: "discovery_not_found",
    });

    // The on-disk file landed under tmp HOME, never the real ~/.prepsavant.
    const queueFile = path.join(home, ".prepsavant", "pending-cursor-exports.json");
    assert.ok(fs.existsSync(queueFile), "queue file lives under tmp HOME");

    const after = listPending();
    assert.equal(after.length, 2);
    // Newest enqueue comes first (unshift).
    assert.equal(after[0]?.sessionId, "ses_b");
    assert.equal(after[1]?.sessionId, "ses_a");
    assert.equal(after[1]?.attemptCount, 0);

    // Re-enqueueing the same sessionId de-dupes rather than duplicating.
    enqueue({ sessionId: "ses_a", filePath: "/tmp/a2.md", reason: "second" });
    const dedup = listPending();
    assert.equal(dedup.length, 2, "re-enqueue de-dupes on sessionId");
    const a = dedup.find((e) => e.sessionId === "ses_a");
    assert.equal(a?.filePath, "/tmp/a2.md");
    assert.equal(a?.reason, "second");

    bumpAttempt("ses_a");
    bumpAttempt("ses_a");
    const bumped = listPending().find((e) => e.sessionId === "ses_a");
    assert.equal(bumped?.attemptCount, 2);

    remove("ses_b");
    const final = listPending();
    assert.equal(final.length, 1);
    assert.equal(final[0]?.sessionId, "ses_a");
  });
});

test("listPending filters entries past MAX_AGE_MS or at MAX_ATTEMPTS", async () => {
  await withTmpHome(async (home) => {
    const queueFile = path.join(home, ".prepsavant", "pending-cursor-exports.json");
    fs.mkdirSync(path.dirname(queueFile), { recursive: true });
    const now = Date.now();
    const stale: PendingEntry = {
      sessionId: "ses_stale",
      filePath: null,
      failedAt: new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString(),
      attemptCount: 0,
    };
    const exhausted: PendingEntry = {
      sessionId: "ses_exhausted",
      filePath: null,
      failedAt: new Date(now).toISOString(),
      attemptCount: 5, // MAX_ATTEMPTS
    };
    const fresh: PendingEntry = {
      sessionId: "ses_fresh",
      filePath: null,
      failedAt: new Date(now).toISOString(),
      attemptCount: 1,
    };
    fs.writeFileSync(queueFile, JSON.stringify([stale, exhausted, fresh]));

    const visible = listPending(now);
    assert.deepEqual(
      visible.map((e) => e.sessionId),
      ["ses_fresh"],
      "only the fresh, under-cap entry is drainable",
    );
  });
});

test("retryPendingUploads removes entry on success and emits cursor_export_retry_drain telemetry", async () => {
  await withTmpHome(async (home) => {
    // Real on-disk export so the drain takes the file-based "uploaded"
    // branch instead of falling back to discovery.
    const exportDir = path.join(home, "exports");
    fs.mkdirSync(exportDir, { recursive: true });
    const exportPath = path.join(exportDir, "cursor-export.md");
    const body = "# session\nbody";
    fs.writeFileSync(exportPath, body, "utf8");

    enqueue({
      sessionId: "ses_retry_ok",
      filePath: exportPath,
      mimeType: "text/markdown",
      reason: "upload_failed: boom",
    });

    let calls = 0;
    const stub = {
      uploadCursorExport: async (
        sessionId: string,
        payload: { discoveryStatus: string; contentBase64?: string },
      ) => {
        calls += 1;
        assert.equal(sessionId, "ses_retry_ok");
        assert.equal(payload.discoveryStatus, "uploaded");
        assert.equal(
          Buffer.from(payload.contentBase64 ?? "", "base64").toString("utf8"),
          body,
        );
        return {
          id: "ce_1",
          sessionId,
          discoveryStatus: "uploaded" as const,
          createdAt: new Date().toISOString(),
        };
      },
    };

    const cap = captureStderr();
    let result;
    try {
      result = await retryPendingUploads({ api: stub as unknown as SamApi });
    } finally {
      cap.restore();
    }

    assert.equal(calls, 1, "retry calls the upload exactly once");
    assert.deepEqual(result, { retried: 1, succeeded: 1 });
    assert.deepEqual(listPending(), [], "successful retry removes the queue entry");

    const drainLines = cap.lines
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((o): o is Record<string, unknown> => !!o && o.event === "cursor_export_retry_drain");
    assert.equal(drainLines.length, 1, "exactly one drain telemetry line");
    assert.equal(drainLines[0]?.retried, 1);
    assert.equal(drainLines[0]?.succeeded, 1);
  });
});

test("retryPendingUploads on a flaky upload keeps the entry queued for the next drain, then succeeds when the network recovers", async () => {
  await withTmpHome(async () => {
    const exportPath = path.join(process.env.HOME!, "cursor-export.md");
    fs.writeFileSync(exportPath, "body", "utf8");

    enqueue({
      sessionId: "ses_flaky",
      filePath: exportPath,
      mimeType: "text/markdown",
      reason: "upload_failed: first blip",
    });

    let uploadAttempts = 0;
    let succeedNext = false;
    const stub = {
      uploadCursorExport: async (
        _sessionId: string,
        payload: { discoveryStatus: string },
      ) => {
        if (payload.discoveryStatus === "uploaded") {
          uploadAttempts += 1;
          if (!succeedNext) throw new Error("network 502");
        }
        return {
          id: "ce_x",
          sessionId: "ses_flaky",
          discoveryStatus: payload.discoveryStatus as
            | "uploaded"
            | "failed"
            | "not_found",
          createdAt: new Date().toISOString(),
        };
      },
    };

    // First drain: upload throws → uploadDiscoveryResult re-enqueues
    // the entry so the next runner invocation picks it up again.
    const first = await retryPendingUploads({ api: stub as unknown as SamApi });
    assert.deepEqual(first, { retried: 1, succeeded: 0 });
    assert.equal(uploadAttempts, 1);
    const stillQueued = listPending();
    assert.equal(stillQueued.length, 1, "failure leaves the entry queued");
    assert.equal(stillQueued[0]?.sessionId, "ses_flaky");

    // Second drain: network recovers → entry uploads and is removed.
    succeedNext = true;
    const second = await retryPendingUploads({ api: stub as unknown as SamApi });
    assert.deepEqual(second, { retried: 1, succeeded: 1 });
    assert.equal(uploadAttempts, 2);
    assert.deepEqual(
      listPending(),
      [],
      "successful retry on the second invocation drops the entry",
    );
  });
});

test("retryPendingUploads drops a persistently failing entry after MAX_ATTEMPTS drains (Task #1189)", async () => {
  await withTmpHome(async () => {
    const exportPath = path.join(process.env.HOME!, "cursor-export.md");
    fs.writeFileSync(exportPath, "body", "utf8");

    enqueue({
      sessionId: "ses_doomed",
      filePath: exportPath,
      mimeType: "text/markdown",
      reason: "upload_failed: persistent",
    });

    let uploadAttempts = 0;
    const stub = {
      uploadCursorExport: async (
        _sessionId: string,
        payload: { discoveryStatus: string },
      ) => {
        if (payload.discoveryStatus === "uploaded") {
          uploadAttempts += 1;
          throw new Error("network always down");
        }
        return {
          id: "ce_x",
          sessionId: "ses_doomed",
          discoveryStatus: payload.discoveryStatus as
            | "uploaded"
            | "failed"
            | "not_found",
          createdAt: new Date().toISOString(),
        };
      },
    };

    // Drain 5 times — each cycle should bumpAttempt and the catch
    // branch's re-enqueue must NOT reset attemptCount back to 0.
    for (let i = 0; i < 5; i += 1) {
      const r = await retryPendingUploads({ api: stub as unknown as SamApi });
      assert.equal(r.retried, 1, `drain ${i + 1} retried the entry`);
      assert.equal(r.succeeded, 0);
    }
    assert.equal(uploadAttempts, 5, "uploadCursorExport called once per drain");

    // After MAX_ATTEMPTS the entry is invisible to listPending and
    // future drains are no-ops — no more wasted retries / telemetry.
    assert.deepEqual(
      listPending(),
      [],
      "entry is dropped from drainable queue once attemptCount hits MAX_ATTEMPTS",
    );
    const sixth = await retryPendingUploads({ api: stub as unknown as SamApi });
    assert.deepEqual(sixth, { retried: 0, succeeded: 0 });
    assert.equal(uploadAttempts, 5, "no further upload attempts after the cap");
  });
});

test("retryPendingUploads on success path: queue file is removed once for the sessionId", async () => {
  await withTmpHome(async (home) => {
    const exportPath = path.join(home, "cursor-export.md");
    fs.writeFileSync(exportPath, "ok", "utf8");
    enqueue({
      sessionId: "ses_clean",
      filePath: exportPath,
      mimeType: "text/markdown",
    });
    // Pre-existing unrelated entry must survive the drain.
    enqueue({
      sessionId: "ses_other",
      filePath: null,
      reason: "discovery_not_found",
    });

    const stub = {
      uploadCursorExport: async (sessionId: string) => ({
        id: "ce_1",
        sessionId,
        discoveryStatus: "uploaded" as const,
        createdAt: new Date().toISOString(),
      }),
    };

    // Force ses_other into the exhausted bucket so listPending only
    // surfaces ses_clean for this drain — keeps the assertion focused.
    for (let i = 0; i < 5; i += 1) bumpAttempt("ses_other");

    const r = await retryPendingUploads({ api: stub as unknown as SamApi });
    assert.equal(r.retried, 1);
    assert.equal(r.succeeded, 1);
    // ses_clean removed; ses_other still on disk (just invisible to
    // listPending due to MAX_ATTEMPTS).
    assert.deepEqual(listPending(), []);
    const queueFile = path.join(home, ".prepsavant", "pending-cursor-exports.json");
    const raw = JSON.parse(fs.readFileSync(queueFile, "utf-8")) as PendingEntry[];
    assert.equal(raw.length, 1);
    assert.equal(raw[0]?.sessionId, "ses_other");
  });
});
