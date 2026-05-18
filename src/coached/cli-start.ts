// CLI flow for Coached mode: `prepsavant start [--mode coached]`.
//
// Task #1388 — Reusable per-question folders.
// The user downloads `<question-slug>-<lang>/` from the portal. The
// folder contains `.prepsavant/question.json` (HMAC-signed manifest,
// no sessionId). Running `prepsavant start` from inside the folder
// reads the manifest and mints a fresh coached session each
// invocation. If a live session for the same (owner, question)
// already exists, the runner prompts the user (default-Yes) to end
// it and start a new one. `--replace` skips the prompt; `--no-replace`
// aborts when an active session exists.
//
// Task #1401 — The runner owns the terminal for Coached sessions: we
// take over stdin/stdout, print the kickoff brief (with the legacy
// HOST INSTRUCTIONS clause stripped), spin up a TerminalCoach that
// wires the proactive cadence loop into a colored Sam › transcript,
// and run a readline loop. LLM reasoning shells out to cursor-agent.
//
// `--session-pack` is retained as a deprecation stub for one release
// so users on older docs get a clean migration message.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { ADAPTER_VERSION, readConfig } from "../config.js";
import { SamApi, ApiError } from "../api.js";
import { startCoachedSession, endCoachedSession } from "./session.js";
import { writeLastSession } from "../last-session.js";
import {
  startTerminalCoach,
  HOST_REASONING_PERSONA,
  OFFLINE_MODE_NOTICE,
} from "./terminal-coach.js";
import { resolveCodingAgent } from "./coding-agent.js";
import { PersonaCache } from "../persona-cache.js";
import {
  makeColors,
  renderStartupBanner,
} from "./startup-banner.js";
import { scaffoldFilenameForLanguage } from "@workspace/api-zod";

export async function runCoachedStart(
  flags: Record<string, string | boolean>,
): Promise<void> {
  const cfg = readConfig();
  const api = new SamApi(cfg);

  const isJson = !!flags.json;
  const sessionPackPath = flags["session-pack"] as string | undefined;
  const replaceFlag = flags["replace"] === true;
  const noReplaceFlag = flags["no-replace"] === true;
  const useMockAgent = !!flags["mock-agent"];
  const cwd = typeof flags["cwd"] === "string" ? (flags["cwd"] as string) : process.cwd();

  // Task #1388 — `--session-pack` deprecation stub. The legacy single-use
  // session pack is retired; tell the user how to migrate and exit.
  if (sessionPackPath) {
    fail(
      isJson,
      "session_pack_retired",
      [
        "`--session-pack` was retired in favour of reusable per-question packages.",
        "Re-download the question from your dashboard — you'll get a folder",
        "with a `.prepsavant/question.json` manifest that you can run from",
        "as many times as you like with just `prepsavant start`.",
      ].join("\n"),
    );
    return;
  }

  if (!cfg.token) {
    fail(isJson, "not_authenticated", "No device token. Run `prepsavant auth` first.");
    return;
  }

  // Look for `.prepsavant/question.json` in the current directory.
  // When found, drive the new question-package flow. Otherwise print
  // the install hint.
  const manifestPath = findQuestionManifest(cwd);
  if (manifestPath) {
    await runQuestionPackageStart({
      api,
      manifestPath,
      isJson,
      useMockAgent,
      replaceFlag,
      noReplaceFlag,
    });
    return;
  }

  const base = cfg.apiBaseUrl.replace(/\/+$/, "");
  const lines: string[] = [
    `prepsavant ${ADAPTER_VERSION} — Coached mode`,
    "",
  ];

  // Task #1478 — when the user runs from the wrong folder, look in the
  // obvious nearby places (~/Downloads, ~/Desktop, CWD's parent, CWD's
  // children — one level deep on each) for already-unzipped question
  // packages and tell them exactly where to `cd`. Per user choice we
  // only hint; we never auto-cd or auto-start.
  const nearby = findQuestionPackagesNearby(cwd);
  if (nearby.length > 0) {
    lines.push(
      nearby.length === 1
        ? "Looks like you're in the wrong folder. I found a question package nearby:"
        : `Looks like you're in the wrong folder. I found ${nearby.length} question packages nearby:`,
      "",
    );
    for (const pkg of nearby) {
      const title = pkg.title ? ` — ${pkg.title}` : "";
      const rendered = renderCdCommand(pkg.dir);
      if (rendered === null) {
        // Path can't be rendered safely on one line (newline / NUL).
        // Fall back to a manual instruction so we never emit a
        // copy-paste command that could execute unintended tokens.
        lines.push(`  (folder has an unusual name — cd into it manually) ${pkg.dir}${title}`);
      } else {
        lines.push(`  ${rendered}${title}`);
      }
    }
    lines.push("");
    lines.push("If none of those is the one you wanted, re-download from the dashboard:");
    lines.push(`  ${base}/dashboard`);
    process.stdout.write(lines.join("\n") + "\n");
    return;
  }

  lines.push(
    "Coached sessions are downloaded as a reusable question package",
    "from the dashboard. Pick a question, click \"Start practice\",",
    "unzip the folder, then `cd` in and run:",
    "",
    "  prepsavant start",
    "",
    "Each invocation mints a fresh session — the folder is reusable.",
    "If a live session for the same question already exists, the runner",
    "will ask whether to end it and start over. Pass `--replace` to skip",
    "the prompt or `--no-replace` to abort instead.",
    "",
    "The terminal becomes Sam — proactive nudges, hints, and time warnings",
    "are spoken straight into your shell. LLM reasoning shells out to",
    "`cursor-agent`. Ctrl+C, or type `quit`, `exit`, `:q`, `stop`, `end`, or `bye` to end the session.",
    "",
    `Dashboard: ${base}/dashboard`,
    `Docs: ${base}/docs/coached`,
  );
  process.stdout.write(lines.join("\n") + "\n");
}

interface QuestionManifestShape {
  v?: unknown;
  questionId?: unknown;
  questionTitle?: unknown;
  language?: unknown;
  apiBaseUrl?: unknown;
  ownerId?: unknown;
  issuedAt?: unknown;
  hmac?: unknown;
}

async function runQuestionPackageStart(args: {
  api: SamApi;
  manifestPath: string;
  isJson: boolean;
  useMockAgent: boolean;
  replaceFlag: boolean;
  noReplaceFlag: boolean;
}): Promise<void> {
  const { api, manifestPath, isJson, useMockAgent, replaceFlag, noReplaceFlag } = args;
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, "utf-8");
  } catch (err) {
    fail(
      isJson,
      "question_package_read_failed",
      `Could not read ${manifestPath}: ${(err as Error).message}`,
    );
    return;
  }
  let manifest: QuestionManifestShape;
  try {
    manifest = JSON.parse(raw) as QuestionManifestShape;
  } catch (err) {
    fail(
      isJson,
      "question_package_parse_failed",
      `Manifest is not valid JSON: ${(err as Error).message}. Re-download the question package from the dashboard.`,
    );
    return;
  }
  const questionId = typeof manifest.questionId === "string" ? manifest.questionId : "";
  if (!questionId || typeof manifest.hmac !== "string") {
    fail(
      isJson,
      "question_package_invalid",
      "Manifest is missing required fields. Re-download the question package from the dashboard.",
    );
    return;
  }

  // Resolve replace policy. CLI flag wins; otherwise prompt when there
  // is an active session.
  let replace = false;
  try {
    const active = await api.getActiveSessionForQuestion(questionId);
    if (active.active) {
      if (noReplaceFlag) {
        fail(
          isJson,
          "active_session_exists",
          `An active coached session (${active.active.id}) already exists for this question. Aborted because of --no-replace.`,
        );
        return;
      }
      if (replaceFlag) {
        replace = true;
      } else if (isJson) {
        // Non-interactive: refuse rather than block on a prompt.
        fail(
          isJson,
          "active_session_exists",
          `An active coached session (${active.active.id}) already exists for this question. Re-run with --replace to end it and start a new one.`,
        );
        return;
      } else {
        replace = await promptYesDefault(
          `An active coached session for this question already exists (${active.active.id}). End it and start a new one?`,
        );
        if (!replace) {
          process.stdout.write("Aborted — keeping the existing session.\n");
          return;
        }
      }
    } else {
      // No active session — replace flag is harmless.
      replace = replaceFlag;
    }
  } catch (err) {
    // If the active-check fails, log and continue: the server-side
    // replace gate will still 409 if there's an active row and replace
    // is false.
    process.stderr.write(
      `[mcp-runner] active-session check failed (${(err as Error).message}); continuing.\n`,
    );
  }

  let res: Awaited<ReturnType<SamApi["createSessionFromQuestionPackage"]>>;
  try {
    res = await api.createSessionFromQuestionPackage({
      manifest,
      replace,
    });
  } catch (err) {
    if (err instanceof ApiError) {
      const code = describeApiError(err);
      const dashboardUrl = buildDashboardUrl(manifest);
      if (err.status === 409 && code === "active_session_exists") {
        fail(
          isJson,
          "active_session_exists",
          [
            "An active coached session for this question already exists.",
            "Re-run with `--replace` to end it and start a new one,",
            "or `--no-replace` to abort.",
          ].join("\n"),
        );
        return;
      }
      if (err.status === 403 && code === "manifest_owner_mismatch") {
        fail(
          isJson,
          "manifest_owner_mismatch",
          [
            "This question package was downloaded by a different account.",
            "Re-download from your own dashboard:",
            `  ${dashboardUrl}`,
          ].join("\n"),
        );
        return;
      }
      if (err.status === 400 && code === "manifest_signature_invalid") {
        fail(
          isJson,
          "manifest_signature_invalid",
          [
            "The question package manifest signature is invalid (likely hand-edited).",
            `Re-download a fresh copy from ${dashboardUrl}.`,
          ].join("\n"),
        );
        return;
      }
      fail(
        isJson,
        "start_failed",
        `Failed to start session (HTTP ${err.status}): ${code}`,
      );
      return;
    }
    fail(isJson, "start_failed", `Failed to start session: ${(err as Error).message}`);
    return;
  }

  const sessionId = res.session.id;
  const packRoot = path.resolve(path.dirname(path.dirname(manifestPath)));

  // Task #1479 — drop a `.prepsavant/last-session.json` breadcrumb so
  // any folder-aware follow-up command (today: `upload-cursor-export`,
  // tomorrow: more) can resolve the session id without flags. Best
  // effort — failures here never block the live session.
  writeLastSession(packRoot, {
    sessionId,
    mode: "coached",
    questionId: res.question.id,
    questionTitle: res.question.title,
    startedAt: new Date().toISOString(),
  });

  if (isJson) {
    process.stdout.write(
      JSON.stringify({
        sessionId,
        mode: "coached",
        startedAt: new Date().toISOString(),
        ...(res.replacedSessionId
          ? { replacedSessionId: res.replacedSessionId }
          : {}),
      }) + "\n",
    );
    return;
  }

  const adoptedState = startCoachedSession({
    sessionId,
    questionId: res.question.id,
    questionTitle: res.question.title,
    questionPrompt: res.question.prompt,
    workspaceDir: packRoot,
  });

  const cfg = readConfig();
  const agent = resolveCodingAgent({
    ...(cfg.codingAgent ? { config: cfg.codingAgent } : {}),
    forceMock: useMockAgent,
  });

  let disposed = false;
  const disposeAgent = async () => {
    if (disposed) return;
    disposed = true;
    if (typeof agent.dispose === "function") {
      try {
        await agent.dispose();
      } catch {
        /* noop */
      }
    }
  };

  try {
    // Task #1506 — Probe the coding agent once at session start. A
    // failed probe used to be a hard error that aborted the session;
    // we now treat it as "offline mode" and start the coach anyway
    // with `offlineMode: true`. The terminal coach surfaces a one-time
    // notice and `renderDirectiveAsSamLine` falls back to the
    // directive's `suggestedWording` (canned verbatim) instead of
    // calling `agent.ask()`. The user can still run --mock-agent or
    // run `cursor-agent login` and restart for a richer experience,
    // but a probe failure no longer blocks practice.
    const probe = await agent.probe();
    const offlineMode = !probe.ok;
    if (offlineMode) {
      process.stderr.write(
        `[prepsavant] coding-agent ${probe.reason ?? "unavailable"}: ${probe.remediation ?? "see runner logs."} — continuing in offline mode (canned Sam lines only).\n`,
      );
    }

    const language =
      typeof manifest.language === "string" && manifest.language.length > 0
        ? (manifest.language as string)
        : null;
    const scratchRelPath = language
      ? `scaffolding/${language}/${scaffoldFilenameForLanguage(language)}`
      : null;
    const colors = makeColors(process.stdout);
    // Task #1499 — fetch the "How this session works" guide from the
    // SAM_VOICE registry so the terminal banner and the dashboard
    // Mode Picker render from the same source of truth. Best-effort:
    // any failure (older api-server replica, transient network blip)
    // just suppresses the section — never blocks session start.
    let instructionGuide: string | null = null;
    try {
      const voice = await api.getSamVoice("practice_coached_guide");
      instructionGuide = voice?.text ?? null;
    } catch {
      instructionGuide = null;
    }
    // Task #1507 — fetch the informative CURSOR_API_KEY tip from
    // SAM_VOICE ONLY when we're on the shell-out adapter path AND
    // the env var is not already set. Same best-effort handling as
    // the instruction guide above: a failure just falls back to the
    // banner's built-in one-line hint, never blocks session start.
    const apiKeySet =
      typeof process.env["CURSOR_API_KEY"] === "string" &&
      process.env["CURSOR_API_KEY"].length > 0;
    const usingPersistentAgent = agent.id === "cursor-sdk";
    let cursorApiKeyTip: string | null = null;
    if (!usingPersistentAgent && !apiKeySet) {
      try {
        const tip = await api.getSamVoice("cursor_api_key_tip");
        cursorApiKeyTip = tip?.text ?? null;
      } catch {
        cursorApiKeyTip = null;
      }
    }
    process.stdout.write(
      renderStartupBanner(
        {
          adapterVersion: ADAPTER_VERSION,
          sessionId,
          packRoot,
          scratchRelPath,
          kickoffBrief: res.kickoffBriefVerbatim ?? null,
          questionTitle: res.question.title ?? null,
          // Surface the persistent-context upgrade hint exactly when we
          // resolved to the CLI shell-out path AND the key isn't
          // already exported. The SDK adapter (and any env that
          // already has CURSOR_API_KEY set) gives multi-turn context
          // for free, so we suppress the tip there.
          usingPersistentAgent: usingPersistentAgent || apiKeySet,
          cursorApiKeyTip,
          instructionGuide,
        },
        colors,
      ),
    );

    if (!process.stdin.isTTY && adoptedState.targetDurationMs == null) {
      fail(
        isJson,
        "non_tty_question_package",
        "Refusing to start an open-ended session from a non-TTY shell. Use --json or run from an interactive terminal.",
      );
      return;
    }

    // Task #1506 r2 — server-edit-without-runner-publish requirement:
    // pull the host-reasoning persona + offline notice text from the
    // SAM_VOICE registry (via PersonaCache) so admins can re-tune
    // Sam's coaching voice without shipping a new runner. PersonaCache
    // falls back to the bundled constants on transient fetch failure,
    // so a 5xx / 401 / offline-network never blocks session start.
    const personaCache = new PersonaCache(api);
    const [personaText, offlineNoticeText] = await Promise.all([
      personaCache.getVoice("coached_host_reasoning_persona", HOST_REASONING_PERSONA),
      personaCache.getVoice("coached_offline_mode_notice", OFFLINE_MODE_NOTICE),
    ]);
    const coach = startTerminalCoach({
      state: adoptedState,
      agent,
      offlineMode,
      personaText,
      offlineNoticeText,
    });
    const reason = await coach.done;

    await disposeAgent();

    const finalState = endCoachedSession(sessionId);
    const recapDraft = finalState
      ? {
          sessionId,
          startedAt: finalState.startedAt,
          endedAt: Date.now(),
          targetDurationMs: finalState.targetDurationMs,
          aiAssistCount: finalState.aiAssistCount,
          aiAssistSummaries: finalState.aiAssistSummaries,
          hintLevelFired: finalState.hintLevelFired,
          events: finalState.recapEvents,
          endReason: reason,
        }
      : undefined;
    try {
      await api.endSession(
        sessionId,
        recapDraft ? { recapDraft } : undefined,
      );
    } catch (err) {
      process.stderr.write(
        `[mcp-runner] end-session POST failed (${(err as Error).message}); session will be reaped server-side by the stale-session sweeper.\n`,
      );
    }

    // Task #1561 — Session-end summary of SDK calls saved by the
    // skip-SDK-on-empty-tick heuristic. Stashed on the state by
    // startTerminalCoach; missing on adapters that don't go through
    // the terminal coach path.
    const sdkStats = (finalState as unknown as {
      sdkCallStats?: { skippedEmptyTicks: number };
    } | null)?.sdkCallStats;
    if (sdkStats && sdkStats.skippedEmptyTicks > 0) {
      process.stdout.write(
        `[mcp-runner] cadence: skipped ${sdkStats.skippedEmptyTicks} SDK call(s) on pure-idle ticks (templated nudge fired instead).\n`,
      );
    }

    process.stdout.write(`\nSession ended (${reason}). See you next time.\n`);
  } finally {
    await disposeAgent();
  }
}

// Task #1401 — strip the legacy "HOST INSTRUCTIONS — SPLIT-LOOP RELAY
// PROTOCOL …" block from the kickoff brief before printing it. Those
// clauses were written to instruct an MCP host (Cursor's AI) on how to
// drive the coached_* tool family; in the runner-driven terminal flow
// the runner IS the host, so showing the prose to the user is just
// confusing noise.
//
// @deprecated Task #1400 — the api-server now splits the directive
// block out into a separate `hostInstructionsVerbatim` field, so the
// `kickoffBriefVerbatim` payload no longer contains a HOST
// INSTRUCTIONS section to strip. Kept here as a defensive
// belt-and-braces against pre-Task-#1400 api-server replicas during
// the rollout window (and as a safety net against any future regression
// that re-merges the directive block back into the brief). Safe to
// delete once every api-server replica is known to ship the split
// payload.
//
// Cuts everything from the first line that begins with "HOST
// INSTRUCTIONS" through the end of the brief (or, if the marker isn't
// present, leaves the brief untouched).
export function stripHostInstructions(brief: string): string {
  const idx = brief.search(/^HOST INSTRUCTIONS\b/m);
  if (idx === -1) return brief.trim();
  return brief.slice(0, idx).replace(/\n+---\n*$/, "").trimEnd();
}

function buildDashboardUrl(manifest: { apiBaseUrl?: unknown }): string {
  const raw = typeof manifest.apiBaseUrl === "string" ? manifest.apiBaseUrl : "";
  const trimmed = raw.replace(/\/+$/, "");
  if (trimmed.length === 0) return "your PrepSavant dashboard";
  return `${trimmed}/dashboard`;
}

function findQuestionManifest(cwd: string): string | null {
  const candidate = path.join(cwd, ".prepsavant", "question.json");
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    return candidate;
  }
  return null;
}

export interface NearbyQuestionPackage {
  dir: string;
  manifestPath: string;
  title: string | null;
}

// Task #1478 — search a small, predictable set of "obvious" locations
// for already-unzipped question packages so the runner can tell the
// user exactly where to `cd` when they invoke from the wrong folder.
// Exported for testability. Tolerant of permission errors / missing
// dirs — those are skipped silently.
//
// Search roots (one level deep on each — we look for
// `<root>/<child>/.prepsavant/question.json`):
//   1. CWD itself (already handled by findQuestionManifest, listed
//      here so its immediate children are scanned too).
//   2. CWD's parent directory (so siblings of the user's current dir
//      get picked up — common when they `cd` into a sibling repo).
//   3. ~/Downloads, ~/Desktop, ~/Documents (where browsers drop zips).
//
// Returns at most 5 entries to keep the hint readable.
//
// `opts.homedir` is a test seam — production callers pass nothing and
// we resolve via os.homedir(). Reassigning os.homedir on the imported
// ESM module is not allowed at runtime, so the seam lives here.
export function findQuestionPackagesNearby(
  cwd: string,
  opts?: { homedir?: string | null },
): NearbyQuestionPackage[] {
  const roots = new Set<string>();
  roots.add(cwd);
  try {
    roots.add(path.dirname(cwd));
  } catch {
    // ignore — defensive.
  }
  const home =
    opts && Object.prototype.hasOwnProperty.call(opts, "homedir")
      ? opts.homedir ?? null
      : safeHomedir();
  if (home) {
    for (const sub of ["Downloads", "Desktop", "Documents"]) {
      roots.add(path.join(home, sub));
    }
  }

  const seen = new Set<string>();
  const found: NearbyQuestionPackage[] = [];
  for (const root of roots) {
    let children: string[];
    try {
      children = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const child of children) {
      const dir = path.join(root, child);
      const manifestPath = path.join(dir, ".prepsavant", "question.json");
      let isFile = false;
      try {
        isFile = fs.statSync(manifestPath).isFile();
      } catch {
        continue;
      }
      if (!isFile) continue;
      // Deduplicate by manifest realpath in case multiple roots
      // resolve to the same directory (e.g. cwd === ~/Downloads).
      let key: string;
      try {
        key = fs.realpathSync(manifestPath);
      } catch {
        key = manifestPath;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ dir, manifestPath, title: readManifestTitle(manifestPath) });
      if (found.length >= 5) return found;
    }
  }
  return found;
}

function safeHomedir(): string | null {
  try {
    const home = os.homedir();
    return typeof home === "string" && home.length > 0 ? home : null;
  } catch {
    return null;
  }
}

function readManifestTitle(manifestPath: string): string | null {
  try {
    const raw = fs.readFileSync(manifestPath, "utf-8");
    const parsed = JSON.parse(raw) as { questionTitle?: unknown };
    if (typeof parsed.questionTitle === "string" && parsed.questionTitle.trim().length > 0) {
      return parsed.questionTitle.trim();
    }
  } catch {
    // Tolerant: a malformed manifest still counts as "a package is here",
    // we just don't decorate the line with a title.
  }
  return null;
}

// Render a `cd <path> && prepsavant start` line that is safe to
// copy-paste into a POSIX shell. Always double-quotes the path and
// backslash-escapes the four characters that retain special meaning
// inside POSIX double quotes (`$`, backtick, `"`, `\`). Windows cmd
// and PowerShell will tolerate double quotes around a path that
// otherwise contains no quote characters of their own.
//
// Returns null when the path contains a newline or NUL byte — those
// can't be quoted safely on one line in either shell family, and the
// caller falls back to a "cd into it manually" instruction instead of
// emitting a copy-pasteable command.
//
// This matters because we surface paths we discovered by scanning
// ~/Downloads et al — a maliciously-named folder there must not be
// able to turn the hint into an arbitrary shell command.
export function renderCdCommand(p: string): string | null {
  if (/[\n\0]/.test(p)) return null;
  const escaped = p.replace(/[\\"$`]/g, (ch) => "\\" + ch);
  return `cd "${escaped}" && prepsavant start`;
}

// Exported for tests (Task #1411) so the default-Yes contract for the
// active-session prompt can be exercised against a fake TTY without
// reaching for the full runCoachedStart flow. Production callers in
// runQuestionPackageStart still pass no opts, which preserves the
// historical behaviour of reading from process.stdin/stdout.
export async function promptYesDefault(
  question: string,
  opts?: {
    input?: NodeJS.ReadableStream & { isTTY?: boolean };
    output?: NodeJS.WritableStream;
  },
): Promise<boolean> {
  const input = opts?.input ?? process.stdin;
  const output = opts?.output ?? process.stdout;
  if (!input.isTTY) return false;
  const rl = readline.createInterface({
    input,
    output,
  });
  try {
    const answer: string = await new Promise((resolve) => {
      rl.question(`${question} [Y/n] `, (a: string) => resolve(a));
    });
    const trimmed = answer.trim().toLowerCase();
    return trimmed === "" || trimmed === "y" || trimmed === "yes";
  } finally {
    rl.close();
  }
}

function describeApiError(err: ApiError): string {
  const body = err.body as Record<string, unknown> | null;
  if (body && typeof body === "object" && typeof body["error"] === "string") {
    return body["error"] as string;
  }
  return err.message;
}

function fail(isJson: boolean, code: string, message: string): void {
  if (isJson) {
    process.stderr.write(JSON.stringify({ error: code, message }) + "\n");
  } else {
    process.stderr.write(message + "\n");
  }
  process.exitCode = 1;
}
