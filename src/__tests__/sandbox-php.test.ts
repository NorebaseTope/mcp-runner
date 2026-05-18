// Task #1200 — PHP sandbox grader smoke test. Skipped at runtime when
// `php` is not on PATH so CI machines without the toolchain don't fail.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { runPhpSandbox, type SandboxCase } from "../sandbox/php.js";

const PHP_AVAILABLE = spawnSync("php", ["--version"]).status === 0;

const CASES: SandboxCase[] = [
  { id: "basic", args: [[2, 7, 11, 15], 9], expected: [0, 1] },
  { id: "tail", args: [[3, 2, 4], 6], expected: [1, 2] },
];

describe("runPhpSandbox", { skip: !PHP_AVAILABLE }, () => {
  it("grades a passing two_sum solution", () => {
    const code = `<?php
function twoSum($nums, $target) {
    $seen = [];
    foreach ($nums as $i => $n) {
        if (isset($seen[$target - $n])) return [$seen[$target - $n], $i];
        $seen[$n] = $i;
    }
    return [];
}
`;
    const result = runPhpSandbox(code, "twoSum", CASES, 10_000);
    assert.equal(result.outcome, "pass");
    assert.equal(result.cases.length, 2);
    assert.ok(result.cases.every((c) => c.passed));
  });

  it("reports an import_error when the entry function is missing", () => {
    const code = `<?php
function notTheEntry($x) { return $x; }
`;
    const result = runPhpSandbox(code, "twoSum", CASES, 10_000);
    assert.equal(result.outcome, "error");
    assert.ok(result.cases[0]!.stderrExcerpt!.includes("twoSum"));
  });

  it("marks the case failed when the result diverges", () => {
    const code = `<?php
function twoSum($nums, $target) { return [99, 99]; }
`;
    const result = runPhpSandbox(code, "twoSum", CASES, 10_000);
    assert.equal(result.outcome, "fail");
    assert.ok(result.cases.every((c) => !c.passed));
  });
});
