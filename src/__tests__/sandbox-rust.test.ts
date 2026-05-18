// Task #1213 — Rust sandbox grader smoke test. Skipped when `rustc` is
// not on PATH. The contract mirrors the C++ grader: a free function
// `pub fn entry(args_json: &str) -> String`, with the user owning the
// JSON parsing. The test solution does a tiny inline parse of the
// well-known shape `[[nums...], target]` to avoid pulling in serde.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { runRustSandbox, type SandboxCase } from "../sandbox/rust.js";

const RUSTC_AVAILABLE = spawnSync("rustc", ["--version"]).status === 0;

const CASES: SandboxCase[] = [
  { id: "basic", args: [[2, 7, 11, 15], 9], expected: [0, 1] },
];

describe("runRustSandbox", { skip: !RUSTC_AVAILABLE, timeout: 180_000 }, () => {
  it("grades a passing two_sum solution", () => {
    const code = `use std::collections::HashMap;

pub fn two_sum(args_json: &str) -> String {
    // Args shape: "[[n1,n2,...], target]"
    let inner = &args_json[2..];
    let close_arr = inner.find(']').unwrap();
    let nums_str = &inner[..close_arr];
    let rest = &inner[close_arr + 2..];
    let close_outer = rest.find(']').unwrap();
    let target: i64 = rest[..close_outer].parse().unwrap();
    let nums: Vec<i64> = nums_str.split(',').map(|s| s.parse().unwrap()).collect();
    let mut seen: HashMap<i64, usize> = HashMap::new();
    for (i, n) in nums.iter().enumerate() {
        if let Some(j) = seen.get(&(target - n)) {
            return format!("[{},{}]", j, i);
        }
        seen.insert(*n, i);
    }
    "[]".to_string()
}
`;
    const result = runRustSandbox(code, "two_sum", CASES, 150_000);
    assert.equal(result.outcome, "pass", JSON.stringify(result));
  });

  it("reports outcome=error with the rustc stderr when the solution doesn't compile", () => {
    const code = `pub fn two_sum(args_json: &str) -> String {
    not_a_real_symbol(args_json)
}
`;
    const result = runRustSandbox(code, "two_sum", CASES, 150_000);
    assert.equal(result.outcome, "error");
    assert.equal(result.timedOut, false);
    assert.ok(result.cases[0]!.stderrExcerpt!.length > 0);
  });
});
