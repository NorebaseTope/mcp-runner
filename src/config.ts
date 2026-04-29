// Token + base-URL persistence at ~/.prepsavant/config.json.
// File is created chmod 600 so other local users can't read the token.
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface RunnerConfig {
  apiBaseUrl: string;
  token?: string;
  deviceId?: string;
  label?: string;
  authorizedAt?: string;
}

const HOME = os.homedir();
export const CONFIG_DIR = path.join(HOME, ".prepsavant");
export const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
export const SANDBOX_DIR = path.join(CONFIG_DIR, "sandbox");
// Local override for the runner's `research_jobs` target list. When this
// file exists it takes precedence over the server-side saved list, so
// power users can keep a per-machine "scan these companies" list without
// touching the dashboard.
export const RESEARCH_TARGETS_PATH = path.join(
  CONFIG_DIR,
  "research-targets.json",
);

export { ADAPTER_VERSION } from "./version.js";
// Canonical production host is the apex domain (https://prepsavant.com), to
// match the post-deploy sign-in smoke (`scripts/src/prod-signin-smoke.ts`),
// the Sentry runbook (`docs/sentry.md`), and the custom-domain wiring
// documented in `replit.md`. `app.prepsavant.com` was never wired up in DNS;
// keeping a non-resolving host as the default would silently break every
// fresh runner install.
export const DEFAULT_API_BASE =
  process.env.PREPSAVANT_API_BASE ??
  process.env.SAM_API_BASE ??
  "https://prepsavant.com";

export function ensureConfigDir(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(SANDBOX_DIR, { recursive: true, mode: 0o700 });
}

export function readConfig(): RunnerConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<RunnerConfig>;
    return {
      apiBaseUrl: parsed.apiBaseUrl || DEFAULT_API_BASE,
      token: parsed.token,
      deviceId: parsed.deviceId,
      label: parsed.label,
      authorizedAt: parsed.authorizedAt,
    };
  } catch {
    return { apiBaseUrl: DEFAULT_API_BASE };
  }
}

export function writeConfig(cfg: RunnerConfig): void {
  ensureConfigDir();
  // Write with restrictive perms; chmod again afterwards for the case where
  // the file already existed with looser perms.
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(CONFIG_PATH, 0o600);
  } catch {
    // Best-effort: Windows / certain filesystems don't honor chmod.
  }
}

export function clearToken(): void {
  const cfg = readConfig();
  delete cfg.token;
  delete cfg.deviceId;
  delete cfg.label;
  delete cfg.authorizedAt;
  writeConfig(cfg);
}

export interface LocalResearchTarget {
  companyName: string;
  careersUrl: string;
  companySlug?: string;
  industry?: string;
}

// Read the local override list. Returns null when the file is missing so
// callers can transparently fall back to the API-saved list. We swallow
// parse errors so a corrupt file doesn't crash the runner — surfacing the
// problem via stderr is good enough for an opt-in power-user feature.
export function readLocalResearchTargets(): LocalResearchTarget[] | null {
  try {
    const raw = fs.readFileSync(RESEARCH_TARGETS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    // Accept either a bare array or `{ targets: [...] }` so users don't
    // have to remember the shape.
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.targets)
        ? parsed.targets
        : null;
    if (!list) return null;
    return list
      .map((t: unknown): LocalResearchTarget | null => {
        if (!t || typeof t !== "object") return null;
        const r = t as Record<string, unknown>;
        const companyName =
          typeof r["companyName"] === "string" ? r["companyName"] : null;
        const careersUrl =
          typeof r["careersUrl"] === "string" ? r["careersUrl"] : null;
        if (!companyName || !careersUrl) return null;
        return {
          companyName,
          careersUrl,
          companySlug:
            typeof r["companySlug"] === "string" ? r["companySlug"] : undefined,
          industry:
            typeof r["industry"] === "string" ? r["industry"] : undefined,
        };
      })
      .filter((t: LocalResearchTarget | null): t is LocalResearchTarget => t !== null);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    process.stderr.write(
      `[prepsavant] could not read ${RESEARCH_TARGETS_PATH}: ${(err as Error).message}\n`,
    );
    return null;
  }
}
