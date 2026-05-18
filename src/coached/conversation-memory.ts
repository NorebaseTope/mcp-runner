// Task #1412 — In-runner conversation memory for the runner-driven
// terminal coach. Adapter-agnostic: any CodingAgentAdapter (Cursor SDK,
// cursor-agent CLI, MockAgent) reads the same prepended `Recent context:`
// block via `buildAskPrompt`, so multi-turn awareness works on day one
// without depending on a `--resume` flag or an API key.
//
// Scope is intentionally tiny: a small ring buffer of the last few
// Sam ↔ user beats plus a per-stuck-shape "hints we've already offered"
// set so the prompt can tell the model not to repeat itself. We always
// store the **rendered/sanitized** Sam line (post-`sanitizeCoachLine`),
// never the raw model reply, so any drift the sanitizer caught doesn't
// get re-amplified on the next tick.

import { sanitizeCoachLine } from "./coding-agent.js";

export type MemoryRole = "sam" | "user";

export interface MemoryEntry {
  role: MemoryRole;
  text: string;
}

// Ring-buffer cap. Counts entries (Sam lines AND user replies),
// roughly ≈3 Sam/user pairs. Kept small so the per-tick token cost
// stays bounded even on the SDK path where every token is billed.
export const MEMORY_MAX_TURNS = 6;

// Hard cap on serialised length per entry. Long user replies and the
// occasional verbose Sam line both get clipped to this so a power
// user pasting an essay can't blow the prompt envelope.
export const MEMORY_MAX_CHARS_PER_TURN = 200;

export interface ConversationMemoryOptions {
  // Test-only override of the ring-buffer cap.
  maxTurns?: number;
  maxCharsPerTurn?: number;
  // When false, every push is a no-op and `renderRecentContextBlock`
  // returns "". Wired to `PREPSAVANT_COACH_MEMORY=0` in TerminalCoach.
  enabled?: boolean;
}

export class ConversationMemory {
  private readonly maxTurns: number;
  private readonly maxCharsPerTurn: number;
  private readonly enabled: boolean;
  private readonly entries: MemoryEntry[] = [];
  private readonly offeredHints = new Map<string, Set<string>>();

  constructor(opts: ConversationMemoryOptions = {}) {
    this.maxTurns = opts.maxTurns ?? MEMORY_MAX_TURNS;
    this.maxCharsPerTurn = opts.maxCharsPerTurn ?? MEMORY_MAX_CHARS_PER_TURN;
    this.enabled = opts.enabled ?? true;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  size(): number {
    return this.entries.length;
  }

  // Task #1561 — Distinguishes "no prior Sam turns" from "no prior
  // entries at all". The readline handler in `startTerminalCoach`
  // calls `memory.pushUser(trimmed)` BEFORE invoking
  // `handleUserUtterance`, so by the time the intro-hint gate runs
  // `size()` is always ≥ 1 — gating on `size() > 0` would dead-code
  // the substantive first-hint path. The first-hint heuristic only
  // cares about whether Sam has ever spoken before; that's what this
  // accessor returns.
  samTurnCount(): number {
    let n = 0;
    for (const e of this.entries) {
      if (e.role === "sam") n += 1;
    }
    return n;
  }

  // Push a Sam line. The caller MUST pass the already-sanitized text
  // (we re-sanitize defensively so an accidental raw-model reply still
  // gets stripped of fences/prefixes before being persisted).
  pushSam(
    text: string,
    opts: { hintShape?: string | null; hintRung?: string | null } = {},
  ): void {
    if (!this.enabled) return;
    const cleaned = clip(sanitizeCoachLine(text), this.maxCharsPerTurn);
    if (cleaned.length > 0) {
      this.entries.push({ role: "sam", text: cleaned });
      this.trim();
    }
    if (opts.hintShape && opts.hintRung) {
      let set = this.offeredHints.get(opts.hintShape);
      if (!set) {
        set = new Set<string>();
        this.offeredHints.set(opts.hintShape, set);
      }
      set.add(opts.hintRung);
    }
  }

  pushUser(text: string): void {
    if (!this.enabled) return;
    const cleaned = clip(text.trim(), this.maxCharsPerTurn);
    if (cleaned.length === 0) return;
    this.entries.push({ role: "user", text: cleaned });
    this.trim();
  }

  hasOfferedHint(shape: string, rung: string): boolean {
    return this.offeredHints.get(shape)?.has(rung) ?? false;
  }

  offeredRungsFor(shape: string): readonly string[] {
    const set = this.offeredHints.get(shape);
    if (!set || set.size === 0) return [];
    return Array.from(set);
  }

  // Returns "" when memory is disabled or empty so callers can
  // unconditionally concatenate without an extra guard.
  renderRecentContextBlock(): string {
    if (!this.enabled || this.entries.length === 0) return "";
    const lines = ["Recent context:"];
    for (const e of this.entries) {
      const tag = e.role === "sam" ? "Sam" : "User";
      lines.push(`  ${tag}: ${e.text}`);
    }
    return lines.join("\n");
  }

  private trim(): void {
    while (this.entries.length > this.maxTurns) {
      this.entries.shift();
    }
  }
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(1, max - 1)).trimEnd() + "…";
}
