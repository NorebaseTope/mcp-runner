// Task #1213 — Rust sandbox grader. Mirrors the cpp.ts shape: because
// stable Rust has no runtime reflection, the contract with the user's
// solution.rs is simpler than the JVM/.NET graders. The user must
// define a free function with the signature
//
//     pub fn <entry>(args_json: &str) -> String
//
// where `args_json` is the JSON-serialized `args` array for one case
// and the returned String must be JSON-encoded. The harness lives in
// its own rlib and exposes `pub fn run(entry: fn(&str) -> String,
// raw: &str)` which does the per-case loop. Per attempt we compile a
// tiny `main.rs` that calls `ps_harness::run(solution::<entry>, ...)`.
//
// We avoid pulling in serde / serde_json so the cold-compile cost
// stays predictable on machines that only have rustc + the standard
// library. The embedded JSON parser/canonicalizer is intentionally
// minimal — it handles the shapes used by the workshop (numbers,
// strings, bools, null, arrays, objects with string keys) and not
// much else.
//
// Task #1231 — same warm-cache speedup as csharp.ts / kotlin.ts. The
// heavy `ps_harness.rs` (JSON parser + canonicalizer + per-case
// dispatch loop) is precompiled to `libps_harness.rlib` exactly once
// per harness-template version under
// `~/.prepsavant/sandbox-cache/rust/<harnessHash>/`. Per attempt we
// only rustc the user's `solution.rs` + a 6-line `main.rs` driver and
// link against the precompiled rlib. Concurrent attempts share the
// cache dir and are serialized via a file lock so two grades can't
// trample each other's `solution.rs` / `main.rs` / `sandbox` binary.
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

export function rustRuntimeVersion(): string {
  const r = spawnSync("rustc", ["--version"], { encoding: "utf-8" });
  if (r.status === 0) {
    return ((r.stdout || r.stderr || "").trim().split("\n")[0] || "unknown");
  }
  return "unavailable";
}

// Heavy harness — JSON parser, canonicalizer, and the per-case
// dispatch loop — packaged as a stable rlib. `run` accepts a function
// pointer rather than a generic so there's no monomorphization at
// per-attempt link time, keeping the per-attempt rustc work minimal.
const HARNESS_LIB = `use std::time::Instant;

#[derive(Clone, Debug)]
pub enum V {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<V>),
    Obj(Vec<(String, V)>),
}

pub struct P<'a> { pub src: &'a [u8], pub pos: usize }
impl<'a> P<'a> {
    pub fn ws(&mut self) { while self.pos < self.src.len() && matches!(self.src[self.pos], b' ' | b'\\t' | b'\\n' | b'\\r') { self.pos += 1; } }
    pub fn parse(&mut self) -> V {
        self.ws();
        let c = self.src[self.pos];
        match c {
            b'{' => self.obj(),
            b'[' => self.arr(),
            b'"' => V::Str(self.string()),
            b't' | b'f' => self.boolv(),
            b'n' => { self.pos += 4; V::Null }
            _ => self.num(),
        }
    }
    fn obj(&mut self) -> V {
        self.pos += 1;
        let mut out: Vec<(String, V)> = Vec::new();
        self.ws();
        if self.src[self.pos] == b'}' { self.pos += 1; return V::Obj(out); }
        loop {
            self.ws();
            let k = self.string();
            self.ws(); self.pos += 1;
            let v = self.parse();
            out.push((k, v));
            self.ws();
            if self.src[self.pos] == b',' { self.pos += 1; }
            else { self.pos += 1; break; }
        }
        V::Obj(out)
    }
    fn arr(&mut self) -> V {
        self.pos += 1;
        let mut out: Vec<V> = Vec::new();
        self.ws();
        if self.src[self.pos] == b']' { self.pos += 1; return V::Arr(out); }
        loop {
            out.push(self.parse());
            self.ws();
            if self.src[self.pos] == b',' { self.pos += 1; }
            else { self.pos += 1; break; }
        }
        V::Arr(out)
    }
    fn string(&mut self) -> String {
        self.pos += 1;
        let mut s = String::new();
        while self.src[self.pos] != b'"' {
            let c = self.src[self.pos];
            if c == b'\\\\' {
                self.pos += 1;
                let e = self.src[self.pos];
                match e {
                    b'"' => s.push('"'),
                    b'\\\\' => s.push('\\\\'),
                    b'/' => s.push('/'),
                    b'b' => s.push('\\u{8}'),
                    b'f' => s.push('\\u{C}'),
                    b'n' => s.push('\\n'),
                    b'r' => s.push('\\r'),
                    b't' => s.push('\\t'),
                    b'u' => {
                        let hex = std::str::from_utf8(&self.src[self.pos + 1..self.pos + 5]).unwrap_or("0000");
                        self.pos += 4;
                        let code = u32::from_str_radix(hex, 16).unwrap_or(0);
                        if let Some(c) = char::from_u32(code) { s.push(c); }
                    }
                    other => s.push(other as char),
                }
                self.pos += 1;
            } else {
                s.push(c as char);
                self.pos += 1;
            }
        }
        self.pos += 1;
        s
    }
    fn boolv(&mut self) -> V {
        if self.src[self.pos] == b't' { self.pos += 4; V::Bool(true) }
        else { self.pos += 5; V::Bool(false) }
    }
    fn num(&mut self) -> V {
        let start = self.pos;
        if self.src[self.pos] == b'-' { self.pos += 1; }
        while self.pos < self.src.len() {
            let c = self.src[self.pos];
            if c.is_ascii_digit() || c == b'.' || c == b'e' || c == b'E' || c == b'+' || c == b'-' { self.pos += 1; }
            else { break; }
        }
        let s = std::str::from_utf8(&self.src[start..self.pos]).unwrap_or("0");
        V::Num(s.parse::<f64>().unwrap_or(0.0))
    }
}

pub fn esc(s: &str) -> String {
    let mut out = String::from("\\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\\\\""),
            '\\\\' => out.push_str("\\\\\\\\"),
            '\\n' => out.push_str("\\\\n"),
            '\\r' => out.push_str("\\\\r"),
            '\\t' => out.push_str("\\\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

pub fn canon(v: &V) -> String {
    match v {
        V::Null => "null".to_string(),
        V::Bool(b) => if *b { "true".to_string() } else { "false".to_string() },
        V::Num(n) => {
            if (n.fract() == 0.0) && n.is_finite() { format!("{}", *n as i64) }
            else { format!("{}", n) }
        }
        V::Str(s) => esc(s),
        V::Arr(a) => {
            let mut o = String::from("[");
            for (i, e) in a.iter().enumerate() {
                if i > 0 { o.push(','); }
                o.push_str(&canon(e));
            }
            o.push(']');
            o
        }
        V::Obj(m) => {
            let mut keys: Vec<&(String, V)> = m.iter().collect();
            keys.sort_by(|a, b| a.0.cmp(&b.0));
            let mut o = String::from("{");
            for (i, kv) in keys.iter().enumerate() {
                if i > 0 { o.push(','); }
                o.push_str(&esc(&kv.0));
                o.push(':');
                o.push_str(&canon(&kv.1));
            }
            o.push('}');
            o
        }
    }
}

fn canon_str(s: &str) -> String {
    let mut p = P { src: s.as_bytes(), pos: 0 };
    canon(&p.parse())
}

fn find_str<'a>(obj: &'a V, key: &str) -> Option<&'a V> {
    if let V::Obj(m) = obj { for (k, v) in m { if k == key { return Some(v); } } }
    None
}

pub fn run(entry: fn(&str) -> String, raw: &str) {
    let mut p = P { src: raw.as_bytes(), pos: 0 };
    let cases = p.parse();
    let cases_arr = if let V::Arr(a) = &cases { a.clone() } else {
        println!("{{\\"kind\\":\\"import_error\\",\\"stderr\\":\\"cases is not an array\\"}}");
        return;
    };
    let mut out = String::from("{\\"kind\\":\\"results\\",\\"results\\":[");
    for (i, c) in cases_arr.iter().enumerate() {
        let id = match find_str(c, "id") { Some(V::Str(s)) => s.clone(), _ => String::new() };
        let args_json = match find_str(c, "args") { Some(v) => canon(v), None => "null".to_string() };
        let expected_json = match find_str(c, "expected") { Some(v) => canon(v), None => "null".to_string() };

        let t0 = Instant::now();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            entry(&args_json)
        }));
        let dt = t0.elapsed().as_millis();

        let (passed, stderr_msg) = match result {
            Ok(got_json) => {
                let g = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| canon_str(&got_json)));
                match g {
                    Ok(g_canon) => {
                        let ok = g_canon == expected_json;
                        if ok { (true, String::new()) }
                        else { (false, format!("expected {}, got {}", expected_json, g_canon)) }
                    }
                    Err(_) => (false, format!("harness could not parse the result as JSON: {}", got_json)),
                }
            }
            Err(e) => {
                let msg = if let Some(s) = e.downcast_ref::<&str>() { (*s).to_string() }
                    else if let Some(s) = e.downcast_ref::<String>() { s.clone() }
                    else { "unknown panic".to_string() };
                (false, format!("panic: {}", msg))
            }
        };

        if i > 0 { out.push(','); }
        out.push('{');
        out.push_str("\\"id\\":"); out.push_str(&esc(&id)); out.push(',');
        out.push_str("\\"passed\\":"); out.push_str(if passed { "true" } else { "false" }); out.push(',');
        out.push_str("\\"durationMs\\":"); out.push_str(&format!("{}", dt)); out.push(',');
        out.push_str("\\"stderr\\":"); out.push_str(&esc(&stderr_msg));
        out.push('}');
    }
    out.push_str("]}");
    println!("{}", out);
}
`;

// Per-attempt main.rs is a tiny driver that pulls in solution.rs as a
// module and forwards the user's `<entry>` to the precompiled
// `ps_harness::run`. Only this file (plus solution.rs) is rustc'd per
// attempt — `libps_harness.rlib` stays cached.
function mainRs(entry: string): string {
  return `extern crate ps_harness;

#[path = "solution.rs"]
mod solution;

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    let raw = if argv.len() > 1 { argv[1].clone() } else { String::new() };
    ps_harness::run(solution::${entry} as fn(&str) -> String, &raw);
}
`;
}

const HARNESS_VERSION = crypto
  .createHash("sha256")
  .update("v1\n")
  .update(HARNESS_LIB)
  .digest("hex")
  .slice(0, 16);

function ensureCacheDir(timeoutMs: number): { dir: string; rlib: string } | { error: SandboxResult } {
  ensureConfigDir();
  const dir = path.join(SANDBOX_CACHE_DIR, "rust", HARNESS_VERSION);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const harnessSrc = path.join(dir, "ps_harness.rs");
  const rlib = path.join(dir, "libps_harness.rlib");
  const stamp = path.join(dir, "harness.version");

  if (fs.existsSync(rlib) && fs.existsSync(stamp)) {
    return { dir, rlib };
  }

  let result: { outcome: "timeout" | "error"; timedOut: boolean; durationMs: number; stderr: string } | null = null;
  try {
    result = withSandboxLock(path.join(dir, ".harness.lock"), timeoutMs, () => {
      if (fs.existsSync(rlib) && fs.existsSync(stamp)) return null;
      fs.writeFileSync(harnessSrc, HARNESS_LIB, { mode: 0o600 });
      const t0 = Date.now();
      const compile = spawnSync(
        "rustc",
        [
          "--edition=2021",
          "-A", "warnings",
          "--crate-type=rlib",
          "--crate-name=ps_harness",
          "ps_harness.rs",
          "-o", rlib,
        ],
        {
          cwd: dir,
          timeout: timeoutMs,
          encoding: "utf-8",
          env: {
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? "",
          },
          maxBuffer: 8 * 1024 * 1024,
        },
      );
      if (compile.status !== 0) {
        const stderr = (compile.stderr ?? "") + (compile.stdout ?? "");
        const timedOut =
          compile.signal === "SIGTERM" ||
          (compile.error && (compile.error as { code?: string }).code === "ETIMEDOUT") ||
          false;
        return {
          outcome: timedOut ? ("timeout" as const) : ("error" as const),
          timedOut,
          durationMs: Date.now() - t0,
          stderr,
        };
      }
      fs.writeFileSync(stamp, HARNESS_VERSION, { mode: 0o600 });
      return null;
    });
  } catch (err) {
    if (err instanceof SandboxLockTimeoutError) {
      result = {
        outcome: "timeout",
        timedOut: true,
        durationMs: timeoutMs,
        stderr: err.message,
      };
    } else {
      throw err;
    }
  }

  if (result) {
    return {
      error: {
        outcome: result.outcome,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        runtimeVersion: rustRuntimeVersion(),
        cases: [],
        rawStderr: truncate(result.stderr),
      },
    };
  }
  return { dir, rlib };
}

export function runRustSandbox(
  code: string,
  entry: string,
  cases: SandboxCase[],
  timeoutMs: number,
): SandboxResult {
  const safeEntry = entry.replace(/[^A-Za-z0-9_]/g, "");
  const t0 = Date.now();
  const cache = ensureCacheDir(timeoutMs);
  if ("error" in cache) {
    const err = cache.error;
    return {
      ...err,
      cases: cases.map((c) => ({
        id: c.id,
        passed: false,
        stderrExcerpt: err.timedOut
          ? "rustc timed out preparing the sandbox harness rlib"
          : truncate(err.rawStderr, 400),
      })),
    };
  }
  const { dir, rlib } = cache;
  const lockStart = Date.now();

  try {
    return withSandboxLock(path.join(dir, ".lock"), timeoutMs, () => {
      fs.writeFileSync(path.join(dir, "solution.rs"), code, { mode: 0o600 });
      fs.writeFileSync(path.join(dir, "main.rs"), mainRs(safeEntry), { mode: 0o600 });
      const binPath = path.join(dir, "sandbox");

      const compile = spawnSync(
        "rustc",
        [
          "--edition=2021",
          "-A", "warnings",
          "--extern", `ps_harness=${rlib}`,
          "main.rs",
          "-o", binPath,
        ],
        {
          cwd: dir,
          timeout: timeoutMs,
          encoding: "utf-8",
          env: {
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? "",
          },
          maxBuffer: 8 * 1024 * 1024,
        },
      );
      if (compile.status !== 0) {
        const stderr = (compile.stderr ?? "") + (compile.stdout ?? "");
        const compileTimedOut =
          compile.signal === "SIGTERM" ||
          (compile.error && (compile.error as { code?: string }).code === "ETIMEDOUT") ||
          false;
        return {
          outcome: compileTimedOut ? "timeout" : "error",
          timedOut: compileTimedOut,
          durationMs: Date.now() - t0,
          runtimeVersion: rustRuntimeVersion(),
          cases: cases.map((c) => ({
            id: c.id,
            passed: false,
            stderrExcerpt: compileTimedOut
              ? "rustc timed out before producing the sandbox binary"
              : truncate(stderr, 400),
          })),
          rawStderr: truncate(stderr),
        };
      }

      const remaining = Math.max(1000, timeoutMs - (Date.now() - t0));
      const proc = spawnSync(binPath, [JSON.stringify(cases)], {
        cwd: dir,
        timeout: remaining,
        encoding: "utf-8",
        env: { PATH: process.env.PATH ?? "" },
        maxBuffer: 8 * 1024 * 1024,
      });
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
          runtimeVersion: rustRuntimeVersion(),
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
          runtimeVersion: rustRuntimeVersion(),
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
          runtimeVersion: rustRuntimeVersion(),
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
          runtimeVersion: rustRuntimeVersion(),
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
          runtimeVersion: rustRuntimeVersion(),
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
        runtimeVersion: rustRuntimeVersion(),
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
        runtimeVersion: rustRuntimeVersion(),
        cases: cases.map((c) => ({
          id: c.id,
          passed: false,
          stderrExcerpt: "Timed out waiting for the Rust sandbox build cache lock",
        })),
        rawStderr: err.message,
      };
    }
    throw err;
  }
}

export const __rustCacheInternals = {
  HARNESS_VERSION,
  cacheDir: () => path.join(SANDBOX_CACHE_DIR, "rust", HARNESS_VERSION),
};
