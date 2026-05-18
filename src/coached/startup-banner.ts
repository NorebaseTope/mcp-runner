// Task #1390 — polish for the `prepsavant start --session-pack` terminal
// output. Splits the kickoff brief into a user-facing call-to-action
// banner + a quieter brief body, strips host-only directive blocks
// (HOST INSTRUCTIONS — HYBRID RELAY PROTOCOL etc.) that are meant for
// the AI host via `coached_get_context`, and applies tasteful color
// that respects `NO_COLOR` and non-TTY stdout.
//
// Task #1399 — the color helpers and host-instructions stripper were
// lifted to `packages/mcp-runner/src/cli-ui/` so the AI-Assisted start
// path can reuse them without dragging in the coached banner specifics.
// We re-export them here so existing imports keep working.

import * as path from "node:path";

import {
  type ColorHelpers,
  type ColorStream,
  makeColors,
  stripHostInstructions,
  supportsColor,
} from "../cli-ui/index.js";

// Re-exports kept for back-compat. The canonical implementations now
// live in `../cli-ui/index.ts`.
//
// Note (Task #1400): the api-server has since split the HOST
// INSTRUCTIONS block out of the kickoff brief into a separate
// `hostInstructionsVerbatim` field, so `stripHostInstructions` is
// effectively a defensive belt-and-braces against pre-Task-#1400
// api-server replicas during the rollout window. It's still used by
// the AI-Assisted banner (Task #1399) where the host-instructions
// prose was previously embedded in the same payload.
export {
  type ColorHelpers,
  type ColorStream,
  makeColors,
  stripHostInstructions,
  supportsColor,
};

// ---------------------------------------------------------------------
// Banner renderer. Returns a single string (with trailing newline) so
// the caller can write it to stdout in one go and tests can assert on
// the exact output without racing on multiple writes.
// ---------------------------------------------------------------------

export interface StartupBannerInput {
  adapterVersion: string;
  sessionId: string;
  packRoot: string;
  scratchRelPath: string | null;
  kickoffBrief: string | null;
  // Task #1507 — render a SHORT pointer to the on-disk question file
  // instead of dumping the full markdown brief into the terminal. The
  // unzipped question package always contains `PROBLEM.md` at its
  // root (see `artifacts/api-server/src/lib/question-package.ts`),
  // so the banner shows the question title + a one-or-two-line
  // preview + the file path. `questionTitle` is required for the
  // pointer block; older callers that omit it fall back to the
  // legacy "full brief" rendering (used by tests that don't have a
  // title to wire in).
  questionTitle?: string | null;
  // Task #1401 follow-up — `true` when the resolved coding agent is the
  // persistent @cursor/sdk Agent (CURSOR_API_KEY in env or explicit
  // `kind: "cursor-sdk"` in config). `false` when we'll shell out to
  // the stateless `cursor-agent` CLI per cadence tick. `undefined`
  // suppresses the tip line entirely (used by callers that don't have
  // a meaningful selection to surface, e.g. tests).
  usingPersistentAgent?: boolean;
  // Task #1507 — server-rendered `cursor_api_key_tip` SAM_VOICE
  // payload. Rendered verbatim under "Optional setup" ONLY when
  // `usingPersistentAgent === false`. The cli-start caller fetches
  // this from `/sam-voice/cursor_api_key_tip` and passes it in (best
  // effort — older api-server replicas or transient failures just
  // suppress the section). When `null`/`undefined`, the banner falls
  // back to a short one-line hint so the user still knows the env var
  // is meaningful even if the voice fetch failed.
  cursorApiKeyTip?: string | null;
  // Task #1499 — server-rendered "How this session works" guide (from
  // the SAM_VOICE `practice_coached_guide` key). Rendered verbatim
  // between Next steps and the kickoff brief so the page + terminal
  // never drift. `null`/`undefined` suppresses the section entirely
  // (older api-server replicas, or tests that don't bother to wire it).
  instructionGuide?: string | null;
}

export function renderStartupBanner(
  input: StartupBannerInput,
  colors: ColorHelpers,
): string {
  const { adapterVersion, sessionId, packRoot, scratchRelPath, kickoffBrief } =
    input;
  const c = colors;

  const headerLine = `${c.green(c.bold(c.check + " Coached session started"))}  ${c.dim(
    `(prepsavant ${adapterVersion})`,
  )}`;
  const sessionLine = `${c.dim("Session:")} ${sessionId}`;
  const folderLine = `${c.dim("Folder:")}  ${packRoot}`;

  // Task #1499 — the instructional "Next steps" body lives in the
  // SAM_VOICE `practice_coached_guide` block (rendered below) so it
  // can't drift from the dashboard. The only runtime-conditional
  // lines that remain in code are:
  //   - the scratch-file path (depends on the question's language)
  //   - the persistent-context tip (depends on the resolved adapter)
  // Both are short, dim, and clearly framed as session-specific.
  const dynamicLines: string[] = [];
  if (scratchRelPath) {
    dynamicLines.push(
      `  ${c.bullet} ${c.dim(`Scratch file: ${c.bold(scratchRelPath)}`)}`,
    );
  }
  const sessionNotes = dynamicLines.length > 0
    ? [c.cyan(c.bold("Session notes")), ...dynamicLines].join("\n")
    : "";

  // Task #1507 — short pointer to the on-disk question file instead of
  // dumping the full markdown brief. Falls back to the legacy verbatim
  // brief when callers haven't wired a questionTitle (tests, older
  // call sites). We still strip HOST INSTRUCTIONS defensively before
  // summarising in case a pre-Task-#1400 api-server replica is serving
  // the merged payload.
  const cleanedBrief = stripHostInstructions(
    kickoffBrief ?? "(no kickoff brief returned)",
  ).trimEnd();
  const briefBlock = input.questionTitle
    ? renderQuestionPointer({
        packRoot,
        questionTitle: input.questionTitle,
        kickoffBrief: cleanedBrief,
        c,
      })
    : [
        c.dim("\u2500\u2500 Kickoff brief " + "\u2500".repeat(46)),
        c.dim(cleanedBrief),
        c.dim("\u2500".repeat(60)),
      ].join("\n");

  // Task #1507 — informative CURSOR_API_KEY tip, sourced from
  // SAM_VOICE so the dashboard Mode Picker and the runner banner
  // can't drift. Rendered ONLY when the resolved adapter is the
  // shell-out CLI (i.e. the key is missing or explicit opt-out).
  let apiKeyTipBlock = "";
  if (input.usingPersistentAgent === false) {
    const heading = c.cyan(c.bold("Optional setup"));
    if (input.cursorApiKeyTip && input.cursorApiKeyTip.trim().length > 0) {
      const body = input.cursorApiKeyTip
        .split("\n")
        .map((line) => {
          const m = line.match(/^\*\*(.+)\*\*\s*$/);
          if (m) return `  ${c.bold(m[1] ?? "")}`;
          if (line.trim().length === 0) return "";
          return `  ${c.dim(line)}`;
        })
        .join("\n");
      apiKeyTipBlock = `${heading}\n${body}`;
    } else {
      apiKeyTipBlock =
        `${heading}\n  ${c.dim(
          "Set CURSOR_API_KEY in your shell for persistent multi-turn context — get a key at https://cursor.com/dashboard.",
        )}`;
    }
  }

  const footer = `${c.yellow(
    "\u25CF watching " + path.basename(packRoot) + "/",
  )}  ${c.dim(
    "Runner is live — press Ctrl+C, or type `quit`, `exit`, `:q`, `stop`, `end`, or `bye` to stop.",
  )}`;

  const blocks: string[] = [headerLine, sessionLine, folderLine];
  if (input.instructionGuide && input.instructionGuide.trim().length > 0) {
    blocks.push("");
    blocks.push(renderInstructionGuide(input.instructionGuide, c));
  }
  if (sessionNotes.length > 0) {
    blocks.push("");
    blocks.push(sessionNotes);
  }
  blocks.push("");
  blocks.push(briefBlock);
  if (apiKeyTipBlock.length > 0) {
    blocks.push("");
    blocks.push(apiKeyTipBlock);
  }
  blocks.push("");
  blocks.push(footer);
  blocks.push("");
  return blocks.join("\n");
}

// Task #1507 — short pointer block used in place of the full
// kickoff brief. Renders the on-disk question file path
// (`<packRoot>/PROBLEM.md`, written by the api-server's
// `buildQuestionPackage`) together with the question title and a
// short one-or-two-line preview pulled from the brief body, so the
// user opens the file in their editor instead of squinting at the
// scrollback. The preview is deliberately capped at ~200 chars to
// keep the banner scannable.
function renderQuestionPointer(input: {
  packRoot: string;
  questionTitle: string;
  kickoffBrief: string;
  c: ColorHelpers;
}): string {
  const { packRoot, questionTitle, kickoffBrief, c } = input;
  const heading = c.cyan(c.bold("Question"));
  const filePath = path.join(packRoot, "PROBLEM.md");
  const preview = summariseBrief(kickoffBrief);
  const lines = [
    heading,
    `  ${c.bold(questionTitle)}`,
    `  ${c.dim("Full statement: ")}${filePath}`,
  ];
  if (preview.length > 0) {
    lines.push(`  ${c.dim(preview)}`);
  }
  return lines.join("\n");
}

// Pull a 1-2 line summary out of the kickoff brief: the first
// non-empty, non-heading paragraph, soft-capped at ~200 chars on a
// word boundary. Markdown headings (`#`, `##`, …) and HOST
// INSTRUCTIONS fences are skipped so the user gets a real
// problem-statement glimpse, not a section header.
function summariseBrief(brief: string): string {
  const paras: string[] = [];
  let buf: string[] = [];
  for (const raw of brief.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) {
      if (buf.length > 0) {
        paras.push(buf.join(" "));
        buf = [];
      }
      continue;
    }
    if (/^#{1,6}\s/.test(line)) continue;
    if (/^[-*]\s/.test(line) && buf.length === 0) continue;
    buf.push(line);
  }
  if (buf.length > 0) paras.push(buf.join(" "));
  const first = paras.find((p) => p.length > 0) ?? "";
  if (first.length === 0) return "";
  if (first.length <= 200) return first;
  const truncated = first.slice(0, 200);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > 80 ? truncated.slice(0, lastSpace) : truncated) + "…";
}

// Task #1499 — shared "How this session works" renderer for both
// coached and AI-Assisted banners. Treats the input as plain text with
// `**Header**` lines and `-` bullets; bolds headers, dims everything
// else, and preserves blank-line section breaks. Does not reflow long
// lines — the source copy is already terminal-friendly.
export function renderInstructionGuide(
  text: string,
  c: ColorHelpers,
): string {
  const heading = c.cyan(c.bold("How this session works"));
  const body = text
    .split("\n")
    .map((line) => {
      const m = line.match(/^\*\*(.+)\*\*\s*$/);
      if (m) return `  ${c.bold(m[1] ?? "")}`;
      if (line.trim().length === 0) return "";
      return `  ${c.dim(line)}`;
    })
    .join("\n");
  return `${heading}\n${body}`;
}
