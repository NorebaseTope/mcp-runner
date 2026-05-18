#!/usr/bin/env node
import * as defaultFs from "node:fs";
// Entry point for the `prepsavant` bin. Subcommands:
//   prepsavant install [--host cursor] [--dry-run]
//                      Cursor is the only supported install host (Task #1175).
//                      Passing a retired host id (claude, claude_code, codex)
//                      surfaces a migration error.
//   prepsavant auth [--no-browser] [--api-base <url>]
//   prepsavant doctor [--json]
//   prepsavant clean-sandbox-cache [--dry-run] [--stale-age-days <n>] [--json]
//   prepsavant mcp        (default — runs the MCP server on stdio)
import { runAuth } from "./auth.js";
import { install, type HostId } from "./installer.js";
import {
  runDoctor,
  formatDoctor,
  formatRunnerUpdateAdvisory,
} from "./doctor.js";
import { ADAPTER_VERSION, readConfig } from "./config.js";
import { SamApi } from "./api.js";

interface ParsedArgs {
  command: string;
  flags: Record<string, string | boolean>;
  positional: string[];
}

// Task #1479 — exported, pure dispatch decision for `prepsavant start`.
//
// Centralises the routing logic the CLI uses to pick between the
// coached folder launcher, the new AI-Assisted folder launcher, and
// the legacy AI-Assisted-retired banner. Splitting it out as a pure
// function lets us cover every combination of (explicit --mode flag,
// folder manifest present, manifest mode) in unit tests without
// shelling out to the CLI.
//
// Routing matrix:
//
//   explicit --mode  | folder manifest | manifest mode | decision
//   -----------------+-----------------+---------------+---------------------
//   none             | absent          | n/a           | coached (legacy)
//   none             | present         | coached       | coached + manifest
//   none             | present         | ai_assisted   | ai-assisted-folder
//   ai-assisted      | absent          | n/a           | ai-assisted-retired
//   ai-assisted      | present         | * (any)       | ai-assisted-folder
//   coached          | * (any)         | * (any)       | coached
//
// The explicit flag ALWAYS wins over the manifest sniff so power
// users can override; the only reason to even sniff when the flag is
// present is to satisfy the "explicit --mode ai-assisted from inside
// a valid package folder must reach the AI-Assisted launcher"
// requirement (Task #1479).
export type StartDispatchDecision =
  | { kind: "coached" }
  | { kind: "ai-assisted-folder"; manifestPath: string }
  | { kind: "ai-assisted-retired" };

export function decideStartDispatch(args: {
  flags: Record<string, string | boolean>;
  cwd: string;
  // Injectable for tests; production callers omit them and get the
  // real `node:fs` + `sniffManifestMode` implementations.
  fsImpl?: {
    existsSync(p: string): boolean;
    statSync(p: string): { isFile(): boolean };
  };
  sniff?: (manifestPath: string) => "coached" | "ai_assisted";
}): StartDispatchDecision {
  const { flags, cwd } = args;
  const explicitMode =
    (flags["mode"] as string | undefined) ??
    (flags["ai-assisted"] ? "ai-assisted" : undefined);

  const candidate = `${cwd.replace(/\/+$/, "")}/.prepsavant/question.json`;
  let folderManifestPath: string | null = null;
  try {
    const fsImpl = args.fsImpl ?? defaultFs;
    if (fsImpl.existsSync(candidate) && fsImpl.statSync(candidate).isFile()) {
      folderManifestPath = candidate;
    }
  } catch {
    folderManifestPath = null;
  }

  if (explicitMode === "ai-assisted") {
    if (folderManifestPath) {
      return { kind: "ai-assisted-folder", manifestPath: folderManifestPath };
    }
    return { kind: "ai-assisted-retired" };
  }
  if (explicitMode === "coached") {
    return { kind: "coached" };
  }
  // No explicit flag: sniff the folder manifest if one exists, fall
  // back to coached otherwise (preserves the historical default for
  // users not inside a question-package folder).
  if (folderManifestPath) {
    const sniff = args.sniff ?? sniffManifestModeSync;
    if (sniff(folderManifestPath) === "ai_assisted") {
      return { kind: "ai-assisted-folder", manifestPath: folderManifestPath };
    }
  }
  return { kind: "coached" };
}

// Synchronous mode sniff — duplicated from
// `ai-assisted/cli-start.ts::sniffManifestMode` so `decideStartDispatch`
// can stay pure-sync (the CLI dispatch path runs before any async
// dynamic import is awaited, and we don't want to pay the import cost
// just to decide whether to take the coached vs ai_assisted branch).
function sniffManifestModeSync(
  manifestPath: string,
): "coached" | "ai_assisted" {
  try {
    const raw = defaultFs.readFileSync(manifestPath, "utf-8");
    const parsed = JSON.parse(raw) as { mode?: unknown };
    return parsed.mode === "ai_assisted" ? "ai_assisted" : "coached";
  } catch {
    return "coached";
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { command: "mcp", flags: {}, positional: [] };
  if (argv.length === 0) return out;
  let i = 0;
  const first = argv[i];
  if (first !== undefined && !first.startsWith("-")) {
    out.command = first;
    i++;
  }
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        out.flags[key] = next;
        i++;
      } else {
        out.flags[key] = true;
      }
    } else if (a === "-w") {
      out.flags["watch"] = true;
    } else {
      out.positional.push(a);
    }
  }
  return out;
}

const HELP = `prepsavant ${ADAPTER_VERSION}

PrepSavant local runner — Cursor-first as of v1 (Task #1175). The
\`prepsavant install\` install path supports Cursor only; the older
Claude Code, Codex, and Claude Desktop install targets were retired.

Usage:
  prepsavant start   [--mode coached|ai-assisted]
                                      Start a session. Defaults to coached if --mode is omitted.
                    [--ai-assisted]   Alias for --mode ai-assisted (backwards-compat)
                    [--json]          Print {sessionId,tool,startedAt} JSON to stdout on success;
                                      {"error":"..."} to stderr on failure (for scripts/CI)
                    [--question-id <id>] Pre-select the problem by id
                    [--replace]       (coached only) End any active coached session for
                                      the same question without prompting, then start a
                                      fresh one. Use from inside an unzipped question
                                      package folder (Task #1388).
                    [--no-replace]    (coached only) Abort if an active coached session
                                      already exists for the same question.
                    [--accept-consent] Auto-accept the session consent dialog
                    [--cleanup-stale-hooks] Auto-remove stale hooks from a prior crashed session
  prepsavant status  [<session-id>]   Show hook channels, events, and integrity for a live session
                    [--watch] [-w]    (defaults to the most recent active session in this workspace)
                    [--interval <s>]  Re-render every <s> seconds in --watch mode (default 5, min 1)
                    [--json]          Print the full status payload as JSON to stdout (one-shot only)
  prepsavant upload-cursor-export
                    --session-id <id>   The session to attach the export to
                    [--file <path>]     Upload a specific file (skip auto-discovery)
                    [--workspace <dir>] Limit auto-discovery to this directory (default cwd)
                    [--json]            Print result JSON to stdout / errors to stderr
  prepsavant install [--host cursor] [--dry-run] [--no-kill]
                                      Install (or upgrade) the sam MCP server
                                      entry in Cursor's mcp.json. Cursor is the
                                      only supported install host as of Task
                                      #1175 — passing claude_code/claude/codex
                                      surfaces a migration error.
                                      By default the installer auto-stops any
                                      active Sam runner before patching
                                      (Task #1205). Pass --no-kill to preserve
                                      the strict pre-1205 refusal instead.
  prepsavant auth    [--no-browser] [--api-base <url>]
  prepsavant doctor  [--json]
                    [--no-auto-prune]         Skip the silent stale-hash sandbox-cache prune
                                              (Task #1259). Default behavior removes stale-hash
                                              dirs only — never the active dir.
  prepsavant clean-sandbox-cache
                    [--dry-run]               Report what would be removed without touching disk
                    [--stale-age-days <n>]    Also evict the active-hash dir when it hasn't been
                                              touched in <n> days (default: don't age-evict)
                    [--json]                  Print result JSON instead of the human summary
  prepsavant mcp     (default — runs the MCP server on stdio)
`;

async function main(): Promise<void> {
  const { command, flags, positional } = parseArgs(process.argv.slice(2));

  // Task #1263 — opportunistically GC stale per-language sandbox cache dirs
  // (rust/go/etc. can balloon to hundreds of MB across harness bumps). The
  // helper is gated by a debounce stamp so it only does real work once per
  // 24h, and swallows all errors so a flaky filesystem can never break the
  // foreground command. We skip it for `clean-sandbox-cache` (the user is
  // already cleaning) and for `help`/`version` (purely cosmetic commands).
  if (
    command !== "clean-sandbox-cache" &&
    command !== "help" &&
    command !== "version" &&
    !flags.help &&
    !flags.version
  ) {
    try {
      const { pruneSandboxCacheOpportunistic } = await import(
        "./sandbox/cache-prune.js"
      );
      pruneSandboxCacheOpportunistic();
    } catch {
      // Never let cache GC break the CLI.
    }
  }

  if (command === "help" || flags.help) {
    process.stdout.write(HELP);
    return;
  }

  if (command === "version" || flags.version) {
    process.stdout.write(`${ADAPTER_VERSION}\n`);
    return;
  }

  if (command === "start") {
    const decision = decideStartDispatch({
      flags,
      cwd:
        typeof flags["cwd"] === "string"
          ? (flags["cwd"] as string)
          : process.cwd(),
    });
    if (decision.kind === "ai-assisted-folder") {
      const { runAiAssistedFolderStart } = await import(
        "./ai-assisted/cli-start.js"
      );
      await runAiAssistedFolderStart({
        manifestPath: decision.manifestPath,
        flags,
      });
      return;
    }
    if (decision.kind === "coached") {
      const { runCoachedStart } = await import("./coached/cli-start.js");
      await runCoachedStart(flags);
      return;
    }
    // decision.kind === "ai-assisted-retired" — explicit AI-Assisted
    // mode but no folder manifest in CWD. Falls through to the legacy
    // retired-banner block below.
  }

  if (command === "start") {
    // AI-Assisted in-process hook capture retired in 2.0.0 (Task #1193).
    // Cursor-export is now the sole evidence pipeline; candidates run
    // their session in Cursor directly and call
    // `prepsavant upload-cursor-export` at the end.
    //
    // Task #1399 — polish this exit path with the same chrome the
    // coached banner uses (color-accented header, Next steps block,
    // dim footer). The shared `makeColors` helper auto-disables ANSI
    // under NO_COLOR / non-TTY / FORCE_COLOR=0, and the `--json` mode
    // (used by scripts/CI) bypasses the banner entirely so the
    // machine-readable failure shape is unchanged.
    if (flags.json) {
      process.stderr.write(
        JSON.stringify({
          error: "ai_assisted_cli_retired",
          message:
            "AI-Assisted hook capture was retired in @prepsavant/mcp@2.0.0. Run the session in Cursor and then call `prepsavant upload-cursor-export --session-id <id>`.",
        }) + "\n",
      );
      process.exitCode = 1;
      return;
    }
    const { makeColors } = await import("./cli-ui/index.js");
    const c = makeColors(process.stderr);
    const lines = [
      `${c.yellow(c.bold("! AI-Assisted CLI start was retired in @prepsavant/mcp@2.0.0"))}`,
      `${c.dim("In-process Cursor hook capture is gone — evidence now ships via the Cursor chat export.")}`,
      "",
      c.cyan(c.bold("Next steps")),
      `  ${c.bullet} Open ${c.bold("Cursor")} and start the AI-Assisted session from the chat (call ${c.bold("ai_assisted_start_session")}).`,
      `  ${c.bullet} Drive the work in Cursor as normal — Sam surfaces feedback between turns.`,
      `  ${c.bullet} When you're done, run ${c.bold("prepsavant upload-cursor-export --session-id <id>")} so the dashboard can grade your transcript.`,
      "",
      `${c.dim("Need a CLI install? Run `prepsavant install --host cursor` first.")}`,
      "",
    ];
    process.stderr.write(lines.join("\n"));
    process.exitCode = 1;
    return;
  }

  if (command === "status") {
    // Live AI-Assisted status retired in 2.0.0 (Task #1193) along with
    // the in-process hook capture path. Use the dashboard report after
    // uploading the Cursor export instead.
    process.stderr.write(
      "`prepsavant status` was retired in @prepsavant/mcp@2.0.0.\n" +
        "View live and post-session status in the PrepSavant dashboard.\n",
    );
    process.exitCode = 1;
    return;
  }

  // `prepsavant study` retired in 1.8.0 (Task #1177); Study is now
  // portal-native at `/study`. MIN_SUPPORTED raised in lockstep.
  // Positional/flags are accepted by the parser but no longer routed
  // through the retired `start --ai-assisted` / `status` branches.
  void positional;

  if (command === "upload-cursor-export") {
    const { runUploadCursorExport } = await import(
      "./cursor-export/cli.js"
    );
    await runUploadCursorExport(flags);
    return;
  }

  if (command === "install") {
    const host = flags.host as HostId | undefined;
    const dryRun = !!flags["dry-run"];
    // Task #1205 — auto-kill is on by default; --no-kill restores the
    // strict pre-1205 refusal so power users / CI can opt out.
    const autoKill = !flags["no-kill"];
    const results = install({
      host,
      dryRun,
      packageSpec: flags["package-spec"] as string | undefined,
      autoKill,
    });
    // task-827 — render the per-host upgrade summary. The installer's
    // `message` already includes any cleanup / rewrite lines so we just
    // need to pick the status glyph and print verbatim. `refused-live-runner`
    // gets its own ✗ so it doesn't blend in with the routine status icons,
    // and we exit non-zero so script callers (CI, install scripts) notice.
    let refusedLiveRunner = false;
    for (const r of results) {
      const sym =
        r.status === "patched"
          ? "✓"
          : r.status === "already-installed"
            ? "·"
            : r.status === "manual"
              ? "!"
              : r.status === "refused-live-runner"
                ? "✗"
                : "·";
      if (r.status === "refused-live-runner") refusedLiveRunner = true;
      process.stdout.write(`${sym} [${r.host}] ${r.message}\n`);
    }
    if (refusedLiveRunner) {
      process.exitCode = 1;
      return;
    }
    // Point freshly-installed users at the dual-surface deep dives. Coached
    // mode now has its own doc covering the in-IDE `coached_*` flow that the
    // runner unlocks (the legacy `practice_*` aliases were removed in 0.5.0
    // — task #807), so we surface it here alongside the existing AI-Assisted
    // doc link rather than only nudging toward AI-Assisted. (task-434)
    const base = readConfig().apiBaseUrl.replace(/\/+$/, "");
    process.stdout.write(
      `\nNext steps — built for Cursor in v1:\n` +
        `  • Install Cursor if you haven't yet: https://cursor.com\n` +
        `  • Coached (Cursor + the in-IDE practice loop): ${base}/docs/coached\n` +
        `  • AI-Assisted (export your Cursor chat, get a prompting report): ${base}/docs/ai-assisted\n`,
    );
    return;
  }

  if (command === "auth") {
    await runAuth({
      noBrowser: !!flags["no-browser"],
      apiBaseUrl: flags["api-base"] as string | undefined,
      hostKind: flags.host as string | undefined,
    });
    return;
  }

  if (command === "doctor") {
    const cfg = readConfig();
    const api = new SamApi(cfg);
    // Fetch plan tier from the API upfront so doctor can surface it in the
    // license section. Best-effort: if the runner isn't authenticated yet or
    // the server is unreachable, we simply omit the plan field rather than
    // blocking the rest of the local environment checks.
    let plan: "free" | "pro" | "lifetime" | undefined;
    if (cfg.token) {
      try {
        const me = await api.getMe();
        plan = me.plan;
      } catch {
        // Non-fatal — offline or token not yet provisioned
      }
    }
    // Ask the API for the latest published runner version so we can mirror
    // the dashboard's "runner is out of date" advisory at the bottom of the
    // CLI output. The endpoint is public (no token needed), so first-time
    // doctor runs still see the nudge. Network/parse failures are non-fatal:
    // doctor's job is to report local state, not to fail because the server
    // is unreachable. (task-464)
    let latestRunnerVersion: string | undefined;
    try {
      const v = await api.getRunnerVersion();
      latestRunnerVersion = v.version;
    } catch {
      // Non-fatal — offline or server unreachable. Skip the advisory.
    }
    // Task #1197 — resolve the runnable-language catalog up-front (API
    // → on-disk cache → baked-in default) so doctor probes match the
    // active server catalog instead of whatever was baked into this
    // runner build. Best-effort: if the resolver throws we fall through
    // to runDoctor's default `RUNNABLE_LANGUAGES` so doctor still runs.
    let runnableLanguages: Awaited<
      ReturnType<typeof import("./doctor.js").resolveRunnableLanguages>
    > = { items: [], source: "default" };
    try {
      const { resolveRunnableLanguages } = await import("./doctor.js");
      runnableLanguages = await resolveRunnableLanguages(api);
    } catch {
      // Fall through to baked-in default.
    }
    const result = runDoctor({
      aiAssistedMode: !!flags["ai-assisted"],
      workspaceDir: process.cwd(),
      plan,
      // Task #1259 — auto-prune stale-hash sandbox cache dirs by
      // default; honor `--no-auto-prune` for power users who want to
      // inspect first via `prepsavant clean-sandbox-cache --dry-run`.
      autoPruneSandboxCache: !flags["no-auto-prune"],
      ...(runnableLanguages.items.length > 0
        ? {
            runnableLanguages: runnableLanguages.items,
            runnableLanguagesSource: runnableLanguages.source,
          }
        : {}),
    });
    if (flags.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else {
      process.stdout.write(formatDoctor(result) + "\n");
      // Mirror the dashboard advisory copy from artifacts/api-server/src/
      // routes/setup.ts so the experience is consistent across surfaces.
      if (latestRunnerVersion) {
        // Task #1382 — pass the most-recently-installed host id so the
        // upgrade hint renders `--host <id>` instead of the bare
        // command. Falls back to the bare command on a fresh install
        // (no recorded host yet).
        const { mostRecentInstalledHostId } = await import(
          "./install-history.js"
        );
        const advisory = formatRunnerUpdateAdvisory(
          ADAPTER_VERSION,
          latestRunnerVersion,
          mostRecentInstalledHostId(),
        );
        if (advisory) {
          process.stdout.write("\n" + advisory);
        }
      }
    }
    // Best-effort upload to the API so the dashboard's Health tile and
    // /setup/doctor page reflect the real local environment instead of a
    // hardcoded placeholder. Skipped silently when the runner isn't
    // authenticated yet (`prepsavant auth` not run) so first-time `doctor`
    // still works offline. Network failures are non-fatal: doctor's job is
    // to report local state, not to fail because the server is unreachable.
    // (task-349)
    if (cfg.token) {
      try {
        await new SamApi(cfg).pushDoctor(result);
      } catch (err) {
        if (!flags.json) {
          process.stderr.write(
            `note: failed to upload doctor report to ${cfg.apiBaseUrl}: ${
              (err as Error).message
            }\n`,
          );
        }
      }
    }
    if (result.overallStatus === "fail") process.exitCode = 1;
    // Task #1562 — The `coaching.win32_arm64_sqlite3` advisory + its
    // dedicated exit-2 mapping were removed alongside the `@cursor/sdk`
    // / `sqlite3` native dep they were warning about. The pure-HTTP
    // client has no native deps, so win32-arm64 needs no remediation.
    return;
  }

  if (command === "clean-sandbox-cache") {
    const { cleanSandboxCache, formatBytes } = await import(
      "./sandbox/cache-cleanup.js"
    );
    const dryRun = !!flags["dry-run"];
    const rawAge = flags["stale-age-days"];
    let staleAgeDays: number | undefined;
    if (rawAge !== undefined) {
      // The flag was passed — require an explicit numeric value so a
      // bare `--stale-age-days` doesn't silently no-op (parseArgs
      // would otherwise set rawAge=true).
      if (typeof rawAge !== "string") {
        process.stderr.write(
          `prepsavant: --stale-age-days requires a non-negative number (e.g. --stale-age-days 30)\n`,
        );
        process.exitCode = 2;
        return;
      }
      const n = Number(rawAge);
      if (!Number.isFinite(n) || n < 0) {
        process.stderr.write(
          `prepsavant: --stale-age-days must be a non-negative number (got ${rawAge})\n`,
        );
        process.exitCode = 2;
        return;
      }
      staleAgeDays = n;
    }
    const result = cleanSandboxCache({
      dryRun,
      ...(staleAgeDays !== undefined ? { staleAgeDays } : {}),
    });
    if (flags.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return;
    }
    const verb = dryRun ? "would remove" : "removed";
    process.stdout.write(
      `prepsavant clean-sandbox-cache — ${result.rootDir}\n`,
    );
    if (result.removed.length === 0) {
      process.stdout.write(`  · nothing to clean (${formatBytes(result.remainingBytes)} kept)\n`);
      return;
    }
    for (const e of result.removed) {
      const reason = e.isActive ? "stale (age-evicted)" : "stale (hash mismatch)";
      process.stdout.write(
        `  - ${verb} ${e.language}/${e.harnessHash} — ${formatBytes(e.sizeBytes)} (${reason})\n`,
      );
    }
    process.stdout.write(
      `  ${verb} ${result.removed.length} dir(s), ` +
        `freed ${formatBytes(result.freedBytes)}; ` +
        `${formatBytes(result.remainingBytes)} kept across ${result.kept.length} dir(s).\n`,
    );
    return;
  }

  if (command === "mcp") {
    // Lazy-import so `prepsavant doctor` doesn't pull in the MCP SDK on cold
    // start when the user just wants to check their environment.
    const { runMcpServer } = await import("./server.js");
    await runMcpServer();
    return;
  }

  process.stderr.write(`Unknown command: ${command}\n${HELP}`);
  process.exitCode = 2;
}

main().catch((err) => {
  process.stderr.write(`prepsavant: ${err?.message ?? err}\n`);
  process.exitCode = 1;
});
