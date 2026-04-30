// CLI flow for Study mode: `prepsavant study`.
//
// Study mode is a teaching chat with Sam scoped to a single problem. It
// runs entirely inside the IDE chat host (Cursor / Claude Desktop / Codex)
// via the MCP `study_*` tools — this CLI command exists primarily as a
// discoverability surface and a JSON-friendly preflight for scripts/CI:
//
//   prepsavant study --question <id>           # study chat about a problem
//   prepsavant study --post-session <sessionId> # post-session reflection
//
// Critical invariant (task-531): this flow never creates session/attempt/
// hint rows. It only persists into the existing study_conversations and
// study_conversation_messages tables.

import { ADAPTER_VERSION, readConfig } from "../config.js";
import { SamApi } from "../api.js";

const STUDY_HELP = `prepsavant ${ADAPTER_VERSION} — study mode

Usage:
  prepsavant study [--question <id>]              Open Study chat about a problem
  prepsavant study --post-session <sessionId>     Post-session reflection chat
  prepsavant study --json                         Emit a JSON success/error payload

Study mode is a teaching chat with Sam, scoped to a single problem. It runs
inside your AI chat host (Cursor, Claude Desktop, Codex) via the MCP
\`study_*\` tools — make sure the runner is active (\`prepsavant mcp\`).

From your AI chat:
  study_start         — open a study conversation for a question id
                        (or pass postSessionId to reflect on a finished session)
  study_send_message  — record one user/Sam turn
  study_get_history   — read back the full transcript

Study mode never starts a graded session. It will not insert sessions,
attempts, or hint events. Conversations show up in the dashboard's
"Study chats" view.
`;

export async function runStudyStart(
  flags: Record<string, string | boolean>,
): Promise<void> {
  if (flags.help) {
    process.stdout.write(STUDY_HELP);
    return;
  }

  const cfg = readConfig();
  const api = new SamApi(cfg);

  const isJson = !!flags.json;
  const questionId = flags.question as string | undefined;
  const postSessionId = flags["post-session"] as string | undefined;

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

  // JSON mode preflight: when a target is provided, eagerly create the
  // conversation server-side so scripts/CI get a stable conversationId
  // before launching the host. Mirrors the coached --json --question-id
  // contract.
  if (isJson && (questionId || postSessionId)) {
    try {
      let detail;
      if (postSessionId) {
        // Post-session needs the question that was practised — we look it up
        // server-side from the session row, so the caller only needs the
        // session id. We pass questionId as empty here and rely on the
        // server to derive it; if questionId is also provided we use it
        // as an override.
        if (!questionId) {
          process.stderr.write(
            JSON.stringify({
              error:
                "Post-session study requires --question <id> alongside --post-session for the JSON preflight.",
            }) + "\n",
          );
          process.exitCode = 1;
          return;
        }
        detail = await api.createStudyConversation({
          questionId,
          mode: "post_session",
          sessionId: postSessionId,
        });
      } else {
        detail = await api.createStudyConversation({
          questionId: questionId!,
          mode: "study",
        });
      }
      process.stdout.write(
        JSON.stringify({
          conversationId: detail.id,
          mode: detail.mode,
          questionId: detail.questionId,
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
    `prepsavant ${ADAPTER_VERSION} — Study mode`,
    "",
    "Study mode is a teaching chat with Sam, scoped to a single problem.",
    "It runs in your AI chat host via MCP — start the runner with `prepsavant mcp`.",
    "",
    "From your AI chat, use these tools:",
    "  study_start         — open a study conversation for a question id",
    "                        (or pass postSessionId for a post-session reflection)",
    "  study_send_message  — record one user/Sam turn",
    "  study_get_history   — read back the full transcript",
    "",
    questionId
      ? `Suggested next prompt to paste into your AI chat:`
      : `Example prompt to paste into your AI chat:`,
    questionId
      ? `  "Use study_start with questionId=\\"${questionId}\\" and tutor me through this problem."`
      : `  "Use study_start with a medium SWE question id and tutor me through it."`,
    postSessionId
      ? `  (alternatively: pass postSessionId=\\"${postSessionId}\\" to study_start to reflect on that finished session)`
      : "",
    "",
    "Study chats never create sessions, attempts, or hints — they're for learning only.",
    "",
    `Dashboard: ${base}/dashboard`,
  ].filter(Boolean);
  process.stdout.write(lines.join("\n") + "\n");
}
