// Best-effort sandboxed Python runner. We write the user's code + a small
// harness to a temp dir, spawn `python3` with a wall-clock timeout, capture
// truncated stdout/stderr, and return per-case results.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
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

function pythonExecutable(): string {
  // Prefer python3, fall back to python.
  const candidates = ["python3", "python"];
  for (const c of candidates) {
    const r = spawnSync(c, ["--version"], { encoding: "utf-8" });
    if (r.status === 0) return c;
  }
  return "python3";
}

export function pythonRuntimeVersion(): string {
  const exe = pythonExecutable();
  const r = spawnSync(exe, ["--version"], { encoding: "utf-8" });
  if (r.status === 0) {
    return (r.stdout || r.stderr || "").trim() || "unknown";
  }
  return "unavailable";
}

const HARNESS = `
import json, sys, time, traceback

def _main():
    try:
        from solution import ${"%ENTRY%"} as _fn  # type: ignore
    except Exception:
        print(json.dumps({
            "kind": "import_error",
            "stderr": traceback.format_exc(),
        }))
        return
    cases = json.loads(sys.argv[1])
    results = []
    for c in cases:
        t0 = time.time()
        try:
            args = c["args"]
            if isinstance(args, list):
                got = _fn(*args)
            else:
                got = _fn(args)
            ok = got == c["expected"]
            results.append({
                "id": c["id"],
                "passed": bool(ok),
                "durationMs": int((time.time() - t0) * 1000),
                "stderr": "" if ok else f"expected {c['expected']!r}, got {got!r}",
            })
        except Exception:
            results.append({
                "id": c["id"],
                "passed": False,
                "durationMs": int((time.time() - t0) * 1000),
                "stderr": traceback.format_exc(),
            })
    print(json.dumps({"kind": "results", "results": results}))

_main()
`;

export function runPythonSandbox(
  code: string,
  entry: string,
  cases: SandboxCase[],
  timeoutMs: number,
): SandboxResult {
  ensureConfigDir();
  const dir = fs.mkdtempSync(path.join(SANDBOX_DIR, "py-"));
  fs.writeFileSync(path.join(dir, "solution.py"), code, { mode: 0o600 });
  fs.writeFileSync(
    path.join(dir, "harness.py"),
    HARNESS.replace("%ENTRY%", entry),
    { mode: 0o600 },
  );
  const exe = pythonExecutable();
  const t0 = Date.now();
  // We deliberately do NOT pass `-I` (isolated mode), because that strips
  // both PYTHONPATH and the implicit cwd entry from `sys.path`, which would
  // make `from solution import ...` fail with ModuleNotFoundError. Instead
  // we use `-S` (skip site.py) to keep the sandbox lean while still allowing
  // the harness to import the user's `solution.py` from `cwd`.
  const proc = spawnSync(
    exe,
    ["-S", "harness.py", JSON.stringify(cases)],
    {
      cwd: dir,
      timeout: timeoutMs,
      encoding: "utf-8",
      // Strip env so user code can't read secrets from the runner process.
      env: {
        PATH: process.env.PATH ?? "",
        PYTHONIOENCODING: "utf-8",
        PYTHONDONTWRITEBYTECODE: "1",
      },
    },
  );
  const durationMs = Date.now() - t0;
  const stderr = proc.stderr ?? "";

  // Cleanup best-effort.
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }

  if (proc.signal === "SIGTERM" || (proc.error && (proc.error as { code?: string }).code === "ETIMEDOUT")) {
    return {
      outcome: "timeout",
      timedOut: true,
      durationMs,
      runtimeVersion: pythonRuntimeVersion(),
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
      runtimeVersion: pythonRuntimeVersion(),
      cases: cases.map((c) => ({
        id: c.id,
        passed: false,
        stderrExcerpt: truncate(stderr, 400),
      })),
      rawStderr: truncate(stderr),
    };
  }

  // The harness prints exactly one JSON line.
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
      runtimeVersion: pythonRuntimeVersion(),
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
      runtimeVersion: pythonRuntimeVersion(),
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
      runtimeVersion: pythonRuntimeVersion(),
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
    runtimeVersion: pythonRuntimeVersion(),
    cases: items.map((r) => ({
      id: r.id,
      passed: r.passed,
      durationMs: r.durationMs,
      stderrExcerpt: r.passed ? undefined : truncate(r.stderr ?? "", 400),
    })),
    rawStderr: truncate(stderr),
  };
}

// Re-export so callers can stat the OS without importing this twice.
export const PLATFORM = `${process.platform}-${os.arch()}`;
