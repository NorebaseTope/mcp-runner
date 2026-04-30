// Regression tests for the TypeScript sandbox CommonJS-friendly behaviour.
//
// Background: parallel to `sandbox-node-cjs.test.ts` for the JS path. The
// TypeScript runner writes the solution to a temp directory whose
// `package.json` declares `"type": "module"`. Before this fix, anyone who
// pasted a CommonJS reference solution in TypeScript (`export = { solve }`,
// `import x = require(...)`, or top-level `module.exports = { solve }`) hit
// `ReferenceError: module is not defined in ES module scope`. The runner now
// detects unambiguous CommonJS bodies and writes them to `.cts` so tsx treats
// them as CommonJS regardless of the surrounding package.
//
// These cases pin:
//   1. ESM TS solutions still work (no behavioural regression).
//   2. `export = { solve }` (TS-style CJS) runs.
//   3. `module.exports = { solve }` (raw CJS in a TS file) runs.
//   4. `import x = require(...)` plus `module.exports = ...` runs.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { runTypescriptSandbox, type SandboxCase } from "../sandbox/node.js";

const CASES: SandboxCase[] = [
  { id: "c1", args: [2, 3], expected: 5 },
  { id: "c2", args: [10, -4], expected: 6 },
];

// tsx is a heavy first-run dependency on cold caches; give it room.
const TIMEOUT_MS = 60_000;

describe("runTypescriptSandbox accepts CommonJS solutions", () => {
  it("runs an ESM TS solution with a named export", () => {
    const code = "export function solve(a: number, b: number): number { return a + b; }";
    const result = runTypescriptSandbox(code, "solve", CASES, TIMEOUT_MS);
    assert.equal(
      result.outcome,
      "pass",
      `expected pass, got ${result.outcome}: ${result.rawStderr}`,
    );
    assert.equal(result.cases.length, 2);
    assert.ok(result.cases.every((c) => c.passed));
  });

  it("runs a TS solution using `export = { solve }`", () => {
    const code = [
      "function solve(a: number, b: number): number { return a + b; }",
      "export = { solve };",
      "",
    ].join("\n");
    const result = runTypescriptSandbox(code, "solve", CASES, TIMEOUT_MS);
    assert.equal(
      result.outcome,
      "pass",
      `expected pass, got ${result.outcome}: ${result.rawStderr}`,
    );
    assert.ok(result.cases.every((c) => c.passed));
  });

  it("runs a TS solution using top-level `module.exports = { solve }`", () => {
    const code = [
      "function solve(a: number, b: number): number { return a + b; }",
      "module.exports = { solve };",
      "",
    ].join("\n");
    const result = runTypescriptSandbox(code, "solve", CASES, TIMEOUT_MS);
    assert.equal(
      result.outcome,
      "pass",
      `expected pass, got ${result.outcome}: ${result.rawStderr}`,
    );
    assert.ok(result.cases.every((c) => c.passed));
  });

  it("supports `import x = require(...)` in a CJS-style TS body", () => {
    const code = [
      "import path = require('node:path');",
      "function solve(a: number, b: number): number {",
      "  // touch path so the require is not dead code",
      "  void path.sep;",
      "  return a + b;",
      "}",
      "module.exports = { solve };",
      "",
    ].join("\n");
    const result = runTypescriptSandbox(code, "solve", CASES, TIMEOUT_MS);
    assert.equal(
      result.outcome,
      "pass",
      `expected pass, got ${result.outcome}: ${result.rawStderr}`,
    );
    assert.ok(result.cases.every((c) => c.passed));
  });
});
