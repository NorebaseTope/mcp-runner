// Task #1200 — C# sandbox grader. The user's solution.cs is expected to
// define `public class Solution` with a method whose name matches
// `entry` (case-insensitive). The grader spawns `dotnet run` against a
// throwaway project + a Program.cs harness that uses System.Text.Json
// + reflection to deserialize each case's `args` into the method's
// declared parameter types, invoke the method, and JSON-normalize both
// the returned value and the expected value for comparison.
//
// Task #1211 — heavy first-run cost (`dotnet run` does an implicit
// restore + build, 5–15s) is amortized by reusing a long-lived per-
// harness-version cache directory at
// `~/.prepsavant/sandbox-cache/csharp/<harnessHash>/`. The csproj +
// Program.cs are written once and `entry` is now passed to the harness
// as a CLI argument (rather than baked into Program.cs via %ENTRY%
// substitution) so the build cache survives across attempts even when
// different questions are graded back-to-back. Concurrent attempts in
// the same cache dir are serialized via a file lock so MSBuild doesn't
// trip over a half-written Solution.cs.
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

export function csharpRuntimeVersion(): string {
  const r = spawnSync("dotnet", ["--version"], { encoding: "utf-8" });
  if (r.status === 0) {
    return ("dotnet " + (r.stdout || r.stderr || "").trim()).trim();
  }
  return "unavailable";
}

const CSPROJ = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>disable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <RootNamespace>PrepSavantSandbox</RootNamespace>
    <AssemblyName>sandbox</AssemblyName>
  </PropertyGroup>
</Project>
`;

// Task #1211 — entry name comes in as args[0] now (was %ENTRY% baked
// into the source), and the cases JSON shifts to args[1]. Keeping
// Program.cs fully static lets the build cache survive across
// different questions / entry-method names.
const HARNESS = `using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;

class HarnessProgram {
    static string Normalize(JsonNode? n) {
        if (n == null) return "null";
        if (n is JsonObject obj) {
            var keys = obj.Select(kv => kv.Key).OrderBy(k => k, StringComparer.Ordinal).ToList();
            var sb = new System.Text.StringBuilder();
            sb.Append('{');
            for (int i = 0; i < keys.Count; i++) {
                if (i > 0) sb.Append(',');
                sb.Append(JsonSerializer.Serialize(keys[i]));
                sb.Append(':');
                sb.Append(Normalize(obj[keys[i]]));
            }
            sb.Append('}');
            return sb.ToString();
        }
        if (n is JsonArray arr) {
            var sb = new System.Text.StringBuilder();
            sb.Append('[');
            for (int i = 0; i < arr.Count; i++) {
                if (i > 0) sb.Append(',');
                sb.Append(Normalize(arr[i]));
            }
            sb.Append(']');
            return sb.ToString();
        }
        return n.ToJsonString();
    }
    static string NormalizeRaw(string rawJson) {
        var node = JsonNode.Parse(rawJson);
        return Normalize(node);
    }
    static void Emit(object o) {
        Console.WriteLine(JsonSerializer.Serialize(o));
    }
    static int Main(string[] args) {
        var entry = args[0];
        Type? solType = Type.GetType("Solution") ?? AppDomain.CurrentDomain
            .GetAssemblies()
            .SelectMany(a => a.GetTypes())
            .FirstOrDefault(t => t.Name == "Solution");
        if (solType == null) {
            Emit(new { kind = "import_error", stderr = "class Solution not found in solution.cs" });
            return 0;
        }
        var method = solType.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static)
            .FirstOrDefault(m => string.Equals(m.Name, entry, StringComparison.OrdinalIgnoreCase));
        if (method == null) {
            Emit(new { kind = "import_error", stderr = "Entry method '" + entry + "' not found on Solution" });
            return 0;
        }
        object? instance = method.IsStatic ? null : Activator.CreateInstance(solType);
        var casesNode = JsonNode.Parse(args[1])!.AsArray();
        var paramInfos = method.GetParameters();
        var results = new List<object>();
        foreach (var c in casesNode) {
            var co = c!.AsObject();
            string id = (string)co["id"]!;
            var argsArr = co["args"]!.AsArray();
            var t0 = DateTime.UtcNow;
            try {
                object?[] paramVals = new object?[paramInfos.Length];
                for (int i = 0; i < paramInfos.Length; i++) {
                    var raw = argsArr[i]?.ToJsonString() ?? "null";
                    paramVals[i] = JsonSerializer.Deserialize(raw, paramInfos[i].ParameterType);
                }
                var got = method.Invoke(instance, paramVals);
                string gotJson = got == null ? "null" : JsonSerializer.Serialize(got);
                string expJson = co["expected"]?.ToJsonString() ?? "null";
                bool ok = NormalizeRaw(gotJson) == NormalizeRaw(expJson);
                results.Add(new {
                    id,
                    passed = ok,
                    durationMs = (int)(DateTime.UtcNow - t0).TotalMilliseconds,
                    stderr = ok ? "" : ("expected " + expJson + ", got " + gotJson),
                });
            } catch (Exception ex) {
                var inner = ex.InnerException ?? ex;
                results.Add(new {
                    id,
                    passed = false,
                    durationMs = (int)(DateTime.UtcNow - t0).TotalMilliseconds,
                    stderr = inner.GetType().Name + ": " + inner.Message + "\\n" + (inner.StackTrace ?? ""),
                });
            }
        }
        Emit(new { kind = "results", results });
        return 0;
    }
}
`;

// Hash the harness + csproj so a template bump invalidates the cache
// (we don't want a stale Program.cs running against new sandbox
// semantics — see Task #1211 "Done looks like" §3).
const HARNESS_VERSION = crypto
  .createHash("sha256")
  .update("v1\n")
  .update(CSPROJ)
  .update("\n---\n")
  .update(HARNESS)
  .digest("hex")
  .slice(0, 16);

function ensureCacheDir(): string {
  ensureConfigDir();
  const dir = path.join(SANDBOX_CACHE_DIR, "csharp", HARNESS_VERSION);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Write the project files once. We only rewrite when the on-disk
  // contents drift (shouldn't happen given the version-hashed dir, but
  // covers a partial write from a previous crash).
  const csprojPath = path.join(dir, "sandbox.csproj");
  const programPath = path.join(dir, "Program.cs");
  if (!fs.existsSync(csprojPath) || fs.readFileSync(csprojPath, "utf-8") !== CSPROJ) {
    fs.writeFileSync(csprojPath, CSPROJ, { mode: 0o600 });
  }
  if (!fs.existsSync(programPath) || fs.readFileSync(programPath, "utf-8") !== HARNESS) {
    fs.writeFileSync(programPath, HARNESS, { mode: 0o600 });
  }
  return dir;
}

export function runCsharpSandbox(
  code: string,
  entry: string,
  cases: SandboxCase[],
  timeoutMs: number,
): SandboxResult {
  const dir = ensureCacheDir();
  const safeEntry = entry.replace(/[^A-Za-z0-9_]/g, "");
  const lockStart = Date.now();

  try {
    return withSandboxLock(path.join(dir, ".lock"), timeoutMs, () => {
    fs.writeFileSync(path.join(dir, "Solution.cs"), code, { mode: 0o600 });

    const t0 = Date.now();
    const proc = spawnSync(
      "dotnet",
      ["run", "--project", dir, "--", safeEntry, JSON.stringify(cases)],
      {
        cwd: dir,
        timeout: timeoutMs,
        encoding: "utf-8",
        env: {
          PATH: process.env.PATH ?? "",
          DOTNET_CLI_TELEMETRY_OPTOUT: "1",
          DOTNET_NOLOGO: "1",
          HOME: process.env.HOME ?? "",
        },
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    const durationMs = Date.now() - t0;
    const stderr = proc.stderr ?? "";

    // Note: we deliberately do NOT delete `dir` between attempts —
    // keeping bin/ and obj/ around is what makes the second invocation
    // sub-second. `Solution.cs` is overwritten on every attempt.

    if (
      proc.signal === "SIGTERM" ||
      (proc.error && (proc.error as { code?: string }).code === "ETIMEDOUT")
    ) {
      return {
        outcome: "timeout",
        timedOut: true,
        durationMs,
        runtimeVersion: csharpRuntimeVersion(),
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
        runtimeVersion: csharpRuntimeVersion(),
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
        runtimeVersion: csharpRuntimeVersion(),
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
        runtimeVersion: csharpRuntimeVersion(),
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
        runtimeVersion: csharpRuntimeVersion(),
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
      runtimeVersion: csharpRuntimeVersion(),
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
      // Cross-process contention exceeded the per-attempt budget — surface
      // a structured timeout result rather than letting the exception
      // bubble out of the grader.
      return {
        outcome: "timeout",
        timedOut: true,
        durationMs: Date.now() - lockStart,
        runtimeVersion: csharpRuntimeVersion(),
        cases: cases.map((c) => ({
          id: c.id,
          passed: false,
          stderrExcerpt: "Timed out waiting for the C# sandbox build cache lock",
        })),
        rawStderr: err.message,
      };
    }
    throw err;
  }
}

export const __csharpCacheInternals = {
  HARNESS_VERSION,
  cacheDir: () => path.join(SANDBOX_CACHE_DIR, "csharp", HARNESS_VERSION),
};
