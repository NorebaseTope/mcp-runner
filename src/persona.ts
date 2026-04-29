// Sam persona: system prompt + grounding builders.
//
// IMPORTANT: The verbatim Sam-voice templates live on the server (lib/sam-voice).
// We never paraphrase them on the runner. The runner is only allowed to ask
// the host model for *new* coaching language that follows Sam's principles.
// If the host refuses sampling, we fall back to the server-side fallback voice
// returned by the attempts endpoint instead of inventing our own.

import {
  getCompanyPattern,
  type CompanyPattern,
} from "@workspace/sam-market-context-shared";

// Re-export the company-pattern types/helpers from the shared lib so callers
// inside the runner (server.ts, tests) can keep importing from "./persona.js"
// without learning about the workspace boundary. The data and matcher live
// in `@workspace/sam-market-context-shared` — this file just builds prompts.
export {
  inferCompanyPattern,
  type CompanyPattern,
  type CompanyPatternEntry,
} from "@workspace/sam-market-context-shared";

export const SAM_SYSTEM_PROMPT = `You are Sam, a candid interview-prep coach who works inside an MCP host
on the user's machine. You speak directly, never flatter, and never give the
answer. Your job is to make the user harder to fool — including by themselves.

Voice rules — always:
- Address the user as "you", never "the candidate".
- Press on reasoning, tradeoffs, and tests. Do not summarize what they did.
- If something is wrong, say so plainly without ridicule.
- If something is correct, name what specifically worked. Do not generalize.
- Never produce code. Never narrate code. Refer to the user's submission as
  "your solution".
- Keep replies under 120 words. One short paragraph + at most one follow-up
  question.

Safety rules — never break:
- Do not reveal hint text the server hasn't released yet.
- Do not invent test outcomes. If a test failed, the failure was already
  measured locally — your job is to interpret it, not to relitigate it.
- Do not answer questions outside interview prep / job search. Politely
  decline and steer back.`;

export interface ReviewGroundingInput {
  questionTitle: string;
  language: string;
  outcome: "pass" | "fail" | "error" | "timeout";
  passedCount: number;
  failedCount: number;
  failedCases: Array<{ id: string; stderrExcerpt?: string }>;
  attemptNumber: number;
  hintsTaken: number;
  // Optional: company pattern tells Sam what this company actually tests for
  // so feedback is grounded in that company's real bar, not generic advice.
  companyPattern?: CompanyPattern;
}

// Builds the grounding payload sent to the host's model when asking for a
// review/probe pair. We deliberately keep the user code OUT of this prompt:
// reading it is the model's job via separate context if it wants to, and we
// don't want to leak it through chat surfaces the user didn't intend.
export function buildReviewGrounding(input: ReviewGroundingInput): string {
  const lines: string[] = [
    `Question: ${input.questionTitle}`,
    `Language: ${input.language}`,
    `Attempt: #${input.attemptNumber}`,
    `Outcome: ${input.outcome.toUpperCase()} (${input.passedCount} passed, ${input.failedCount} failed)`,
    `Hints taken so far: ${input.hintsTaken}`,
  ];
  if (input.failedCases.length > 0) {
    lines.push("");
    lines.push("Failed test cases (id → stderr excerpt):");
    for (const c of input.failedCases.slice(0, 5)) {
      lines.push(`- ${c.id}: ${c.stderrExcerpt ?? "(no stderr)"}`);
    }
  }

  // Company-pattern context paragraph: tells Sam what this company actually
  // tests for, so feedback targets the real bar, not a generic root cause.
  // Sourced from @workspace/sam-market-context-shared so the runner and the
  // server cannot drift on what each company is known to test.
  const pattern = input.companyPattern ?? "generic";
  const patternEntry = getCompanyPattern(pattern);
  lines.push("");
  lines.push("Company interview context (use this to frame your review):");
  lines.push(`  Pattern: ${pattern}`);
  lines.push(`  What they test: ${patternEntry.whatTheyTest.join("; ")}`);
  lines.push(`  Moat moment: ${patternEntry.moatMoment}`);
  lines.push(`  Red flags to call out if present: ${patternEntry.redFlags.join("; ")}`);

  lines.push("");
  lines.push(
    "Write a 2–3 sentence review in Sam's voice that names the most likely root cause given those failures AND references what this specific company cares about. Then write a single short probing follow-up question. Return JSON: {\"review\": string, \"probe\": string}.",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Job enrichment grounding — implements the Search spec's fit-score reasoning.
// ---------------------------------------------------------------------------

export interface JobEnrichmentGroundingInput {
  jobTitle: string;
  company: string;
  jobDescription?: string;
  candidateProfileSummary: string;
  // Structured calibration fields from the Search spec's fit-score formula.
  // Providing these lets Sam name which dimensions are strong and which are weak.
  currentProofPoints?: string[];   // candidate's strongest evidence items
  weakSpots?: string[];            // known gaps from profile or CV extraction
  calibratedTargetIndustries?: string[]; // industries the candidate is open to
  compFloor?: number;              // minimum acceptable TC in USD
  sponsorshipNeed?: boolean;       // true if candidate needs visa sponsorship
  geoPreference?: string;          // e.g. "San Francisco or remote"
}

export interface JobResearchGroundingInput {
  companyName: string;
  careersUrl: string;
  pageExcerpt: string;
  maxJobs: number;
}

// Asks the host model to convert a careers-page excerpt into structured job
// listings. We deliberately constrain the schema to what the Sam dashboard's
// /api/jobs/research/:id/record endpoint accepts, so the runner can post the
// model's JSON straight through after a small parse pass.
export function buildJobResearchGrounding(
  input: JobResearchGroundingInput,
): string {
  return [
    `Company: ${input.companyName}`,
    `Careers URL: ${input.careersUrl}`,
    `Extract up to ${input.maxJobs} OPEN engineering / technical roles from the careers page below.`,
    "",
    "Page excerpt (truncated, raw text only):",
    input.pageExcerpt.slice(0, 8000),
    "",
    "For each role return an object with these fields:",
    "- title (string)",
    '- canonicalUrl (string, absolute URL — use the careers URL if no per-job link is visible)',
    "- roleFamily (one of: backend, frontend, fullstack, data, infra, mobile, ml, security, other)",
    "- seniority (one of: intern, junior, mid, senior, staff, principal, lead, manager)",
    "- location (string)",
    "- remotePolicy (one of: remote, hybrid, onsite, unspecified)",
    "- postingExcerpt (1–2 sentences pulled verbatim from the page)",
    "- team (string, optional)",
    "",
    'Return ONLY JSON: {"jobs": [...]}.',
    "Skip non-engineering roles (sales, ops, design unless eng-adjacent). If the page has no openings, return {\"jobs\": []}.",
  ].join("\n");
}

export function buildJobEnrichmentGrounding(
  input: JobEnrichmentGroundingInput,
): string {
  const lines: string[] = [
    `Job: ${input.jobTitle} at ${input.company}`,
    `Candidate profile: ${input.candidateProfileSummary}`,
  ];

  if (input.jobDescription) {
    lines.push(`Job description (truncated): ${input.jobDescription.slice(0, 1500)}`);
  } else {
    lines.push("Job description: (not available)");
  }

  // Structured calibration context for fit-score reasoning.
  lines.push("");
  lines.push("Candidate calibration (use these to score the five fit dimensions):");

  if (input.currentProofPoints && input.currentProofPoints.length > 0) {
    lines.push(`  Proof points: ${input.currentProofPoints.slice(0, 4).join("; ")}`);
  } else {
    lines.push("  Proof points: (none provided — note this as a risk)");
  }

  if (input.weakSpots && input.weakSpots.length > 0) {
    lines.push(`  Known weak spots: ${input.weakSpots.join("; ")}`);
  }

  if (input.calibratedTargetIndustries && input.calibratedTargetIndustries.length > 0) {
    lines.push(`  Open industries: ${input.calibratedTargetIndustries.join(", ")}`);
  }

  if (typeof input.compFloor === "number") {
    lines.push(`  Comp floor: $${input.compFloor.toLocaleString()} TC`);
  }

  if (input.sponsorshipNeed !== undefined) {
    lines.push(`  Visa sponsorship needed: ${input.sponsorshipNeed ? "yes" : "no"}`);
  }

  if (input.geoPreference) {
    lines.push(`  Geo preference: ${input.geoPreference}`);
  }

  lines.push("");
  lines.push("FIT-SCORE INSTRUCTIONS (Search spec):");
  lines.push("Apply the five-dimension fit formula. For each dimension, state whether it is STRONG, WEAK, or UNKNOWN:");
  lines.push("  1. Level match — does the role seniority match the candidate's calibrated level?");
  lines.push("  2. Proof match — does the candidate have specific evidence that maps to the role's core requirements?");
  lines.push("  3. Geo match — does the role location match geo preference?");
  lines.push("  4. Sponsorship match — does the company sponsor if the candidate needs it?");
  lines.push("  5. Comp match — is the role's likely TC above the candidate's floor?");
  lines.push("");
  lines.push("Then produce:");
  lines.push("  - why_you_fit: 3–4 concrete sentences naming the strongest proof-point evidence. Name the dimension, name the evidence. Do not hedge.");
  lines.push("  - risks: an array of up to 3 honest gaps (each as a short phrase). Do not invent risks not grounded in the calibration data.");
  lines.push("  - first_action_angle: one sentence — the single most concrete step the candidate should take first (e.g. 'Modal runs a take-home before the first call; carve four hours this week'). Specific > generic.");
  lines.push("  - application_angle: one sentence framing how the candidate should pitch themselves in the application.");
  lines.push("");
  lines.push('Return JSON: {"why_you_fit": string, "risks": string[], "first_action_angle": string, "application_angle": string}.');

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Application channel-selection grounding — implements the Application spec.
// ---------------------------------------------------------------------------

export type ApplicationChannel =
  | "referral"
  | "recruiter_outreach"
  | "hiring_manager_outreach"
  | "warm_intro"
  | "direct_apply";

export interface ShortlistRow {
  jobTitle: string;
  company: string;
  roleFamily: string;
  seniority: string;
  postingExcerpt?: string;
  canonicalUrl?: string;
}

export interface ApplicationCalibration {
  currentProofPoints?: string[];
  weakSpots?: string[];
  targetLevel?: string;
  compFloor?: number;
  sponsorshipNeed?: boolean;
  geoPreference?: string;
  availableContacts?: string[];  // names/roles of any connections at the company
}

export interface PrepPayload {
  // Optional prep context that informs the channel recommendation.
  hasRecentPractice?: boolean;
  practiceReadiness?: "low" | "medium" | "high";
}

export type SessionIntent =
  | "apply_now"
  | "explore_fit"
  | "build_plan"
  | "unknown";

export interface ApplicationGroundingInput {
  shortlistRow: ShortlistRow;
  calibration: ApplicationCalibration;
  prepPayload?: PrepPayload;
  sessionIntent?: SessionIntent;
}

// Builds the grounding payload for the Application surface.
// Instructs Sam to select the right channel using the Application spec's rules,
// explain the choice in one sentence, and produce a submission checklist.
export function buildApplicationGrounding(input: ApplicationGroundingInput): string {
  const { shortlistRow, calibration, prepPayload, sessionIntent } = input;

  const lines: string[] = [
    `Job: ${shortlistRow.jobTitle} at ${shortlistRow.company} (${shortlistRow.seniority} ${shortlistRow.roleFamily})`,
  ];

  if (shortlistRow.postingExcerpt) {
    lines.push(`Posting excerpt: ${shortlistRow.postingExcerpt}`);
  }

  if (shortlistRow.canonicalUrl) {
    lines.push(`Posting URL: ${shortlistRow.canonicalUrl}`);
  }

  lines.push("");
  lines.push("Candidate context:");
  if (calibration.targetLevel) lines.push(`  Target level: ${calibration.targetLevel}`);
  if (calibration.currentProofPoints && calibration.currentProofPoints.length > 0) {
    lines.push(`  Proof points: ${calibration.currentProofPoints.slice(0, 3).join("; ")}`);
  }
  if (calibration.weakSpots && calibration.weakSpots.length > 0) {
    lines.push(`  Weak spots: ${calibration.weakSpots.join("; ")}`);
  }
  if (typeof calibration.compFloor === "number") {
    lines.push(`  Comp floor: $${calibration.compFloor.toLocaleString()} TC`);
  }
  if (calibration.sponsorshipNeed !== undefined) {
    lines.push(`  Visa sponsorship needed: ${calibration.sponsorshipNeed ? "yes" : "no"}`);
  }
  if (calibration.availableContacts && calibration.availableContacts.length > 0) {
    lines.push(`  Available contacts at company: ${calibration.availableContacts.join(", ")}`);
  } else {
    lines.push("  Available contacts at company: none identified");
  }

  if (prepPayload) {
    lines.push(`  Practice readiness: ${prepPayload.practiceReadiness ?? "unknown"}`);
    lines.push(`  Has recent practice: ${prepPayload.hasRecentPractice ? "yes" : "no"}`);
  }

  if (sessionIntent && sessionIntent !== "unknown") {
    lines.push(`  Session intent: ${sessionIntent}`);
  }

  lines.push("");
  lines.push("CHANNEL SELECTION RULES (Application spec — apply in order, stop at the first match):");
  lines.push("  1. referral — if a contact is available AND they have worked with the candidate directly or can vouch for them");
  lines.push("  2. recruiter_outreach — if the company is in a category where recruiters own the pipeline: HFT, quant, bank (Goldman, Citadel, Jane Street, Morgan Stanley, etc.)");
  lines.push("  3. hiring_manager_outreach — ONLY if ALL THREE conditions hold: (a) the role was posted within the last 30 days, (b) the hiring manager is identifiable from the posting or LinkedIn, (c) there is a specific connection point (shared project domain, mutual connection, cited research)");
  lines.push("  4. warm_intro — if the candidate is targeting Staff+ level and has a second-degree connection who can make an introduction");
  lines.push("  5. direct_apply — default if none of the above apply");
  lines.push("");
  lines.push("INSTRUCTIONS:");
  lines.push("  - Select the highest-priority channel that applies based on the candidate context above.");
  lines.push("  - Explain the channel choice in exactly one sentence (the 'channel_rationale' field).");
  lines.push("  - Produce a submission_checklist: an ordered array of 3–5 concrete steps the candidate should take before or when submitting. Each step is a short imperative sentence.");
  lines.push("  - Write an outreach_draft_angle: one paragraph (3–5 sentences) in Sam's voice that frames the message the candidate should send — either to the recruiter, HM, or contact. Omit if channel is direct_apply.");
  lines.push("");
  lines.push('Return JSON: {"channel": string, "channel_rationale": string, "submission_checklist": string[], "outreach_draft_angle": string | null}.');

  return lines.join("\n");
}
