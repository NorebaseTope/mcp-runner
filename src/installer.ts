// Installs the `sam` MCP server entry into the chosen MCP host's config file.
// We patch JSON configs in place where possible; for hosts whose config is not
// JSON (Cursor / Codex, in some installations), we print the manual snippet.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type HostId = "claude" | "cursor" | "codex";

export interface HostTarget {
  id: HostId;
  label: string;
  configPath: string | null; // null = no known config file → manual snippet
  exists: boolean;
}

function home(...p: string[]): string {
  return path.join(os.homedir(), ...p);
}

function claudeDesktopConfigPath(): string | null {
  if (process.platform === "darwin") {
    return home("Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (!appData) return null;
    return path.join(appData, "Claude", "claude_desktop_config.json");
  }
  // Linux: Claude Desktop is not officially supported, but follow XDG.
  return home(".config", "Claude", "claude_desktop_config.json");
}

function cursorConfigPath(): string | null {
  // Cursor 0.45+ supports a global mcp.json under the user config directory.
  // Older Cursor versions only allow MCP via Settings UI; we fall back to a
  // manual snippet in that case.
  if (process.platform === "darwin" || process.platform === "linux") {
    return home(".cursor", "mcp.json");
  }
  if (process.platform === "win32") {
    return home(".cursor", "mcp.json");
  }
  return null;
}

function codexConfigPath(): string | null {
  // OpenAI Codex CLI's MCP plugins config.
  return home(".codex", "config.toml"); // not patched automatically — see below
}

export function detectHosts(): HostTarget[] {
  const items: Array<{ id: HostId; label: string; configPath: string | null }> = [
    { id: "claude", label: "Claude Desktop", configPath: claudeDesktopConfigPath() },
    { id: "cursor", label: "Cursor", configPath: cursorConfigPath() },
    { id: "codex", label: "Codex", configPath: codexConfigPath() },
  ];
  return items.map((it) => ({
    ...it,
    exists: it.configPath ? fs.existsSync(it.configPath) : false,
  }));
}

export interface InstallOptions {
  host?: HostId;
  dryRun?: boolean;
  packageSpec?: string; // override for local testing
}

const DEFAULT_PACKAGE_SPEC = "@prepsavant/mcp";

interface InstallResult {
  host: HostId;
  status: "patched" | "already-installed" | "manual" | "skipped";
  configPath: string | null;
  message: string;
}

function patchJsonConfig(
  configPath: string,
  packageSpec: string,
  dryRun: boolean,
): InstallResult["status"] {
  let parsed: { mcpServers?: Record<string, unknown> } = {};
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, "utf-8");
    if (raw.trim()) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(
          `Could not parse JSON at ${configPath}. Refusing to overwrite an unreadable file.`,
        );
      }
    }
  }
  parsed.mcpServers = parsed.mcpServers ?? {};
  const existing = (parsed.mcpServers as Record<string, unknown>)["sam"];
  const desired = {
    command: "npx",
    args: ["-y", packageSpec],
  };
  if (
    existing &&
    typeof existing === "object" &&
    JSON.stringify(existing) === JSON.stringify(desired)
  ) {
    return "already-installed";
  }
  (parsed.mcpServers as Record<string, unknown>)["sam"] = desired;
  if (dryRun) return "patched";
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(parsed, null, 2) + "\n");
  return "patched";
}

const CODEX_MANUAL_SNIPPET = (pkg: string) => `
Add the following to ~/.codex/config.toml under [mcp_servers]:

[mcp_servers.sam]
command = "npx"
args = ["-y", "${pkg}"]
`;

export function install(opts: InstallOptions = {}): InstallResult[] {
  const pkg = opts.packageSpec ?? DEFAULT_PACKAGE_SPEC;
  const all = detectHosts();
  const targets = opts.host ? all.filter((t) => t.id === opts.host) : all;
  if (opts.host && targets.length === 0) {
    throw new Error(`Unknown host "${opts.host}". Use one of: claude, cursor, codex.`);
  }

  const results: InstallResult[] = [];
  for (const t of targets) {
    if (t.id === "codex") {
      // Codex uses TOML — we don't ship a TOML editor here, just print the snippet.
      results.push({
        host: t.id,
        status: "manual",
        configPath: t.configPath,
        message: CODEX_MANUAL_SNIPPET(pkg).trim(),
      });
      continue;
    }
    if (!t.configPath) {
      results.push({
        host: t.id,
        status: "skipped",
        configPath: null,
        message: `No known config path on ${process.platform}.`,
      });
      continue;
    }
    try {
      const status = patchJsonConfig(t.configPath, pkg, !!opts.dryRun);
      results.push({
        host: t.id,
        status,
        configPath: t.configPath,
        message:
          status === "already-installed"
            ? `Already installed at ${t.configPath}.`
            : opts.dryRun
              ? `Would patch ${t.configPath} (dry-run).`
              : `Patched ${t.configPath}.`,
      });
    } catch (err) {
      results.push({
        host: t.id,
        status: "skipped",
        configPath: t.configPath,
        message: (err as Error).message,
      });
    }
  }
  return results;
}
