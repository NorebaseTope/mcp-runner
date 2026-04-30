// CLI flow for Coached mode: `prepsavant start --mode coached`
// Explains to the user that Coached mode runs inside their AI chat host via
// the MCP server. Outputs guidance on which coached_* tools to use.
import { ADAPTER_VERSION, readConfig } from "../config.js";
import { SamApi } from "../api.js";

export async function runCoachedStart(
  flags: Record<string, string | boolean>,
): Promise<void> {
  const cfg = readConfig();
  const api = new SamApi(cfg);

  const isJson = !!flags.json;
  const questionId = flags["question-id"] as string | undefined;

  if (!cfg.token) {
    if (isJson) {
      process.stderr.write(
        JSON.stringify({ error: "not_authenticated" }) + "\n",
      );
    } else {
      process.stderr.write(
        "No device token. Run `prepsavant auth` first.\n",
      );
    }
    process.exitCode = 1;
    return;
  }

  if (isJson && questionId) {
    try {
      const start = await api.startSession({ questionId });
      process.stdout.write(
        JSON.stringify({
          sessionId: start.sessionId,
          mode: "coached",
          startedAt: new Date().toISOString(),
        }) + "\n",
      );
    } catch (err) {
      process.stderr.write(
        JSON.stringify({ error: (err as Error).message }) + "\n",
      );
      process.exitCode = 1;
    }
    return;
  }

  const base = cfg.apiBaseUrl.replace(/\/+$/, "");
  const lines = [
    `prepsavant ${ADAPTER_VERSION} — Coached mode`,
    "",
    "Coached mode runs entirely in your AI chat host (Cursor, Claude Desktop, Codex).",
    "The MCP server must be running — start it with `prepsavant mcp`.",
    "",
    "From your AI chat, use these tools:",
    "  coached_pick_question  — browse questions by role/difficulty/language",
    "  coached_start_session  — start a coached session with a question id",
    "  coached_ask            — ask Sam a clarifying question about the problem",
    "  coached_check_in       — check for nudges and report AI-assist events",
    "  coached_end_session    — end the session and get a post-mortem recap",
    "",
    "Example prompt to paste into your AI chat:",
    '  "Use coached_pick_question to show me a medium difficulty backend SWE question, then start a coached session."',
    "",
    `Dashboard: ${base}/dashboard`,
    `Docs: ${base}/docs/coached`,
  ];
  process.stdout.write(lines.join("\n") + "\n");
}
