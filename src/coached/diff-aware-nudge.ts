// Diff-aware Sam nudge enrichment for Coached check-ins (Task #832).
//
// On every `coached_check_in`, after the server returns a directive and the
// runner-side stall watcher has had a chance to escalate `stay_quiet` into a
// probe, we take a fresh shadow-git snapshot, diff it against the
// session-start baseline, and ask the host model to rewrite the static
// `suggestedWording` into a single short Sam line that references what the
// candidate actually changed.
//
// This file is the *only* place the runner is allowed to talk to MCP
// sampling for the diff-aware nudge — everywhere else falls back to
// `STALL_PROBE_LINES` / `DIRECTIVE_VOICE` so behaviour never regresses.
//
// Invariants:
//   - `submit_pasted_code` is a hard fixed-string directive (verbatim
//     contract from `SAM_VOICE.coached_submit_pasted_code`); we never
//     enrich it.
//   - `stay_quiet` has no spoken line; nothing to enrich.
//   - When the diff is empty / oversized after trimming / sampling fails or
//     times out / the host doesn't support sampling, we return the original
//     directive unchanged. The caller never has to special-case the failure
//     path — the resolved directive is always speakable.
//   - Snapshot work is best-effort: any thrown error degrades to "no
//     enrichment", never to a broken check-in.

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

import type { CheckInDirective } from "../api.js";
import { sampleSamVoice } from "../sampling.js";
import type { CoachedSessionState } from "./session.js";

// Soft cap on the diff size we ship to the host model. Above this we drop
// the largest per-file patches first; if even that doesn't fit, we treat
// the diff as oversized and fall back to the static directive line. Sized
// generously enough to fit a few hundred lines of typical interview-prep
// code while staying well below typical host context windows.
export const MAX_DIFF_BYTES = 8 * 1024;

// Task #1126 (Phase 2) — separate (smaller) cap on the diff text the
// runner forwards to the server as `diffSnippet` for the host_reasoning
// evidence payload. Smaller than MAX_DIFF_BYTES because the server-side
// evidence payload is persisted on the session row + included on the
// directive response, so we keep the on-the-wire copy tighter.
export const MAX_CHECKIN_DIFF_BYTES = 4 * 1024;

// How long the host model has to produce a one-line nudge before we give
// up and serve the static directive line. Coached check-ins fire on every
// user message; a slow host must never block the directive delivery.
export const DIFF_SAMPLE_TIMEOUT_MS = 4_000;

// Token cap for the host model. Sam's nudge is one short paragraph plus
// optionally one follow-up question — well under 200 tokens — but we leave
// some headroom so the model isn't truncated mid-sentence.
const DIFF_SAMPLE_MAX_TOKENS = 220;

export function isEnrichableDirective(directive: CheckInDirective): boolean {
  // Task #1075 — never enrich a directive whose wording is part of the
  // session contract (`mustBeVerbatim === true`); the dashboard's
  // coached-honest-recap pipeline asserts those byte-for-byte and any
  // rewrite would break the contract. `stay_quiet` likewise has no
  // wording to rewrite.
  if (directive.action === "stay_quiet") return false;
  if (directive.mustBeVerbatim === true) return false;
  // Without a fallback voice line there is nothing to rewrite. Defensive —
  // every non-stay_quiet server directive currently carries suggestedWording.
  if (directive.suggestedWording == null || directive.suggestedWording.trim() === "") {
    return false;
  }
  return true;
}

// User-prompt grounding for the host model. Built on the runner so the
// existing `PersonaCache` system prompt can wrap any Sam-voice sampling
// call without needing a new endpoint shape (Task #832 step 4).
//
// The runner consumes the server's `SAM_VOICE.coached_diff_aware_nudge_instruction`
// entry as the canonical Sam-voice contract for this surface — admins can
// re-tune the instruction wording on the persona page without shipping a
// runner update. The fetched text is prepended to the prompt; on a
// transient voice-API failure we fall back to the bundled instruction
// `BUNDLED_NUDGE_INSTRUCTION` so the prompt is always well-formed.
//
// Inputs are deliberately compact:
//   - `instruction`: server-tuned Sam-voice contract for this surface.
//   - `directive`: the directive action + its static fallback voice line,
//     so the model knows what intent Sam is currently expressing and what
//     line it would otherwise speak. We pass the action and reason
//     verbatim so the model can pivot ("hint_offer" reads differently
//     from "probe").
//   - `recentUserMessage`: optional. When the host surfaces it, the
//     model can echo what the candidate just said.
//   - `diff`: the size-budgeted unified-diff blob from the snapshot store.
//   - `questionTitle`: the problem the candidate is working on.
//   - `filesChanged`, `truncated`: diff metadata so the model knows
//     whether the picture it sees is partial.
export interface DiffAwareNudgeGroundingInput {
  directive: CheckInDirective;
  questionTitle: string;
  recentUserMessage?: string | null;
  diff: string;
  filesChanged: number;
  truncated: boolean;
  instruction?: string;
}

// Bundled Sam-voice contract — used only when the server's voice
// registry is unreachable on the very first check-in of a session.
// Mirrors `SAM_VOICE.coached_diff_aware_nudge_instruction` on the
// server side (artifacts/api-server/src/lib/sam-voice.ts).
export const BUNDLED_NUDGE_INSTRUCTION =
  "On every Coached check-in, look at the unified diff of what the candidate has actually written since the session started, then speak ONE short Sam-voice nudge that references something concrete they changed while still serving the directive's intent — probe, hint, time-warning, or wrap-up. Two sentences max. No code. If the diff is empty or unhelpful, fall back to the static directive line verbatim.";

export function buildDiffAwareNudgeGrounding(
  input: DiffAwareNudgeGroundingInput,
): string {
  const lines: string[] = [
    `Sam-voice contract for this surface:`,
    (input.instruction ?? BUNDLED_NUDGE_INSTRUCTION).trim(),
    "",
    `Question being coached: ${input.questionTitle}`,
    `Current Sam directive: ${input.directive.action}`,
    `Reason: ${input.directive.reason}`,
    `Static fallback line (what Sam would say without seeing the diff): "${input.directive.suggestedWording ?? ""}"`,
  ];
  if (input.recentUserMessage && input.recentUserMessage.trim()) {
    lines.push("");
    lines.push(`Most recent thing the candidate said:`);
    lines.push(input.recentUserMessage.trim().slice(0, 500));
  }
  lines.push("");
  lines.push(
    `Code changes since this Coached session started (unified diff${input.truncated ? ", TRIMMED — largest files dropped" : ""}, ${input.filesChanged} file${input.filesChanged === 1 ? "" : "s"} changed):`,
  );
  lines.push("```diff");
  lines.push(input.diff);
  lines.push("```");
  lines.push("");
  lines.push(
    "Write ONE short Sam-voice nudge (max 2 sentences, can include one short follow-up question) that:",
  );
  lines.push(
    "- references something concrete the candidate actually changed (a function they sketched, a branch they added, code they deleted), AND",
  );
  lines.push(
    "- still serves the directive's intent (probe = press for reasoning, hint_offer = offer the next hint, time_warning = nudge on time, wrap_up = land the session).",
  );
  lines.push(
    "Do NOT produce code, do not narrate the diff line-by-line, do not flatter, address the candidate as \"you\". If the diff doesn't show anything meaningful, just speak the static fallback line verbatim instead.",
  );
  lines.push(
    "Return ONLY the spoken line as plain text — no JSON, no quotes, no preamble.",
  );
  return lines.join("\n");
}

// Dependencies abstracted so the unit test can stub MCP sampling and the
// snapshot store without spinning up a real shadow git repo or a real host
// connection. The server-side wiring is in `runMcpServer`.
export interface EnrichDirectiveDeps {
  // The MCP server reference is what `sampleSamVoice` ultimately uses to
  // dispatch `createMessage`. The default sampler reads from this; tests
  // can pass a custom `sample` to bypass it entirely.
  server: Server;
  // Resolved persona system prompt (already composed via `PersonaCache`).
  systemPrompt: string;
  // Async fetcher for the server-tuned Sam-voice contract for this
  // surface (`SAM_VOICE.coached_diff_aware_nudge_instruction`). The
  // runner wires this to `PersonaCache.getVoice`, which caches with the
  // same TTL as the system prompt and serves the bundled fallback on
  // voice-API failures. Optional so unit tests can omit it and still
  // exercise the rest of the enrichment branches.
  getNudgeInstruction?: () => Promise<string>;
  // Override sampler hook for tests. Default is `sampleSamVoice` with the
  // task's timeout + token caps.
  sample?: (args: {
    systemPrompt: string;
    userPrompt: string;
    fallback: string;
  }) => Promise<{ text: string; source: "runner_sampling" | "runner_fallback" }>;
  // Override clock so tests don't actually wait on the timeout race.
  now?: () => number;
  // Soft cap on diff size; defaults to MAX_DIFF_BYTES.
  maxDiffBytes?: number;
  // Sampling timeout; defaults to DIFF_SAMPLE_TIMEOUT_MS.
  timeoutMs?: number;
}

export interface EnrichDirectiveInput {
  directive: CheckInDirective;
  state: CoachedSessionState | null;
  recentUserMessage?: string | null;
}

export interface DiffSummary {
  filesChanged: string[];
  truncated: boolean;
}

export interface EnrichDirectiveResult {
  directive: CheckInDirective;
  // Why we ended up with this directive. Useful for debug logs and tests.
  // "enriched": diff-aware nudge replaced the voice line.
  // "skipped:hard_fixed": directive is a verbatim contract (e.g.
  //                      submit_pasted_code) — never enriched.
  // "skipped:no_state": no in-memory session, nothing to snapshot against.
  // "skipped:no_baseline": baseline snapshot was never taken (e.g. git
  //                       unavailable at session start).
  // "skipped:no_snapshot": fresh-snapshot pass returned no commit (e.g.
  //                       no diffs vs baseline yet).
  // "skipped:empty_diff": diff returned 0 changed files.
  // "skipped:oversized": diff exceeded the byte budget after trimming.
  // "fallback:sample_failed": the host returned the static fallback (timed
  //                          out, refused sampling, returned garbage, etc.)
  outcome:
    | "enriched"
    | "skipped:hard_fixed"
    | "skipped:no_state"
    | "skipped:no_baseline"
    | "skipped:no_snapshot"
    | "skipped:empty_diff"
    | "skipped:oversized"
    | "fallback:sample_failed";
  diffSummary?: DiffSummary;
  // Task #1126 (Phase 2) — captured unified-diff text the runner can
  // forward to the server on the NEXT check-in as `diffSnippet`, so the
  // host_reasoning evidence payload carries the actual diff text for
  // runner-originated coached sessions. Always capped to
  // MAX_CHECKIN_DIFF_BYTES (smaller than the sampling cap). Set whenever
  // a diff was successfully computed, even if sampling later failed.
  diffSnippet?: string;
}

// Take a fresh snapshot of the workspace, compute the diff vs the
// session-start baseline, and (if everything lines up) sample a
// diff-aware Sam-voice line to replace the directive's static fallback.
//
// On any failure path we return the original directive — never a broken
// or partially-rewritten one — so the caller can pass the result through
// `buildCheckInPayloadFromResolved` without any extra defensive checks.
export async function enrichDirectiveWithDiff(
  input: EnrichDirectiveInput,
  deps: EnrichDirectiveDeps,
): Promise<EnrichDirectiveResult> {
  const { directive, state } = input;

  // Task #1126 (Phase 2) — diff capture for the host_reasoning evidence
  // payload runs INDEPENDENTLY of enrichment eligibility. host_reasoning
  // directives intentionally omit `suggestedWording` (so they're not
  // "enrichable"), but those are exactly the directives whose evidence
  // payload most needs the captured diff. We therefore guard the
  // snapshot/diff pass on `state` + `state.snapshot` only, and fold the
  // enrichment-eligibility gate into a later branch so we can still
  // return a non-empty `diffSnippet` for non-enrichable directives.
  if (state == null) {
    return { directive, outcome: "skipped:no_state" };
  }
  if (state.snapshot == null || state.baselineSha == null) {
    if (!isEnrichableDirective(directive)) {
      return { directive, outcome: "skipped:hard_fixed" };
    }
    return { directive, outcome: "skipped:no_baseline" };
  }

  // Fresh snapshot of the candidate's workspace. May return null when
  // there is nothing to commit (workspace identical to last snapshot) —
  // in that case fall back to diffing the baseline against the previous
  // snapshot's HEAD, which still represents the cumulative session diff.
  let headSha: string | null = null;
  try {
    const fresh = state.snapshot.snapshot("coached_check_in");
    if (fresh) {
      headSha = fresh.commitSha;
      state.lastSnapshotSha = fresh.commitSha;
    } else {
      headSha = state.lastSnapshotSha;
    }
  } catch {
    return { directive, outcome: "skipped:no_snapshot" };
  }

  if (headSha == null || headSha === state.baselineSha) {
    if (!isEnrichableDirective(directive)) {
      return { directive, outcome: "skipped:hard_fixed" };
    }
    return { directive, outcome: "skipped:empty_diff" };
  }

  const maxDiffBytes = deps.maxDiffBytes ?? MAX_DIFF_BYTES;
  let diffResult: { diff: string; truncated: boolean; filesChanged: number; fileNames: string[] };
  try {
    diffResult = state.snapshot.getDiffSince(state.baselineSha, {
      maxBytes: maxDiffBytes,
    });
  } catch {
    return { directive, outcome: "skipped:no_snapshot" };
  }

  if (!diffResult.diff || diffResult.filesChanged === 0) {
    if (!isEnrichableDirective(directive)) {
      return { directive, outcome: "skipped:hard_fixed" };
    }
    return { directive, outcome: "skipped:empty_diff" };
  }

  // Task #1126 (Phase 2) — capture the size-capped snippet *now*, so
  // every return path below (including the non-enrichable / oversized
  // / sample_failed branches) carries it back to the caller.
  const diffSnippet = (() => {
    const raw = diffResult.diff;
    const buf = Buffer.from(raw, "utf-8");
    if (buf.length <= MAX_CHECKIN_DIFF_BYTES) return raw;
    return buf.subarray(0, MAX_CHECKIN_DIFF_BYTES).toString("utf-8");
  })();

  // Defensive: even if the helper says the diff fits, double-check the
  // emitted blob fits inside the budget. If trimming dropped every file
  // (everything was oversized) the helper returns an empty diff, which
  // is already handled above. Note: diffSnippet remains valid even when
  // the FULL diff is oversized — it's a separately-capped copy.
  if (Buffer.byteLength(diffResult.diff, "utf-8") > maxDiffBytes) {
    return { directive, outcome: "skipped:oversized", diffSnippet };
  }

  // host_reasoning (and any other non-enrichable) directives stop here:
  // the diff was successfully captured, but there is nothing to rewrite.
  if (!isEnrichableDirective(directive)) {
    return { directive, outcome: "skipped:hard_fixed", diffSnippet };
  }

  // Pull the server-tuned Sam-voice contract for this surface, falling
  // back to the bundled instruction on any error so the prompt is always
  // well-formed. The fetcher is optional so unit tests that don't care
  // about voice-key wiring can omit it.
  let instruction = BUNDLED_NUDGE_INSTRUCTION;
  if (deps.getNudgeInstruction) {
    try {
      const fetched = await deps.getNudgeInstruction();
      if (fetched && fetched.trim()) instruction = fetched;
    } catch {
      // Stick with the bundled fallback — voice-API outages must never
      // break a Coached check-in.
    }
  }

  const userPrompt = buildDiffAwareNudgeGrounding({
    directive,
    questionTitle: state.questionTitle,
    recentUserMessage: input.recentUserMessage ?? null,
    diff: diffResult.diff,
    filesChanged: diffResult.filesChanged,
    truncated: diffResult.truncated,
    instruction,
  });

  const fallback = directive.suggestedWording ?? "";
  const sampleFn =
    deps.sample ??
    (async (args) =>
      sampleSamVoice(deps.server, args.systemPrompt, args.userPrompt, args.fallback, {
        timeoutMs: deps.timeoutMs ?? DIFF_SAMPLE_TIMEOUT_MS,
        maxTokens: DIFF_SAMPLE_MAX_TOKENS,
      }));

  let sampleResult: { text: string; source: "runner_sampling" | "runner_fallback" };
  try {
    sampleResult = await sampleFn({
      systemPrompt: deps.systemPrompt,
      userPrompt,
      fallback,
    });
  } catch {
    return { directive, outcome: "fallback:sample_failed", diffSnippet };
  }

  if (sampleResult.source !== "runner_sampling") {
    return { directive, outcome: "fallback:sample_failed", diffSnippet };
  }
  const enrichedText = sampleResult.text.trim();
  if (!enrichedText) {
    return { directive, outcome: "fallback:sample_failed", diffSnippet };
  }

  return {
    directive: {
      ...directive,
      // Diff-aware enrichment never targets a `mustBeVerbatim` directive
      // (filtered out above), so the rewritten text is always the new
      // `suggestedWording` plain-text form.
      suggestedWording: enrichedText,
    },
    outcome: "enriched",
    diffSummary: {
      filesChanged: diffResult.fileNames,
      truncated: diffResult.truncated,
    },
    diffSnippet,
  };
}
