// Task #1399 — polish for the `ai_assisted_start_session` MCP tool
// response and the `prepsavant start --mode ai-assisted` CLI exit
// path. Mirrors the coached `renderStartupBanner` shape — three blocks
// (success header / Next steps / quieted question brief) plus a
// footer — so the AI host renders something approachable in chat
// instead of the previous wall of `HOST INSTRUCTIONS` prose.
//
// HOST INSTRUCTIONS are stripped from the user-facing render via the
// shared `stripHostInstructions` helper. The AI host still receives
// the protocol via two channels that survive this change:
//   1. The `.cursor/rules/prepsavant-ai-assisted.mdc` standing frame
//      installed by `installIdeRulesBestEffort` at session start.
//   2. The `activeConstraints` payload returned by every
//      `ai_assisted_get_context` call.
// So nothing about the host's split-loop contract changes — only the
// chrome around it.

import {
  type ColorHelpers,
  stripHostInstructions,
} from "./index.js";
import { renderInstructionGuide } from "../coached/startup-banner.js";

export interface AiAssistedStartupBannerInput {
  adapterVersion: string;
  sessionId: string;
  questionTitle: string;
  questionPrompt: string;
  targetDurationMinutes?: number | undefined;
  // Task #1499 — server-rendered "How this session works" guide
  // (SAM_VOICE `practice_ai_assisted_guide`). Mirrors the page copy so
  // the export-into-this-folder instruction can't drift between the
  // dashboard and the runner. `null`/`undefined` suppresses the section.
  instructionGuide?: string | null;
}

export function renderAiAssistedStartupBanner(
  input: AiAssistedStartupBannerInput,
  colors: ColorHelpers,
): string {
  const { adapterVersion, sessionId, questionTitle, questionPrompt } = input;
  const c = colors;

  const headerLine = `${c.green(c.bold(c.check + " AI-Assisted session started"))}  ${c.dim(
    `(prepsavant ${adapterVersion})`,
  )}`;
  const sessionLine = `${c.dim("Session:")} ${sessionId}`;
  const titleLine = `${c.dim("Question:")} ${questionTitle}`;

  // Task #1499 — the instructional body (drive the work in Cursor,
  // export INTO this folder, run `prepsavant upload-cursor-export` with
  // no flags) lives in the SAM_VOICE `practice_ai_assisted_guide` block
  // rendered below. The only runtime-conditional line that stays in
  // code is the per-question timer, which the registry can't know.
  const timerLine =
    typeof input.targetDurationMinutes === "number"
      ? `  ${c.bullet} ${c.dim(
          `Timer: ${c.bold(`${input.targetDurationMinutes} min`)} — Sam surfaces feedback between turns.`,
        )}`
      : `  ${c.bullet} ${c.dim(
          "No fixed timer — Sam surfaces feedback between turns.",
        )}`;
  const sessionNotes = [c.cyan(c.bold("Session notes")), timerLine].join("\n");

  // Task #1507 deliberate asymmetry: this banner is the in-CHAT
  // response from the `ai_assisted_start_session` MCP tool, NOT the
  // folder-launched runner. The folder-launched flow shortened its
  // brief block to "see PROBLEM.md" because the user is sitting in a
  // package folder on disk; in the chat path the user has no such
  // file — the prompt body IS the only delivery channel. Shortening
  // it here would silently lose the question. So this surface keeps
  // the full body; HOST INSTRUCTIONS prose is still stripped via
  // `stripHostInstructions` below.
  const briefBody = stripHostInstructions(
    questionPrompt && questionPrompt.length > 0
      ? questionPrompt
      : "(no question prompt returned)",
  ).trimEnd();
  const briefBlock = [
    c.dim("\u2500\u2500 Question " + "\u2500".repeat(50)),
    c.dim(briefBody),
    c.dim("\u2500".repeat(60)),
  ].join("\n");

  const footer = `${c.yellow("\u25CF session live")}  ${c.dim(
    "End the session in Cursor when you're finished — evidence ships via the chat export.",
  )}`;

  const blocks: string[] = [headerLine, sessionLine, titleLine];
  if (input.instructionGuide && input.instructionGuide.trim().length > 0) {
    blocks.push("");
    blocks.push(renderInstructionGuide(input.instructionGuide, c));
  }
  blocks.push("");
  blocks.push(sessionNotes);
  blocks.push("");
  blocks.push(briefBlock);
  blocks.push("");
  blocks.push(footer);
  blocks.push("");
  return blocks.join("\n");
}
