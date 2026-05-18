// Task #1561 — Broadened stall-nudge templated wording pool.
//
// 2.2.4 shipped with only ~6 stall-probe lines (`STALL_PROBE_LINES` x
// 3 variants, plus the per-shape `fallbackProbeText` ladder), which
// produced visible repeats within 90s in idle sessions (see
// `ses_3tofurxbf1`). This module expands each cadence "stage" to ~20
// variants so a fresh template can be picked on every tick without
// repeating itself in a 5-minute window.
//
// Voice contract: every line is measured, curious, never preachy —
// matches the Sam persona in `HOST_REASONING_PERSONA`. No emoji, no
// markdown, no code, one or two short sentences max.
//
// Each pool is grouped by cadence stage so escalation still feels
// natural — `early_stall` is gentle / curious, `mid_stall` starts
// probing more concretely, `late_stall` invites a hint, and
// `hint_offer` is the strongest probe.

export type CadenceStage = "early_stall" | "mid_stall" | "late_stall" | "hint_offer";

// `early_stall` — first idle window. Wording is open-ended; we just
// want the candidate to think out loud.
export const EARLY_STALL_POOL: readonly string[] = [
  "You've gone quiet — what are you turning over in your head right now?",
  "Walk me through what you're considering, even rough.",
  "Where are you in your head on this — still framing it, or trying something specific?",
  "What's the next thing you're tempted to try?",
  "Talk me through what you're noticing in the problem so far.",
  "What do you think the shape of the answer is?",
  "If you had to describe what you're trying to do in one sentence, what would it be?",
  "What feels uncertain right now — the approach, or the details?",
  "What's the smallest version of this you could get working first?",
  "Anything in the problem statement you're rereading?",
  "What part feels clearest, and what part feels fuzziest?",
  "Where would you start if you only had ten minutes?",
  "What inputs and outputs are you picturing?",
  "Is there an example case you'd want to step through by hand?",
  "What constraints have you noticed that might shape the approach?",
  "What's a brute-force version look like, even if it's slow?",
  "What would the function signature be if you wrote it right now?",
  "Anything you want to clarify about the problem before you commit to an approach?",
  "What's holding you back from typing the first line?",
  "Say more — what's the question you're asking yourself?",
];

// `mid_stall` — silence has persisted past the first window. Probe
// more concretely about what they've tried and what they're seeing.
export const MID_STALL_POOL: readonly string[] = [
  "Still with me? What have you tried so far, even if it didn't work?",
  "Walk me through your current attempt — where does it break down?",
  "What's the part you keep getting stuck on?",
  "If you ran what you have right now, what do you think would happen?",
  "Talk me through one of the test cases by hand — what should happen step by step?",
  "What's the assumption you're least sure about?",
  "Which case do you think your current approach gets wrong?",
  "What would you change if you started over from scratch right now?",
  "Where's the friction — the algorithm, the data structure, or the edge cases?",
  "What does your current code do well, and where does it fall short?",
  "What's the simplest input where you'd expect this to fail?",
  "If you had to bet, what's the one bug you suspect is in there?",
  "What did you try last, and what did you see?",
  "Is there a pattern from a similar problem you're trying to bend to fit?",
  "What would a slower but obviously-correct version look like?",
  "Where in the code are you least confident?",
  "If you could ask a teammate one question right now, what would it be?",
  "What's the loop or branch you keep rewriting?",
  "Which test case are you mentally running against your current draft?",
  "Tell me where you got to and what made you pause.",
];

// `late_stall` — silence is now long enough that we want to open the
// door to a hint without forcing it. Still in Sam's voice — supportive,
// not preachy.
export const LATE_STALL_POOL: readonly string[] = [
  "Want to talk through a hint together, or would you rather keep pushing?",
  "Happy to nudge you in a direction if it'd help — say the word.",
  "If you're stuck on the approach, I can offer one tip. Want it?",
  "Should we narrow it down — want a hint on where to look next?",
  "I can suggest one thing to try; want me to?",
  "We can keep going as-is, or I can drop a small hint. Your call.",
  "Want me to point at the part of the problem that usually trips people up here?",
  "If a hint would unstick you, just ask. Otherwise I'll stay quiet.",
  "Would it help if I asked you a more pointed question?",
  "Say the word and I'll offer the next nudge.",
  "Want me to suggest one concrete thing to try?",
  "I can scope the problem down with you — want to?",
  "Want a starting structure to react to?",
  "Let me know if you'd rather think more or take a hint.",
  "If you want, I can flag the case I'd start from.",
  "Want me to ask the question I'd ask a candidate stuck here?",
  "I'm happy to wait, but the door's open for a hint when you want one.",
  "Should we step back and rethink the approach together?",
  "Want me to suggest a data structure to consider?",
  "Just checking in — hint, talk it out, or keep going alone?",
];

// `hint_offer` — actively offering the next rung of the hint ladder.
// Sam still doesn't reveal the solution; these are conversational
// openers that lead into the shape-aware hint rung.
export const HINT_OFFER_POOL: readonly string[] = [
  "Here's a small nudge to chew on: what's the structure of the input telling you?",
  "Try this: what invariant should hold every step of the way?",
  "One thing to look at: which subproblem repeats?",
  "Hint: think about what changes between one step and the next.",
  "A nudge: what state do you need to carry forward?",
  "Try sketching the smallest case — what does the answer look like there?",
  "Look at the edges: what's the trivial case, and what does it tell you?",
  "Think about ordering — does it matter for this problem?",
  "Consider what you're indexing by — is there a more natural key?",
  "Ask yourself: what's the brute-force, and where does it waste work?",
  "What's the operation you'd want to do quickly that you're doing slowly?",
  "Try walking the test by hand — where does the expected output diverge from what you'd produce?",
  "Look for a transformation: can you rewrite the input into a form that makes the answer obvious?",
  "Think about complementary pairs — does pairing things up simplify it?",
  "Consider a single sweep: what would you need to remember as you go?",
  "Ask: what's the smallest thing I can build that would unblock the next step?",
  "Hint: there's a classic shape here — what data structure makes the lookup cheap?",
  "Try writing the post-condition first, then work backwards.",
  "Look at the constraints — they often hint at the intended complexity.",
  "Pick one test case and write the answer down before any code — what pattern do you see?",
];

export function poolFor(stage: CadenceStage): readonly string[] {
  switch (stage) {
    case "early_stall":
      return EARLY_STALL_POOL;
    case "mid_stall":
      return MID_STALL_POOL;
    case "late_stall":
      return LATE_STALL_POOL;
    case "hint_offer":
      return HINT_OFFER_POOL;
  }
}

// Pick a template line at random, AVOIDING any line in `recent`. Falls
// back to a plain rotation when every line in the pool has been used
// recently (long idle sessions). Deterministic when `rng` is injected
// so unit tests can assert exact variety without flakiness.
export function pickTemplate(
  stage: CadenceStage,
  recent: ReadonlySet<string> = new Set(),
  rng: () => number = Math.random,
): string {
  const pool = poolFor(stage);
  const fresh = pool.filter((l) => !recent.has(l));
  const choices = fresh.length > 0 ? fresh : pool;
  const idx = Math.floor(rng() * choices.length) % choices.length;
  return choices[idx]!;
}

// Map a cadence directive `kind` to its stage. Used by both the
// runner-driven cadence sink (when picking a template-only fallback
// for an empty-content tick) and by the dedupe-pool tracker.
export function stageForDirectiveKind(kind: string): CadenceStage {
  if (kind.startsWith("hint_offer")) return "hint_offer";
  if (kind.startsWith("stall_nudge")) {
    // Stall stage isn't carried on the directive itself today — the
    // cadence-loop emits one `stall_nudge:<lastEditAt>` per stall
    // window — so we treat every cadence stall_nudge as `mid_stall`
    // by default. The sink can pass a stage override based on how
    // long the user has actually been idle.
    return "mid_stall";
  }
  return "early_stall";
}
