// Task #1479 — pure dispatch decision for `prepsavant start`.
//
// Locks in the routing matrix documented above `decideStartDispatch`
// in `cli.ts`. The key invariants this file guards:
//
//   1. No explicit --mode + no folder manifest  -> coached (legacy
//      default — users not inside a question package).
//   2. No explicit --mode + manifest mode=coached -> coached.
//   3. No explicit --mode + manifest mode=ai_assisted -> ai-assisted
//      folder launcher (Task #1479 auto-detect).
//   4. --mode ai-assisted + no folder manifest -> ai-assisted-retired
//      banner (legacy behaviour preserved).
//   5. --mode ai-assisted + ANY folder manifest -> ai-assisted folder
//      launcher. The original Task #1479 review caught a regression
//      where explicit --mode silently skipped folder discovery and
//      fell through to the retired banner; this is the regression
//      guard. Folder manifest sniff is intentionally NOT consulted
//      here — the explicit flag wins.
//   6. --mode coached -> coached (explicit flag wins over any sniff).

import test from "node:test";
import assert from "node:assert/strict";

import { decideStartDispatch } from "../cli.js";

function makeFs(present: boolean) {
  return {
    existsSync: (_p: string) => present,
    statSync: (_p: string) => ({ isFile: () => present }),
  };
}

test("no flag + no manifest -> coached", () => {
  const decision = decideStartDispatch({
    flags: {},
    cwd: "/tmp/nowhere",
    fsImpl: makeFs(false),
    sniff: () => "coached",
  });
  assert.equal(decision.kind, "coached");
});

test("no flag + coached manifest -> coached", () => {
  const decision = decideStartDispatch({
    flags: {},
    cwd: "/tmp/pkg",
    fsImpl: makeFs(true),
    sniff: () => "coached",
  });
  assert.equal(decision.kind, "coached");
});

test("no flag + ai_assisted manifest -> ai-assisted-folder", () => {
  const decision = decideStartDispatch({
    flags: {},
    cwd: "/tmp/pkg",
    fsImpl: makeFs(true),
    sniff: () => "ai_assisted",
  });
  assert.equal(decision.kind, "ai-assisted-folder");
  if (decision.kind === "ai-assisted-folder") {
    assert.equal(decision.manifestPath, "/tmp/pkg/.prepsavant/question.json");
  }
});

test("--mode ai-assisted + no manifest -> ai-assisted-retired", () => {
  const decision = decideStartDispatch({
    flags: { mode: "ai-assisted" },
    cwd: "/tmp/nowhere",
    fsImpl: makeFs(false),
    sniff: () => "coached",
  });
  assert.equal(decision.kind, "ai-assisted-retired");
});

test("--mode ai-assisted + manifest present -> ai-assisted-folder (regression: explicit flag must not skip discovery)", () => {
  // Note: sniff returns "coached" here on purpose — the explicit
  // flag must override the sniff result. The original review
  // flagged this as a blocker: explicit --mode silently bypassed
  // folder discovery and fell through to the retired banner.
  const decision = decideStartDispatch({
    flags: { mode: "ai-assisted" },
    cwd: "/tmp/pkg",
    fsImpl: makeFs(true),
    sniff: () => "coached",
  });
  assert.equal(decision.kind, "ai-assisted-folder");
});

test("--ai-assisted bool flag is equivalent to --mode ai-assisted", () => {
  const decision = decideStartDispatch({
    flags: { "ai-assisted": true },
    cwd: "/tmp/pkg",
    fsImpl: makeFs(true),
    sniff: () => "coached",
  });
  assert.equal(decision.kind, "ai-assisted-folder");
});

test("--mode coached + ai_assisted manifest -> coached (explicit flag wins)", () => {
  const decision = decideStartDispatch({
    flags: { mode: "coached" },
    cwd: "/tmp/pkg",
    fsImpl: makeFs(true),
    sniff: () => "ai_assisted",
  });
  assert.equal(decision.kind, "coached");
});

test("fs throwing is treated as no manifest", () => {
  const decision = decideStartDispatch({
    flags: {},
    cwd: "/tmp/pkg",
    fsImpl: {
      existsSync: () => {
        throw new Error("EACCES");
      },
      statSync: () => ({ isFile: () => false }),
    },
    sniff: () => "ai_assisted",
  });
  assert.equal(decision.kind, "coached");
});
