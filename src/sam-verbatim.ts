// Sam-voice verbatim relay protocol (Task #1064).
//
// MIRRORED from `artifacts/api-server/src/lib/sam-verbatim.ts`. The runner
// is a published npm package that cannot import from internal monorepo
// paths, so the helpers live in both places by hand. Keep them in sync.
import { createHash } from "node:crypto";

export const SAM_VERBATIM_OPEN = "<<<SAM_VERBATIM>>>";
export const SAM_VERBATIM_CLOSE = "<<<END_SAM_VERBATIM>>>";

export function wrapSamVerbatim(line: string | null | undefined): string {
  const text = (line ?? "").trim();
  if (!text) return "";
  if (text.startsWith(SAM_VERBATIM_OPEN) && text.endsWith(SAM_VERBATIM_CLOSE)) {
    return text;
  }
  return `${SAM_VERBATIM_OPEN}\n${text}\n${SAM_VERBATIM_CLOSE}`;
}

export function extractSamVerbatim(blob: string | null | undefined): string {
  if (!blob) return "";
  const text = blob.trim();
  const open = text.indexOf(SAM_VERBATIM_OPEN);
  const close = text.lastIndexOf(SAM_VERBATIM_CLOSE);
  if (open === -1 || close === -1 || close <= open) {
    return text;
  }
  return text.slice(open + SAM_VERBATIM_OPEN.length, close).trim();
}

export function normalizeForCompare(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[*_`>#~]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function hashVoiceLine(line: string | null | undefined): string {
  const norm = normalizeForCompare(extractSamVerbatim(line ?? ""));
  return createHash("sha256").update(norm).digest("hex").slice(0, 16);
}

export type RelayClassification =
  | "relayed_verbatim"
  | "relayed_with_drift"
  | "not_relayed"
  | "unknown";

/**
 * Classify the host's last assistant turn against the most recent
 * Sam-voice line we issued. Mirrors the server-side helper.
 */
export function classifyRelay(args: {
  lastAssistantTurn?: string | null;
  lastSamVoiceLine?: string | null;
}): RelayClassification {
  const sam = extractSamVerbatim(args.lastSamVoiceLine ?? "");
  const turn = args.lastAssistantTurn ?? "";
  if (!sam) return "unknown";
  if (!turn || turn.trim().length === 0) return "not_relayed";
  const samNorm = normalizeForCompare(sam);
  const turnNorm = normalizeForCompare(turn);
  if (!samNorm) return "unknown";
  if (turnNorm.includes(samNorm)) return "relayed_verbatim";
  const minLen = Math.max(20, Math.floor(samNorm.length * 0.6));
  if (samNorm.length >= 20) {
    for (let i = 0; i + minLen <= samNorm.length; i++) {
      const slice = samNorm.slice(i, i + minLen);
      if (turnNorm.includes(slice)) return "relayed_with_drift";
    }
  }
  return "not_relayed";
}

// ---------------------------------------------------------------------------
// Task #1075 — hybrid directive-compliance helpers (mirror of the server).
// Used by host-side test fixtures and any future runner-side telemetry; the
// server is the source of truth for the persisted rollup.
// ---------------------------------------------------------------------------

export type DirectiveCompliance =
  | "honored"
  | "missed"
  | "verbatim_violation"
  | "unknown";

export interface DirectiveComplianceRollup {
  honored: number;
  missed: number;
  verbatim_violation: number;
  unknown: number;
}

export function emptyDirectiveCompliance(): DirectiveComplianceRollup {
  return { honored: 0, missed: 0, verbatim_violation: 0, unknown: 0 };
}

export function classifyDirectiveCompliance(args: {
  lastAssistantTurn?: string | null;
  lastSuggestedWordingHash?: string | null;
  lastMustBeVerbatim?: boolean | null;
}): DirectiveCompliance {
  if (!args.lastSuggestedWordingHash) return "unknown";
  const turn = (args.lastAssistantTurn ?? "").trim();
  if (turn.length === 0) return "missed";
  if (args.lastMustBeVerbatim) {
    const turnHash = hashVoiceLine(turn);
    if (turnHash !== args.lastSuggestedWordingHash) return "verbatim_violation";
  }
  return "honored";
}

export function directiveCompliancePct(
  rollup: DirectiveComplianceRollup | null | undefined,
): number | null {
  if (!rollup) return null;
  const denom = rollup.honored + rollup.missed + rollup.verbatim_violation;
  if (denom === 0) return null;
  return Math.round((rollup.honored / denom) * 100);
}
