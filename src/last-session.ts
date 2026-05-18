// Task #1479 — `.prepsavant/last-session.json` persistence.
//
// Written by `prepsavant start` (both coached and ai_assisted) into the
// question-package folder right after a session is minted, so the next
// invocation of `prepsavant upload-cursor-export` (or any future
// folder-aware command) can auto-resolve the session id without
// flags. Best-effort: a write failure logs to stderr but does NOT
// abort the start flow — the session is already live server-side and
// the user can always pass `--session-id` explicitly.
//
// Schema is intentionally tiny and forward-compatible. Unknown fields
// on read are ignored; missing optional fields are tolerated. Bumping
// `v` lets readers reject incompatible future shapes.
import * as fs from "node:fs";
import * as path from "node:path";

export const LAST_SESSION_VERSION = 1 as const;

export interface LastSessionFile {
  v: 1;
  sessionId: string;
  mode: "coached" | "ai_assisted";
  questionId: string;
  questionTitle?: string;
  startedAt: string;
}

// Resolve the `.prepsavant/last-session.json` path under the given
// question-package folder. The folder is the directory CONTAINING
// `.prepsavant/`, i.e. the folder the user `cd`'d into.
export function lastSessionPath(packRoot: string): string {
  return path.join(packRoot, ".prepsavant", "last-session.json");
}

// Best-effort write — never throws. Returns true on success, false on
// any filesystem error (also logged to stderr for the user). The
// `.prepsavant` directory already exists in a freshly-unzipped
// question package, but we mkdir defensively in case the user nuked
// it between runs.
export function writeLastSession(
  packRoot: string,
  payload: Omit<LastSessionFile, "v">,
): boolean {
  const target = lastSessionPath(packRoot);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const body: LastSessionFile = { v: LAST_SESSION_VERSION, ...payload };
    fs.writeFileSync(target, JSON.stringify(body, null, 2) + "\n", "utf-8");
    return true;
  } catch (err) {
    process.stderr.write(
      `[mcp-runner] could not write ${target}: ${(err as Error).message} — ` +
        "subsequent `prepsavant upload-cursor-export` calls will need an explicit --session-id.\n",
    );
    return false;
  }
}

// Best-effort read — returns null on any error or version mismatch.
// Callers fall back to either an explicit flag or a hard error.
export function readLastSession(packRoot: string): LastSessionFile | null {
  const target = lastSessionPath(packRoot);
  let raw: string;
  try {
    raw = fs.readFileSync(target, "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (obj["v"] !== LAST_SESSION_VERSION) return null;
  const sessionId = obj["sessionId"];
  const mode = obj["mode"];
  const questionId = obj["questionId"];
  const startedAt = obj["startedAt"];
  if (
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    (mode !== "coached" && mode !== "ai_assisted") ||
    typeof questionId !== "string" ||
    typeof startedAt !== "string"
  ) {
    return null;
  }
  const out: LastSessionFile = {
    v: LAST_SESSION_VERSION,
    sessionId,
    mode,
    questionId,
    startedAt,
  };
  if (typeof obj["questionTitle"] === "string") {
    out.questionTitle = obj["questionTitle"];
  }
  return out;
}
