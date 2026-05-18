// Task #1200 — Kotlin sandbox grader. The user's solution.kt is expected
// to define a top-level function whose name matches `entry` (or a member
// of `class Solution` with that name). The grader uses a tiny Harness.kt
// + a hand-rolled minimal JSON codec so it doesn't pull in any third-
// party kotlinx.serialization dependencies (which would balloon compile
// time).
//
// Task #1211 — first-compile cost (kotlinc -include-runtime cold-start
// is 15–25s on a fresh box) is amortized by:
//   1. Precompiling Harness.kt + the kotlin-stdlib into a long-lived
//      `harness.jar` (with `-include-runtime`) under
//      `~/.prepsavant/sandbox-cache/kotlin/<harnessHash>/`. This is the
//      slow step and runs once per harness-template version.
//   2. On every attempt, only solution.kt is compiled — *without*
//      `-include-runtime` and *with* `-classpath harness.jar` — into a
//      `solution-classes/` directory. Skipping the runtime bundling is
//      what cuts the per-attempt kotlinc work from ~20s down to ~3-5s.
//   3. Running `java -cp harness.jar:solution-classes HarnessKt <entry>
//      <cases>`; the harness reads `entry` from argv now (it used to be
//      baked into Harness.kt via %ENTRY% substitution) so the prebuilt
//      jar can be reused across questions and entry-method names.
// Concurrent attempts in the same cache dir are serialized via a file
// lock so kotlinc doesn't race on solution.kt and solution-classes/.
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

export function kotlinRuntimeVersion(): string {
  const r = spawnSync("kotlinc", ["-version"], { encoding: "utf-8" });
  if (r.status === 0) {
    return ((r.stdout || r.stderr || "").trim().split("\n")[0] || "unknown");
  }
  return "unavailable";
}

// Harness: hand-rolled tiny JSON parser + serializer + reflection-based
// dispatch. Top-level Kotlin functions in solution.kt are compiled into
// a class named `SolutionKt` (Kotlin's default file-class naming).
//
// Task #1211 — `entry` now comes in as args[0] (was %ENTRY% baked into
// the source) and the cases JSON shifts to args[1]. Keeping Harness.kt
// fully static lets the prebuilt harness.jar be reused across questions.
const HARNESS = `import java.lang.reflect.Method

private var _pos = 0
private lateinit var _src: String

private fun skipWs() { while (_pos < _src.length && _src[_pos].isWhitespace()) _pos++ }
private fun parseValue(): Any? {
    skipWs()
    val ch = _src[_pos]
    return when {
        ch == '{' -> parseObject()
        ch == '[' -> parseArray()
        ch == '"' -> parseString()
        ch == 't' || ch == 'f' -> parseBool()
        ch == 'n' -> { _pos += 4; null }
        else -> parseNumber()
    }
}
private fun parseObject(): LinkedHashMap<String, Any?> {
    _pos++ // {
    val out = LinkedHashMap<String, Any?>()
    skipWs()
    if (_src[_pos] == '}') { _pos++; return out }
    while (true) {
        skipWs()
        val k = parseString()
        skipWs(); _pos++ // :
        val v = parseValue()
        out[k] = v
        skipWs()
        if (_src[_pos] == ',') { _pos++ } else { _pos++; break }
    }
    return out
}
private fun parseArray(): ArrayList<Any?> {
    _pos++ // [
    val out = ArrayList<Any?>()
    skipWs()
    if (_src[_pos] == ']') { _pos++; return out }
    while (true) {
        val v = parseValue()
        out.add(v)
        skipWs()
        if (_src[_pos] == ',') { _pos++ } else { _pos++; break }
    }
    return out
}
private fun parseString(): String {
    _pos++ // opening "
    val sb = StringBuilder()
    while (_src[_pos] != '"') {
        val c = _src[_pos]
        if (c == '\\\\') {
            _pos++
            val esc = _src[_pos]
            sb.append(when (esc) {
                '"' -> '"'; '\\\\' -> '\\\\'; '/' -> '/';
                'b' -> '\\b'; 'f' -> '\\u000C'; 'n' -> '\\n'; 'r' -> '\\r'; 't' -> '\\t';
                'u' -> { val hex = _src.substring(_pos + 1, _pos + 5); _pos += 4; hex.toInt(16).toChar() }
                else -> esc
            })
            _pos++
        } else { sb.append(c); _pos++ }
    }
    _pos++ // closing "
    return sb.toString()
}
private fun parseBool(): Boolean {
    if (_src[_pos] == 't') { _pos += 4; return true }
    _pos += 5; return false
}
private fun parseNumber(): Any {
    val start = _pos
    if (_src[_pos] == '-') _pos++
    while (_pos < _src.length && (_src[_pos].isDigit() || _src[_pos] == '.' || _src[_pos] == 'e' || _src[_pos] == 'E' || _src[_pos] == '+' || _src[_pos] == '-')) _pos++
    val s = _src.substring(start, _pos)
    return if (s.contains('.') || s.contains('e') || s.contains('E')) s.toDouble() else s.toLong()
}
private fun parseJson(s: String): Any? { _src = s; _pos = 0; return parseValue() }
private fun jsonString(s: String): String {
    val sb = StringBuilder("\\"")
    for (c in s) sb.append(when (c) {
        '"' -> "\\\\\\""; '\\\\' -> "\\\\\\\\"; '\\n' -> "\\\\n"; '\\r' -> "\\\\r"; '\\t' -> "\\\\t"
        else -> if (c.code < 0x20) String.format("\\\\u%04x", c.code) else c.toString()
    })
    sb.append('"')
    return sb.toString()
}
private fun toJson(v: Any?): String = when (v) {
    null -> "null"
    is Boolean -> v.toString()
    is Number -> if (v is Double && v == v.toLong().toDouble()) v.toLong().toString() else v.toString()
    is String -> jsonString(v)
    is Map<*, *> -> v.entries.sortedBy { it.key.toString() }.joinToString(",", "{", "}") { jsonString(it.key.toString()) + ":" + toJson(it.value) }
    is Iterable<*> -> v.joinToString(",", "[", "]") { toJson(it) }
    is IntArray -> v.joinToString(",", "[", "]") { it.toString() }
    is LongArray -> v.joinToString(",", "[", "]") { it.toString() }
    is DoubleArray -> v.joinToString(",", "[", "]") { it.toString() }
    is Array<*> -> v.joinToString(",", "[", "]") { toJson(it) }
    else -> jsonString(v.toString())
}
private fun coerce(v: Any?, target: Class<*>): Any? {
    if (v == null) return null
    return when (target) {
        Int::class.javaPrimitiveType, Integer::class.java -> (v as Number).toInt()
        Long::class.javaPrimitiveType, java.lang.Long::class.java -> (v as Number).toLong()
        Double::class.javaPrimitiveType, java.lang.Double::class.java -> (v as Number).toDouble()
        Boolean::class.javaPrimitiveType, java.lang.Boolean::class.java -> v as Boolean
        String::class.java -> v.toString()
        IntArray::class.java -> (v as List<*>).map { (it as Number).toInt() }.toIntArray()
        LongArray::class.java -> (v as List<*>).map { (it as Number).toLong() }.toLongArray()
        DoubleArray::class.java -> (v as List<*>).map { (it as Number).toDouble() }.toDoubleArray()
        else -> if (List::class.java.isAssignableFrom(target)) v as List<*> else v
    }
}

fun main(args: Array<String>) {
    val entry = args[0]
    val candidates = listOf("SolutionKt", "Solution")
    var method: Method? = null
    var instance: Any? = null
    var lastErr: String? = null
    for (cn in candidates) {
        try {
            val cls = Class.forName(cn)
            val m = cls.declaredMethods.firstOrNull { it.name.equals(entry, ignoreCase = true) }
            if (m != null) {
                method = m
                instance = if (java.lang.reflect.Modifier.isStatic(m.modifiers)) null else cls.getDeclaredConstructor().newInstance()
                break
            }
        } catch (e: Throwable) { lastErr = e.message }
    }
    if (method == null) {
        println("{\\"kind\\":\\"import_error\\",\\"stderr\\":" + jsonString("Entry function '\$entry' not found (tried SolutionKt, Solution): \${lastErr ?: ""}") + "}")
        return
    }
    val cases = parseJson(args[1]) as List<*>
    val results = ArrayList<Map<String, Any?>>()
    val pTypes = method.parameterTypes
    for (c in cases) {
        @Suppress("UNCHECKED_CAST")
        val co = c as Map<String, Any?>
        val id = co["id"] as String
        val argsList = (co["args"] as? List<*>) ?: listOf(co["args"])
        val expected = co["expected"]
        val t0 = System.currentTimeMillis()
        try {
            val paramVals = Array(pTypes.size) { i -> coerce(argsList[i], pTypes[i]) }
            val got = method.invoke(instance, *paramVals)
            val ok = toJson(got) == toJson(expected)
            results.add(mapOf(
                "id" to id, "passed" to ok,
                "durationMs" to (System.currentTimeMillis() - t0).toInt(),
                "stderr" to if (ok) "" else "expected \${toJson(expected)}, got \${toJson(got)}"
            ))
        } catch (e: Throwable) {
            val inner = (e as? java.lang.reflect.InvocationTargetException)?.targetException ?: e
            results.add(mapOf(
                "id" to id, "passed" to false,
                "durationMs" to (System.currentTimeMillis() - t0).toInt(),
                "stderr" to (inner.javaClass.simpleName + ": " + (inner.message ?: ""))
            ))
        }
    }
    println(toJson(mapOf("kind" to "results", "results" to results)))
}
`;

// Bumping the harness body invalidates every cache dir (different hash
// → different folder), so we never run a stale Harness.kt against new
// sandbox semantics — see Task #1211 "Done looks like" §3.
const HARNESS_VERSION = crypto
  .createHash("sha256")
  .update("v1\n")
  .update(HARNESS)
  .digest("hex")
  .slice(0, 16);

function classpathSep(): string {
  return process.platform === "win32" ? ";" : ":";
}

function ensureCacheDir(timeoutMs: number): { dir: string; harnessJar: string } | { error: SandboxResult } {
  ensureConfigDir();
  const dir = path.join(SANDBOX_CACHE_DIR, "kotlin", HARNESS_VERSION);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const harnessSrc = path.join(dir, "Harness.kt");
  const harnessJar = path.join(dir, "harness.jar");
  const stamp = path.join(dir, "harness.version");

  // Fast path: precompiled harness.jar already exists for this version.
  if (fs.existsSync(harnessJar) && fs.existsSync(stamp)) {
    return { dir, harnessJar };
  }

  // Slow path: do the one-time `-include-runtime` compile under the
  // same lock as grading attempts so two cold starts can't both try to
  // write harness.jar at once. Lock-contention timeouts surface as a
  // structured `error` (mirrors the result-union API intent) rather
  // than throwing out of the grader.
  let result: { outcome: "timeout" | "error"; timedOut: boolean; durationMs: number; stderr: string } | null = null;
  try {
    result = withSandboxLock(path.join(dir, ".harness.lock"), timeoutMs, () => {
    if (fs.existsSync(harnessJar) && fs.existsSync(stamp)) return null;
    fs.writeFileSync(harnessSrc, HARNESS, { mode: 0o600 });
    const t0 = Date.now();
    const compile = spawnSync(
      "kotlinc",
      ["Harness.kt", "-include-runtime", "-d", harnessJar],
      {
        cwd: dir,
        timeout: timeoutMs,
        encoding: "utf-8",
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          JAVA_HOME: process.env.JAVA_HOME ?? "",
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
        runtimeVersion: kotlinRuntimeVersion(),
        cases: [],
        rawStderr: truncate(result.stderr),
      },
    };
  }
  return { dir, harnessJar };
}

export function runKotlinSandbox(
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
          ? "kotlinc timed out preparing the sandbox harness"
          : truncate(err.rawStderr, 400),
      })),
    };
  }
  const { dir, harnessJar } = cache;
  const lockStart = Date.now();

  try {
    return withSandboxLock(path.join(dir, ".lock"), timeoutMs, () => {
    fs.writeFileSync(path.join(dir, "solution.kt"), code, { mode: 0o600 });
    const solutionClasses = path.join(dir, "solution-classes");
    // Wipe stale solution classes so a previous attempt's SolutionKt
    // can't shadow this one if the current compile fails.
    try {
      fs.rmSync(solutionClasses, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    fs.mkdirSync(solutionClasses, { recursive: true, mode: 0o700 });

    const compile = spawnSync(
      "kotlinc",
      [
        "solution.kt",
        "-classpath",
        harnessJar,
        "-d",
        solutionClasses,
      ],
      {
        cwd: dir,
        timeout: timeoutMs,
        encoding: "utf-8",
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          JAVA_HOME: process.env.JAVA_HOME ?? "",
        },
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    if (compile.status !== 0) {
      const stderr = (compile.stderr ?? "") + (compile.stdout ?? "");
      // Task #1200 (round 3) — distinguish a kotlinc cold-start that
      // exceeded the configured per-attempt timeout from a real compile
      // error. Both used to surface as `outcome: "error"`, which the
      // workshop pipeline displayed as a generic failure even though the
      // user's solution may well be correct.
      const compileTimedOut =
        compile.signal === "SIGTERM" ||
        (compile.error && (compile.error as { code?: string }).code === "ETIMEDOUT") ||
        false;
      return {
        outcome: compileTimedOut ? "timeout" : "error",
        timedOut: compileTimedOut,
        durationMs: Date.now() - t0,
        runtimeVersion: kotlinRuntimeVersion(),
        cases: cases.map((c) => ({
          id: c.id,
          passed: false,
          stderrExcerpt: compileTimedOut
            ? "kotlinc timed out before producing the sandbox classes"
            : truncate(stderr, 400),
        })),
        rawStderr: truncate(stderr),
      };
    }

    const remaining = Math.max(1000, timeoutMs - (Date.now() - t0));
    const cp = [harnessJar, solutionClasses].join(classpathSep());
    const proc = spawnSync(
      "java",
      ["-cp", cp, "HarnessKt", safeEntry, JSON.stringify(cases)],
      {
        cwd: dir,
        timeout: remaining,
        encoding: "utf-8",
        env: { PATH: process.env.PATH ?? "", JAVA_HOME: process.env.JAVA_HOME ?? "" },
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
        runtimeVersion: kotlinRuntimeVersion(),
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
        runtimeVersion: kotlinRuntimeVersion(),
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
        runtimeVersion: kotlinRuntimeVersion(),
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
        runtimeVersion: kotlinRuntimeVersion(),
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
        runtimeVersion: kotlinRuntimeVersion(),
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
      runtimeVersion: kotlinRuntimeVersion(),
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
        runtimeVersion: kotlinRuntimeVersion(),
        cases: cases.map((c) => ({
          id: c.id,
          passed: false,
          stderrExcerpt: "Timed out waiting for the Kotlin sandbox build cache lock",
        })),
        rawStderr: err.message,
      };
    }
    throw err;
  }
}

export const __kotlinCacheInternals = {
  HARNESS_VERSION,
  cacheDir: () => path.join(SANDBOX_CACHE_DIR, "kotlin", HARNESS_VERSION),
};
