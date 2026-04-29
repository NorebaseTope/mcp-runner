// Unit tests for persona.ts grounding builders.
//
// Verifies that the runner's grounding prompts adapt correctly per company
// pattern and that the output JSON schemas requested from the host model
// match the contracts the Sam server expects:
//
//   - buildReviewGrounding: company-specific language per CompanyPattern
//     (faang-canonical, stripe-integration, anthropic-swe, hft-mental-math)
//   - buildJobEnrichmentGrounding: five fit dimensions + risks + first action
//   - buildApplicationGrounding: channel-selection signals (referral when
//     contacts present, recruiter rule covers HFT firms, direct_apply default)

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildApplicationGrounding,
  buildJobEnrichmentGrounding,
  buildReviewGrounding,
  inferCompanyPattern,
  type CompanyPattern,
  type ReviewGroundingInput,
} from "../persona.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function baseReviewInput(
  overrides: Partial<ReviewGroundingInput> = {},
): ReviewGroundingInput {
  return {
    questionTitle: "Two Sum",
    language: "python",
    outcome: "fail",
    passedCount: 9,
    failedCount: 1,
    failedCases: [{ id: "case-3", stderrExcerpt: "IndexError" }],
    attemptNumber: 2,
    hintsTaken: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildReviewGrounding: company-specific language per pattern
// ---------------------------------------------------------------------------

// Each pattern must surface its distinguishing vocabulary in the grounding so
// the host model can frame Sam's review around the company's real bar. The
// keywords are taken from the COMPANY_PATTERN_CONTEXT block in persona.ts.
const PATTERN_KEYWORDS: Record<
  Extract<
    CompanyPattern,
    "faang-canonical" | "stripe-integration" | "anthropic-swe" | "hft-mental-math"
  >,
  string[]
> = {
  "faang-canonical": ["edge-case coverage", "asymptotic"],
  "stripe-integration": ["idempotency", "retry"],
  "anthropic-swe": ["code clarity", "alignment"],
  "hft-mental-math": ["mental math", "latency"],
};

for (const [pattern, keywords] of Object.entries(PATTERN_KEYWORDS) as [
  CompanyPattern,
  string[],
][]) {
  test(`buildReviewGrounding embeds company-specific language for ${pattern}`, () => {
    const out = buildReviewGrounding(baseReviewInput({ companyPattern: pattern }));

    // Pattern label is always echoed back verbatim so the model can ground on it.
    assert.ok(
      out.includes(`Pattern: ${pattern}`),
      `output must label the pattern as "${pattern}"`,
    );

    // Distinguishing vocabulary for this pattern must appear (case-insensitive).
    const lower = out.toLowerCase();
    for (const kw of keywords) {
      assert.ok(
        lower.includes(kw.toLowerCase()),
        `output for pattern "${pattern}" must mention "${kw}"`,
      );
    }

    // The three labelled sections of the company context block must be present.
    assert.ok(out.includes("What they test:"), "output must include 'What they test:' section");
    assert.ok(out.includes("Moat moment:"), "output must include 'Moat moment:' section");
    assert.ok(out.includes("Red flags"), "output must include 'Red flags' section");
  });
}

test("buildReviewGrounding falls back to generic context when companyPattern is omitted", () => {
  const out = buildReviewGrounding(baseReviewInput());
  assert.ok(out.includes("Pattern: generic"), "should default to generic pattern");
  assert.ok(out.includes("Company interview context"), "should still include company context section");
});

test("buildReviewGrounding does not bleed pattern-specific keywords across patterns", () => {
  // A faang-canonical grounding must NOT advertise stripe's idempotency framing,
  // which would make Sam give the wrong company-specific feedback.
  const faang = buildReviewGrounding(
    baseReviewInput({ companyPattern: "faang-canonical" }),
  ).toLowerCase();
  assert.ok(!faang.includes("idempotency"), "faang grounding must not mention idempotency");
  assert.ok(!faang.includes("mental math"), "faang grounding must not mention mental math");

  const stripe = buildReviewGrounding(
    baseReviewInput({ companyPattern: "stripe-integration" }),
  ).toLowerCase();
  assert.ok(!stripe.includes("mental math"), "stripe grounding must not mention mental math");
});

test("buildReviewGrounding requests the canonical {review, probe} JSON shape", () => {
  const out = buildReviewGrounding(baseReviewInput({ companyPattern: "anthropic-swe" }));
  assert.ok(
    out.includes('{"review": string, "probe": string}'),
    "output must request the {review, probe} JSON shape",
  );
});

test("buildReviewGrounding includes attempt metadata and failed cases", () => {
  const out = buildReviewGrounding(
    baseReviewInput({
      attemptNumber: 4,
      hintsTaken: 2,
      failedCases: [
        { id: "case-1", stderrExcerpt: "AssertionError: empty input" },
        { id: "case-2" },
      ],
    }),
  );
  assert.ok(out.includes("Attempt: #4"), "must include attempt number");
  assert.ok(out.includes("Hints taken so far: 2"), "must include hints-taken count");
  assert.ok(out.includes("case-1: AssertionError: empty input"), "must include failed case excerpt");
  assert.ok(out.includes("case-2: (no stderr)"), "must show placeholder for missing stderr");
});

test("inferCompanyPattern maps known company names to the correct pattern", () => {
  assert.equal(inferCompanyPattern("Stripe"), "stripe-integration");
  assert.equal(inferCompanyPattern("Google"), "faang-canonical");
  assert.equal(inferCompanyPattern("Anthropic"), "anthropic-swe");
  assert.equal(inferCompanyPattern("Citadel Securities"), "hft-mental-math");
  assert.equal(inferCompanyPattern("Goldman Sachs"), "bank-structured");
  assert.equal(inferCompanyPattern("SomeUnknownStartup"), "generic");
});

// ---------------------------------------------------------------------------
// buildJobEnrichmentGrounding: five fit dimensions + output schema
// ---------------------------------------------------------------------------

test("buildJobEnrichmentGrounding lists all five fit dimensions", () => {
  const out = buildJobEnrichmentGrounding({
    jobTitle: "Senior Backend Engineer",
    company: "Stripe",
    candidateProfileSummary: "10 years of payments infra experience.",
    currentProofPoints: ["Built idempotency layer at Square"],
    weakSpots: ["Limited frontend exposure"],
    calibratedTargetIndustries: ["fintech", "infra"],
    compFloor: 250000,
    sponsorshipNeed: false,
    geoPreference: "San Francisco or remote",
  });

  // Each of the five fit dimensions must be enumerated in the prompt.
  assert.ok(/1\.\s+Level match/i.test(out), "must list dimension 1: Level match");
  assert.ok(/2\.\s+Proof match/i.test(out), "must list dimension 2: Proof match");
  assert.ok(/3\.\s+Geo match/i.test(out), "must list dimension 3: Geo match");
  assert.ok(/4\.\s+Sponsorship match/i.test(out), "must list dimension 4: Sponsorship match");
  assert.ok(/5\.\s+Comp match/i.test(out), "must list dimension 5: Comp match");
});

test("buildJobEnrichmentGrounding requests risks and first_action_angle in the JSON schema", () => {
  const out = buildJobEnrichmentGrounding({
    jobTitle: "Staff Engineer",
    company: "Anthropic",
    candidateProfileSummary: "Distributed-systems background.",
  });

  // The model must be told to emit each of these fields, and the JSON shape
  // returned at the end must include them as keys.
  assert.ok(out.includes("why_you_fit"), "must request why_you_fit");
  assert.ok(out.includes("risks"), "must request risks");
  assert.ok(out.includes("first_action_angle"), "must request first_action_angle");
  assert.ok(out.includes("application_angle"), "must request application_angle");

  // Risks must be requested as an array of short phrases.
  assert.ok(
    /risks:\s*an array/i.test(out),
    "must describe risks as an array",
  );

  // The final JSON schema instruction must include these fields by name.
  assert.ok(
    out.includes('"why_you_fit"') &&
      out.includes('"risks"') &&
      out.includes('"first_action_angle"') &&
      out.includes('"application_angle"'),
    "final JSON schema must list all four output fields",
  );
  assert.ok(
    out.includes("string[]"),
    "final JSON schema must type risks as string[]",
  );
});

test("buildJobEnrichmentGrounding flags missing proof points as a risk", () => {
  const out = buildJobEnrichmentGrounding({
    jobTitle: "Senior Engineer",
    company: "GenericCo",
    candidateProfileSummary: "Backend generalist.",
    // No currentProofPoints supplied — builder should explicitly instruct the
    // model to call this out as a risk rather than fabricate proof points.
  });
  assert.ok(
    out.toLowerCase().includes("none provided") || out.toLowerCase().includes("note this as a risk"),
    "missing proof points must be flagged in the grounding",
  );
});

test("buildJobEnrichmentGrounding handles missing job description without breaking", () => {
  const out = buildJobEnrichmentGrounding({
    jobTitle: "Backend Engineer",
    company: "ExampleCo",
    candidateProfileSummary: "Generalist.",
  });
  assert.ok(out.includes("Job description: (not available)"));
});

// ---------------------------------------------------------------------------
// buildApplicationGrounding: channel-selection logic signals
// ---------------------------------------------------------------------------

// The grounding builder doesn't pick a channel itself — it constructs the
// prompt the host model uses to apply the Application spec's rules. So these
// tests verify two things at once:
//   (a) the rules are stated correctly and in priority order, AND
//   (b) the right inputs are surfaced so the model would pick the channel
//       the Application spec calls for in each scenario.

test("buildApplicationGrounding lists the five channel rules in priority order", () => {
  const out = buildApplicationGrounding({
    shortlistRow: {
      jobTitle: "Senior Engineer",
      company: "ExampleCo",
      roleFamily: "backend",
      seniority: "senior",
    },
    calibration: {},
  });

  // Each rule appears with its number; assert their priorities match the spec.
  const order = [
    "1. referral",
    "2. recruiter_outreach",
    "3. hiring_manager_outreach",
    "4. warm_intro",
    "5. direct_apply",
  ];
  let lastIdx = -1;
  for (const label of order) {
    const idx = out.indexOf(label);
    assert.ok(idx !== -1, `output must include rule "${label}"`);
    assert.ok(idx > lastIdx, `rule "${label}" must appear after the previous rule in priority order`);
    lastIdx = idx;
  }
});

test("buildApplicationGrounding surfaces contact list when contacts are present (referral case)", () => {
  const out = buildApplicationGrounding({
    shortlistRow: {
      jobTitle: "Senior Engineer",
      company: "ExampleCo",
      roleFamily: "backend",
      seniority: "senior",
    },
    calibration: {
      availableContacts: ["Alex Kim (former teammate, EM at ExampleCo)"],
    },
  });

  // The contact must be surfaced verbatim so the model can apply rule 1.
  assert.ok(
    out.includes("Available contacts at company: Alex Kim (former teammate, EM at ExampleCo)"),
    "contact must be surfaced in the grounding when present",
  );
  // The referral rule itself must reference contacts so the model knows when to fire it.
  assert.ok(
    /referral.*contact/i.test(out),
    "referral rule must reference contacts",
  );
});

test("buildApplicationGrounding marks contacts as 'none identified' when missing (default case)", () => {
  const out = buildApplicationGrounding({
    shortlistRow: {
      jobTitle: "Senior Engineer",
      company: "ExampleCo",
      roleFamily: "backend",
      seniority: "senior",
    },
    calibration: {},
  });

  assert.ok(
    out.includes("Available contacts at company: none identified"),
    "missing contacts must be explicitly marked",
  );
  // direct_apply must remain the documented default fallback.
  assert.ok(
    /direct_apply.*default/i.test(out),
    "direct_apply must be described as the default fallback",
  );
});

test("buildApplicationGrounding routes HFT companies to recruiter_outreach via the rule text", () => {
  // Citadel is one of the HFT firms inferCompanyPattern recognises. The
  // recruiter_outreach rule explicitly enumerates these firms in the prompt
  // so the model picks recruiter_outreach for them.
  const out = buildApplicationGrounding({
    shortlistRow: {
      jobTitle: "Quant Developer",
      company: "Citadel",
      roleFamily: "backend",
      seniority: "senior",
    },
    calibration: {},
  });

  // Sanity: this is an HFT firm in the pattern map.
  assert.equal(inferCompanyPattern("Citadel"), "hft-mental-math");

  // The Job line must surface the HFT company so the model has the trigger.
  assert.ok(out.includes("Citadel"), "company name must appear in the job line");

  // The recruiter_outreach rule must mention HFT and at least one HFT firm by
  // name so the model can match the company to this category.
  assert.ok(
    /recruiter_outreach.*HFT/i.test(out),
    "recruiter_outreach rule must mention HFT companies",
  );
  assert.ok(
    /citadel|jane street/i.test(out),
    "recruiter_outreach rule must enumerate HFT firms by name",
  );
});

test("buildApplicationGrounding requests the canonical channel JSON shape", () => {
  const out = buildApplicationGrounding({
    shortlistRow: {
      jobTitle: "Senior Engineer",
      company: "ExampleCo",
      roleFamily: "backend",
      seniority: "senior",
    },
    calibration: {},
  });

  // The output schema must include all four contract fields the server expects.
  assert.ok(out.includes('"channel"'), "JSON schema must include channel");
  assert.ok(out.includes('"channel_rationale"'), "JSON schema must include channel_rationale");
  assert.ok(out.includes('"submission_checklist"'), "JSON schema must include submission_checklist");
  assert.ok(out.includes('"outreach_draft_angle"'), "JSON schema must include outreach_draft_angle");
});

test("buildApplicationGrounding includes optional prep + session intent context when supplied", () => {
  const out = buildApplicationGrounding({
    shortlistRow: {
      jobTitle: "Staff Engineer",
      company: "ExampleCo",
      roleFamily: "backend",
      seniority: "staff",
    },
    calibration: {
      targetLevel: "Staff",
      currentProofPoints: ["Led platform migration"],
      compFloor: 350000,
      sponsorshipNeed: true,
    },
    prepPayload: { hasRecentPractice: true, practiceReadiness: "high" },
    sessionIntent: "apply_now",
  });

  assert.ok(out.includes("Target level: Staff"));
  assert.ok(out.includes("Comp floor: $350,000 TC"));
  assert.ok(out.includes("Visa sponsorship needed: yes"));
  assert.ok(out.includes("Practice readiness: high"));
  assert.ok(out.includes("Has recent practice: yes"));
  assert.ok(out.includes("Session intent: apply_now"));
});
