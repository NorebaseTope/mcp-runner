// Task #1134 — runner unit coverage for the host_reasoning evidence
// `diffSnippet` capture in `enrichDirectiveWithDiff`.
//
// Locks in two invariants:
//   1. When a diff is successfully captured, `result.diffSnippet` is set
//      (independent of enrichment eligibility — host_reasoning directives
//      are not "enrichable" but their evidence payload most needs the
//      captured diff).
//   2. The captured snippet is byte-capped at MAX_CHECKIN_DIFF_BYTES so
//      the wire-shape evidence payload stays bounded even when the
//      candidate's working diff is much larger than the snippet budget.

import test from "node:test";
import assert from "node:assert/strict";

import {
  enrichDirectiveWithDiff,
  MAX_CHECKIN_DIFF_BYTES,
} from "../coached/diff-aware-nudge.js";
import type { CheckInDirective } from "../api.js";
import type { CoachedSessionState } from "../coached/session.js";

// Minimal stand-in for `SnapshotStore` exposing only the surface
// `enrichDirectiveWithDiff` actually invokes (snapshot + getDiffSince).
function makeSnapshotStub(opts: {
  diff: string;
  filesChanged?: number;
  fileNames?: string[];
}) {
  return {
    snapshot(_kind: string) {
      return { commitSha: "deadbeef", filesChanged: 1 };
    },
    getDiffSince(
      _baseline: string,
      _opts: { maxBytes: number },
    ): {
      diff: string;
      truncated: boolean;
      filesChanged: number;
      fileNames: string[];
    } {
      return {
        diff: opts.diff,
        truncated: false,
        filesChanged: opts.filesChanged ?? 1,
        fileNames: opts.fileNames ?? ["src/foo.ts"],
      };
    },
  };
}

function makeState(snapshotStub: unknown): CoachedSessionState {
  // The enrichment helper only reads `snapshot`, `baselineSha`,
  // `lastSnapshotSha`, `questionTitle`. Cast through `unknown` so the
  // stubbed snapshot doesn't have to mirror every method on the real
  // store.
  return {
    sessionId: "ses_test",
    questionId: "qst_test",
    questionTitle: "test question",
    questionPrompt: "do the thing",
    workspaceDir: null,
    startedAt: 0,
    lastEditAt: 0,
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
    snapshot: snapshotStub as CoachedSessionState["snapshot"],
    baselineSha: "baseline",
    lastSnapshotSha: null,
    checkInDiffSummaries: [],
    editedFilesSinceLastCheckIn: new Set<string>(),
    bestPassedCount: null,
    cadence: null,
    targetDurationMs: null,
    recapEvents: [],
    shapeLadderState: {},
  };
}

function hostReasoningHintOffer(): CheckInDirective {
  return {
    action: "hint_offer",
    reason: "test",
    intent: "offer next hint",
    constraints: [],
    suggestedWording: null,
    mustBeVerbatim: false,
    mode: "host_reasoning",
    evidence: {
      diffSnippet: null,
      lastFailingTest: null,
      currentHintRungText: null,
      nextHintRungText: null,
    },
  };
}

test("enrichDirectiveWithDiff sets diffSnippet for a small diff (host_reasoning, not enrichable)", async () => {
  const smallDiff =
    "diff --git a/src/foo.ts b/src/foo.ts\n+++\n+const x = 1;\n";
  const state = makeState(makeSnapshotStub({ diff: smallDiff }));
  const result = await enrichDirectiveWithDiff(
    { directive: hostReasoningHintOffer(), state, recentUserMessage: null },
    {
      // No real MCP server is needed — host_reasoning is not enrichable
      // so the helper short-circuits before sampling.
      server: {} as unknown as Parameters<typeof enrichDirectiveWithDiff>[1]["server"],
      systemPrompt: "test",
    },
  );

  assert.equal(result.outcome, "skipped:hard_fixed");
  assert.equal(typeof result.diffSnippet, "string");
  assert.equal(result.diffSnippet, smallDiff);
});

test("enrichDirectiveWithDiff caps diffSnippet at MAX_CHECKIN_DIFF_BYTES bytes", async () => {
  // Build a diff well beyond the snippet cap (8KB > 4KB cap). We bump
  // the enrichment-side `maxDiffBytes` so the diff fits the enrichment
  // budget — the snippet cap is independent and tighter.
  const oversizedDiff = "x".repeat(MAX_CHECKIN_DIFF_BYTES * 2);
  const state = makeState(makeSnapshotStub({ diff: oversizedDiff }));
  const result = await enrichDirectiveWithDiff(
    { directive: hostReasoningHintOffer(), state, recentUserMessage: null },
    {
      server: {} as unknown as Parameters<typeof enrichDirectiveWithDiff>[1]["server"],
      systemPrompt: "test",
      maxDiffBytes: MAX_CHECKIN_DIFF_BYTES * 4,
    },
  );

  // host_reasoning is not enrichable, so we expect `skipped:hard_fixed`
  // — but the diff snippet must still come back.
  assert.equal(result.outcome, "skipped:hard_fixed");
  assert.equal(typeof result.diffSnippet, "string");
  const snippetBytes = Buffer.byteLength(result.diffSnippet!, "utf-8");
  assert.ok(
    snippetBytes <= MAX_CHECKIN_DIFF_BYTES,
    `diffSnippet must be ≤ ${MAX_CHECKIN_DIFF_BYTES} bytes; got ${snippetBytes}`,
  );
  assert.equal(
    snippetBytes,
    MAX_CHECKIN_DIFF_BYTES,
    "snippet is filled to the cap when the source diff exceeds it",
  );
});

test("enrichDirectiveWithDiff omits diffSnippet on the no-baseline branch", async () => {
  // No snapshot → the helper exits before computing a diff and the
  // snippet field must be undefined (not an empty string) so the
  // caller's `if (result.diffSnippet)` guards continue to behave.
  const state = makeState(null);
  state.snapshot = null;
  state.baselineSha = null;
  const result = await enrichDirectiveWithDiff(
    { directive: hostReasoningHintOffer(), state, recentUserMessage: null },
    {
      server: {} as unknown as Parameters<typeof enrichDirectiveWithDiff>[1]["server"],
      systemPrompt: "test",
    },
  );
  assert.equal(result.outcome, "skipped:hard_fixed");
  assert.equal(result.diffSnippet, undefined);
});
