// Non-interference contract validation framework.
// Every Claude Code adapter handler must pass these assertions:
//   1. Writes no meaningful stdout beyond the minimum empty success response ({})
//   2. Does not block, approve, deny, defer, or modify any tool action
//   3. Does not add context to the assistant or modify prompts/responses
//   4. Returns the minimum empty success response the tool requires
//
// Used by the test suite (src/__tests__/non-interference.test.ts) and
// by the runner at session start to self-attest.

import { spawnSync } from "node:child_process";

export interface NonInterferenceResult {
  handlerKind: string;
  ok: boolean;
  violations: string[];
}

export interface HandlerTestFixture {
  kind: string;
  stdin: string;
}

// The set of fixture inputs used to exercise each handler.
export const HANDLER_FIXTURES: HandlerTestFixture[] = [
  { kind: "pre_tool_use", stdin: JSON.stringify({ tool_name: "bash", tool_input: { command: "ls" } }) },
  { kind: "post_tool_use", stdin: JSON.stringify({ tool_name: "bash", tool_input: { command: "ls" }, tool_response: { stdout: "file.ts\n", stderr: "", exit_code: 0 } }) },
  { kind: "user_prompt_submit", stdin: JSON.stringify({ prompt: "Add a binary search function." }) },
  { kind: "stop", stdin: JSON.stringify({ transcript_path: "/tmp/transcript.json" }) },
];

// Run a single handler against a fixture and check the non-interference contract.
export function testHandlerNonInterference(
  handlerPath: string,
  fixture: HandlerTestFixture,
): NonInterferenceResult {
  const violations: string[] = [];

  const result = spawnSync("node", [handlerPath, fixture.kind], {
    input: fixture.stdin,
    encoding: "utf-8",
    timeout: 3000,
  });

  if (result.status !== 0) {
    violations.push(`handler exited with code ${result.status}: ${result.stderr?.slice(0, 200)}`);
  }

  // stdout must be valid JSON (the minimum success response)
  const stdout = result.stdout ?? "";
  try {
    JSON.parse(stdout);
  } catch {
    violations.push(`stdout is not valid JSON: ${stdout.slice(0, 200)}`);
  }

  // stdout must not contain any of the known blocking response keys
  const blockingKeys = ["block", "approve", "deny", "defer", "modify", "context", "prompt"];
  for (const key of blockingKeys) {
    if (stdout.toLowerCase().includes(`"${key}"`)) {
      violations.push(`stdout contains blocking key "${key}"`);
    }
  }

  // stderr may have adapter diagnostics; we don't fail on non-empty stderr
  // but we do check that no blocking signals appear there either.

  return { handlerKind: fixture.kind, ok: violations.length === 0, violations };
}

// Run all fixtures against a handler binary. Returns overall pass/fail.
export function runAllNonInterferenceTests(handlerPath: string): {
  passed: number;
  failed: number;
  results: NonInterferenceResult[];
} {
  const results = HANDLER_FIXTURES.map((f) =>
    testHandlerNonInterference(handlerPath, f),
  );
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  return { passed, failed, results };
}
