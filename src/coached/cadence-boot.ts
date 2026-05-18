// Task #1169 (Cursor-first M4) — shared "boot a CadenceDriver onto a
// just-started Coached session" helper.
//
// Pulled out of `server.ts` so BOTH coached entry points share one
// implementation:
//
//   1. The MCP tool `coached_start_session` (server.ts) — boots with
//      a live `McpServer` so cadence directives are pushed
//      out-of-band to the host via `notifications/message`.
//
//   2. The CLI `prepsavant start --session-pack <path>` adopt path
//      (cli-start.ts) — boots WITHOUT an `McpServer` (the CLI is a
//      bootstrap step that runs before the host attaches MCP). The
//      directives are still written into the rolling recap so the
//      end-of-session POST surfaces every nudge that fired locally.
//
// Task #1194 (Cursor-first M8 runtime) retired the demoted
// `coached_check_in` queue drainer; Cursor surfaces MCP
// `notifications/message` natively, so the per-session pickup queue
// has no consumer.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CadenceDriver,
  type CadenceDirective,
} from "./cadence-loop.js";
import {
  appendRecapEvent,
  type CoachedSessionState,
  type RecapEvent,
} from "./session.js";

// Monotonic counter so directiveId values are unique within a
// process even when many directives fire on the same millisecond
// (e.g. clock-faked tests or a debounced burst).
let directiveSeq = 0;
function nextDirectiveId(sessionId: string): string {
  directiveSeq += 1;
  return `dir_${sessionId}_${Date.now()}_${directiveSeq}`;
}

export interface BootCoachedCadenceLoopOptions {
  // Optional MCP server. When non-null, every directive is also
  // pushed via `notifications/message` (best-effort). When null —
  // CLI bootstrap path, no MCP attached yet — the queue is the
  // sole delivery channel.
  mcp?: McpServer | null;
  // Optional override for the directive sink — only intended for
  // tests that want to assert the exact payload shape without
  // standing up an MCP transport.
  testSink?: (payload: Record<string, unknown> & { directiveId: string }) => void;
  // Test-only clock + timer overrides forwarded straight to the
  // CadenceDriver so tests can drive ticks deterministically against
  // a fake clock (used by the session-pack-adopt integration test).
  now?: () => number;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
  tickMs?: number;
}

export function bootCoachedCadenceLoop(
  state: CoachedSessionState,
  opts: BootCoachedCadenceLoopOptions = {},
): CadenceDriver {
  const mcp = opts.mcp ?? null;

  const driver = new CadenceDriver({
    state,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.setInterval ? { setInterval: opts.setInterval } : {}),
    ...(opts.clearInterval ? { clearInterval: opts.clearInterval } : {}),
    ...(opts.tickMs !== undefined ? { tickMs: opts.tickMs } : {}),
    sink: (directive: CadenceDirective) => {
      // Stable per-directive id surfaced on the MCP
      // `notifications/message` payload so hosts can de-dupe.
      const directiveId = nextDirectiveId(state.sessionId);
      const payload: Record<string, unknown> & { directiveId: string } = {
        directiveId,
        kind: directive.kind,
        action: directive.action,
        reason: directive.reason,
        intent: directive.intent,
        constraints: directive.constraints,
        suggestedWording: directive.suggestedWording,
        mustBeVerbatim: directive.mustBeVerbatim,
        mode: directive.mode,
        emittedAt: directive.emittedAt,
        sessionId: directive.sessionId,
        ...(directive.hintShape ? { hintShape: directive.hintShape } : {}),
        ...(directive.hintRung ? { hintRung: directive.hintRung } : {}),
        ...(directive.hintLevel ? { hintLevel: directive.hintLevel } : {}),
      };

      // (a) Best-effort MCP push when an MCP server is attached.
      //     Notifications can fail mid-shutdown or while the host
      //     transport is mid-reconnect — the queue is the durable
      //     backstop.
      if (mcp) {
        try {
          void mcp.server
            .notification({
              method: "notifications/message",
              params: {
                level: "info",
                logger: "coached_cadence",
                data: payload,
              },
            })
            .catch(() => {
              /* noop */
            });
        } catch {
          /* noop */
        }
      }

      // (b) Test-only sink, when provided.
      if (opts.testSink) {
        try {
          opts.testSink(payload);
        } catch {
          /* noop */
        }
      }

      // (c) Capture into the rolling recap so the end-of-session
      //     POST surfaces every nudge that fired locally. Hint
      //     directives also bump the session-state hint level
      //     high-water mark so the recap reflects the strongest
      //     rung that fired across all stuck shapes.
      let recapKind: RecapEvent["kind"];
      if (directive.kind.startsWith("time_warning")) {
        recapKind = "time_warning_fired";
      } else if (directive.kind.startsWith("hint_offer:")) {
        recapKind = "hint_level_advanced";
        const lvl = directive.hintLevel;
        if (typeof lvl === "number" && lvl > state.hintLevelFired) {
          state.hintLevelFired = lvl;
        }
      } else {
        recapKind = "stall_nudge_fired";
      }
      appendRecapEvent(state, {
        ts: directive.emittedAt,
        kind: recapKind,
        detail: directive.kind,
      });
    },
  });

  state.cadence = driver;
  driver.start();
  return driver;
}
