// Task #1200 — PHP sandbox grader. Mirrors the python.ts shape: write the
// user's solution.php + a tiny harness.php to a fresh temp dir, spawn
// `php` with a wall-clock timeout, capture truncated stdout/stderr, and
// return per-case results.
//
// The user's solution.php is expected to define a top-level function
// whose name matches `entry`. Args are passed as a positional array
// from the cases JSON; the harness compares the result against
// `expected` by JSON-normalizing both sides (sorted keys, no
// whitespace) so two PHP associative arrays / objects with the same
// contents are treated as equal regardless of insertion order.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { SANDBOX_DIR, ensureConfigDir } from "../config.js";

export interface SandboxCase {
  id: string;
  args: unknown;
  expected: unknown;
}

export interface SandboxResult {
  outcome: "pass" | "fail" | "error" | "timeout";
  timedOut: boolean;
  durationMs: number;
  runtimeVersion: string;
  cases: Array<{
    id: string;
    passed: boolean;
    durationMs?: number;
    stderrExcerpt?: string;
  }>;
  rawStderr: string;
}

const STDERR_LIMIT = 4_000;

function truncate(s: string, max = STDERR_LIMIT): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[truncated ${s.length - max} bytes]`;
}

export function phpRuntimeVersion(): string {
  const r = spawnSync("php", ["--version"], { encoding: "utf-8" });
  if (r.status === 0) {
    return ((r.stdout || r.stderr || "").trim().split("\n")[0] || "unknown");
  }
  return "unavailable";
}

// The harness uses `require_once` so the user's file is loaded once and
// any top-level `function entry(...)` definitions become callable. Errors
// during require (parse / fatal) are caught via a shutdown handler and
// surfaced as `import_error` so the runner can show a useful message
// instead of a blank "no output" result.
const HARNESS = `<?php
function _norm($v) {
    if (is_array($v)) {
        $assoc = false;
        foreach (array_keys($v) as $k) { if (!is_int($k)) { $assoc = true; break; } }
        if ($assoc) {
            ksort($v);
            $out = [];
            foreach ($v as $k => $vv) { $out[$k] = _norm($vv); }
            return $out;
        }
        return array_map('_norm', $v);
    }
    if (is_object($v)) {
        $arr = (array)$v;
        ksort($arr);
        $out = [];
        foreach ($arr as $k => $vv) { $out[$k] = _norm($vv); }
        return $out;
    }
    return $v;
}
function _emit($obj) { echo json_encode($obj) . PHP_EOL; }
register_shutdown_function(function () {
    $err = error_get_last();
    if ($err !== null && in_array($err['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR])) {
        _emit(["kind" => "import_error", "stderr" => $err['message'] . " in " . $err['file'] . ":" . $err['line']]);
    }
});
try {
    require_once __DIR__ . '/solution.php';
} catch (\\Throwable $e) {
    _emit(["kind" => "import_error", "stderr" => $e->getMessage() . "\\n" . $e->getTraceAsString()]);
    exit(0);
}
$entry = '%ENTRY%';
if (!function_exists($entry)) {
    _emit(["kind" => "import_error", "stderr" => "Entry function '" . $entry . "' is not defined in solution.php"]);
    exit(0);
}
$cases = json_decode($argv[1], true);
$results = [];
foreach ($cases as $c) {
    $args = isset($c['args']) ? $c['args'] : [];
    if (!is_array($args)) $args = [$args];
    $t0 = microtime(true);
    try {
        $got = call_user_func_array($entry, $args);
        $ok = json_encode(_norm($got)) === json_encode(_norm($c['expected']));
        $results[] = [
            "id" => $c['id'],
            "passed" => (bool)$ok,
            "durationMs" => (int)((microtime(true) - $t0) * 1000),
            "stderr" => $ok ? "" : ("expected " . json_encode($c['expected']) . ", got " . json_encode($got)),
        ];
    } catch (\\Throwable $e) {
        $results[] = [
            "id" => $c['id'],
            "passed" => false,
            "durationMs" => (int)((microtime(true) - $t0) * 1000),
            "stderr" => $e->getMessage() . "\\n" . $e->getTraceAsString(),
        ];
    }
}
_emit(["kind" => "results", "results" => $results]);
`;

export function runPhpSandbox(
  code: string,
  entry: string,
  cases: SandboxCase[],
  timeoutMs: number,
): SandboxResult {
  ensureConfigDir();
  const dir = fs.mkdtempSync(path.join(SANDBOX_DIR, "php-"));
  fs.writeFileSync(path.join(dir, "solution.php"), code, { mode: 0o600 });
  fs.writeFileSync(
    path.join(dir, "harness.php"),
    HARNESS.replace("%ENTRY%", entry.replace(/'/g, "\\'")),
    { mode: 0o600 },
  );
  const t0 = Date.now();
  const proc = spawnSync(
    "php",
    [
      // -d display_errors=stderr keeps fatal output off stdout so the
      // last-line JSON parse stays clean; the shutdown handler still
      // emits a structured import_error before we ever look at stderr.
      "-d", "display_errors=stderr",
      "-d", "log_errors=0",
      "harness.php",
      JSON.stringify(cases),
    ],
    {
      cwd: dir,
      timeout: timeoutMs,
      encoding: "utf-8",
      env: { PATH: process.env.PATH ?? "" },
    },
  );
  const durationMs = Date.now() - t0;
  const stderr = proc.stderr ?? "";

  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }

  if (
    proc.signal === "SIGTERM" ||
    (proc.error && (proc.error as { code?: string }).code === "ETIMEDOUT")
  ) {
    return {
      outcome: "timeout",
      timedOut: true,
      durationMs,
      runtimeVersion: phpRuntimeVersion(),
      cases: cases.map((c) => ({
        id: c.id,
        passed: false,
        stderrExcerpt: "Timed out before completion",
      })),
      rawStderr: truncate(stderr),
    };
  }

  if (proc.status !== 0 && !proc.stdout) {
    return {
      outcome: "error",
      timedOut: false,
      durationMs,
      runtimeVersion: phpRuntimeVersion(),
      cases: cases.map((c) => ({
        id: c.id,
        passed: false,
        stderrExcerpt: truncate(stderr, 400),
      })),
      rawStderr: truncate(stderr),
    };
  }

  const lastLine = (proc.stdout || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();

  if (!lastLine) {
    return {
      outcome: "error",
      timedOut: false,
      durationMs,
      runtimeVersion: phpRuntimeVersion(),
      cases: cases.map((c) => ({
        id: c.id,
        passed: false,
        stderrExcerpt: "Harness produced no output",
      })),
      rawStderr: truncate(stderr),
    };
  }

  let parsed: { kind: string; stderr?: string; results?: unknown[] };
  try {
    parsed = JSON.parse(lastLine);
  } catch {
    return {
      outcome: "error",
      timedOut: false,
      durationMs,
      runtimeVersion: phpRuntimeVersion(),
      cases: cases.map((c) => ({
        id: c.id,
        passed: false,
        stderrExcerpt: "Harness output was not valid JSON",
      })),
      rawStderr: truncate(stderr + "\n" + lastLine),
    };
  }

  if (parsed.kind === "import_error") {
    return {
      outcome: "error",
      timedOut: false,
      durationMs,
      runtimeVersion: phpRuntimeVersion(),
      cases: cases.map((c) => ({
        id: c.id,
        passed: false,
        stderrExcerpt: truncate(parsed.stderr ?? "import error", 400),
      })),
      rawStderr: truncate(parsed.stderr ?? "import error"),
    };
  }

  const items = (parsed.results ?? []) as Array<{
    id: string;
    passed: boolean;
    durationMs?: number;
    stderr?: string;
  }>;
  const allPassed = items.length > 0 && items.every((r) => r.passed);
  return {
    outcome: allPassed ? "pass" : "fail",
    timedOut: false,
    durationMs,
    runtimeVersion: phpRuntimeVersion(),
    cases: items.map((r) => ({
      id: r.id,
      passed: r.passed,
      durationMs: r.durationMs,
      stderrExcerpt: r.passed ? undefined : truncate(r.stderr ?? "", 400),
    })),
    rawStderr: truncate(stderr),
  };
}
