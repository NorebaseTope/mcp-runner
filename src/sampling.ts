// Typed wrapper around MCP `createMessage` (host sampling) with safe fallbacks.
// If the host refuses sampling or returns garbage, callers MUST fall back to
// the server-side fallback voice — never invent text on the runner.
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

export interface SamplingResult {
  text: string;
  source: "runner_sampling" | "runner_fallback";
}

export interface SampleSamVoiceOptions {
  // Soft cap on how long the host model has to reply before we fall back
  // to the static voice line. Required for time-sensitive surfaces like
  // `coached_check_in`, where a slow host must never block the directive
  // delivery (Task #832). Omit (or pass 0) to wait indefinitely.
  timeoutMs?: number;
  // Token budget passed through to MCP `createMessage`. Defaults to 512
  // (the historical value) so existing callers stay unchanged. Diff-aware
  // nudges run with a tighter cap because Sam's reply is one short line.
  maxTokens?: number;
}

export async function sampleSamVoice(
  server: Server,
  systemPrompt: string,
  userPrompt: string,
  fallback: string,
  opts: SampleSamVoiceOptions = {},
): Promise<SamplingResult> {
  const maxTokens = opts.maxTokens ?? 512;
  const samplePromise = (async (): Promise<SamplingResult> => {
    try {
      const res = await server.createMessage({
        systemPrompt,
        maxTokens,
        messages: [
          {
            role: "user",
            content: { type: "text", text: userPrompt },
          },
        ],
      });
      if (res?.content?.type === "text" && res.content.text.trim()) {
        return { text: res.content.text.trim(), source: "runner_sampling" };
      }
      return { text: fallback, source: "runner_fallback" };
    } catch {
      return { text: fallback, source: "runner_fallback" };
    }
  })();

  const timeoutMs = opts.timeoutMs ?? 0;
  if (!timeoutMs || timeoutMs <= 0) return samplePromise;

  // Race the sample against a short timer. We do NOT cancel the underlying
  // MCP request — the SDK doesn't expose a cancel handle here — but we
  // resolve the caller with the fallback so the tool response is never
  // blocked by a slow host model. The orphaned sample resolves into the
  // void, which is acceptable: it's a one-shot per check-in.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<SamplingResult>((resolve) => {
    timer = setTimeout(
      () => resolve({ text: fallback, source: "runner_fallback" }),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([samplePromise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Best-effort JSON extraction. Models often wrap JSON in fences or include
// preamble; we strip fences and parse the first object we find. On failure,
// callers fall back to the verbatim text.
export function tryExtractJson<T = unknown>(text: string): T | null {
  let s = text.trim();
  // Strip ```json fences
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(s) as T;
  } catch {
    // Try the first {...} block
    const m = s.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]) as T;
    } catch {
      return null;
    }
  }
}
