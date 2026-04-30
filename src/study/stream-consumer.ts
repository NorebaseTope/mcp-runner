// Consumer for the runner's study-conversation stream. Lifted out of the
// `study_ask` MCP tool handler in server.ts so we can:
//   1. unit-test the notification sequencing (thinking → thinking_done →
//      deltas) without standing up an McpServer + transport, and
//   2. share the same per-event logic with any other surface that
//      eventually wants to fan stream events out as notifications.
//
// The notification phrasing ("Sam is thinking…") is intentionally pinned
// here — both the server-side `thinking` event and the runner's wire type
// carry no payload, so the tone lives in exactly one place.
import type { StudyStreamEvent } from "../api.js";

// Best-effort callback. Implementations (e.g. the MCP `study_ask`
// handler) are expected to swallow errors internally; we never let a
// notification failure abort the stream.
export type NotifyFn = (data: Record<string, unknown>) => Promise<void>;

export const STUDY_THINKING_TEXT = "Sam is thinking…";

export interface StudyAskStreamResult {
  // Concatenated Sam reply text. Empty string when the stream errored
  // before any delta landed.
  full: string;
  // Server-reported stream error (e.g. model failure), or null on a
  // clean stream.
  error: string | null;
}

// Walk a study-conversation stream and fan each event out as a host
// notification:
//   - `thinking`   → notify({ status: "thinking", text: "Sam is thinking…" })
//   - first delta  → notify({ status: "thinking_done" }) then the delta
//   - subsequent deltas → notify({ delta: <text> })
//   - `error` before first delta → notify({ status: "thinking_done" }) so
//     hosts that key off status notifications don't leave a stale
//     indicator on screen.
//   - `user_persisted` / `complete` → ignored (host already has context).
//
// Returns the full accumulated reply and any stream-level error so the
// caller can decide how to surface them in the tool's text result.
export async function consumeStudyAskStream(
  stream: AsyncIterable<StudyStreamEvent>,
  notify: NotifyFn,
): Promise<StudyAskStreamResult> {
  let full = "";
  let error: string | null = null;
  let firstDeltaSeen = false;
  for await (const evt of stream) {
    if (evt.type === "thinking") {
      await notify({ status: "thinking", text: STUDY_THINKING_TEXT });
    } else if (evt.type === "delta") {
      if (!firstDeltaSeen) {
        firstDeltaSeen = true;
        await notify({ status: "thinking_done" });
      }
      full += evt.text;
      await notify({ delta: evt.text });
    } else if (evt.type === "error") {
      error = evt.error;
      // Hardening: if no delta has landed yet, hosts that strictly key
      // their typing-indicator UI off status notifications would still
      // be showing "Sam is thinking…". Tell them to clear it.
      if (!firstDeltaSeen) {
        await notify({ status: "thinking_done" });
      }
      break;
    }
    // user_persisted / complete carry server-issued message ids but the
    // host already has the conversation context; no need to surface
    // them as notifications.
  }
  return { full, error };
}
