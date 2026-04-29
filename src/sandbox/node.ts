// Best-effort sandboxed Node runner. We write the user's code + a small
// harness to a temp dir, spawn a fresh Node subprocess with a wall-clock
// timeout, and capture per-case results. TypeScript code is supported via
// `npx -y tsx` if available; otherwise we surface a clear error.
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

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => deepEqual(ao[k], bo[k]));
  }
  return false;
}

const HARNESS_JS = `
import("./solution.js")
  .then((mod) => {
    const fn = mod["%ENTRY%"] ?? mod.default;
    if (typeof fn !== "function") {
      console.log(JSON.stringify({ kind: "import_error", stderr: "Entry symbol \\"%ENTRY%\\" is not a function (got " + typeof fn + ")." }));
      return;
    }
    const cases = JSON.parse(process.argv[2]);
    const equal = ${deepEqual.toString()};
    const out = [];
    for (const c of cases) {
      const t0 = Date.now();
      try {
        const args = Array.isArray(c.args) ? c.args : [c.args];
        const got = fn(...args);
        const ok = equal(got, c.expected);
        out.push({ id: c.id, passed: !!ok, durationMs: Date.now() - t0, stderr: ok ? "" : "expected " + JSON.stringify(c.expected) + ", got " + JSON.stringify(got) });
      } catch (e) {
        out.push({ id: c.id, passed: false, durationMs: Date.now() - t0, stderr: (e && e.stack) || String(e) });
      }
    }
    console.log(JSON.stringify({ kind: "results", results: out }));
  })
  .catch((e) => {
    console.log(JSON.stringify({ kind: "import_error", stderr: (e && e.stack) || String(e) }));
  });
`;

const HARNESS_TS = `
import * as mod from "./solution.ts";
const fn: any = (mod as any)["%ENTRY%"] ?? (mod as any).default;
${deepEqual.toString()}
async function main() {
  if (typeof fn !== "function") {
    console.log(JSON.stringify({ kind: "import_error", stderr: "Entry symbol \\"%ENTRY%\\" is not a function (got " + typeof fn + ")." }));
    return;
  }
  const cases: any[] = JSON.parse(process.argv[2]);
  const out: any[] = [];
  for (const c of cases) {
    const t0 = Date.now();
    try {
      const args = Array.isArray(c.args) ? c.args : [c.args];
      const got = fn(...args);
      const ok = deepEqual(got, c.expected);
      out.push({ id: c.id, passed: !!ok, durationMs: Date.now() - t0, stderr: ok ? "" : "expected " + JSON.stringify(c.expected) + ", got " + JSON.stringify(got) });
    } catch (e: any) {
      out.push({ id: c.id, passed: false, durationMs: Date.now() - t0, stderr: (e && e.stack) || String(e) });
    }
  }
  console.log(JSON.stringify({ kind: "results", results: out }));
}
main();
`;

export function nodeRuntimeVersion(): string {
  return `node ${process.version}`;
}

export function tsxRuntimeVersion(): string {
  const r = spawnSync("npx", ["-y", "tsx", "--version"], { encoding: "utf-8" });
  if (r.status === 0) return ("tsx " + (r.stdout || r.stderr || "")).trim();
  return "tsx: not available";
}

function parseHarnessOutput(
  stdout: string,
  stderr: string,
  cases: SandboxCase[],
  durationMs: number,
  runtimeVersion: string,
): SandboxResult {
  const lastLine = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  if (!lastLine) {
    return {
      outcome: "error",
      timedOut: false,
      durationMs,
      runtimeVersion,
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
      runtimeVersion,
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
      runtimeVersion,
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
    runtimeVersion,
    cases: items.map((r) => ({
      id: r.id,
      passed: r.passed,
      durationMs: r.durationMs,
      stderrExcerpt: r.passed ? undefined : truncate(r.stderr ?? "", 400),
    })),
    rawStderr: truncate(stderr),
  };
}

export function runJavascriptSandbox(
  code: string,
  entry: string,
  cases: SandboxCase[],
  timeoutMs: number,
): SandboxResult {
  ensureConfigDir();
  const dir = fs.mkdtempSync(path.join(SANDBOX_DIR, "js-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
  fs.writeFileSync(path.join(dir, "solution.js"), code, { mode: 0o600 });
  fs.writeFileSync(
    path.join(dir, "harness.mjs"),
    HARNESS_JS.replace(/%ENTRY%/g, entry),
    { mode: 0o600 },
  );
  const t0 = Date.now();
  const proc = spawnSync(
    process.execPath,
    ["--no-warnings", "harness.mjs", JSON.stringify(cases)],
    {
      cwd: dir,
      timeout: timeoutMs,
      encoding: "utf-8",
      env: { PATH: process.env.PATH ?? "" },
    },
  );
  const durationMs = Date.now() - t0;
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
      runtimeVersion: nodeRuntimeVersion(),
      cases: cases.map((c) => ({
        id: c.id,
        passed: false,
        stderrExcerpt: "Timed out before completion",
      })),
      rawStderr: truncate(proc.stderr ?? ""),
    };
  }
  return parseHarnessOutput(
    proc.stdout ?? "",
    proc.stderr ?? "",
    cases,
    durationMs,
    nodeRuntimeVersion(),
  );
}

export function runTypescriptSandbox(
  code: string,
  entry: string,
  cases: SandboxCase[],
  timeoutMs: number,
): SandboxResult {
  ensureConfigDir();
  const dir = fs.mkdtempSync(path.join(SANDBOX_DIR, "ts-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
  fs.writeFileSync(path.join(dir, "solution.ts"), code, { mode: 0o600 });
  fs.writeFileSync(
    path.join(dir, "harness.ts"),
    HARNESS_TS.replace(/%ENTRY%/g, entry),
    { mode: 0o600 },
  );
  const t0 = Date.now();
  const proc = spawnSync(
    "npx",
    ["-y", "tsx", "harness.ts", JSON.stringify(cases)],
    {
      cwd: dir,
      timeout: timeoutMs,
      encoding: "utf-8",
      env: { PATH: process.env.PATH ?? "" },
    },
  );
  const durationMs = Date.now() - t0;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
  if (proc.error && (proc.error as { code?: string }).code === "ENOENT") {
    return {
      outcome: "error",
      timedOut: false,
      durationMs,
      runtimeVersion: "tsx: not installed",
      cases: cases.map((c) => ({
        id: c.id,
        passed: false,
        stderrExcerpt:
          "Could not find tsx. Install Node 18.18+ and ensure `npx` is on PATH.",
      })),
      rawStderr: "",
    };
  }
  if (proc.signal === "SIGTERM" || (proc.error && (proc.error as { code?: string }).code === "ETIMEDOUT")) {
    return {
      outcome: "timeout",
      timedOut: true,
      durationMs,
      runtimeVersion: tsxRuntimeVersion(),
      cases: cases.map((c) => ({
        id: c.id,
        passed: false,
        stderrExcerpt: "Timed out before completion",
      })),
      rawStderr: truncate(proc.stderr ?? ""),
    };
  }
  return parseHarnessOutput(
    proc.stdout ?? "",
    proc.stderr ?? "",
    cases,
    durationMs,
    tsxRuntimeVersion(),
  );
}
