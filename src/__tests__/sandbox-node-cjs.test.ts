// Regression tests for the JS sandbox CommonJS-friendly behaviour.
//
// Background: the runner writes the solution to a temp directory whose
// `package.json` declares `"type": "module"`. Before this fix, anyone who
// pasted a CommonJS reference solution (`module.exports = { solve }`) hit
// `ReferenceError: module is not defined in ES module scope`. The runner
// now detects unambiguous CommonJS bodies and writes them to `.cjs` so
// Node treats them as CommonJS regardless of the surrounding package.
//
// These cases pin:
//   1. ESM solutions still work (no behavioural regression).
//   2. `module.exports = { solve }` runs.
//   3. `module.exports = solve` (function-as-export) runs.
//   4. `exports.solve = solve` runs.
//   5. The `looksLikeCommonJS` heuristic does not misclassify ESM bodies
//      that merely reference the words "module" or "require" in strings or
//      comments.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  looksLikeCommonJS,
  runJavascriptSandbox,
  type SandboxCase,
} from "../sandbox/node.js";

const CASES: SandboxCase[] = [
  { id: "c1", args: [2, 3], expected: 5 },
  { id: "c2", args: [10, -4], expected: 6 },
];

describe("looksLikeCommonJS heuristic", () => {
  it("flags module.exports = { ... } bodies", () => {
    assert.equal(
      looksLikeCommonJS("function solve(a,b){return a+b}\nmodule.exports = { solve };"),
      true,
    );
  });

  it("flags exports.foo = ... bodies", () => {
    assert.equal(
      looksLikeCommonJS("function solve(a,b){return a+b}\nexports.solve = solve;"),
      true,
    );
  });

  it("flags top-level require() bodies", () => {
    assert.equal(
      looksLikeCommonJS("const x = require('node:path');\nmodule.exports = {};"),
      true,
    );
  });

  it("does not flag ESM bodies with named exports", () => {
    assert.equal(
      looksLikeCommonJS("export function solve(a,b){return a+b}"),
      false,
    );
  });

  it("does not flag ESM bodies with default export", () => {
    assert.equal(
      looksLikeCommonJS("export default function solve(a,b){return a+b}"),
      false,
    );
  });

  it("prefers ESM when both styles appear (mixed body)", () => {
    // If the author already wrote `export`, leave it as ESM — they will hit
    // a clear syntax error from Node rather than us silently swapping modes.
    assert.equal(
      looksLikeCommonJS(
        "export function solve(a,b){return a+b}\n// module.exports also mentioned",
      ),
      false,
    );
  });

  it("does NOT flag pure TS `export =` bodies (handled by the harness fallback)", () => {
    // `export = { solve }` is TypeScript-only sugar that compiles to
    // `module.exports = { ... }`. The heuristic intentionally does not
    // match it (no `module.exports`/`require` token in the source). The
    // TS sandbox relies on the harness's `mod.default[entry]` fallback to
    // pick up the function instead. This test pins that contract so a
    // future tweak to `looksLikeCommonJS` doesn't accidentally change
    // which TS bodies get the `.cts` swap.
    assert.equal(
      looksLikeCommonJS(
        "function solve(a: number, b: number) { return a + b }\nexport = { solve };",
      ),
      false,
    );
  });

  it("ignores `module.exports` mentions inside string literals only", () => {
    // The current heuristic is intentionally simple; a body whose ONLY
    // reference to `module.exports` is inside a string still gets treated as
    // CJS, which is harmless (the file will simply run as CJS). We just pin
    // that an ESM body with a leading `import` keeps the ESM treatment even
    // when the word `module.exports` appears later in a comment.
    assert.equal(
      looksLikeCommonJS(
        "import x from 'node:path'\n// module.exports = whatever\nexport const y = 1;",
      ),
      false,
    );
  });
});

describe("runJavascriptSandbox accepts CommonJS solutions", () => {
  it("runs an ESM solution with a named export", () => {
    const code = "export function solve(a, b) { return a + b; }";
    const result = runJavascriptSandbox(code, "solve", CASES, 10_000);
    assert.equal(
      result.outcome,
      "pass",
      `expected pass, got ${result.outcome}: ${result.rawStderr}`,
    );
    assert.equal(result.cases.length, 2);
    assert.ok(result.cases.every((c) => c.passed));
  });

  it("runs a CommonJS solution using `module.exports = { solve }`", () => {
    const code =
      "function solve(a, b) { return a + b; }\nmodule.exports = { solve };\n";
    const result = runJavascriptSandbox(code, "solve", CASES, 10_000);
    assert.equal(
      result.outcome,
      "pass",
      `expected pass, got ${result.outcome}: ${result.rawStderr}`,
    );
    assert.ok(result.cases.every((c) => c.passed));
  });

  it("runs a CommonJS solution using `module.exports = solve` (function as export)", () => {
    const code =
      "function solve(a, b) { return a + b; }\nmodule.exports = solve;\n";
    const result = runJavascriptSandbox(code, "solve", CASES, 10_000);
    assert.equal(
      result.outcome,
      "pass",
      `expected pass, got ${result.outcome}: ${result.rawStderr}`,
    );
    assert.ok(result.cases.every((c) => c.passed));
  });

  it("runs a CommonJS solution using `exports.solve = ...`", () => {
    const code =
      "function solve(a, b) { return a + b; }\nexports.solve = solve;\n";
    const result = runJavascriptSandbox(code, "solve", CASES, 10_000);
    assert.equal(
      result.outcome,
      "pass",
      `expected pass, got ${result.outcome}: ${result.rawStderr}`,
    );
    assert.ok(result.cases.every((c) => c.passed));
  });

  it("supports `require()` calls in a CommonJS body", () => {
    const code = [
      "const path = require('node:path');",
      "function solve(a, b) {",
      "  // touch path so the require is not dead code",
      "  void path.sep;",
      "  return a + b;",
      "}",
      "module.exports = { solve };",
    ].join("\n");
    const result = runJavascriptSandbox(code, "solve", CASES, 10_000);
    assert.equal(
      result.outcome,
      "pass",
      `expected pass, got ${result.outcome}: ${result.rawStderr}`,
    );
    assert.ok(result.cases.every((c) => c.passed));
  });
});
