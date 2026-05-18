// Task #1213 — C++ sandbox grader. Mirrors the csharp.ts / kotlin.ts
// shape (compile → run → JSON-on-stdout) but, because C++ has no
// runtime reflection, the contract with the user's solution.cpp is
// simpler: the user must define a free function with the signature
//
//     std::string <entry>(const std::string& argsJson);
//
// where `argsJson` is the JSON-serialized `args` array for one case
// and the returned string must be JSON-encoded. The harness compiles
// solution.cpp + harness.cpp together with `g++` (falling back to
// `clang++` if `g++` is unavailable), then runs the binary with the
// full cases array on argv. Per-case dispatch + JSON normalization
// happens inside the C++ harness itself, mirroring the kotlin/php
// pattern of "one binary call grades the whole batch".
//
// We deliberately keep the harness JSON parser minimal — we never
// re-encode user-supplied numeric precision or escape exotic
// characters, just enough to compare two JSON values structurally
// (sorted keys, no whitespace).
//
// Task #1231 — same warm-cache speedup as csharp.ts / kotlin.ts. The
// heavy harness.cpp (with iostream / sstream / chrono / map etc.) is
// precompiled to `harness.o` exactly once per harness-template version
// under `~/.prepsavant/sandbox-cache/cpp/<harnessHash>/`. Per attempt
// we only compile the much smaller `dispatch.cpp` + the user's
// `solution.cpp` and link against the precompiled object. The
// harness no longer bakes the entry name in via %ENTRY%; instead it
// calls `extern std::string prepsavant_user_entry(const std::string&)`
// which the per-attempt dispatch.cpp shim forwards to the user's
// `<entry>` function. Concurrent attempts share the cache dir and
// are serialized via a file lock so two grades can't trample each
// other's `solution.cpp` / `dispatch.cpp` / `sandbox` binary.
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

function cppCompiler(): string {
  for (const c of ["g++", "clang++"]) {
    const r = spawnSync(c, ["--version"], { encoding: "utf-8" });
    if (r.status === 0) return c;
  }
  return "g++";
}

export function cppRuntimeVersion(): string {
  const cc = cppCompiler();
  const r = spawnSync(cc, ["--version"], { encoding: "utf-8" });
  if (r.status === 0) {
    return ((r.stdout || r.stderr || "").trim().split("\n")[0] || cc);
  }
  return "unavailable";
}

// The harness embeds:
//   * a declaration `extern std::string prepsavant_user_entry(...)`
//     that a per-attempt dispatch.cpp shim defines (forwarding to the
//     user's `<entry>` function). Keeping the harness entry-agnostic
//     is what lets the precompiled `harness.o` be reused across
//     questions without recompiling.
//   * a tiny JSON tokenizer (good enough for arrays / objects / numbers
//     / strings / bools / null) used to pull the per-case shape out of
//     the cases array and to canonicalize result + expected JSON for
//     equality comparison
//   * a `main()` that walks the cases array, calls
//     `prepsavant_user_entry` once per case, captures any std::exception
//     thrown, and emits the same `{"kind":"results","results":[...]}`
//     shape the workshop pipeline expects.
const HARNESS = `#include <chrono>
#include <cstring>
#include <exception>
#include <iostream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

extern std::string prepsavant_user_entry(const std::string& argsJson);

namespace ps {
struct V {
    enum T { N_NULL, N_BOOL, N_NUM, N_STR, N_ARR, N_OBJ } t = N_NULL;
    bool b = false;
    double num = 0;
    std::string s;
    std::vector<V> arr;
    std::vector<std::pair<std::string, V>> obj;
};

struct P {
    const std::string& src;
    size_t pos = 0;
    P(const std::string& s) : src(s) {}
    void ws() { while (pos < src.size() && (src[pos] == ' ' || src[pos] == '\\t' || src[pos] == '\\n' || src[pos] == '\\r')) pos++; }
    V parse() {
        ws();
        char c = src[pos];
        if (c == '{') return obj();
        if (c == '[') return arr();
        if (c == '"') return str();
        if (c == 't' || c == 'f') return bl();
        if (c == 'n') { pos += 4; return V{}; }
        return num();
    }
    V obj() {
        pos++; V v; v.t = V::N_OBJ;
        ws();
        if (src[pos] == '}') { pos++; return v; }
        while (true) {
            ws();
            V k = str();
            ws(); pos++; // ':'
            V child = parse();
            v.obj.push_back({k.s, child});
            ws();
            if (src[pos] == ',') pos++;
            else { pos++; break; }
        }
        return v;
    }
    V arr() {
        pos++; V v; v.t = V::N_ARR;
        ws();
        if (src[pos] == ']') { pos++; return v; }
        while (true) {
            v.arr.push_back(parse());
            ws();
            if (src[pos] == ',') pos++;
            else { pos++; break; }
        }
        return v;
    }
    V str() {
        pos++;
        V v; v.t = V::N_STR;
        std::string out;
        while (src[pos] != '"') {
            char c = src[pos];
            if (c == '\\\\') {
                pos++;
                char e = src[pos];
                switch (e) {
                    case '"': out += '"'; break;
                    case '\\\\': out += '\\\\'; break;
                    case '/': out += '/'; break;
                    case 'b': out += '\\b'; break;
                    case 'f': out += '\\f'; break;
                    case 'n': out += '\\n'; break;
                    case 'r': out += '\\r'; break;
                    case 't': out += '\\t'; break;
                    case 'u': {
                        std::string hex = src.substr(pos + 1, 4);
                        pos += 4;
                        out += (char) std::stoi(hex, nullptr, 16);
                        break;
                    }
                    default: out += e;
                }
                pos++;
            } else {
                out += c; pos++;
            }
        }
        pos++;
        v.s = out;
        return v;
    }
    V bl() {
        V v; v.t = V::N_BOOL;
        if (src[pos] == 't') { v.b = true; pos += 4; }
        else { v.b = false; pos += 5; }
        return v;
    }
    V num() {
        size_t start = pos;
        if (src[pos] == '-') pos++;
        while (pos < src.size()) {
            char c = src[pos];
            if ((c >= '0' && c <= '9') || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') pos++;
            else break;
        }
        V v; v.t = V::N_NUM;
        v.num = std::stod(src.substr(start, pos - start));
        return v;
    }
};

std::string esc(const std::string& s) {
    std::string out = "\\"";
    for (char c : s) {
        switch (c) {
            case '"': out += "\\\\\\""; break;
            case '\\\\': out += "\\\\\\\\"; break;
            case '\\n': out += "\\\\n"; break;
            case '\\r': out += "\\\\r"; break;
            case '\\t': out += "\\\\t"; break;
            default:
                if ((unsigned char) c < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\\\u%04x", (unsigned char) c);
                    out += buf;
                } else {
                    out += c;
                }
        }
    }
    out += '"';
    return out;
}

std::string canon(const V& v) {
    std::ostringstream o;
    switch (v.t) {
        case V::N_NULL: o << "null"; break;
        case V::N_BOOL: o << (v.b ? "true" : "false"); break;
        case V::N_NUM: {
            double d = v.num;
            if (d == (long long) d) o << (long long) d;
            else o << d;
            break;
        }
        case V::N_STR: o << esc(v.s); break;
        case V::N_ARR: {
            o << '[';
            for (size_t i = 0; i < v.arr.size(); i++) { if (i) o << ','; o << canon(v.arr[i]); }
            o << ']';
            break;
        }
        case V::N_OBJ: {
            std::map<std::string, std::string> sorted;
            for (auto& kv : v.obj) sorted[kv.first] = canon(kv.second);
            o << '{';
            bool first = true;
            for (auto& kv : sorted) {
                if (!first) o << ',';
                o << esc(kv.first) << ':' << kv.second;
                first = false;
            }
            o << '}';
            break;
        }
    }
    return o.str();
}

std::string canonStr(const std::string& s) {
    P p(s);
    return canon(p.parse());
}

std::string toJson(const V& v) { return canon(v); }

std::string sliceJson(const V& v) { return canon(v); }
} // namespace ps

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cout << "{\\"kind\\":\\"import_error\\",\\"stderr\\":\\"missing cases argument\\"}" << std::endl;
        return 0;
    }
    std::string raw(argv[1]);
    ps::P p(raw);
    ps::V cases = p.parse();
    if (cases.t != ps::V::N_ARR) {
        std::cout << "{\\"kind\\":\\"import_error\\",\\"stderr\\":\\"cases is not an array\\"}" << std::endl;
        return 0;
    }
    std::string out = "{\\"kind\\":\\"results\\",\\"results\\":[";
    for (size_t i = 0; i < cases.arr.size(); i++) {
        const ps::V& c = cases.arr[i];
        std::string id, argsJson, expectedJson;
        for (auto& kv : c.obj) {
            if (kv.first == "id") id = kv.second.s;
            else if (kv.first == "args") argsJson = ps::canon(kv.second);
            else if (kv.first == "expected") expectedJson = ps::canon(kv.second);
        }
        auto t0 = std::chrono::steady_clock::now();
        std::string gotJson;
        std::string err;
        try {
            gotJson = prepsavant_user_entry(argsJson);
        } catch (const std::exception& e) {
            err = std::string("std::exception: ") + e.what();
        } catch (...) {
            err = "unknown exception";
        }
        auto dt = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - t0).count();
        bool passed = false;
        std::string stderrMsg;
        if (!err.empty()) {
            stderrMsg = err;
        } else {
            try {
                std::string g = ps::canonStr(gotJson);
                std::string e = expectedJson;
                passed = g == e;
                if (!passed) stderrMsg = "expected " + e + ", got " + g;
            } catch (...) {
                stderrMsg = "harness could not parse the result as JSON: " + gotJson;
            }
        }
        if (i) out += ',';
        out += "{";
        out += "\\"id\\":" + ps::esc(id) + ",";
        out += std::string("\\"passed\\":") + (passed ? "true" : "false") + ",";
        out += "\\"durationMs\\":" + std::to_string(dt) + ",";
        out += "\\"stderr\\":" + ps::esc(stderrMsg);
        out += "}";
    }
    out += "]}";
    std::cout << out << std::endl;
    return 0;
}
`;

// Bumping the harness body invalidates every cache dir (different hash
// → different folder), so we never link a stale `harness.o` against
// new sandbox semantics.
const HARNESS_VERSION = crypto
  .createHash("sha256")
  .update("v1\n")
  .update(HARNESS)
  .digest("hex")
  .slice(0, 16);

function ensureCacheDir(timeoutMs: number): { dir: string; harnessObj: string; cc: string } | { error: SandboxResult } {
  ensureConfigDir();
  const dir = path.join(SANDBOX_CACHE_DIR, "cpp", HARNESS_VERSION);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const harnessSrc = path.join(dir, "harness.cpp");
  const harnessObj = path.join(dir, "harness.o");
  const stamp = path.join(dir, "harness.version");
  const cc = cppCompiler();

  if (fs.existsSync(harnessObj) && fs.existsSync(stamp)) {
    return { dir, harnessObj, cc };
  }

  let result: { outcome: "timeout" | "error"; timedOut: boolean; durationMs: number; stderr: string } | null = null;
  try {
    result = withSandboxLock(path.join(dir, ".harness.lock"), timeoutMs, () => {
      if (fs.existsSync(harnessObj) && fs.existsSync(stamp)) return null;
      fs.writeFileSync(harnessSrc, HARNESS, { mode: 0o600 });
      const t0 = Date.now();
      const compile = spawnSync(
        cc,
        ["-std=c++17", "-O0", "-c", "harness.cpp", "-o", harnessObj],
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
        runtimeVersion: cppRuntimeVersion(),
        cases: [],
        rawStderr: truncate(result.stderr),
      },
    };
  }
  return { dir, harnessObj, cc };
}

export function runCppSandbox(
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
          ? "g++ timed out preparing the sandbox harness"
          : truncate(err.rawStderr, 400),
      })),
    };
  }
  const { dir, harnessObj, cc } = cache;
  const lockStart = Date.now();

  // Tiny per-attempt shim: forwards the harness's entry-agnostic
  // `prepsavant_user_entry` to whatever name the user gave their
  // function. This is what lets the precompiled `harness.o` be reused
  // across questions / entry-method names without ever recompiling.
  const dispatch = `#include <string>
extern std::string ${safeEntry}(const std::string&);
std::string prepsavant_user_entry(const std::string& s) { return ${safeEntry}(s); }
`;

  try {
    return withSandboxLock(path.join(dir, ".lock"), timeoutMs, () => {
      fs.writeFileSync(path.join(dir, "solution.cpp"), code, { mode: 0o600 });
      fs.writeFileSync(path.join(dir, "dispatch.cpp"), dispatch, { mode: 0o600 });
      const binPath = path.join(dir, "sandbox");

      const compile = spawnSync(
        cc,
        ["-std=c++17", "-O0", "dispatch.cpp", "solution.cpp", harnessObj, "-o", binPath],
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
          runtimeVersion: cppRuntimeVersion(),
          cases: cases.map((c) => ({
            id: c.id,
            passed: false,
            stderrExcerpt: compileTimedOut
              ? `${cc} timed out before producing the sandbox binary`
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
          runtimeVersion: cppRuntimeVersion(),
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
          runtimeVersion: cppRuntimeVersion(),
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
          runtimeVersion: cppRuntimeVersion(),
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
          runtimeVersion: cppRuntimeVersion(),
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
          runtimeVersion: cppRuntimeVersion(),
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
        runtimeVersion: cppRuntimeVersion(),
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
        runtimeVersion: cppRuntimeVersion(),
        cases: cases.map((c) => ({
          id: c.id,
          passed: false,
          stderrExcerpt: "Timed out waiting for the C++ sandbox build cache lock",
        })),
        rawStderr: err.message,
      };
    }
    throw err;
  }
}

export const __cppCacheInternals = {
  HARNESS_VERSION,
  cacheDir: () => path.join(SANDBOX_CACHE_DIR, "cpp", HARNESS_VERSION),
};
