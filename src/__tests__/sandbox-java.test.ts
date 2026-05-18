// Task #1213 — Java sandbox grader smoke test. Skipped at runtime when
// `javac` or `java` is not on PATH so CI machines without the JDK don't
// fail. The first compile is fast (sub-second on a warm box) so we use
// a relatively tight timeout.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { runJavaSandbox, type SandboxCase } from "../sandbox/java.js";

const JAVAC_AVAILABLE = spawnSync("javac", ["-version"]).status === 0;
const JAVA_AVAILABLE = spawnSync("java", ["-version"]).status === 0;
const JDK_AVAILABLE = JAVAC_AVAILABLE && JAVA_AVAILABLE;

const CASES: SandboxCase[] = [
  { id: "basic", args: [[2, 7, 11, 15], 9], expected: [0, 1] },
  { id: "tail", args: [[3, 2, 4], 6], expected: [1, 2] },
];

describe("runJavaSandbox", { skip: !JDK_AVAILABLE, timeout: 120_000 }, () => {
  it("grades a passing twoSum solution", () => {
    const code = `import java.util.HashMap;
public class Solution {
    public int[] twoSum(int[] nums, int target) {
        HashMap<Integer, Integer> seen = new HashMap<>();
        for (int i = 0; i < nums.length; i++) {
            Integer j = seen.get(target - nums[i]);
            if (j != null) return new int[]{ j, i };
            seen.put(nums[i], i);
        }
        return new int[0];
    }
}
`;
    const result = runJavaSandbox(code, "twoSum", CASES, 90_000);
    assert.equal(result.outcome, "pass", JSON.stringify(result));
    assert.ok(result.cases.every((c) => c.passed));
  });

  it("reports an import_error when the entry method is missing", () => {
    const code = `public class Solution {
    public int notTheEntry(int x) { return x; }
}
`;
    const result = runJavaSandbox(code, "twoSum", CASES, 90_000);
    assert.equal(result.outcome, "error");
    assert.ok(result.cases[0]!.stderrExcerpt!.includes("twoSum"));
  });

  it("reports outcome=error with the javac stderr when the solution doesn't compile", () => {
    const code = `public class Solution {
    public int[] twoSum(int[] nums, int target) {
        return notARealSymbol(nums, target);
    }
}
`;
    const result = runJavaSandbox(code, "twoSum", CASES, 90_000);
    assert.equal(result.outcome, "error");
    assert.equal(result.timedOut, false);
    assert.ok(result.cases[0]!.stderrExcerpt!.length > 0);
  });
});
