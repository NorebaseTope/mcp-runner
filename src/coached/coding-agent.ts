// Task #1401 — Pluggable adapter for the user's installed coding-agent
// CLI. The runner shells out to it for LLM reasoning when authoring a
// host-reasoning directive turn (e.g. a hint_offer that needs to be
// grounded in a diff snippet). LLM cost is billed to the user's own
// Cursor (or whatever) quota — we never use a server-side API key here.
//
// Cursor is the sole supported adapter in v1; the interface is kept
// intentionally small so adding Claude Code, Codex CLI, or Aider later
// is mechanical. See `docs/runbooks/runner-driven-terminal-coach.md`.

import { spawn, spawnSync } from "node:child_process";
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptions,
  SpawnSyncOptions,
  SpawnSyncOptionsWithStringEncoding,
  SpawnSyncReturns,
} from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface CodingAgentAsk {
  systemPrompt: string;
  userPrompt: string;
  timeoutMs?: number;
}

export interface CodingAgentReply {
  text: string;
}

export interface CodingAgentProbeResult {
  ok: boolean;
  version?: string;
  reason?: "not_installed" | "not_authenticated" | "unknown_error";
  remediation?: string;
}

export interface CodingAgentAdapter {
  readonly id: string;
  probe(): Promise<CodingAgentProbeResult>;
  ask(req: CodingAgentAsk): Promise<CodingAgentReply>;
  // Optional teardown — adapters that hold a persistent agent (e.g.
  // CursorSdkAdapter's @cursor/sdk Agent instance) implement this so the
  // CLI can release the underlying connection at session end. Stateless
  // adapters (CursorAgentAdapter, MockAgent) leave it undefined.
  dispose?(): Promise<void>;
}

export interface CodingAgentConfig {
  kind?: "cursor-agent" | "cursor-sdk" | "mock";
  binPath?: string;
  extraArgs?: string[];
  model?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const REPLY_MAX_CHARS = 600;

// ---------------------------------------------------------------------
// CursorAgentAdapter — shells to the user's locally-installed Cursor
// terminal-agent. Two invocation forms exist in the wild:
//   • Cursor 0.45–2.x ships a standalone `cursor-agent` binary.
//   • Cursor 3.x folds it into the IDE binary as `cursor agent <args>`.
// We probe both at construction time and adopt whichever responds to
// `--version`. Operators can pin a specific invocation via the config
// block (`codingAgent.binPath` for the legacy single-binary form, or
// `codingAgent.invocation` for the new array form).
// ---------------------------------------------------------------------
// Task #1533 / #1544 — Two invocation forms exist in the wild:
//   • Cursor 0.45–2.x ships a standalone `cursor-agent` binary.
//   • Cursor 3.x folds the agent into the IDE binary as
//     `cursor agent <args>` (this is also the ONLY form on Windows
//     Cursor installs — there is no separate `cursor-agent.cmd`).
// Both candidates are tried on every platform. The
// `looksLikeCursorEditor` / `looksLikeCursorAgentVersion` gate below
// is what keeps an editor binary that swallows `--version` from being
// mistaken for the agent CLI (the original #1533 bug). Pre-#1544 the
// fallback was dropped entirely on Windows, which broke Cursor 3.x
// users who legitimately reach the agent via `cursor agent ...`.
const DEFAULT_AGENT_CANDIDATES: ReadonlyArray<readonly string[]> = [
  ["cursor-agent"],
  ["cursor", "agent"],
];

// Test-only seam to recompute the default candidate list against a
// stubbed `process.platform`. Production callers never touch this.
export function defaultAgentCandidatesFor(
  _platform: NodeJS.Platform,
): ReadonlyArray<readonly string[]> {
  return [["cursor-agent"], ["cursor", "agent"]];
}

// Task #1533 — Positive identification of a `cursor-agent --version`
// response. A real reply is a SHORT, single-line bare semver (or
// `cursor-agent X.Y.Z`). The Cursor *editor* responds to a bogus
// `--version` invocation with either its built-in help line
// (`Run with 'cursor -' to read output from another program …`) or a
// multi-line dump that includes Electron / Chromium / Commit / etc.
// We accept only the agent-shaped output; everything else is treated
// as an editor-or-other false positive and rejected with a
// remediation that points at the standalone CLI install.
const EDITOR_FINGERPRINTS = [
  "Run with 'cursor -'",
  "Electron",
  "Chromium",
  "ItHelpers",
  "Visit https://cursor.com",
  "Usage:",
  "USAGE:",
];

export function looksLikeCursorEditor(output: string): boolean {
  const trimmed = output.trim();
  if (trimmed.length === 0) return false;
  for (const fp of EDITOR_FINGERPRINTS) {
    if (trimmed.includes(fp)) return true;
  }
  // Multi-line dumps that don't carry an explicit fingerprint: the
  // editor's version block on macOS/Linux is typically 5+ lines
  // (Cursor version, VSCode version, Commit, Date, Electron, Chromium,
  // Node, V8, OS, …). Cursor 3.x on Windows ARM64 (and likely other
  // 3.x platforms) responds to `cursor agent --version` with EXACTLY
  // three lines — `<semver>` / `<commit-sha>` / `<arch>` — which is
  // the real agent CLI and MUST NOT be rejected. We therefore raise
  // the cardinality threshold to 5 so the 3-line agent reply passes
  // through and the longer editor block is still caught even when
  // none of the explicit fingerprints match (defence-in-depth for
  // future editor builds whose version banner shifts).
  const nonEmptyLines = trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (nonEmptyLines.length >= 5) return true;
  return false;
}

// A line that's "just a semver" — e.g. `3.0.12`, `cursor-agent 0.45.7`,
// `v2.1.0`, or `0.45.7-beta.1`. The Cursor editor's version banner
// usually starts with a human label (`Cursor 1.2.3`, `Visual Studio
// Code …`, `Electron …`) so requiring the agent's first line to be
// bare-semver-shaped is a strong positive ID.
const SEMVER_FIRST_LINE =
  /^(?:cursor-agent\s+|v)?\d+\.\d+\.\d+(?:[-+][\w.]+)?\s*$/i;

export function looksLikeCursorAgentVersion(output: string): boolean {
  const trimmed = output.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return false;
  if (looksLikeCursorEditor(trimmed)) return false;
  // A real cursor-agent prints either:
  //   `0.45.7`
  //   `cursor-agent 0.45.7`
  //   `3.0.12\n<commit-sha>\n<arch>`        (Cursor 3.x `cursor agent`)
  // The defining signal is that LINE 1 is a bare semver token (with
  // an optional `cursor-agent ` / `v` prefix), not a human-readable
  // banner. We anchor on that — any first line containing additional
  // descriptive text is rejected.
  const firstLine = (trimmed.split(/\r?\n/)[0] ?? "").trim();
  return SEMVER_FIRST_LINE.test(firstLine);
}

export const EDITOR_REMEDIATION_SUFFIX =
  "Detected the Cursor editor on PATH instead of the standalone `cursor-agent` CLI. " +
  "Install the agent CLI (Cursor 0.45+ ships it as `cursor-agent`; on Windows it lands as " +
  "`cursor-agent.cmd`) from https://cursor.com, then run `cursor-agent login`. If the " +
  "agent CLI is installed in a non-standard location, add its bin directory to PATH so the " +
  "runner picks it up instead of the editor launcher.";

// Task #1538 — Synchronous probe used by `prepsavant doctor` to detect
// the "Cursor editor on PATH, agent CLI missing" install layout BEFORE
// the user starts their first coached session. Returns:
//   - { kind: "ok" }            cursor-agent (or `cursor agent` on POSIX)
//                               responded with a valid agent-CLI version
//                               string. No remediation needed.
//   - { kind: "editor_only" }   `cursor-agent` is not on PATH (or didn't
//                               look like the agent CLI), but `cursor`
//                               IS on PATH and its `--version` output
//                               matches the editor fingerprints. This
//                               is the actionable case doctor surfaces.
//   - { kind: "missing" }       Neither the agent CLI nor the editor is
//                               positively identifiable. Doctor leaves
//                               this to the existing aspirational
//                               "will shell out to cursor-agent" notice
//                               so we don't double-warn users who simply
//                               haven't installed Cursor yet.
export type CursorAgentSyncProbeResult =
  | { kind: "ok"; version?: string }
  | { kind: "editor_only"; remediation: string }
  | { kind: "missing" };

export function probeCursorAgentSync(opts: {
  // Test-only override of the candidate list. Production callers omit
  // this and get `defaultAgentCandidatesFor(process.platform)`.
  candidates?: ReadonlyArray<readonly string[]>;
  // Test-only override of the editor probe candidate. On Windows the
  // editor launcher is `cursor.cmd`; on POSIX it's `cursor`. Production
  // callers omit this.
  editorCandidate?: readonly string[];
} = {}): CursorAgentSyncProbeResult {
  const candidates =
    opts.candidates ?? defaultAgentCandidatesFor(process.platform);
  for (const inv of candidates) {
    const [bin, ...prefix] = inv;
    if (!bin) continue;
    const resolved = resolveBinOnPath(bin) ?? bin;
    const isBareCommand =
      !bin.includes("/") && !bin.includes("\\") && !/^[a-zA-Z]:/.test(bin);
    if (
      process.platform === "win32" &&
      resolveBinOnPath(bin) == null &&
      isBareCommand
    ) {
      continue;
    }
    let r;
    try {
      r = spawnSyncCompat(resolved, [...prefix, "--version"], {
        encoding: "utf-8",
      });
    } catch {
      continue;
    }
    if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") {
      continue;
    }
    if (r.status !== 0) continue;
    const combined = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    if (looksLikeCursorEditor(combined)) continue;
    if (looksLikeCursorAgentVersion(combined)) {
      const version = (r.stdout || r.stderr || "").trim().split("\n")[0];
      return version ? { kind: "ok", version } : { kind: "ok" };
    }
  }
  // No agent CLI found — check if the editor is on PATH.
  const editorInv = opts.editorCandidate ?? ["cursor"];
  const [editorBin, ...editorPrefix] = editorInv;
  if (!editorBin) return { kind: "missing" };
  const resolvedEditor = resolveBinOnPath(editorBin) ?? editorBin;
  const isBareEditor =
    !editorBin.includes("/") &&
    !editorBin.includes("\\") &&
    !/^[a-zA-Z]:/.test(editorBin);
  if (
    process.platform === "win32" &&
    resolveBinOnPath(editorBin) == null &&
    isBareEditor
  ) {
    return { kind: "missing" };
  }
  let er;
  try {
    er = spawnSyncCompat(resolvedEditor, [...editorPrefix, "--version"], {
      encoding: "utf-8",
    });
  } catch {
    return { kind: "missing" };
  }
  if (er.error && (er.error as NodeJS.ErrnoException).code === "ENOENT") {
    return { kind: "missing" };
  }
  if (er.status !== 0) return { kind: "missing" };
  const editorCombined = `${er.stdout ?? ""}\n${er.stderr ?? ""}`;
  if (looksLikeCursorEditor(editorCombined)) {
    return {
      kind: "editor_only",
      remediation: EDITOR_REMEDIATION_SUFFIX,
    };
  }
  return { kind: "missing" };
}

// Task #1477 — Windows-aware PATH resolver.
//
// Node's `spawnSync(bin, args)` on Windows does NOT honour `PATHEXT`, so
// a `cursor-agent.cmd` / `cursor.cmd` shim (the normal Windows install
// layout for Cursor 0.45+ and 3.x) returns ENOENT even though the same
// command resolves from PowerShell. We walk PATH ourselves and try each
// `PATHEXT` extension, returning the absolute path of the first hit.
//
// On non-Windows platforms this is a no-op pass-through — `spawnSync`
// already honours PATH lookups correctly on POSIX, and we don't want to
// change that behaviour.
// Task #1477 follow-up #2 — Windows .cmd/.bat shim spawn helper.
//
// Node 22 (CVE-2024-27980) refuses to spawn `.cmd` / `.bat` files unless
// `shell: true` is set. Without it, `spawnSync(bin, [...args])` returns
// `{ status: null }` with no actionable error — exactly what the probe
// surfaced as `cursor agent --version exited null` on a working Cursor
// 3.x install. With `shell: true` the args are re-parsed by cmd.exe so
// we must do our own quoting; we wrap the bin path AND each arg in
// double quotes when they contain whitespace or quotes, which is safe
// for the inputs we control (absolute paths into Program Files, literal
// CLI flags, sys-file paths in tmpdir).
function needsShellOnWindows(bin: string): boolean {
  if (process.platform !== "win32") return false;
  if (!/\.(cmd|bat)$/i.test(bin)) return false;
  // Test-only escape hatch: the existing PATHEXT tests stub
  // `process.platform = "win32"` on Linux to exercise the resolver, then
  // spawn the resolved shim relying on POSIX shebang+chmod execution.
  // shell:true under that stub makes Node try to invoke `cmd.exe`, which
  // ENOENTs on Linux. Tests set this var to bypass the wrap so the same
  // POSIX execution path runs that worked before this follow-up.
  if (process.env["PREPSAVANT_WIN_SPAWN_NO_SHELL"] === "1") return false;
  return true;
}

function quoteWinArg(arg: string): string {
  if (arg.length === 0) return '""';
  if (!/[\s"]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

export function spawnSyncCompat(
  bin: string,
  args: ReadonlyArray<string>,
  opts: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string> {
  if (needsShellOnWindows(bin)) {
    const cmdLine = [bin, ...args].map(quoteWinArg).join(" ");
    return spawnSync(cmdLine, [], { ...opts, shell: true });
  }
  return spawnSync(bin, [...args], opts);
}

export function spawnCompat(
  bin: string,
  args: ReadonlyArray<string>,
  opts: SpawnOptions,
): ChildProcessWithoutNullStreams {
  if (needsShellOnWindows(bin)) {
    const cmdLine = [bin, ...args].map(quoteWinArg).join(" ");
    return spawn(cmdLine, [], { ...opts, shell: true }) as ChildProcessWithoutNullStreams;
  }
  return spawn(bin, [...args], opts) as ChildProcessWithoutNullStreams;
}

export function resolveBinOnPath(
  bin: string,
  opts: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    existsSync?: (p: string) => boolean;
  } = {},
): string | null {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return null;
  // Absolute or explicitly-relative paths — let spawn handle them.
  if (
    bin.includes("/") ||
    bin.includes("\\") ||
    /^[a-zA-Z]:/.test(bin)
  ) {
    return null;
  }
  const env = opts.env ?? process.env;
  const existsSync = opts.existsSync ?? fs.existsSync;
  const pathVar = env["PATH"] ?? env["Path"] ?? env["path"] ?? "";
  if (!pathVar) return null;
  const exts = (env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
  // Task #1477 follow-up: try real PATHEXT extensions FIRST, then fall
  // back to the empty extension as a last resort. On Windows the only
  // files `spawn()` can actually execute are those with a PATHEXT
  // extension (`.cmd`, `.exe`, `.bat`, ...); an extensionless file
  // sitting next to its `.cmd` shim is almost always a POSIX shell
  // script shipped for WSL / Git Bash (e.g. Cursor's
  // `C:\Program Files\cursor\resources\app\bin\cursor`) which spawn
  // cannot run on Win32. Preferring it caused the probe to pick the
  // shell script over the working `.cmd` shim and report
  // `Coding-agent not_installed` even on a healthy Cursor install.
  const candidateExts = [...exts, ""];
  const dirs = pathVar.split(path.delimiter).filter((d) => d.length > 0);
  for (const dir of dirs) {
    for (const ext of candidateExts) {
      const candidate = path.join(dir, bin + ext);
      try {
        if (existsSync(candidate)) return candidate;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

export class CursorAgentAdapter implements CodingAgentAdapter {
  readonly id = "cursor-agent";
  private readonly extraArgs: string[];
  // The list we'll try at probe time (first success wins). Once probe
  // resolves the working form we cache it in `chosenInvocation` so
  // every subsequent `ask()` uses the same binary.
  private readonly candidates: ReadonlyArray<readonly string[]>;
  private chosenInvocation: readonly string[] | null = null;
  // Task #1477 — Absolute path of the resolved binary that probe()
  // validated, cached so every subsequent ask() spawns the exact same
  // executable (avoids a TOCTOU mismatch if PATH/PATHEXT changes
  // mid-session). Only populated on Windows; null on POSIX where the
  // OS-level PATH resolution in spawn() does the right thing.
  private chosenBinAbsPath: string | null = null;

  constructor(opts: {
    binPath?: string;
    invocation?: readonly string[];
    extraArgs?: string[];
  } = {}) {
    this.extraArgs = opts.extraArgs ?? [];
    if (opts.invocation && opts.invocation.length > 0) {
      this.candidates = [opts.invocation];
    } else if (opts.binPath) {
      // Back-compat: a single binPath becomes a single-candidate list.
      this.candidates = [[opts.binPath]];
    } else {
      this.candidates = DEFAULT_AGENT_CANDIDATES;
    }
  }

  // Test-only seam to assert which invocation was selected.
  /** @internal */
  _chosenInvocation(): readonly string[] | null {
    return this.chosenInvocation;
  }

  private describeInvocation(inv: readonly string[]): string {
    return inv.join(" ");
  }

  async probe(): Promise<CodingAgentProbeResult> {
    let lastAuthFailure: CodingAgentProbeResult | null = null;
    let lastUnknown: CodingAgentProbeResult | null = null;
    // Task #1533 — captured when a candidate exits 0 but the output
    // matches the Cursor editor's `--version` shape (help line / Electron
    // dump / 3+ lines). Preferred over auth/unknown because it's the
    // most actionable remediation we can surface.
    let lastEditorDetected: CodingAgentProbeResult | null = null;
    for (const inv of this.candidates) {
      const [bin, ...prefix] = inv;
      if (!bin) continue;
      // Task #1477 — On Windows, resolve `.cmd` / `.bat` shims via
      // PATHEXT ourselves; spawnSync doesn't do this. On POSIX this
      // returns null and we fall through to the regular PATH lookup.
      const resolvedAbs = resolveBinOnPath(bin);
      // Only skip on Windows when `bin` is a BARE command name (no
      // path separators, no drive prefix) AND PATHEXT lookup found
      // nothing — that's the same outcome as today's ENOENT. Explicit
      // relative / absolute paths (e.g. `./cursor-agent.cmd` or a
      // user-configured `codingAgent.binPath`) must still be delegated
      // to spawn so the OS can resolve them.
      const isBareCommand =
        !bin.includes("/") && !bin.includes("\\") && !/^[a-zA-Z]:/.test(bin);
      if (process.platform === "win32" && !resolvedAbs && isBareCommand) {
        continue;
      }
      const spawnBin = resolvedAbs ?? bin;
      let r;
      try {
        r = spawnSyncCompat(spawnBin, [...prefix, "--version"], { encoding: "utf-8" });
      } catch (err) {
        lastUnknown = {
          ok: false,
          reason: "not_installed",
          remediation:
            `Could not invoke \`${this.describeInvocation(inv)}\`: ${(err as Error).message}. ` +
            "Install Cursor 0.45+ from https://cursor.com, then run `cursor-agent login` (or `cursor agent login` on Cursor 3.x).",
        };
        continue;
      }
      if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") {
        // Try the next candidate — this binary just isn't on PATH.
        continue;
      }
      if (r.status !== 0) {
        const out = `${r.stderr ?? ""}\n${r.stdout ?? ""}`.toLowerCase();
        if (out.includes("login") || out.includes("auth")) {
          lastAuthFailure = {
            ok: false,
            reason: "not_authenticated",
            remediation: `Run \`${this.describeInvocation(inv)} login\` and follow the browser flow.`,
          };
          continue;
        }
        lastUnknown = {
          ok: false,
          reason: "unknown_error",
          remediation: `\`${this.describeInvocation(inv)} --version\` exited ${r.status}.`,
        };
        continue;
      }
      // Task #1533 — Positively identify the agent CLI before adopting
      // this candidate. On a typical Windows install with only the
      // editor on PATH, `cursor.cmd agent --version` exits 0 but the
      // editor prints its built-in help line — we must NOT cache that
      // as if it were the agent CLI (doing so leaks editor help text
      // through as `Sam ›` lines on every cadence tick AND triggers
      // the editor's sidebar agent to autonomously write code into
      // whatever folder we open as a side effect).
      const combined = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
      if (looksLikeCursorEditor(combined)) {
        lastEditorDetected = {
          ok: false,
          reason: "not_installed",
          remediation:
            `\`${this.describeInvocation(inv)} --version\` responded with editor output, ` +
            `not a cursor-agent version. ${EDITOR_REMEDIATION_SUFFIX}`,
        };
        continue;
      }
      if (!looksLikeCursorAgentVersion(combined)) {
        const preview = combined.trim().slice(0, 120).replace(/\s+/g, " ");
        lastUnknown = {
          ok: false,
          reason: "unknown_error",
          remediation:
            `\`${this.describeInvocation(inv)} --version\` did not look like a cursor-agent ` +
            `response (got ${JSON.stringify(preview)}). ${EDITOR_REMEDIATION_SUFFIX}`,
        };
        continue;
      }
      // Found a working invocation — cache it and return.
      this.chosenInvocation = inv;
      this.chosenBinAbsPath = resolvedAbs;
      const version = (r.stdout || r.stderr || "").trim().split("\n")[0];
      return { ok: true, ...(version ? { version } : {}) };
    }
    // Task #1533 — Prefer the editor-detected remediation over the
    // generic "not installed" / "unknown error" so the user sees the
    // actionable message ("install the standalone CLI") rather than a
    // dead-end "nothing found on PATH" when the editor IS on PATH.
    if (lastEditorDetected) return lastEditorDetected;
    // Auth failure on a known binary is more actionable than "not
    // installed" on an unknown one — surface it preferentially.
    if (lastAuthFailure) return lastAuthFailure;
    if (lastUnknown) return lastUnknown;
    const winHint =
      process.platform === "win32"
        ? " On Windows the runner looks for `cursor-agent.cmd` / `cursor.cmd` on PATH — " +
          "if you installed Cursor to a non-standard location, add its bin directory to PATH."
        : "";
    return {
      ok: false,
      reason: "not_installed",
      remediation:
        "Neither `cursor-agent` nor `cursor agent` was found on PATH. " +
        "Install Cursor 0.45+ from https://cursor.com, then run " +
        "`cursor-agent login` (or `cursor agent login` on Cursor 3.x)." +
        winHint,
    };
  }

  async ask(req: CodingAgentAsk): Promise<CodingAgentReply> {
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prepsavant-agent-"));
    const sysFile = path.join(tmpDir, "system.txt");
    fs.writeFileSync(sysFile, req.systemPrompt, "utf-8");
    // If ask() is called before probe() (shouldn't happen in cli-start
    // but defensive), fall back to the first candidate so we don't
    // crash on `null`.
    const inv = this.chosenInvocation ?? this.candidates[0] ?? ["cursor-agent"];
    const [bin, ...prefix] = inv;
    // Task #1477 — Prefer the absolute path probe() resolved on Windows
    // so we spawn the exact same shim it validated.
    const spawnBin = this.chosenBinAbsPath ?? bin;

    return await new Promise<CodingAgentReply>((resolve) => {
      const args = [
        ...prefix,
        "--no-stream",
        "--json",
        "--stdin",
        "--system-file",
        sysFile,
        ...this.extraArgs,
      ];
      let proc;
      try {
        proc = spawnCompat(spawnBin ?? "cursor-agent", args, { stdio: ["pipe", "pipe", "pipe"] });
      } catch {
        cleanup();
        resolve({ text: "" });
        return;
      }

      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          proc.kill("SIGKILL");
        } catch {
          /* noop */
        }
        cleanup();
        resolve({ text: "" });
      }, timeoutMs);

      proc.stdout.on("data", (b: Buffer) => {
        stdout += b.toString("utf-8");
      });
      proc.stderr.on("data", (b: Buffer) => {
        stderr += b.toString("utf-8");
      });
      proc.on("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        resolve({ text: "" });
      });
      proc.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        if (code !== 0) {
          resolve({ text: "" });
          return;
        }
        resolve({ text: parseAndSanitizeReply(stdout) });
      });

      try {
        proc.stdin.end(req.userPrompt, "utf-8");
      } catch {
        /* noop — close handler will fire */
      }

      function cleanup(): void {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          /* noop */
        }
        // referenced for diagnostics; do not surface stderr text to the user
        void stderr;
      }
    });
  }
}

// Pulled out so MockAgent can reuse the sanitization rules and tests
// can pin them.
export function parseAndSanitizeReply(stdout: string): string {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return "";
  let candidate = trimmed;
  // cursor-agent --json wraps the reply in {reply, model, ...}.
  try {
    const parsed = JSON.parse(trimmed) as { reply?: unknown };
    if (typeof parsed?.reply === "string") candidate = parsed.reply;
  } catch {
    // Plaintext mode — use as-is.
  }
  return sanitizeCoachLine(candidate);
}

export function sanitizeCoachLine(input: string): string {
  let s = input.trim();
  // Strip markdown code fences first so a trailing fence isn't mistaken
  // for surrounding backtick "quotes" by the next pass.
  s = s.replace(/```[\s\S]*?```/g, "").trim();
  // Strip surrounding straight or smart quotes (NOT backticks — those
  // are handled by the fence pass above).
  s = s.replace(/^["“']+|["”']+$/g, "").trim();
  // Drop leading "Sam:"/"Sam ›"/"Coach:" prefixes the model sometimes
  // adds because we asked it to speak as Sam.
  s = s.replace(/^(Sam|Coach)\s*[›:>\-—]\s*/i, "").trim();
  // Collapse multi-line replies to a single paragraph (keep the first
  // non-empty paragraph; the renderer is single-line per Sam beat).
  const firstPara = s.split(/\n{2,}/)[0] ?? s;
  s = firstPara.replace(/\s*\n\s*/g, " ").trim();
  if (s.length > REPLY_MAX_CHARS) s = s.slice(0, REPLY_MAX_CHARS).trim() + "…";
  return s;
}

// ---------------------------------------------------------------------
// CursorSdkAdapter — uses @cursor/sdk's persistent Agent so multiple
// host-reasoning ticks share conversation context, avoiding a cold
// LLM start on every cadence beat. Selected automatically when
// CURSOR_API_KEY is set, or explicitly via `codingAgent.kind: "cursor-sdk"`.
//
// Trade-off vs CursorAgentAdapter: requires a Cursor *API key* (paid
// programmatic-access tier) — the CLI shell-out works with a normal
// `cursor-agent login`. The SDK is loaded via dynamic import inside an
// `optionalDependencies` entry so an install that failed to build
// sqlite3 (the SDK's only native dep) doesn't break the runner — we
// fall back to a clear remediation in `probe()`.
// ---------------------------------------------------------------------

// Task #1562 — Pure-HTTP client over Cursor's cloud-agent API replaces
// the prior `@cursor/sdk` dependency (whose transitive `sqlite3` native
// module was the dominant source of install failures on `win32-arm64`).
// Surface contract: docs/cursor-http-api.md.
import {
  CursorHttpClient,
  CursorHttpError,
  type CursorHttpFetch,
} from "./cursor-http-client.js";

export class CursorSdkAdapter implements CodingAgentAdapter {
  // Stable id kept as `"cursor-sdk"` for backward compat with consumers
  // that branch on `agent.id` (cli-start.ts, startup-banner.ts, tests).
  // The name is historical; the implementation is now pure HTTP.
  readonly id = "cursor-sdk";
  private readonly apiKey: string;
  private readonly model: string | undefined;
  private readonly cliFallback: CursorAgentAdapter;
  private readonly cliFallbackOpts: {
    binPath?: string;
    invocation?: readonly string[];
    extraArgs?: string[];
  };
  private readonly clientVersion: string | undefined;
  private readonly baseUrl: string | undefined;
  private readonly fetchImpl: CursorHttpFetch | undefined;
  private client: CursorHttpClient | null = null;
  private agentId: string | null = null;
  // Once the HTTP probe fails (e.g. invalid/missing API key, hard
  // network error) we route every subsequent probe/ask/dispose call
  // through the CLI shell-out adapter. Preserves the
  // `_didFallBackToCli()` test seam from the pre-2.3 SDK adapter.
  private fellBackToCli = false;
  private probeError: string | null = null;

  constructor(opts: {
    apiKey: string;
    model?: string;
    /**
     * Historical option from the @cursor/sdk era (local-Agent passed a
     * cwd). The cloud-agent HTTP API has no cwd concept; kept in the
     * signature so existing call sites compile without churn.
     */
    cwd?: string;
    cliFallback?: { binPath?: string; invocation?: readonly string[]; extraArgs?: string[] };
    baseUrl?: string;
    clientVersion?: string;
    /** @internal Task #1562 — test-only fetch injection. */
    fetchImplForTests?: CursorHttpFetch;
  }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    void opts.cwd; // accepted for backward compat; unused on the HTTP path
    this.cliFallbackOpts = opts.cliFallback ?? {};
    this.cliFallback = new CursorAgentAdapter(this.cliFallbackOpts);
    this.baseUrl = opts.baseUrl;
    this.clientVersion = opts.clientVersion;
    this.fetchImpl = opts.fetchImplForTests;
  }

  private ensureClient(): CursorHttpClient {
    if (!this.client) {
      const o: ConstructorParameters<typeof CursorHttpClient>[0] = { apiKey: this.apiKey };
      if (this.baseUrl) o.baseUrl = this.baseUrl;
      if (this.clientVersion) o.clientVersion = this.clientVersion;
      if (this.fetchImpl) o.fetchImpl = this.fetchImpl;
      this.client = new CursorHttpClient(o);
    }
    return this.client;
  }

  private tripFallback(reason: string): void {
    if (this.fellBackToCli) return;
    this.fellBackToCli = true;
    this.probeError = reason;
    process.stderr.write(
      `[prepsavant] cursor cloud-agent API unavailable (${reason}); falling back to cursor-agent CLI for this session.\n`,
    );
  }

  async probe(): Promise<CodingAgentProbeResult> {
    if (this.fellBackToCli) return await this.cliFallback.probe();
    try {
      const me = await this.ensureClient().getMe({ timeoutMs: 5_000 });
      return { ok: true, version: `cursor-cloud (${me.apiKeyName})` };
    } catch (err) {
      const reason =
        err instanceof CursorHttpError ? `${err.code}:${err.status}` : (err as Error).message;
      this.tripFallback(reason);
      // Delegate to the CLI probe so the user gets the CLI's clearer
      // remediation message ("install Cursor / cursor-agent login")
      // instead of a dead-end HTTP error string.
      return await this.cliFallback.probe();
    }
  }

  async ask(req: CodingAgentAsk): Promise<CodingAgentReply> {
    if (this.fellBackToCli) return await this.cliFallback.ask(req);
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // The cloud agent has no separate system slot — concat the system
    // prompt with the per-turn user prompt so each call carries the
    // persona + the current directive intent. Multi-turn context
    // accumulates server-side because we reuse the same `agentId`
    // across subsequent `sendMessage` calls.
    const prompt = `${req.systemPrompt}\n\n---\n\n${req.userPrompt}`;
    const client = this.ensureClient();
    const askPromise = (async (): Promise<CodingAgentReply> => {
      try {
        let runId: string;
        if (!this.agentId) {
          const created = await client.createAgent({
            prompt,
            ...(this.model ? { model: this.model } : {}),
            timeoutMs,
          });
          this.agentId = created.agentId;
          runId = created.runId;
        } else {
          const sent = await client.sendMessage({
            agentId: this.agentId,
            prompt,
            ...(this.model ? { model: this.model } : {}),
            timeoutMs,
          });
          runId = sent.runId;
        }
        const run = await client.waitForRun(this.agentId, runId, {
          timeoutMs,
        });
        if (process.env["PREPSAVANT_DEBUG_CODING_AGENT"] === "1") {
          const preview = (run.result ?? "").slice(0, 120);
          process.stderr.write(
            `[prepsavant] cursor-cloud ask done status=${run.status} preview=${JSON.stringify(preview)}\n`,
          );
        }
        if (run.status !== "FINISHED") return { text: "" };
        return { text: sanitizeCoachLine(run.result ?? "") };
      } catch (err) {
        // 401/403 → permanent auth failure for this session. Trip
        // fallback so subsequent ticks don't keep hammering the API
        // with a known-bad key.
        if (err instanceof CursorHttpError && (err.status === 401 || err.status === 403)) {
          this.tripFallback(`${err.code}:${err.status}`);
          return await this.cliFallback.ask(req);
        }
        if (process.env["PREPSAVANT_DEBUG_CODING_AGENT"] === "1") {
          process.stderr.write(
            `[prepsavant] cursor-cloud ask error: ${(err as Error).message}\n`,
          );
        }
        return { text: "" };
      }
    })();
    const timeoutPromise = new Promise<CodingAgentReply>((resolve) => {
      const t = setTimeout(() => resolve({ text: "" }), timeoutMs);
      (t as { unref?: () => void }).unref?.();
    });
    return await Promise.race([askPromise, timeoutPromise]);
  }

  async dispose(): Promise<void> {
    // The HTTP client holds no persistent connection; nothing to release.
    // We deliberately do NOT cancel outstanding runs here — they'll
    // either land in cache for the user's next session or time out
    // server-side. Keep dispose() defined so consumers that branch on
    // `adapter.dispose?.()` still find it.
    this.agentId = null;
    this.client = null;
  }
  // Test-only seam: lets the unit tests assert which path serviced the
  // call (HTTP vs CLI fallback) without monkey-patching globals.
  /** @internal */
  _didFallBackToCli(): boolean {
    return this.fellBackToCli;
  }
  /** @internal */
  _probeError(): string | null {
    return this.probeError;
  }
}

// ---------------------------------------------------------------------
// MockAgent — used by tests AND by `--mock-agent` so an end-to-end
// session can run without a real Cursor install. Echoes the directive
// intent in a deterministic Sam-voice template.
// ---------------------------------------------------------------------
export class MockAgent implements CodingAgentAdapter {
  readonly id = "mock";
  async probe(): Promise<CodingAgentProbeResult> {
    return { ok: true, version: "mock-1.0.0" };
  }
  async ask(req: CodingAgentAsk): Promise<CodingAgentReply> {
    // Extract the intent line so the mock reply is shaped like a real
    // Sam line and the integration test can assert structure.
    const m = /Directive intent:\s*(.+)/i.exec(req.userPrompt);
    const intent = m?.[1]?.trim() ?? "Keep going.";
    return { text: sanitizeCoachLine(`(mock) ${intent}`) };
  }
}

// ---------------------------------------------------------------------
// Resolver: pick an adapter from explicit config / env / default.
// ---------------------------------------------------------------------
export function resolveCodingAgent(opts: {
  config?: CodingAgentConfig;
  forceMock?: boolean;
  env?: NodeJS.ProcessEnv;
}): CodingAgentAdapter {
  const env = opts.env ?? process.env;
  if (opts.forceMock || env["PREPSAVANT_MOCK_AGENT"] === "1") {
    return new MockAgent();
  }
  const cfg = opts.config ?? {};
  if (cfg.kind === "mock") return new MockAgent();

  // Hybrid selection: prefer the persistent SDK agent when the user has
  // a CURSOR_API_KEY set (or explicitly opted into "cursor-sdk"), and
  // fall back to the CLI shell-out otherwise. The SDK gives multi-turn
  // conversation context across cadence ticks; the CLI works with a
  // normal `cursor-agent login` (no API key needed).
  const apiKey = env["CURSOR_API_KEY"];
  if (cfg.kind === "cursor-sdk" || (cfg.kind == null && apiKey)) {
    if (apiKey) {
      return new CursorSdkAdapter({
        apiKey,
        ...(cfg.model ? { model: cfg.model } : {}),
        // Forward the CLI tuning so the runtime fallback (when sqlite3
        // is missing on this host) honours the same binPath/extraArgs
        // the user configured for the CLI path.
        cliFallback: {
          ...(cfg.binPath ? { binPath: cfg.binPath } : {}),
          ...(cfg.extraArgs ? { extraArgs: cfg.extraArgs } : {}),
        },
      });
    }
    // kind explicitly cursor-sdk but no key — fall through to CLI with
    // a clear stderr breadcrumb instead of failing hard.
    process.stderr.write(
      "[prepsavant] codingAgent.kind=cursor-sdk but CURSOR_API_KEY is not set; falling back to cursor-agent CLI.\n",
    );
  }
  return new CursorAgentAdapter({
    ...(cfg.binPath ? { binPath: cfg.binPath } : {}),
    ...(cfg.extraArgs ? { extraArgs: cfg.extraArgs } : {}),
  });
}
