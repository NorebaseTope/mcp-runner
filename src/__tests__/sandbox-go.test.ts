// Task #1213 — Go sandbox grader smoke test. Skipped when `go` is not
// on PATH (most CI lanes). When go IS available the first invocation
// builds the user's package + harness (1–10s on a clean GOCACHE), so we
// give the test a generous timeout.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { runGoSandbox, type SandboxCase } from "../sandbox/go.js";

const GO_AVAILABLE = spawnSync("go", ["version"]).status === 0;

const CASES: SandboxCase[] = [
  { id: "basic", args: [[2, 7, 11, 15], 9], expected: [0, 1] },
];

describe("runGoSandbox", { skip: !GO_AVAILABLE, timeout: 120_000 }, () => {
  // Regression guard: the workshop default entry name is lowercase
  // `solve`, and Go solutions in the same `package main` as the
  // harness can use any case. An earlier draft of this grader force-
  // uppercased the entry symbol, which silently broke valid lowercase
  // solutions — this test would catch a recurrence.
  it("grades a passing lowercase-entry twoSum solution", () => {
    const code = `package main

func twoSum(nums []int, target int) []int {
    seen := map[int]int{}
    for i, n := range nums {
        if j, ok := seen[target-n]; ok {
            return []int{j, i}
        }
        seen[n] = i
    }
    return []int{}
}
`;
    const result = runGoSandbox(code, "twoSum", CASES, 90_000);
    assert.equal(result.outcome, "pass", JSON.stringify(result));
  });

  it("also accepts an uppercase-entry solution (Go's free choice within a package)", () => {
    const code = `package main

func Solve(nums []int, target int) []int {
    seen := map[int]int{}
    for i, n := range nums {
        if j, ok := seen[target-n]; ok {
            return []int{j, i}
        }
        seen[n] = i
    }
    return []int{}
}
`;
    const result = runGoSandbox(code, "Solve", CASES, 90_000);
    assert.equal(result.outcome, "pass", JSON.stringify(result));
  });

  it("reports outcome=error with the go stderr when the solution doesn't compile", () => {
    const code = `package main

func twoSum(nums []int, target int) []int {
    return notARealSymbol(nums, target)
}
`;
    const result = runGoSandbox(code, "twoSum", CASES, 90_000);
    assert.equal(result.outcome, "error");
    assert.equal(result.timedOut, false);
    assert.ok(result.cases[0]!.stderrExcerpt!.length > 0);
  });
});
