// Typed wrapper around MCP `createMessage` (host sampling) with safe fallbacks.
// If the host refuses sampling or returns garbage, callers MUST fall back to
// the server-side fallback voice — never invent text on the runner.
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

export interface SamplingResult {
  text: string;
  source: "runner_sampling" | "runner_fallback";
}

export async function sampleSamVoice(
  server: Server,
  systemPrompt: string,
  userPrompt: string,
  fallback: string,
): Promise<SamplingResult> {
  try {
    const res = await server.createMessage({
      systemPrompt,
      maxTokens: 512,
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
