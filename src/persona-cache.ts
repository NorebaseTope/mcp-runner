// Caches the server-resolved Sam persona so every tool call uses the same
// system prompt the dashboard was tuned with. The runner re-checks the
// composite version at most once per `MIN_REFRESH_MS` and only re-renders
// the prompt when that version moves; if the server is briefly unreachable
// we keep using the last good copy and fall back to the in-package
// `SAM_SYSTEM_PROMPT` only when we've never successfully fetched.
//
// Also provides static fallback directive phrasings used when the check-in
// endpoint is unavailable. The server is still the canonical source — these
// are only used as a last resort so the runner doesn't go silent.

import type { SamApi, CheckInDirective } from "./api.js";
import { SAM_SYSTEM_PROMPT } from "./persona.js";

export type DirectiveAction = CheckInDirective["action"];

// Fallback directive phrasings. The server returns these via the check-in
// endpoint; we keep a local copy so the runner can surface something useful
// even if the server call fails.
export const DIRECTIVE_FALLBACK: Record<
  Exclude<DirectiveAction, "stay_quiet">,
  string
> = {
  probe:
    "Walk me through the last thing you tried. What did you expect to happen, and what did the runner show instead?",
  hint_offer:
    "You've hit the same failing test a few times. I have a hint ready — say \"hint\" and I'll give you the next step.",
  time_warning:
    "Check your time. If you're still stuck, take the next hint now rather than burning what's left.",
  wrap_up:
    "Time is up. Commit to what you have, tell me what you would fix with more time, then we'll close the session.",
  // Task #795 — pasted-code submit prompt. Spoken when the host surfaces a
  // recent user message that contains a fenced code block in the session's
  // language. Sam asks before submitting; the runner never auto-submits.
  // Mirrors SAM_VOICE.coached_submit_pasted_code on the server side — the
  // server is the source of truth, this string is only used as a fallback
  // when the check-in endpoint is unreachable.
  submit_pasted_code:
    "You pasted code in chat instead of editing the scratch file. I can submit that pasted code for scoring now, or you can move it into the scratch file first. Want me to submit it?",
  // Task #1064 — server-issued corrective when the host has fallen out
  // of the 90s coached_check_in cadence. Mirrors
  // SAM_VOICE.coached_missed_heartbeat on the server side; only used as
  // a fallback when the check-in endpoint is unreachable so the runner
  // can still surface something rather than going silent.
  missed_heartbeat:
    "I lost you for a moment — let's get back on cadence. Walk me through where you are right now and what you're trying next.",
};

// Sam-voice lines used when the runner-side stall watcher upgrades a
// stay_quiet server directive into a probe because the user has stopped
// editing files. Kept here so they live next to the other fallback
// phrasings the runner can speak without a server round trip.
//
// Picked by `(attemptsTotal, passedLatest, consecutiveFailingTestCount)`
// — the same progress signal the server uses for time-directive variants
// (see `pickProgressVariant` in api-server). A user with a working draft
// who has gone quiet is almost certainly weighing tradeoffs, not "stuck"
// in the help-me sense, so the old single "where did you get stuck" line
// misfired in that case (Task #803).
export type StallProbeVariant = "blank_page" | "stuck" | "working_draft";

export const STALL_PROBE_LINES: Record<StallProbeVariant, string> = {
  // Haven't submitted anything yet — likely reading or planning, so probe
  // around what they're trying to do rather than where they're stuck.
  blank_page:
    "You've gone quiet — what are you turning over in your head? Walk me through what you're trying to do, even rough.",
  // Same test failing back-to-back — the original "where did you get stuck"
  // phrasing fits here.
  stuck:
    "You've gone quiet on the same failing test. Tell me what you think it expects, and where you think your code is diverging.",
  // Code runs and most tests are passing — they're almost certainly weighing
  // a tradeoff, not blocked. Probe for that instead.
  working_draft:
    "You have a working draft and you've gone quiet — what tradeoff are you weighing? Walk me through complexity and what you'd change with more time.",
};

// Backwards-compat alias for hosts and tests that imported the original
// single line. Maps to the `blank_page` variant since that's the closest
// to the historical phrasing's intent. Prefer `STALL_PROBE_LINES[variant]`
// in new code.
export const STALL_PROBE_LINE = STALL_PROBE_LINES.blank_page;

const MIN_REFRESH_MS = 5 * 60 * 1000;

export interface ResolvedPersona {
  systemPrompt: string;
  version: number | null;
}

interface PersonaState {
  systemPrompt: string;
  version: number | null;
  lastCheckedAt: number;
  lastError: string | null;
}

function compose(payload: {
  persona: { body: string };
  toneRules: { body: string };
  boundaryConstraints: { body: string };
}): string {
  return [
    payload.persona.body.trim(),
    "",
    "Voice rules:",
    payload.toneRules.body.trim(),
    "",
    "Boundaries:",
    payload.boundaryConstraints.body.trim(),
  ]
    .join("\n")
    .trim();
}

// Per-voice-key cache. Voice texts on the server change rarely (they're
// admin-tuned contracts) but the runner refetches on the same cadence as
// the persona refresh so any in-session re-tune lands without a runner
// restart. `text` is the canonical line; `lastFetchedAt` drives the TTL;
// `lastError` is surfaced for `prepsavant doctor`.
interface VoiceState {
  text: string;
  lastFetchedAt: number;
  lastError: string | null;
}

export class PersonaCache {
  private state: PersonaState = {
    // Until the first successful fetch we use the bundled fallback so any
    // tool call that races startup still has a sensible system prompt.
    systemPrompt: SAM_SYSTEM_PROMPT,
    version: null,
    lastCheckedAt: 0,
    lastError: null,
  };
  // Voice-key cache shared across all callers. Keyed by VoiceKey string
  // (e.g. `coached_diff_aware_nudge_instruction`). We avoid a per-tool
  // network hop by reusing the cached text for `MIN_REFRESH_MS` after a
  // successful fetch.
  private voiceCache = new Map<string, VoiceState>();

  constructor(private readonly api: SamApi) {}

  // Fetch (and cache) one Sam-voice registry entry by key (Task #832).
  // Returns the cached text if the entry was fetched successfully within
  // the last `MIN_REFRESH_MS`; otherwise refetches once and falls back to
  // the supplied `fallback` (and to the cached text if any) on error so
  // the caller never has to special-case voice-API outages.
  async getVoice(key: string, fallback: string): Promise<string> {
    const now = Date.now();
    const cached = this.voiceCache.get(key);
    if (
      cached &&
      cached.lastError == null &&
      now - cached.lastFetchedAt < MIN_REFRESH_MS
    ) {
      return cached.text;
    }
    try {
      const res = await this.api.getSamVoice(key);
      this.voiceCache.set(key, {
        text: res.text,
        lastFetchedAt: now,
        lastError: null,
      });
      return res.text;
    } catch (err) {
      const lastError = (err as Error).message;
      // Hold on to the previous cached text — voice texts are stable, so
      // a transient 401/5xx shouldn't flip Sam back to the bundled
      // fallback if we already had a real value.
      const text = cached?.text ?? fallback;
      this.voiceCache.set(key, {
        text,
        lastFetchedAt: now,
        lastError,
      });
      return text;
    }
  }

  async refresh(force = false): Promise<ResolvedPersona> {
    const now = Date.now();
    if (
      !force &&
      this.state.version !== null &&
      now - this.state.lastCheckedAt < MIN_REFRESH_MS
    ) {
      return {
        systemPrompt: this.state.systemPrompt,
        version: this.state.version,
      };
    }
    try {
      const payload = await this.api.getSamPersona();
      this.state.lastCheckedAt = now;
      this.state.lastError = null;
      if (payload.version !== this.state.version) {
        this.state.systemPrompt = compose(payload);
        this.state.version = payload.version;
      }
    } catch (err) {
      // Don't blow up the tool call on transient persona fetch failures —
      // the tool's coaching response matters more than a perfectly fresh
      // prompt. Surface the failure on stderr so `prepsavant doctor` and
      // host log views can see it.
      this.state.lastError = (err as Error).message;
      this.state.lastCheckedAt = now;
      process.stderr.write(
        `[prepsavant] persona refresh failed: ${this.state.lastError}\n`,
      );
    }
    return {
      systemPrompt: this.state.systemPrompt,
      version: this.state.version,
    };
  }

  getSnapshot(): ResolvedPersona & { lastError: string | null } {
    return {
      systemPrompt: this.state.systemPrompt,
      version: this.state.version,
      lastError: this.state.lastError,
    };
  }
}
