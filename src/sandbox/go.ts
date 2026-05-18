// Task #1213 — Go sandbox grader. The user's solution.go is expected to
// declare `package main` and define a function whose name matches
// `entry` exactly (any case — `solve`, `Solve`, `twoSum`, `TwoSum`
// all work, since solution + driver compile into the same package
// and Go's package-private export rule doesn't apply within a
// package). The driver passes the entry symbol to a sibling
// `harness` package via `harness.Run(<entry>, rawCases)`.
//
// Putting solution in `package main` (alongside the driver) avoids
// the cross-package export rule (which would force the user's
// function name to be uppercased — incompatible with the workshop
// default `entry: "solve"`). The reflection-heavy harness lives in
// its own sub-package so the Go build cache can keep its compiled
// object across attempts.
//
// Task #1231 — same warm-cache speedup as csharp.ts / kotlin.ts. The
// long-lived cache dir at `~/.prepsavant/sandbox-cache/go/<harnessHash>/`
// holds:
//   * `harness/harness.go` — the heavy reflection + JSON code, in its
//     own package so Go's build cache caches its compiled object.
//   * a stable `GOCACHE` subdir so subsequent `go run` invocations
//     reuse the harness build artifacts.
// Per attempt we only write `main.go` (a 6-line driver that calls
// `harness.Run(<entry>, raw)`) and `solution.go` (the user's code).
// The first call still pays the full `go build` cost (1–10s), but
// steady-state warm grades land well under 2s. Concurrent attempts
// share the cache dir and are serialized via a file lock.
import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { SANDBOX_CACHE_DIR, ensureConfigDir } from "../config.js";
import { SandboxLockTimeoutError, withSandboxLock } from "./lock.js";

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

export function goRuntimeVersion(): string {
  const r = spawnSync("go", ["version"], { encoding: "utf-8" });
  if (r.status === 0) {
    return ((r.stdout || r.stderr || "").trim().split("\n")[0] || "unknown");
  }
  return "unavailable";
}

const GO_MOD = `module sandbox

go 1.21
`;

// All the heavy lifting (reflect, encoding/json, JSON canonicalizer)
// lives in the `harness` sub-package so Go's build cache can keep its
// compiled object across attempts. `Run` takes the entry function as
// `interface{}` and uses reflect to invoke it per case.
const HARNESS_PKG = `package harness

import (
        "encoding/json"
        "fmt"
        "reflect"
        "sort"
        "time"
)

func canonicalize(v interface{}) interface{} {
        switch x := v.(type) {
        case map[string]interface{}:
                keys := make([]string, 0, len(x))
                for k := range x {
                        keys = append(keys, k)
                }
                sort.Strings(keys)
                out := make([]interface{}, 0, len(keys)*2)
                for _, k := range keys {
                        out = append(out, k, canonicalize(x[k]))
                }
                return out
        case []interface{}:
                out := make([]interface{}, len(x))
                for i, e := range x {
                        out[i] = canonicalize(e)
                }
                return out
        default:
                return x
        }
}

func canonicalJSON(b []byte) string {
        var v interface{}
        if err := json.Unmarshal(b, &v); err != nil {
                return string(b)
        }
        out, _ := json.Marshal(canonicalize(v))
        return string(out)
}

func emit(o interface{}) {
        b, _ := json.Marshal(o)
        fmt.Println(string(b))
}

// Run dispatches the per-case loop. entryFn must be a function value
// (e.g. via passing the user's symbol directly). rawCases is the JSON-
// serialized cases array from argv.
func Run(entryFn interface{}, rawCases string) {
        defer func() {
                if r := recover(); r != nil {
                        emit(map[string]interface{}{
                                "kind":   "import_error",
                                "stderr": fmt.Sprintf("panic: %v", r),
                        })
                }
        }()
        fn := reflect.ValueOf(entryFn)
        if fn.Kind() != reflect.Func {
                emit(map[string]interface{}{
                        "kind":   "import_error",
                        "stderr": "entry symbol is not a function",
                })
                return
        }
        fnType := fn.Type()
        var cases []map[string]interface{}
        if err := json.Unmarshal([]byte(rawCases), &cases); err != nil {
                emit(map[string]interface{}{
                        "kind":   "import_error",
                        "stderr": "cases JSON parse failed: " + err.Error(),
                })
                return
        }
        results := make([]map[string]interface{}, 0, len(cases))
        for _, c := range cases {
                id, _ := c["id"].(string)
                argsRaw := c["args"]
                expected := c["expected"]
                argsList, ok := argsRaw.([]interface{})
                if !ok {
                        argsList = []interface{}{argsRaw}
                }
                t0 := time.Now()
                func() {
                        defer func() {
                                if r := recover(); r != nil {
                                        results = append(results, map[string]interface{}{
                                                "id":         id,
                                                "passed":     false,
                                                "durationMs": int(time.Since(t0).Milliseconds()),
                                                "stderr":     fmt.Sprintf("panic: %v", r),
                                        })
                                }
                        }()
                        argVals := make([]reflect.Value, fnType.NumIn())
                        for i := 0; i < fnType.NumIn(); i++ {
                                ptr := reflect.New(fnType.In(i))
                                raw, err := json.Marshal(argsList[i])
                                if err != nil {
                                        panic("marshal arg " + err.Error())
                                }
                                if err := json.Unmarshal(raw, ptr.Interface()); err != nil {
                                        panic("unmarshal arg " + err.Error())
                                }
                                argVals[i] = ptr.Elem()
                        }
                        out := fn.Call(argVals)
                        var got interface{}
                        if len(out) == 1 {
                                got = out[0].Interface()
                        } else if len(out) == 0 {
                                got = nil
                        } else {
                                slice := make([]interface{}, len(out))
                                for i, v := range out {
                                        slice[i] = v.Interface()
                                }
                                got = slice
                        }
                        gotJSON, _ := json.Marshal(got)
                        expectedJSON, _ := json.Marshal(expected)
                        passed := canonicalJSON(gotJSON) == canonicalJSON(expectedJSON)
                        stderr := ""
                        if !passed {
                                stderr = fmt.Sprintf("expected %s, got %s", string(expectedJSON), string(gotJSON))
                        }
                        results = append(results, map[string]interface{}{
                                "id":         id,
                                "passed":     passed,
                                "durationMs": int(time.Since(t0).Milliseconds()),
                                "stderr":     stderr,
                        })
                }()
        }
        emit(map[string]interface{}{"kind": "results", "results": results})
}
`;

// Per-attempt main.go is a 6-line driver. Only this file (plus
// solution.go) is recompiled per attempt — the harness package's
// compiled object stays in the Go build cache.
function mainGo(entry: string): string {
  return `package main

import (
        "os"
        "sandbox/harness"
)

func main() {
        raw := ""
        if len(os.Args) > 1 {
                raw = os.Args[1]
        }
        harness.Run(${entry}, raw)
}
`;
}

const HARNESS_VERSION = crypto
  .createHash("sha256")
  .update("v1\n")
  .update(GO_MOD)
  .update("\n---\n")
  .update(HARNESS_PKG)
  .digest("hex")
  .slice(0, 16);

function ensureCacheDir(): string {
  ensureConfigDir();
  const dir = path.join(SANDBOX_CACHE_DIR, "go", HARNESS_VERSION);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Stable harness package + go.mod survive across attempts.
  const harnessDir = path.join(dir, "harness");
  fs.mkdirSync(harnessDir, { recursive: true, mode: 0o700 });
  const goModPath = path.join(dir, "go.mod");
  if (!fs.existsSync(goModPath) || fs.readFileSync(goModPath, "utf-8") !== GO_MOD) {
    fs.writeFileSync(goModPath, GO_MOD, { mode: 0o600 });
  }
  const harnessPath = path.join(harnessDir, "harness.go");
  if (!fs.existsSync(harnessPath) || fs.readFileSync(harnessPath, "utf-8") !== HARNESS_PKG) {
    fs.writeFileSync(harnessPath, HARNESS_PKG, { mode: 0o600 });
  }
  // Long-lived GOCACHE so the harness package stays compiled.
  fs.mkdirSync(path.join(dir, ".gocache"), { recursive: true, mode: 0o700 });
  return dir;
}

function sanitizeEntry(entry: string): string {
  const cleaned = entry.replace(/[^A-Za-z0-9_]/g, "");
  return cleaned || "solve";
}

export function runGoSandbox(
  code: string,
  entry: string,
  cases: SandboxCase[],
  timeoutMs: number,
): SandboxResult {
  const dir = ensureCacheDir();
  const lockStart = Date.now();

  try {
    return withSandboxLock(path.join(dir, ".lock"), timeoutMs, () => {
      fs.writeFileSync(path.join(dir, "solution.go"), code, { mode: 0o600 });
      fs.writeFileSync(path.join(dir, "main.go"), mainGo(sanitizeEntry(entry)), { mode: 0o600 });

      const t0 = Date.now();
      const proc = spawnSync(
        "go",
        ["run", ".", JSON.stringify(cases)],
        {
          cwd: dir,
          timeout: timeoutMs,
          encoding: "utf-8",
          env: {
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? "",
            GOPATH: process.env.GOPATH ?? "",
            // Stable per-cache-dir GOCACHE keeps the compiled harness
            // package across attempts, which is what makes warm runs
            // sub-2s.
            GOCACHE: path.join(dir, ".gocache"),
            GOMODCACHE: process.env.GOMODCACHE ?? "",
          },
          maxBuffer: 8 * 1024 * 1024,
        },
      );
      const durationMs = Date.now() - t0;
      const stderr = proc.stderr ?? "";

      if (
        proc.signal === "SIGTERM" ||
        (proc.error && (proc.error as { code?: string }).code === "ETIMEDOUT")
      ) {
        return {
          outcome: "timeout",
          timedOut: true,
          durationMs,
          runtimeVersion: goRuntimeVersion(),
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
          runtimeVersion: goRuntimeVersion(),
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
          runtimeVersion: goRuntimeVersion(),
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
          runtimeVersion: goRuntimeVersion(),
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
          runtimeVersion: goRuntimeVersion(),
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
        runtimeVersion: goRuntimeVersion(),
        cases: items.map((r) => ({
          id: r.id,
          passed: r.passed,
          durationMs: r.durationMs,
          stderrExcerpt: r.passed ? undefined : truncate(r.stderr ?? "", 400),
        })),
        rawStderr: truncate(stderr),
      };
    });
  } catch (err) {
    if (err instanceof SandboxLockTimeoutError) {
      return {
        outcome: "timeout",
        timedOut: true,
        durationMs: Date.now() - lockStart,
        runtimeVersion: goRuntimeVersion(),
        cases: cases.map((c) => ({
          id: c.id,
          passed: false,
          stderrExcerpt: "Timed out waiting for the Go sandbox build cache lock",
        })),
        rawStderr: err.message,
      };
    }
    throw err;
  }
}

export const __goCacheInternals = {
  HARNESS_VERSION,
  cacheDir: () => path.join(SANDBOX_CACHE_DIR, "go", HARNESS_VERSION),
};
