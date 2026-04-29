// Device-link flow: kick off the link, print the user code + URL, poll until
// the user has authorized (or declined / expired), then persist the token.
import * as os from "node:os";
import { spawn } from "node:child_process";
import { SamApi } from "./api.js";
import { readConfig, writeConfig, ADAPTER_VERSION } from "./config.js";

// Server enum: "claude_desktop" | "cursor" | "codex" | "unknown".
const HOST_ALIASES: Record<string, string> = {
  claude: "claude_desktop",
  claude_desktop: "claude_desktop",
  cursor: "cursor",
  codex: "codex",
};

function normalizeHostKind(raw?: string): string {
  if (!raw) return "unknown";
  return HOST_ALIASES[raw.toLowerCase()] ?? "unknown";
}

function detectHostKind(): string {
  // Best-effort: when the runner is invoked by an MCP host, the host name
  // sometimes leaks via env. We default to "unknown" otherwise.
  return normalizeHostKind(process.env.PREPSAVANT_HOST);
}

function defaultLabel(): string {
  return `${os.hostname()} • prepsavant ${ADAPTER_VERSION}`;
}

function tryOpenBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args =
    process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // ignore — we already printed the URL
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface AuthOptions {
  apiBaseUrl?: string;
  noBrowser?: boolean;
  hostKind?: string;
}

export async function runAuth(opts: AuthOptions = {}): Promise<void> {
  const cfg = readConfig();
  if (opts.apiBaseUrl) cfg.apiBaseUrl = opts.apiBaseUrl;
  const api = new SamApi(cfg);

  const start = await api.startDeviceLink({
    hostKind: normalizeHostKind(opts.hostKind ?? detectHostKind()),
    platform: `${process.platform}-${os.arch()}`,
    suggestedLabel: defaultLabel(),
  });

  process.stdout.write("\n");
  process.stdout.write(`  Authorize this device at:\n`);
  process.stdout.write(`    ${start.verificationUri}\n\n`);
  process.stdout.write(`  If your browser doesn't open, paste the URL above\n`);
  process.stdout.write(`  or enter the code:  ${start.userCode}\n\n`);

  if (!opts.noBrowser) tryOpenBrowser(start.verificationUri);

  const intervalMs = Math.max(start.pollIntervalSeconds, 1) * 1000;
  const deadline = Date.now() + start.expiresInSeconds * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    let poll;
    try {
      poll = await api.pollDeviceLink(start.deviceCode);
    } catch (err) {
      process.stderr.write(`  poll error: ${(err as Error).message}\n`);
      continue;
    }
    if (poll.status === "authorized" && poll.token) {
      writeConfig({
        ...cfg,
        token: poll.token,
        deviceId: poll.deviceId,
        label: defaultLabel(),
        authorizedAt: new Date().toISOString(),
      });
      process.stdout.write(
        `\n  ✓ Authorized. Token saved to ~/.prepsavant/config.json (chmod 600).\n`,
      );
      return;
    }
    if (poll.status === "expired") {
      throw new Error("Device code expired before approval. Run `prepsavant auth` again.");
    }
    if (poll.status === "denied") {
      throw new Error("Authorization was denied from the dashboard.");
    }
    // status === "pending": keep polling silently.
  }

  throw new Error("Timed out waiting for authorization.");
}
