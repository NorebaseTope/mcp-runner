#!/usr/bin/env node
// Entry point for the `prepsavant` bin. Subcommands:
//   prepsavant install [--host claude|claude_code|cursor|codex] [--dry-run]
//   prepsavant auth [--no-browser] [--api-base <url>]
//   prepsavant doctor [--json]
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

Usage:
  prepsavant start   [--mode coached|ai-assisted]
                                      Start a session. Defaults to coached if --mode is omitted.
                    [--ai-assisted]   Alias for --mode ai-assisted (backwards-compat)
                    [--json]          Print {sessionId,tool,startedAt} JSON to stdout on success;
                                      {"error":"..."} to stderr on failure (for scripts/CI)
                    [--tool <id>]     (ai-assisted only) Pre-select tool (claude_code|cursor|codex_cli)
                    [--codex-mode <m>] Pre-select Codex capture mode (interactive|exec)
                    [--codex-prompt <p>] Pre-supply the Codex exec prompt
                    [--question-id <id>] Pre-select the problem by id
                    [--accept-consent] Auto-accept the session consent dialog
                    [--cleanup-stale-hooks] Auto-remove stale hooks from a prior crashed session
  prepsavant status  [<session-id>]   Show hook channels, events, and integrity for a live session
                    [--watch] [-w]    (defaults to the most recent active session in this workspace)
                    [--interval <s>]  Re-render every <s> seconds in --watch mode (default 5, min 1)
                    [--json]          Print the full status payload as JSON to stdout (one-shot only)
  prepsavant study   [--question <id>]   Open Study chat with Sam scoped to a problem.
                                          Runs in your IDE chat via MCP study_* tools.
                    [--post-session <sessionId>]
                                          Post-session reflection chat for a finished session.
                                          Requires --question with the same questionId.
                    [--json]              JSON preflight: creates the conversation server-side
                                          and prints {conversationId,mode,questionId,startedAt}.
                                          (No sessions/attempts/hints are ever written.)
  prepsavant install [--host claude|claude_code|cursor|codex] [--dry-run]
  prepsavant auth    [--no-browser] [--api-base <url>]
  prepsavant doctor  [--json]
  prepsavant mcp     (default — runs the MCP server on stdio)
`;

async function main(): Promise<void> {
  const { command, flags, positional } = parseArgs(process.argv.slice(2));

  if (command === "help" || flags.help) {
    process.stdout.write(HELP);
    return;
  }

  if (command === "version" || flags.version) {
    process.stdout.write(`${ADAPTER_VERSION}\n`);
    return;
  }

  if (command === "start") {
    const mode = (flags.mode as string | undefined) ?? (flags["ai-assisted"] ? "ai-assisted" : "coached");
    if (mode === "coached") {
      const { runCoachedStart } = await import("./coached/cli-start.js");
      await runCoachedStart(flags);
      return;
    }
    const { runStart } = await import("./ai-assisted/cli-start.js");
    await runStart(flags);
    return;
  }

  if (command === "status") {
    const { runStatus } = await import("./ai-assisted/cli-status.js");
    await runStatus(positional, flags);
    return;
  }

  if (command === "study") {
    const { runStudyStart } = await import("./study/cli-start.js");
    await runStudyStart(flags);
    return;
  }

  if (command === "install") {
    const host = flags.host as HostId | undefined;
    const dryRun = !!flags["dry-run"];
    const results = install({
      host,
      dryRun,
      packageSpec: flags["package-spec"] as string | undefined,
    });
    for (const r of results) {
      const sym =
        r.status === "patched"
          ? "✓"
          : r.status === "already-installed"
            ? "·"
            : r.status === "manual"
              ? "!"
              : "·";
      process.stdout.write(`${sym} [${r.host}] ${r.message}\n`);
    }
    // Point freshly-installed users at the dual-surface deep dives. Coached
    // mode now has its own doc covering the in-IDE `practice_*` flow that the
    // runner unlocks, so we surface it here alongside the existing
    // AI-Assisted doc link rather than only nudging toward AI-Assisted.
    // (task-434)
    const base = readConfig().apiBaseUrl.replace(/\/+$/, "");
    process.stdout.write(
      `\nNext steps — read the mode deep dives:\n` +
        `  • Coached (browser + IDE practice loop): ${base}/docs/coached\n` +
        `  • AI-Assisted (capture & grade real sessions): ${base}/docs/ai-assisted\n`,
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
    const result = runDoctor({
      aiAssistedMode: !!flags["ai-assisted"],
      workspaceDir: process.cwd(),
      plan,
    });
    if (flags.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else {
      process.stdout.write(formatDoctor(result) + "\n");
      // Mirror the dashboard advisory copy from artifacts/api-server/src/
      // routes/setup.ts so the experience is consistent across surfaces.
      if (latestRunnerVersion) {
        const advisory = formatRunnerUpdateAdvisory(
          ADAPTER_VERSION,
          latestRunnerVersion,
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
