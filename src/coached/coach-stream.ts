// Task #1401 — Tiny typed event bus the runner-driven terminal coach
// uses to fan cadence directives, user-typed input, and tick events out
// to the terminal renderer (and to test sinks). Plain EventEmitter so
// we don't pull a dependency in for one file.

import { EventEmitter } from "node:events";

export type SamLineKind =
  | "kickoff"
  | "stall_nudge"
  | "time_warning"
  | "hint_offer"
  | "wrap_up"
  | "free"; // for ask / interactive responses

export interface SamLine {
  kind: SamLineKind;
  text: string;
  emittedAt: number;
  // Optional metadata surfaced to the footer / recap.
  hintRung?: string;
  hintShape?: string;
  directiveKind?: string;
}

export interface TickInfo {
  elapsedMs: number;
  remainingMs: number | null;
  hintRung: string | null;
  sessionId: string;
}

export interface UserUtterance {
  text: string;
  command?: "submit" | "hint" | "skip" | "quit";
  emittedAt: number;
}

export interface StatusLine {
  text: string;
  emittedAt: number;
}

export class CoachStream extends EventEmitter {
  emitSam(line: SamLine): void {
    this.emit("sam", line);
  }
  emitUser(u: UserUtterance): void {
    this.emit("user", u);
  }
  emitStatus(s: StatusLine): void {
    this.emit("status", s);
  }
  emitTick(t: TickInfo): void {
    this.emit("tick", t);
  }
  emitEnd(reason: "user_quit" | "ctrl_c" | "timer_expired" | "error"): void {
    this.emit("end", reason);
  }

  onSam(fn: (line: SamLine) => void): this {
    return this.on("sam", fn);
  }
  onUser(fn: (u: UserUtterance) => void): this {
    return this.on("user", fn);
  }
  onStatus(fn: (s: StatusLine) => void): this {
    return this.on("status", fn);
  }
  onTick(fn: (t: TickInfo) => void): this {
    return this.on("tick", fn);
  }
  onEnd(fn: (r: "user_quit" | "ctrl_c" | "timer_expired" | "error") => void): this {
    return this.on("end", fn);
  }
}
