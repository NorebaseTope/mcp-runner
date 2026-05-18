// Task #1479 — `.prepsavant/last-session.json` persistence + sniff.
//
// Locks in the contract `upload-cursor-export` and the
// `prepsavant start` dispatcher depend on:
//
//   * writeLastSession + readLastSession round-trip the breadcrumb,
//     including the v=1 envelope, and tolerate the dir not yet
//     existing (the writer mkdirs defensively).
//   * readLastSession returns `null` on a malformed file, a missing
//     file, and a future-version envelope — so the upload command
//     can fall through to its "no flag, no breadcrumb" error message
//     instead of crashing.
//   * sniffManifestMode reads `mode` without doing the full HMAC
//     parse and returns "coached" as the safe default for any
//     malformed or modeless manifest.

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  LAST_SESSION_VERSION,
  lastSessionPath,
  readLastSession,
  writeLastSession,
} from "../last-session.js";
import { sniffManifestMode } from "../ai-assisted/cli-start.js";

function freshTmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `t1479-last-session-${label}-`));
}

test("writeLastSession round-trips through readLastSession with the v=1 envelope", () => {
  const dir = freshTmpDir("rt");
  const ok = writeLastSession(dir, {
    sessionId: "ses_t1479_rt_abc",
    mode: "ai_assisted",
    questionId: "q_t1479_rt_xyz",
    questionTitle: "RT Test",
    startedAt: "2025-05-16T12:00:00.000Z",
  });
  assert.equal(ok, true);
  assert.ok(fs.existsSync(lastSessionPath(dir)));
  const got = readLastSession(dir);
  assert.deepEqual(got, {
    v: LAST_SESSION_VERSION,
    sessionId: "ses_t1479_rt_abc",
    mode: "ai_assisted",
    questionId: "q_t1479_rt_xyz",
    questionTitle: "RT Test",
    startedAt: "2025-05-16T12:00:00.000Z",
  });
});

test("readLastSession returns null when file is absent, malformed, or a future version", () => {
  const dir = freshTmpDir("err");
  assert.equal(readLastSession(dir), null, "absent file → null");

  fs.mkdirSync(path.join(dir, ".prepsavant"), { recursive: true });
  fs.writeFileSync(lastSessionPath(dir), "{not json", "utf-8");
  assert.equal(readLastSession(dir), null, "malformed JSON → null");

  fs.writeFileSync(
    lastSessionPath(dir),
    JSON.stringify({ v: 99, sessionId: "x", mode: "coached", questionId: "q", startedAt: "x" }),
    "utf-8",
  );
  assert.equal(readLastSession(dir), null, "future version → null");

  fs.writeFileSync(
    lastSessionPath(dir),
    JSON.stringify({ v: 1, sessionId: "x", mode: "bogus", questionId: "q", startedAt: "x" }),
    "utf-8",
  );
  assert.equal(readLastSession(dir), null, "unknown mode → null");
});

test("sniffManifestMode returns 'ai_assisted' iff manifest.mode === 'ai_assisted', else 'coached'", () => {
  const dir = freshTmpDir("sniff");
  const m1 = path.join(dir, "ai.json");
  fs.writeFileSync(
    m1,
    JSON.stringify({ questionId: "q", mode: "ai_assisted", hmac: "h" }),
    "utf-8",
  );
  assert.equal(sniffManifestMode(m1), "ai_assisted");

  const m2 = path.join(dir, "coached.json");
  fs.writeFileSync(
    m2,
    JSON.stringify({ questionId: "q", mode: "coached", hmac: "h" }),
    "utf-8",
  );
  assert.equal(sniffManifestMode(m2), "coached");

  const m3 = path.join(dir, "no-mode.json");
  fs.writeFileSync(m3, JSON.stringify({ questionId: "q", hmac: "h" }), "utf-8");
  assert.equal(
    sniffManifestMode(m3),
    "coached",
    "absent `mode` → coached default",
  );

  const m4 = path.join(dir, "garbage.json");
  fs.writeFileSync(m4, "totally not json", "utf-8");
  assert.equal(
    sniffManifestMode(m4),
    "coached",
    "parse failure → coached default",
  );

  assert.equal(
    sniffManifestMode(path.join(dir, "nope.json")),
    "coached",
    "missing file → coached default",
  );
});
