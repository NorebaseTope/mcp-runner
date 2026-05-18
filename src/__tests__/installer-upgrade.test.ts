// task-827 — `prepsavant install` as a real upgrade tool.
//
// Task #1175 (Cursor-first M8) — physical retirement of the Claude Code,
// Codex, and Claude Desktop install paths. Cursor is now the only host
// the runner installer knows how to patch, so every test in this file
// drives the JSON-config path at `~/.cursor/mcp.json`. Codex's TOML
// reconciler was deleted along with its install path; we lock in the
// rejection contract for the retired host ids in a dedicated test.
//
// What we lock in here, all on a per-test temp HOME so each scenario
// sees a pristine `~/.prepsavant`:
//   1. Stale alias keys (`sam-old`, `prepsavant`) are reconciled into
//      the canonical `sam` key, even when they live alongside an
//      existing `sam` entry. The canonical entry's spec is rewritten
//      to floating.
//   2. A pinned-version `sam` (e.g. `@prepsavant/mcp@0.3.0`) is
//      rewritten to the floating `@prepsavant/mcp` spec without the
//      user needing to edit JSON. The previous spec is reported back
//      via `previousSpec`.
//   3. Entries identified by command/args (not by key name) get
//      cleaned up too — a user-renamed `sam-experiment` pointing at
//      `@prepsavant/mcp` should not survive.
//   4. Idempotent: a fresh canonical install is reported as
//      `already-installed` and writes nothing new on disk.
//   5. Refuses to patch when the runner-lock is held by a live
//      process. The refusal is surfaced as a `refused-live-runner`
//      result AND persisted to install-history so doctor can flag it.
//   6. Successful installs append a per-host entry to install-history,
//      capped at MAX_HISTORY_ENTRIES.
//   7. Retired host ids (`claude`, `claude_code`, `codex`) throw with
//      a clear migration message instead of silently writing a Cursor
//      config under the wrong identity.

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function withTempHome<T>(fn: (homeDir: string) => Promise<T> | T): Promise<T> {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "prepsavant-installer-"));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  return Promise.resolve(fn(homeDir)).finally(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    try {
      fs.rmSync(homeDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });
}

// Cursor's global mcp.json is at `~/.cursor/mcp.json` on every platform
// the runner supports today (see `cursorConfigPath` in installer.ts).
function cursorConfigPathFor(homeDir: string): string {
  return path.join(homeDir, ".cursor", "mcp.json");
}

function writeJson(p: string, data: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

function readJson<T = unknown>(p: string): T {
  return JSON.parse(fs.readFileSync(p, "utf-8")) as T;
}

test("install: collapses sam-old + prepsavant aliases into canonical `sam`", async () => {
  await withTempHome(async (homeDir) => {
    const cfgPath = cursorConfigPathFor(homeDir);
    writeJson(cfgPath, {
      mcpServers: {
        sam: { command: "npx", args: ["-y", "@prepsavant/mcp@0.3.0"] },
        "sam-old": { command: "npx", args: ["-y", "@prepsavant/mcp@0.2.1"] },
        prepsavant: { command: "npx", args: ["-y", "@prepsavant/mcp"] },
        "unrelated-server": { command: "node", args: ["./other.js"] },
      },
    });
    const { install } = await import("../installer.js");
    const results = install({ host: "cursor", liveRunnerLock: null });
    assert.equal(results.length, 1);
    const r = results[0]!;
    assert.equal(r.host, "cursor");
    assert.equal(r.status, "patched");
    assert.deepEqual(r.cleanedKeys.sort(), ["prepsavant", "sam-old"]);
    // Reports what `sam` itself was before — the pinned spec.
    assert.equal(r.previousSpec, "-y @prepsavant/mcp@0.3.0");
    const after = readJson<{ mcpServers: Record<string, { command: string; args: string[] }> }>(cfgPath);
    assert.deepEqual(after.mcpServers.sam, { command: "npx", args: ["-y", "@prepsavant/mcp"] });
    assert.equal(after.mcpServers["sam-old"], undefined);
    assert.equal(after.mcpServers.prepsavant, undefined);
    // Non-Sam entries must be left alone.
    assert.deepEqual(after.mcpServers["unrelated-server"], { command: "node", args: ["./other.js"] });
  });
});

test("install: rewrites a non-canonical key whose args target @prepsavant/mcp", async () => {
  await withTempHome(async (homeDir) => {
    const cfgPath = cursorConfigPathFor(homeDir);
    writeJson(cfgPath, {
      mcpServers: {
        // User renamed it to anything they want — we still recognise it
        // by the package reference in args.
        "sam-experiment": { command: "npx", args: ["-y", "@prepsavant/mcp@0.4.0"] },
      },
    });
    const { install } = await import("../installer.js");
    const r = install({ host: "cursor", liveRunnerLock: null })[0]!;
    assert.equal(r.status, "patched");
    assert.deepEqual(r.cleanedKeys, ["sam-experiment"]);
    // No canonical `sam` existed, so the previous spec falls back to the
    // alias entry's args.
    assert.equal(r.previousSpec, "-y @prepsavant/mcp@0.4.0");
    const after = readJson<{ mcpServers: Record<string, unknown> }>(cfgPath);
    assert.equal(after.mcpServers["sam-experiment"], undefined);
    assert.deepEqual(after.mcpServers.sam, { command: "npx", args: ["-y", "@prepsavant/mcp"] });
  });
});

test("install: returns already-installed when canonical `sam` matches and no aliases exist", async () => {
  await withTempHome(async (homeDir) => {
    const cfgPath = cursorConfigPathFor(homeDir);
    writeJson(cfgPath, {
      mcpServers: {
        sam: { command: "npx", args: ["-y", "@prepsavant/mcp"] },
      },
    });
    const before = fs.readFileSync(cfgPath, "utf-8");
    const { install } = await import("../installer.js");
    const r = install({ host: "cursor", liveRunnerLock: null })[0]!;
    assert.equal(r.status, "already-installed");
    assert.deepEqual(r.cleanedKeys, []);
    assert.equal(r.previousSpec, undefined);
    // File must be byte-identical so we don't churn timestamps.
    assert.equal(fs.readFileSync(cfgPath, "utf-8"), before);
  });
});

test("install: writes a fresh canonical block when the file is missing", async () => {
  await withTempHome(async (homeDir) => {
    const cfgPath = cursorConfigPathFor(homeDir);
    // Note: do NOT pre-create the file. The installer must create both
    // the ~/.cursor directory and mcp.json on a clean machine.
    const { install } = await import("../installer.js");
    const r = install({ host: "cursor", liveRunnerLock: null })[0]!;
    assert.equal(r.status, "patched");
    assert.deepEqual(r.cleanedKeys, []);
    assert.equal(r.previousSpec, undefined);
    const after = readJson<{ mcpServers: Record<string, { command: string; args: string[] }> }>(cfgPath);
    assert.deepEqual(after.mcpServers.sam, {
      command: "npx",
      args: ["-y", "@prepsavant/mcp"],
    });
    // Install-history records the cursor host so doctor can see it.
    const { mostRecentInstallEntry } = await import("../install-history.js");
    const entry = mostRecentInstallEntry();
    assert.ok(entry);
    const cursorHost = entry!.hosts.find((h) => h.host === "cursor");
    assert.ok(cursorHost, "cursor host should be recorded in install-history");
    assert.equal(cursorHost!.status, "patched");
    assert.deepEqual(cursorHost!.cleanedKeys, []);
  });
});

test("install: refuses to patch when a runner lock is held; persists refusal", async () => {
  await withTempHome(async (homeDir) => {
    const cfgPath = cursorConfigPathFor(homeDir);
    writeJson(cfgPath, {
      mcpServers: {
        sam: { command: "npx", args: ["-y", "@prepsavant/mcp@0.3.0"] },
      },
    });
    const before = fs.readFileSync(cfgPath, "utf-8");
    const { install } = await import("../installer.js");
    // Task #1205 — auto-kill is on by default. The strict pre-1205
    // refusal contract this test locks in is now opt-in via --no-kill.
    const results = install({
      host: "cursor",
      liveRunnerLock: { pid: 12345, startedAt: "2026-05-01T00:00:00.000Z" },
      autoKill: false,
    });
    assert.equal(results[0]!.status, "refused-live-runner");
    assert.match(results[0]!.message, /pid 12345/);
    assert.match(results[0]!.message, /currently active/);
    // Crucially: the on-disk config must NOT be rewritten.
    assert.equal(fs.readFileSync(cfgPath, "utf-8"), before);
    // Refused attempts are still recorded so doctor can surface them.
    const { mostRecentInstallEntry } = await import("../install-history.js");
    const entry = mostRecentInstallEntry();
    assert.ok(entry, "expected a history entry for the refused attempt");
    assert.equal(entry!.hosts[0]!.status, "refused-live-runner");
  });
});

// Task #1175 — retired host ids must throw a clear migration message
// rather than silently writing a Cursor config under the wrong identity
// or falling through with a generic "Unknown host" CLI error.
test("install: rejects retired host ids (claude, claude_code, codex) with migration message", async () => {
  await withTempHome(async () => {
    const { install } = await import("../installer.js");
    for (const retired of ["claude", "claude_code", "codex"]) {
      assert.throws(
        () => install({ host: retired, liveRunnerLock: null }),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, new RegExp(`--host ${retired}`));
          assert.match(err.message, /no longer supported/);
          assert.match(err.message, /Cursor/);
          return true;
        },
        `--host ${retired} must be rejected`,
      );
    }
  });
});

test("install: appends an upgrade history entry on success and caps at 10", async () => {
  await withTempHome(async (homeDir) => {
    const cfgPath = cursorConfigPathFor(homeDir);
    writeJson(cfgPath, {
      mcpServers: {
        sam: { command: "npx", args: ["-y", "@prepsavant/mcp@0.3.0"] },
        "sam-old": { command: "npx", args: ["-y", "@prepsavant/mcp@0.2.0"] },
      },
    });
    const installer = await import("../installer.js");
    const history = await import("../install-history.js");

    installer.install({ host: "cursor", liveRunnerLock: null });
    const first = history.mostRecentInstallEntry();
    assert.ok(first);
    assert.equal(first!.previousVersion, null, "first install has no prior version");
    const cursorHost = first!.hosts.find((h) => h.host === "cursor");
    assert.ok(cursorHost);
    assert.deepEqual(cursorHost!.cleanedKeys, ["sam-old"]);
    assert.equal(cursorHost!.previousSpec, "-y @prepsavant/mcp@0.3.0");

    // Subsequent installs should chain through previousVersion (set to the
    // last record's newVersion) and respect the cap.
    for (let i = 0; i < history.MAX_HISTORY_ENTRIES + 3; i++) {
      installer.install({ host: "cursor", liveRunnerLock: null });
    }
    const all = history.readInstallHistory();
    assert.equal(all.length, history.MAX_HISTORY_ENTRIES);
    // First entry in the most-recent-first listing chains to the prior one.
    assert.ok(all[0]!.previousVersion, "later entries record their predecessor's version");
  });
});
