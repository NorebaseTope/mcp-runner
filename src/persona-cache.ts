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
};

// Sam-voice line used when the runner-side stall watcher upgrades a
// stay_quiet server directive into a probe because the user has stopped
// editing files. Kept here so it lives next to the other fallback phrasings
// the runner can speak without a server round trip.
export const STALL_PROBE_LINE =
  "You've gone quiet — want me to unblock you? Tell me where you got stuck and I'll nudge you forward.";

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

export class PersonaCache {
  private state: PersonaState = {
    // Until the first successful fetch we use the bundled fallback so any
    // tool call that races startup still has a sensible system prompt.
    systemPrompt: SAM_SYSTEM_PROMPT,
    version: null,
    lastCheckedAt: 0,
    lastError: null,
  };

  constructor(private readonly api: SamApi) {}

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
