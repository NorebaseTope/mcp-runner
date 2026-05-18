// Task #1200 — C# sandbox grader smoke test. Skipped when `dotnet` is
// not on PATH (most CI lanes). When dotnet IS available the first
// invocation does an implicit restore + build and can take 10–30s, so
// we give the test a generous timeout and only run a single case.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { runCsharpSandbox, type SandboxCase } from "../sandbox/csharp.js";

const DOTNET_AVAILABLE = spawnSync("dotnet", ["--version"]).status === 0;

const CASES: SandboxCase[] = [
  { id: "basic", args: [[2, 7, 11, 15], 9], expected: [0, 1] },
];

describe("runCsharpSandbox", { skip: !DOTNET_AVAILABLE, timeout: 120_000 }, () => {
  it("grades a passing TwoSum solution", () => {
    const code = `using System.Collections.Generic;
public class Solution {
    public int[] TwoSum(int[] nums, int target) {
        var seen = new Dictionary<int, int>();
        for (int i = 0; i < nums.Length; i++) {
            if (seen.TryGetValue(target - nums[i], out var j)) return new[] { j, i };
            seen[nums[i]] = i;
        }
        return new int[0];
    }
}
`;
    const result = runCsharpSandbox(code, "TwoSum", CASES, 90_000);
    assert.equal(result.outcome, "pass", JSON.stringify(result));
  });
});
