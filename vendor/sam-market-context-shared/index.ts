// Sam company-pattern data — single source of truth.
//
// Both the API server (artifacts/api-server/src/lib/sam-market-context.ts)
// and the local MCP runner (packages/mcp-runner/src/persona.ts) consume
// `COMPANY_PATTERNS` from here. Keeping the per-pattern coaching context
// (whatTheyTest / moatMoment / redFlags) in one place means a product
// change to a pattern is a one-file edit, not a two-file edit, and the two
// surfaces cannot drift in what Sam says about a given company.
//
// Server-only market data — title-deflation rules, comp bands, industry
// hiring signals — stays in the server's sam-market-context.ts because the
// runner doesn't need it for grounding.

export type CompanyPattern =
  | "faang-canonical"
  | "stripe-integration"
  | "anthropic-swe"
  | "hft-mental-math"
  | "bank-structured"
  | "startup-system-design"
  | "generic";

export type CompanyPatternEntry = {
  pattern: CompanyPattern;
  companies: string[];
  whatTheyTest: string[];
  moatMoment: string;
  redFlags: string[];
  notes: string;
};

export const COMPANY_PATTERNS: CompanyPatternEntry[] = [
  {
    pattern: "faang-canonical",
    companies: ["Google", "Meta", "Facebook", "Amazon", "Apple", "Microsoft"],
    whatTheyTest: [
      "Algorithmic correctness and edge-case coverage",
      "Asymptotic complexity (both time and space — asked explicitly)",
      "Clean generalization from small to large inputs",
      "System design at L5+: scale, fault tolerance, consistency tradeoffs",
    ],
    moatMoment:
      "Edge-case coverage and asymptotic correctness. A solution that passes 9 of 10 tests but fails on empty input or overflow is a fail.",
    redFlags: [
      "Correct solution with no complexity analysis",
      "No edge cases named before coding",
      "System design that doesn't name a consistency model",
    ],
    notes:
      "Leetcode-style, two 45-min rounds, then behavioral (STAR). L5+ adds system design and leadership principles.",
  },
  {
    pattern: "stripe-integration",
    companies: ["Stripe"],
    whatTheyTest: [
      "API design hygiene: idempotency, error semantics, versioning",
      "Idempotency key scope and duplicate-key conflict handling",
      "Real-world integration failure modes (retry storms, partial writes)",
      "Code clarity and explicit error handling over clever one-liners",
    ],
    moatMoment:
      "Idempotency key scope and duplicate-key conflict path. Stripe does not ask Two Sum — they ask you to build a payment endpoint that is safe to retry.",
    redFlags: [
      "Treating idempotency as optional or an afterthought",
      "No retry/backoff consideration in distributed calls",
      "Clever code that obscures failure paths",
    ],
    notes:
      "Homework-style take-home (4–6 hrs) + in-depth code review session. Stripe values explicitness over terseness.",
  },
  {
    pattern: "anthropic-swe",
    companies: ["Anthropic"],
    whatTheyTest: [
      "Code clarity: readable over clever, names that communicate intent",
      "Test coverage: edge cases, boundary conditions, failure modes",
      "Alignment thinking in behavioral: how you reason about ambiguous tradeoffs",
      "Systems thinking: what breaks, who is affected, how you would monitor it",
    ],
    moatMoment:
      "Code clarity and alignment reasoning. Anthropic wants to see that you can write code a colleague can trust and that you've thought about second-order effects.",
    redFlags: [
      "Obscure variable names or implicit logic",
      "Test suite that only covers the happy path",
      "Behavioral answers that optimize for personal impact over team/user impact",
    ],
    notes:
      "MTS role probes scope heavily in interview — 'what would you own vs. delegate' style questions. Alignment reasoning appears in behavioral rounds.",
  },
  {
    pattern: "hft-mental-math",
    companies: [
      "Jane Street",
      "Citadel",
      "Hudson River Trading",
      "Tower Research",
      "Jump Trading",
      "DRW",
      "Two Sigma",
      "Virtu",
    ],
    whatTheyTest: [
      "Mental math under pressure: probability, expected value, order-of-magnitude estimates",
      "Latency reasoning: what does 1 microsecond mean in a 10Gbps pipeline",
      "Brain teasers with no right answer — they're testing reasoning transparency",
      "Probability and combinatorics, sometimes with dice or card decks",
    ],
    moatMoment:
      "Reasoning transparency under pressure. HFT firms do not expect perfect answers — they expect you to narrate your thinking clearly while moving fast.",
    redFlags: [
      "Going silent when uncertain — narrate even wrong guesses",
      "Skipping order-of-magnitude sanity checks",
      "Treating ambiguous problems as if they have one right answer",
    ],
    notes:
      "Typically 3–5 rounds of brain teasers + technical coding (latency-sensitive, often C++). Comp is heavily bonus-weighted.",
  },
  {
    pattern: "bank-structured",
    companies: [
      "Goldman Sachs",
      "JP Morgan",
      "Morgan Stanley",
      "Deutsche Bank",
      "BlackRock",
      "Barclays",
      "UBS",
    ],
    whatTheyTest: [
      "Structured coding: well-organized, readable, no shortcuts",
      "Domain basics: data structures, SQL, sometimes finance fundamentals",
      "Behavioral: STAR format, leadership, cross-team conflict resolution",
      "Situational judgment: how you handle ambiguity in regulated environments",
    ],
    moatMoment:
      "Structured communication. Banks reward candidates who explain their reasoning step-by-step and ask clarifying questions before diving in.",
    redFlags: [
      "Unstructured answers that skip problem clarification",
      "Code that works but is hard to review",
      "Not demonstrating awareness of compliance or audit trails",
    ],
    notes: "Goldman VP = L5 scope. Apply title deflation before calibrating level claims.",
  },
  {
    pattern: "startup-system-design",
    companies: [],
    whatTheyTest: [
      "System design with constraints: 'build it with 2 engineers in 3 months'",
      "Pragmatic tradeoffs: MVP vs. scale, build vs. buy",
      "Broad ownership: full-stack, ops, on-call reasoning",
      "Speed of delivery and comfort with ambiguity",
    ],
    moatMoment:
      "Pragmatic tradeoff reasoning. Startups want to see you can ship something real under resource constraints, not architect a perfect system.",
    redFlags: [
      "Over-engineering: proposing Kubernetes for a 100-user app",
      "No mention of observability or on-call burden",
      "Answers that assume dedicated infra/ops teams",
    ],
    notes: "Varies widely. Often a take-home or live-coding exercise with a realistic, messy problem.",
  },
  {
    pattern: "generic",
    companies: [],
    whatTheyTest: [
      "Basic algorithmic correctness",
      "Code cleanliness and communication",
      "Behavioral STAR answers",
    ],
    moatMoment: "Clear reasoning and named tradeoffs.",
    redFlags: ["No edge cases", "Silent problem-solving"],
    notes: "Fallback pattern for unknown company types.",
  },
];

export function getCompanyPattern(patternKey: CompanyPattern): CompanyPatternEntry {
  return (
    COMPANY_PATTERNS.find((p) => p.pattern === patternKey) ??
    COMPANY_PATTERNS.find((p) => p.pattern === "generic")!
  );
}

export function inferCompanyPattern(companyName: string): CompanyPattern {
  const name = companyName.toLowerCase();
  for (const entry of COMPANY_PATTERNS) {
    if (entry.companies.some((c) => name.includes(c.toLowerCase()))) {
      return entry.pattern;
    }
  }
  return "generic";
}

// Compact text block of a pattern's coaching context, suitable for embedding
// in a grounding prompt. The runner uses this to brief the host model on
// what a given company actually tests, so feedback targets the real bar
// rather than a generic root cause.
export function formatCompanyPatternContext(pattern: CompanyPatternEntry): string {
  return [
    `Company pattern: ${pattern.pattern}`,
    `What they test:`,
    ...pattern.whatTheyTest.map((t) => `  - ${t}`),
    `Moat moment: ${pattern.moatMoment}`,
    `Red flags to avoid:`,
    ...pattern.redFlags.map((r) => `  - ${r}`),
  ].join("\n");
}
