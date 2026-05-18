// Task #1200 — Kotlin sandbox grader smoke test. Skipped when `kotlinc`
// is not on PATH (most CI lanes). The first compile is slow so we give
// the test a generous timeout.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { runKotlinSandbox, type SandboxCase } from "../sandbox/kotlin.js";

const KOTLINC_AVAILABLE = spawnSync("kotlinc", ["-version"]).status === 0;

const CASES: SandboxCase[] = [
  { id: "basic", args: [[2, 7, 11, 15], 9], expected: [0, 1] },
];

describe("runKotlinSandbox", { skip: !KOTLINC_AVAILABLE, timeout: 180_000 }, () => {
  it("reports outcome=error with the kotlinc stderr when the solution doesn't compile", () => {
    const code = `fun twoSum(nums: IntArray, target: Int): IntArray {
    return notARealSymbol(nums, target)
}
`;
    const result = runKotlinSandbox(code, "twoSum", CASES, 150_000);
    assert.equal(result.outcome, "error");
    assert.equal(result.timedOut, false);
    assert.ok(result.cases[0]!.stderrExcerpt!.length > 0);
  });

  it("grades a passing twoSum top-level function", () => {
    const code = `fun twoSum(nums: IntArray, target: Int): IntArray {
    val seen = HashMap<Int, Int>()
    for (i in nums.indices) {
        val j = seen[target - nums[i]]
        if (j != null) return intArrayOf(j, i)
        seen[nums[i]] = i
    }
    return intArrayOf()
}
`;
    const result = runKotlinSandbox(code, "twoSum", CASES, 150_000);
    assert.equal(result.outcome, "pass", JSON.stringify(result));
  });
});
