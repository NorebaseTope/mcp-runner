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
import("./%SOLUTION_FILE%")
  .then((mod) => {
    // Resolve the entry function. Order:
    //   1. named ESM export: \`export function solve\`
    //   2. named on the CJS module.exports object surfaced via mod.default:
    //      \`module.exports = { solve }\`
    //   3. ESM default export, or \`module.exports = function ...\`
    const fn = mod["%ENTRY%"]
      ?? (mod.default && mod.default["%ENTRY%"])
      ?? mod.default;
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
import * as mod from "./%SOLUTION_FILE%";
// Resolve the entry function. Order mirrors the JS harness:
//   1. named ESM export: \`export function solve\`
//   2. named on the CJS module.exports object surfaced via mod.default:
//      \`export = { solve }\` or \`module.exports = { solve }\` in a .cts file
//   3. ESM default export, or \`module.exports = function ...\`
const _m: any = mod as any;
const fn: any = _m["%ENTRY%"]
  ?? (_m.default && _m.default["%ENTRY%"])
  ?? _m.default;
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

// Best-effort detector for CommonJS-style solutions. The sandbox writes a
// `package.json` with `"type": "module"`, so a body that uses `module.exports`
// or top-level `require()` would otherwise fail with the misleading
// `ReferenceError: module is not defined in ES module scope`. When the body
// looks unambiguously CommonJS (and lacks ESM markers), we mirror it to a
// `.cjs` file so Node treats it as CommonJS regardless of the surrounding
// `package.json`. Anything that uses `import`/`export` keeps the ESM treatment.
export function looksLikeCommonJS(code: string): boolean {
  // Strip block + line comments so commented-out hints don't fool the heuristic.
  const stripped = code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  const hasCjs =
    /\bmodule\.exports\b/.test(stripped) ||
    /\bexports\.\w+\s*=/.test(stripped) ||
    /(^|[^.\w])require\s*\(/.test(stripped);
  if (!hasCjs) return false;
  const hasEsm =
    /^\s*export\s+(?:default\s+|\{|const\b|let\b|var\b|function\b|class\b|async\b|type\b|interface\b|enum\b|\*)/m.test(stripped) ||
    /^\s*import\s+[\s\S]+?from\s+['"]/m.test(stripped) ||
    /^\s*import\s*['"]/m.test(stripped);
  return !hasEsm;
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
  // Pick the extension that matches the solution body. The `.mjs`/`.cjs`
  // extensions force Node into the matching module mode regardless of the
  // surrounding `package.json`, so authors can use either style without a
  // `ReferenceError: module is not defined` (or the inverse for `import`).
  const solutionFile = looksLikeCommonJS(code) ? "solution.cjs" : "solution.mjs";
  fs.writeFileSync(path.join(dir, solutionFile), code, { mode: 0o600 });
  fs.writeFileSync(
    path.join(dir, "harness.mjs"),
    HARNESS_JS
      .replace(/%ENTRY%/g, entry)
      .replace(/%SOLUTION_FILE%/g, solutionFile),
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
  // Mirror the JS path: pick `.cts` for unambiguous CommonJS bodies (the
  // `looksLikeCommonJS` heuristic flags top-level `module.exports`,
  // `exports.foo =`, and `require(...)` calls). That avoids the misleading
  // `ReferenceError: module is not defined in ES module scope` from the
  // surrounding `"type": "module"` package.json on older tsx/Node combos,
  // and keeps the file unambiguously CJS for tsx's resolver.
  //
  // Pure `export = { solve }` bodies are *not* matched by the heuristic —
  // they have no `module.exports`/`require` token — and intentionally stay
  // on the `.ts` path. tsx still transpiles them to a CJS-shaped module
  // surfaced as `mod.default`, which the harness's entry-symbol fallback
  // (`mod.default[entry]`) below picks up.
  const solutionFile = looksLikeCommonJS(code) ? "solution.cts" : "solution.ts";
  fs.writeFileSync(path.join(dir, solutionFile), code, { mode: 0o600 });
  fs.writeFileSync(
    path.join(dir, "harness.ts"),
    HARNESS_TS
      .replace(/%ENTRY%/g, entry)
      .replace(/%SOLUTION_FILE%/g, solutionFile),
    { mode: 0o600 },
  );
  const t0 = Date.now();
  // npx's NixOS wrapper requires HOME/XDG_CONFIG_HOME to be set (it runs
  // under `set -u`), and tsx itself needs HOME for its on-disk module
  // resolution cache. Forward only those well-known config/cache markers
  // so the sandbox stays lean while still being launchable on Replit.
  const npxEnv: Record<string, string> = { PATH: process.env.PATH ?? "" };
  for (const k of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "TMPDIR"]) {
    const v = process.env[k];
    if (v) npxEnv[k] = v;
  }
  const proc = spawnSync(
    "npx",
    ["-y", "tsx", "harness.ts", JSON.stringify(cases)],
    {
      cwd: dir,
      timeout: timeoutMs,
      encoding: "utf-8",
      env: npxEnv,
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
