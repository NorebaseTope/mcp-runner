// Task #1213 — C++ sandbox grader smoke test. Skipped when neither
// `g++` nor `clang++` is on PATH. The contract is "free function takes
// a JSON args string and returns a JSON result string" — so the test
// solution does a tiny inline parse of the well-known shape
// `[[nums...], target]` rather than pulling in a JSON dep.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { runCppSandbox, type SandboxCase } from "../sandbox/cpp.js";

const GPP_AVAILABLE = spawnSync("g++", ["--version"]).status === 0;
const CLANG_AVAILABLE = spawnSync("clang++", ["--version"]).status === 0;
const CPP_AVAILABLE = GPP_AVAILABLE || CLANG_AVAILABLE;

const CASES: SandboxCase[] = [
  { id: "basic", args: [[2, 7, 11, 15], 9], expected: [0, 1] },
];

describe("runCppSandbox", { skip: !CPP_AVAILABLE, timeout: 120_000 }, () => {
  it("grades a passing twoSum solution", () => {
    // Solution parses the canonical args shape `[[a,b,c,...], target]`
    // by hand using std::sscanf — keeps the test free of any external
    // JSON library while still exercising the round-trip.
    const code = `#include <string>
#include <vector>
#include <unordered_map>
#include <sstream>

std::string twoSum(const std::string& argsJson) {
    // Strip "[[" prefix and split on "]," to get the nums array and target.
    auto inner = argsJson.substr(2);
    auto closeArr = inner.find(']');
    auto numsStr = inner.substr(0, closeArr);
    auto rest = inner.substr(closeArr + 2);
    auto closeOuter = rest.find(']');
    auto targetStr = rest.substr(0, closeOuter);
    int target = std::stoi(targetStr);
    std::vector<int> nums;
    std::stringstream ss(numsStr);
    std::string item;
    while (std::getline(ss, item, ',')) nums.push_back(std::stoi(item));
    std::unordered_map<int, int> seen;
    for (size_t i = 0; i < nums.size(); i++) {
        auto it = seen.find(target - nums[i]);
        if (it != seen.end()) {
            return "[" + std::to_string(it->second) + "," + std::to_string(i) + "]";
        }
        seen[nums[i]] = i;
    }
    return "[]";
}
`;
    const result = runCppSandbox(code, "twoSum", CASES, 90_000);
    assert.equal(result.outcome, "pass", JSON.stringify(result));
  });

  it("reports outcome=error with the compiler stderr when the solution doesn't compile", () => {
    const code = `#include <string>
std::string twoSum(const std::string& argsJson) {
    return notARealSymbol(argsJson);
}
`;
    const result = runCppSandbox(code, "twoSum", CASES, 90_000);
    assert.equal(result.outcome, "error");
    assert.equal(result.timedOut, false);
    assert.ok(result.cases[0]!.stderrExcerpt!.length > 0);
  });
});
