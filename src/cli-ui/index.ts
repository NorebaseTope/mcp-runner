// Task #1399 — shared CLI UI helpers used by both the Coached
// `prepsavant start --session-pack` terminal output (Task #1390) and
// the AI-Assisted start path (Task #1399). Both startup banners need
// the same color-helper / NO_COLOR / non-TTY plumbing and the same
// HOST INSTRUCTIONS stripper, so we lift them to a shared module
// rather than duplicate the implementation.
//
// `coached/startup-banner.ts` re-exports these so existing imports keep
// working; new callers should import from `cli-ui` directly.

// ---------------------------------------------------------------------
// Color helpers — tiny hand-rolled ANSI so we don't add a dependency.
// All public callers go through `makeColors(stream)` so a single check
// at construction time decides whether ANSI is allowed for that stream.
// ---------------------------------------------------------------------

export interface ColorHelpers {
  readonly enabled: boolean;
  bold(s: string): string;
  dim(s: string): string;
  green(s: string): string;
  cyan(s: string): string;
  yellow(s: string): string;
  check: string;
  bullet: string;
}

export interface ColorStream {
  isTTY?: boolean;
}

export function supportsColor(
  stream: ColorStream,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // Honor the de-facto NO_COLOR standard (https://no-color.org): any
  // non-empty value disables color across well-behaved CLIs.
  if (env["NO_COLOR"] !== undefined && env["NO_COLOR"] !== "") return false;
  // Respect FORCE_COLOR=0 as the explicit opt-out used by some CIs.
  if (env["FORCE_COLOR"] === "0") return false;
  // Allow callers / CI to force color even when piping to a file.
  if (
    env["FORCE_COLOR"] !== undefined &&
    env["FORCE_COLOR"] !== "" &&
    env["FORCE_COLOR"] !== "0"
  ) {
    return true;
  }
  return !!stream.isTTY;
}

export function makeColors(
  stream: ColorStream,
  env: NodeJS.ProcessEnv = process.env,
): ColorHelpers {
  const enabled = supportsColor(stream, env);
  const wrap = (open: string, close: string) =>
    enabled ? (s: string) => `\u001b[${open}m${s}\u001b[${close}m` : (s: string) => s;
  return {
    enabled,
    bold: wrap("1", "22"),
    dim: wrap("2", "22"),
    green: wrap("32", "39"),
    cyan: wrap("36", "39"),
    yellow: wrap("33", "39"),
    check: enabled ? "\u2713" : "v",
    bullet: enabled ? "\u2022" : "-",
  };
}

// ---------------------------------------------------------------------
// Host-instructions stripper.
//
// Both the Coached kickoff brief and the AI-Assisted start_session text
// payload include a `HOST INSTRUCTIONS — …` block intended for the AI
// host (it tells the host how to drive the split-loop coaching tools).
// That prose is noise — and worse, confusing noise — when the human
// reads the same payload, so we strip it from the user-facing render.
// The original payload is untouched and any downstream programmatic
// consumer (or the host's own context tools) still sees the full text.
// ---------------------------------------------------------------------

// Match the canonical `HOST INSTRUCTIONS — HYBRID RELAY PROTOCOL`
// header AND any analogous host-only heading (e.g. a future
// `HOST DIRECTIVES`, `HOST PROTOCOL`, etc.). Anchored to the start
// of a line and requires `HOST ` followed by an ALL-CAPS token so a
// stray sentence like "the host instructions are…" inside a problem
// statement never trips the cut.
const HOST_INSTRUCTIONS_HEADER_RE = /^[ \t]*HOST [A-Z][A-Z ]*\b.*$/m;

export function stripHostInstructions(brief: string): string {
  if (!brief) return brief;
  const idx = brief.search(HOST_INSTRUCTIONS_HEADER_RE);
  if (idx === -1) return brief;
  // Cut at the start of the matched line and trim trailing blank
  // lines so the visible brief ends cleanly. Also drop a trailing
  // `---` separator that immediately precedes the host block (the
  // AI-Assisted payload renders the host instructions after a `---`
  // divider; without this the divider would dangle on its own).
  const head = brief.slice(0, idx).replace(/\s+$/g, "");
  const cleaned = head.replace(/\n+---\s*$/g, "").replace(/\s+$/g, "");
  return cleaned + "\n";
}
