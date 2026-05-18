// Task #1213 — Java sandbox grader. Mirrors the kotlin.ts shape: the
// user's Solution.java is expected to define `public class Solution`
// with a method whose name matches `entry` (case-insensitive). We
// compile Solution.java + a tiny Harness.java with `javac`, then
// execute `java -cp <dir> Harness <entry> <casesJson>`.
//
// The harness uses java.lang reflection + a hand-rolled minimal JSON
// codec so it doesn't pull in any third-party JSON library — that
// keeps the cold-compile cost predictable and avoids polluting the
// sandbox dir with downloaded jars.
//
// Task #1231 — same warm-cache speedup as csharp.ts / kotlin.ts. The
// Harness.class is compiled exactly once per harness-template version
// into `~/.prepsavant/sandbox-cache/java/<harnessHash>/harness-classes/`,
// and `entry` now comes in as args[0] (was %ENTRY% baked into the source)
// so the prebuilt class survives across questions / entry-method names.
// Per-attempt work is just `javac Solution.java` into a separate
// solution-classes dir + `java -cp ...`. Concurrent attempts are
// serialized via a file lock so javac doesn't race on Solution.java.
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

export function javaRuntimeVersion(): string {
  const r = spawnSync("java", ["-version"], { encoding: "utf-8" });
  if (r.status === 0 || r.status === null) {
    // `java -version` writes to stderr by convention.
    const line = ((r.stderr || r.stdout || "").trim().split("\n")[0] || "").trim();
    if (line) return line;
  }
  return "unavailable";
}

// Task #1231 — `entry` comes in as args[0] (was %ENTRY% baked into the
// source) and the cases JSON shifts to args[1]. Keeping Harness.java
// fully static lets the prebuilt Harness.class be reused across
// questions / entry-method names.
const HARNESS = `import java.lang.reflect.Method;
import java.util.*;

public class Harness {
    private static int _pos = 0;
    private static String _src = "";

    private static void skipWs() {
        while (_pos < _src.length() && Character.isWhitespace(_src.charAt(_pos))) _pos++;
    }
    private static Object parseValue() {
        skipWs();
        char ch = _src.charAt(_pos);
        if (ch == '{') return parseObject();
        if (ch == '[') return parseArray();
        if (ch == '"') return parseString();
        if (ch == 't' || ch == 'f') return parseBool();
        if (ch == 'n') { _pos += 4; return null; }
        return parseNumber();
    }
    private static LinkedHashMap<String, Object> parseObject() {
        _pos++;
        LinkedHashMap<String, Object> out = new LinkedHashMap<>();
        skipWs();
        if (_src.charAt(_pos) == '}') { _pos++; return out; }
        while (true) {
            skipWs();
            String k = parseString();
            skipWs(); _pos++;
            Object v = parseValue();
            out.put(k, v);
            skipWs();
            if (_src.charAt(_pos) == ',') _pos++; else { _pos++; break; }
        }
        return out;
    }
    private static ArrayList<Object> parseArray() {
        _pos++;
        ArrayList<Object> out = new ArrayList<>();
        skipWs();
        if (_src.charAt(_pos) == ']') { _pos++; return out; }
        while (true) {
            Object v = parseValue();
            out.add(v);
            skipWs();
            if (_src.charAt(_pos) == ',') _pos++; else { _pos++; break; }
        }
        return out;
    }
    private static String parseString() {
        _pos++;
        StringBuilder sb = new StringBuilder();
        while (_src.charAt(_pos) != '"') {
            char c = _src.charAt(_pos);
            if (c == '\\\\') {
                _pos++;
                char esc = _src.charAt(_pos);
                switch (esc) {
                    case '"': sb.append('"'); break;
                    case '\\\\': sb.append('\\\\'); break;
                    case '/': sb.append('/'); break;
                    case 'b': sb.append('\\b'); break;
                    case 'f': sb.append('\\f'); break;
                    case 'n': sb.append('\\n'); break;
                    case 'r': sb.append('\\r'); break;
                    case 't': sb.append('\\t'); break;
                    case 'u':
                        String hex = _src.substring(_pos + 1, _pos + 5);
                        _pos += 4;
                        sb.append((char) Integer.parseInt(hex, 16));
                        break;
                    default: sb.append(esc);
                }
                _pos++;
            } else {
                sb.append(c);
                _pos++;
            }
        }
        _pos++;
        return sb.toString();
    }
    private static Boolean parseBool() {
        if (_src.charAt(_pos) == 't') { _pos += 4; return true; }
        _pos += 5; return false;
    }
    private static Object parseNumber() {
        int start = _pos;
        if (_src.charAt(_pos) == '-') _pos++;
        while (_pos < _src.length()) {
            char c = _src.charAt(_pos);
            if (Character.isDigit(c) || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') _pos++;
            else break;
        }
        String s = _src.substring(start, _pos);
        if (s.contains(".") || s.contains("e") || s.contains("E")) return Double.parseDouble(s);
        return Long.parseLong(s);
    }
    private static Object parseJson(String s) { _src = s; _pos = 0; return parseValue(); }

    private static String jsonString(String s) {
        StringBuilder sb = new StringBuilder("\\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\\\\""); break;
                case '\\\\': sb.append("\\\\\\\\"); break;
                case '\\n': sb.append("\\\\n"); break;
                case '\\r': sb.append("\\\\r"); break;
                case '\\t': sb.append("\\\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        sb.append('"');
        return sb.toString();
    }
    @SuppressWarnings("unchecked")
    private static String toJson(Object v) {
        if (v == null) return "null";
        if (v instanceof Boolean) return v.toString();
        if (v instanceof Number) {
            if (v instanceof Double) {
                double d = (Double) v;
                if (d == Math.floor(d) && !Double.isInfinite(d)) return Long.toString((long) d);
            }
            return v.toString();
        }
        if (v instanceof String) return jsonString((String) v);
        if (v instanceof Map) {
            Map<String, Object> m = (Map<String, Object>) v;
            ArrayList<String> keys = new ArrayList<>(m.keySet());
            Collections.sort(keys);
            StringBuilder sb = new StringBuilder("{");
            for (int i = 0; i < keys.size(); i++) {
                if (i > 0) sb.append(',');
                sb.append(jsonString(keys.get(i))).append(':').append(toJson(m.get(keys.get(i))));
            }
            sb.append('}');
            return sb.toString();
        }
        if (v instanceof Iterable) {
            StringBuilder sb = new StringBuilder("[");
            boolean first = true;
            for (Object o : (Iterable<Object>) v) {
                if (!first) sb.append(',');
                sb.append(toJson(o));
                first = false;
            }
            sb.append(']');
            return sb.toString();
        }
        if (v instanceof int[]) {
            int[] a = (int[]) v;
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < a.length; i++) { if (i > 0) sb.append(','); sb.append(a[i]); }
            sb.append(']');
            return sb.toString();
        }
        if (v instanceof long[]) {
            long[] a = (long[]) v;
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < a.length; i++) { if (i > 0) sb.append(','); sb.append(a[i]); }
            sb.append(']');
            return sb.toString();
        }
        if (v instanceof double[]) {
            double[] a = (double[]) v;
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < a.length; i++) {
                if (i > 0) sb.append(',');
                double d = a[i];
                if (d == Math.floor(d) && !Double.isInfinite(d)) sb.append((long) d);
                else sb.append(d);
            }
            sb.append(']');
            return sb.toString();
        }
        if (v instanceof Object[]) {
            Object[] a = (Object[]) v;
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < a.length; i++) { if (i > 0) sb.append(','); sb.append(toJson(a[i])); }
            sb.append(']');
            return sb.toString();
        }
        return jsonString(v.toString());
    }

    @SuppressWarnings("unchecked")
    private static Object coerce(Object v, Class<?> target) {
        if (v == null) return null;
        if (target == int.class || target == Integer.class) return ((Number) v).intValue();
        if (target == long.class || target == Long.class) return ((Number) v).longValue();
        if (target == double.class || target == Double.class) return ((Number) v).doubleValue();
        if (target == boolean.class || target == Boolean.class) return v;
        if (target == String.class) return v.toString();
        if (target == int[].class) {
            List<Object> l = (List<Object>) v;
            int[] out = new int[l.size()];
            for (int i = 0; i < l.size(); i++) out[i] = ((Number) l.get(i)).intValue();
            return out;
        }
        if (target == long[].class) {
            List<Object> l = (List<Object>) v;
            long[] out = new long[l.size()];
            for (int i = 0; i < l.size(); i++) out[i] = ((Number) l.get(i)).longValue();
            return out;
        }
        if (target == double[].class) {
            List<Object> l = (List<Object>) v;
            double[] out = new double[l.size()];
            for (int i = 0; i < l.size(); i++) out[i] = ((Number) l.get(i)).doubleValue();
            return out;
        }
        if (List.class.isAssignableFrom(target)) return v;
        if (Map.class.isAssignableFrom(target)) return v;
        return v;
    }

    public static void main(String[] args) throws Exception {
        String entry = args[0];
        Class<?> cls;
        try {
            cls = Class.forName("Solution");
        } catch (ClassNotFoundException e) {
            System.out.println("{\\"kind\\":\\"import_error\\",\\"stderr\\":" + jsonString("class Solution not found in Solution.java") + "}");
            return;
        }
        Method method = null;
        for (Method m : cls.getDeclaredMethods()) {
            if (m.getName().equalsIgnoreCase(entry)) { method = m; break; }
        }
        if (method == null) {
            System.out.println("{\\"kind\\":\\"import_error\\",\\"stderr\\":" + jsonString("Entry method '" + entry + "' not found on Solution") + "}");
            return;
        }
        method.setAccessible(true);
        Object instance = java.lang.reflect.Modifier.isStatic(method.getModifiers())
                ? null
                : cls.getDeclaredConstructor().newInstance();
        @SuppressWarnings("unchecked")
        List<Object> cases = (List<Object>) parseJson(args[1]);
        Class<?>[] pTypes = method.getParameterTypes();
        ArrayList<Map<String, Object>> results = new ArrayList<>();
        for (Object c : cases) {
            @SuppressWarnings("unchecked")
            Map<String, Object> co = (Map<String, Object>) c;
            String id = (String) co.get("id");
            Object argsObj = co.get("args");
            List<Object> argsList = (argsObj instanceof List)
                    ? (List<Object>) argsObj
                    : Collections.singletonList(argsObj);
            Object expected = co.get("expected");
            long t0 = System.currentTimeMillis();
            try {
                Object[] paramVals = new Object[pTypes.length];
                for (int i = 0; i < pTypes.length; i++) paramVals[i] = coerce(argsList.get(i), pTypes[i]);
                Object got = method.invoke(instance, paramVals);
                boolean ok = toJson(got).equals(toJson(expected));
                LinkedHashMap<String, Object> r = new LinkedHashMap<>();
                r.put("id", id);
                r.put("passed", ok);
                r.put("durationMs", (int) (System.currentTimeMillis() - t0));
                r.put("stderr", ok ? "" : ("expected " + toJson(expected) + ", got " + toJson(got)));
                results.add(r);
            } catch (Throwable e) {
                Throwable inner = (e instanceof java.lang.reflect.InvocationTargetException)
                        ? ((java.lang.reflect.InvocationTargetException) e).getTargetException()
                        : e;
                LinkedHashMap<String, Object> r = new LinkedHashMap<>();
                r.put("id", id);
                r.put("passed", false);
                r.put("durationMs", (int) (System.currentTimeMillis() - t0));
                r.put("stderr", inner.getClass().getSimpleName() + ": " + (inner.getMessage() == null ? "" : inner.getMessage()));
                results.add(r);
            }
        }
        LinkedHashMap<String, Object> out = new LinkedHashMap<>();
        out.put("kind", "results");
        out.put("results", results);
        System.out.println(toJson(out));
    }
}
`;

// Bumping the harness body invalidates every cache dir (different hash
// → different folder), so we never run a stale Harness.class against
// new sandbox semantics.
const HARNESS_VERSION = crypto
  .createHash("sha256")
  .update("v1\n")
  .update(HARNESS)
  .digest("hex")
  .slice(0, 16);

function classpathSep(): string {
  return process.platform === "win32" ? ";" : ":";
}

function ensureCacheDir(timeoutMs: number): { dir: string; harnessClasses: string } | { error: SandboxResult } {
  ensureConfigDir();
  const dir = path.join(SANDBOX_CACHE_DIR, "java", HARNESS_VERSION);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const harnessSrc = path.join(dir, "Harness.java");
  const harnessClasses = path.join(dir, "harness-classes");
  const stamp = path.join(dir, "harness.version");

  // Fast path: precompiled Harness.class already exists for this version.
  if (fs.existsSync(path.join(harnessClasses, "Harness.class")) && fs.existsSync(stamp)) {
    return { dir, harnessClasses };
  }

  let result: { outcome: "timeout" | "error"; timedOut: boolean; durationMs: number; stderr: string } | null = null;
  try {
    result = withSandboxLock(path.join(dir, ".harness.lock"), timeoutMs, () => {
      if (fs.existsSync(path.join(harnessClasses, "Harness.class")) && fs.existsSync(stamp)) return null;
      fs.writeFileSync(harnessSrc, HARNESS, { mode: 0o600 });
      fs.mkdirSync(harnessClasses, { recursive: true, mode: 0o700 });
      const t0 = Date.now();
      const compile = spawnSync(
        "javac",
        ["-d", harnessClasses, "Harness.java"],
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
        runtimeVersion: javaRuntimeVersion(),
        cases: [],
        rawStderr: truncate(result.stderr),
      },
    };
  }
  return { dir, harnessClasses };
}

export function runJavaSandbox(
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
          ? "javac timed out preparing the sandbox harness"
          : truncate(err.rawStderr, 400),
      })),
    };
  }
  const { dir, harnessClasses } = cache;
  const lockStart = Date.now();

  try {
    return withSandboxLock(path.join(dir, ".lock"), timeoutMs, () => {
      fs.writeFileSync(path.join(dir, "Solution.java"), code, { mode: 0o600 });
      const solutionClasses = path.join(dir, "solution-classes");
      try {
        fs.rmSync(solutionClasses, { recursive: true, force: true });
      } catch {
        // best-effort
      }
      fs.mkdirSync(solutionClasses, { recursive: true, mode: 0o700 });

      const compile = spawnSync(
        "javac",
        ["-d", solutionClasses, "Solution.java"],
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
        const compileTimedOut =
          compile.signal === "SIGTERM" ||
          (compile.error && (compile.error as { code?: string }).code === "ETIMEDOUT") ||
          false;
        return {
          outcome: compileTimedOut ? "timeout" : "error",
          timedOut: compileTimedOut,
          durationMs: Date.now() - t0,
          runtimeVersion: javaRuntimeVersion(),
          cases: cases.map((c) => ({
            id: c.id,
            passed: false,
            stderrExcerpt: compileTimedOut
              ? "javac timed out before producing class files"
              : truncate(stderr, 400),
          })),
          rawStderr: truncate(stderr),
        };
      }

      const remaining = Math.max(1000, timeoutMs - (Date.now() - t0));
      const cp = [harnessClasses, solutionClasses].join(classpathSep());
      const proc = spawnSync(
        "java",
        ["-cp", cp, "Harness", safeEntry, JSON.stringify(cases)],
        {
          cwd: dir,
          timeout: remaining,
          encoding: "utf-8",
          env: {
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? "",
            JAVA_HOME: process.env.JAVA_HOME ?? "",
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
          runtimeVersion: javaRuntimeVersion(),
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
          runtimeVersion: javaRuntimeVersion(),
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
          runtimeVersion: javaRuntimeVersion(),
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
          runtimeVersion: javaRuntimeVersion(),
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
          runtimeVersion: javaRuntimeVersion(),
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
        runtimeVersion: javaRuntimeVersion(),
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
        runtimeVersion: javaRuntimeVersion(),
        cases: cases.map((c) => ({
          id: c.id,
          passed: false,
          stderrExcerpt: "Timed out waiting for the Java sandbox build cache lock",
        })),
        rawStderr: err.message,
      };
    }
    throw err;
  }
}

export const __javaCacheInternals = {
  HARNESS_VERSION,
  cacheDir: () => path.join(SANDBOX_CACHE_DIR, "java", HARNESS_VERSION),
};
