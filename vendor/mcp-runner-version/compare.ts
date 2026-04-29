// Hand-maintained helpers for comparing the locally-installed runner
// version against `MCP_RUNNER_VERSION` (the latest version the dashboard
// knows about). Kept in a sibling file so `pnpm sync-mcp-runner-version`
// — which rewrites `index.ts` from scratch — never clobbers them.

import { MCP_RUNNER_VERSION } from "./index.js";

// Parse a semver-ish "MAJOR.MINOR.PATCH[-prerelease]" string into a tuple
// of integers. Trailing prerelease/build metadata is ignored. Returns null
// when the string can't be parsed — callers should treat that as "unknown",
// not as "matches" or "older".
export function parseRunnerVersion(
  raw: string | null | undefined,
): [number, number, number] | null {
  if (!raw) return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

// True when `installed` is strictly older than `latest` (i.e. the user
// should be nudged to re-install). Returns false when either side is
// unparseable so we never fire a false-positive warning on weird input.
export function isRunnerOutdated(
  installed: string | null | undefined,
  latest: string | null | undefined = MCP_RUNNER_VERSION,
): boolean {
  const a = parseRunnerVersion(installed);
  const b = parseRunnerVersion(latest);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i]! < b[i]!) return true;
    if (a[i]! > b[i]!) return false;
  }
  return false;
}
