// task-827 — `prepsavant doctor` surfaces the local install-history file.
//
// The doctor's manifest section gains a `manifest.install_history` check
// that reads the most recent entry written by `prepsavant install`. This
// test pins three buckets we want users to see:
//
//   1. Skipped placeholder when no install has run on this machine yet
//      (fresh setup — green-ish, never red, since the user might be on
//      their very first session).
//   2. Pass with a "cleaned up N stale entries" detail when the most
//      recent install actually removed legacy aliases — that's the signal
//      that the modern upgrade tool worked.
//   3. Fail with a "refused because a Sam runner was active" detail when
//      the most recent recorded attempt was blocked by the runner-lock,
//      so the doctor exit status flips and the user sees a clear next step.

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  InstallHistoryEntry,
  InstallHistoryHostResult,
} from "../install-history.js";

// Typed escape hatch: post-Task #1175 the runtime `HostId` is narrowed to
// `"cursor"`, but these fixtures intentionally seed legacy host strings
// (`"claude"`) to pin that the doctor's install-history check tolerates
// rows written by older runner versions before the cutover.
type LegacyInstallHistoryHostResult = Omit<InstallHistoryHostResult, "host"> & {
  host: string;
};
type LegacyInstallHistoryEntry = Omit<InstallHistoryEntry, "hosts"> & {
  hosts: LegacyInstallHistoryHostResult[];
};
function asInstallHistoryEntry(
  entry: LegacyInstallHistoryEntry,
): InstallHistoryEntry {
  return entry as unknown as InstallHistoryEntry;
}

function withTempHome<T>(fn: (homeDir: string) => Promise<T> | T): Promise<T> {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "prepsavant-doctor-history-"));
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

test("doctor: install_history check is skipped when no history exists", async () => {
  await withTempHome(async () => {
    const { runDoctor } = await import("../doctor.js");
    const result = runDoctor();
    const check = result.manifest.find((c) => c.id === "manifest.install_history");
    assert.ok(check, "expected an install_history check");
    assert.equal(check!.status, "skipped");
    assert.match(check!.detail ?? "", /No prior install recorded/);
    // Task #1382 — even on the fresh-machine path the check stamps a
    // copy-pasteable install command so the api-server's
    // `runner_outdated` splice always has a `fixCommand` to forward.
    assert.equal(check!.fixCommand, "npx -y @prepsavant/mcp install");
  });
});

test("doctor: install_history reports pass with cleanup count after a real upgrade", async () => {
  await withTempHome(async () => {
    const { appendInstallHistoryEntry } = await import("../install-history.js");
    appendInstallHistoryEntry(
      asInstallHistoryEntry({
        ts: "2026-04-30T12:00:00.000Z",
        previousVersion: "0.4.0",
        newVersion: "0.5.0",
        hosts: [
          {
            host: "claude",
            status: "patched",
            configPath: "/tmp/claude.json",
            cleanedKeys: ["sam-old", "prepsavant"],
            previousSpec: "-y @prepsavant/mcp@0.4.0",
          },
          {
            host: "cursor",
            status: "patched",
            configPath: "/tmp/cursor.json",
            cleanedKeys: ["sam-experiment"],
          },
        ],
      }),
    );
    const { runDoctor } = await import("../doctor.js");
    const result = runDoctor();
    const check = result.manifest.find((c) => c.id === "manifest.install_history");
    assert.ok(check);
    assert.equal(check!.status, "pass");
    // We sum cleanups across hosts so users see one number rather than a
    // per-host breakdown — the dashboard / verbose CLI can drill down.
    assert.match(check!.detail ?? "", /cleaned up 3 stale entries/);
    assert.match(check!.detail ?? "", /v0\.4\.0 → v0\.5\.0/);
    // Task #1382 — happy-path pass row also stamps a host-aware
    // install command. The fixture above seeds both a legacy
    // `claude` row and the supported `cursor` row on the same entry;
    // the helper skips legacy/unsupported hosts and returns the
    // single supported host, so the fixCommand must say
    // `--host cursor` (never `--host claude` — that command would
    // error out because the installer no longer accepts the retired
    // host id).
    assert.equal(
      check!.fixCommand,
      "npx -y @prepsavant/mcp install --host cursor",
    );
  });
});

// Task #1205 — when the installer auto-stopped a previous Sam runner
// before patching, the install-history doctor row must surface the
// killed pid so users can audit what happened. The status stays `pass`
// (the install itself succeeded); the kill notice is appended to the
// detail string.
test("doctor: install_history pass row surfaces the auto-killed runner pid (task #1205)", async () => {
  await withTempHome(async () => {
    const { appendInstallHistoryEntry } = await import("../install-history.js");
    appendInstallHistoryEntry(
      asInstallHistoryEntry({
        ts: "2026-05-13T12:00:00.000Z",
        previousVersion: "1.8.0",
        newVersion: "1.9.0",
        hosts: [
          {
            host: "cursor",
            status: "patched",
            configPath: "/tmp/cursor.json",
            cleanedKeys: [],
            autoKilledRunnerPid: 12345,
          },
        ],
      }),
    );
    const { runDoctor } = await import("../doctor.js");
    const result = runDoctor();
    const check = result.manifest.find((c) => c.id === "manifest.install_history");
    assert.ok(check);
    assert.equal(check!.status, "pass");
    assert.match(check!.detail ?? "", /Stopped previous runner \(pid 12345\)/);
    // Sanity: the version stanza and cleanup note still render alongside.
    assert.match(check!.detail ?? "", /v1\.8\.0 → v1\.9\.0/);
    assert.match(check!.detail ?? "", /no stale entries to clean/);
  });
});

// Task #1382 — `mostRecentInstalledHostId` MUST refuse to surface
// retired host ids (`claude`, `claude_code`, `codex`). Emitting
// `--host claude` from the upgrade advisory would produce a command
// the installer rejects with a migration error — strictly worse than
// falling back to the bare `prepsavant install`.
test("mostRecentInstalledHostId: returns null when only legacy/unsupported hosts are recorded", async () => {
  await withTempHome(async () => {
    const { appendInstallHistoryEntry, mostRecentInstalledHostId } =
      await import("../install-history.js");
    appendInstallHistoryEntry(
      asInstallHistoryEntry({
        ts: "2026-04-30T12:00:00.000Z",
        previousVersion: "0.4.0",
        newVersion: "0.5.0",
        hosts: [
          {
            host: "claude",
            status: "patched",
            configPath: "/tmp/claude.json",
            cleanedKeys: [],
          },
          {
            host: "codex",
            status: "patched",
            configPath: "/tmp/codex.toml",
            cleanedKeys: [],
          },
        ],
      }),
    );
    assert.equal(mostRecentInstalledHostId(), null);
  });
});

test("mostRecentInstalledHostId: prefers a supported host over legacy siblings on the same entry", async () => {
  await withTempHome(async () => {
    const { appendInstallHistoryEntry, mostRecentInstalledHostId } =
      await import("../install-history.js");
    appendInstallHistoryEntry(
      asInstallHistoryEntry({
        ts: "2026-04-30T12:00:00.000Z",
        previousVersion: "0.4.0",
        newVersion: "0.5.0",
        hosts: [
          {
            host: "claude",
            status: "patched",
            configPath: "/tmp/claude.json",
            cleanedKeys: [],
          },
          {
            host: "cursor",
            status: "patched",
            configPath: "/tmp/cursor.json",
            cleanedKeys: [],
          },
        ],
      }),
    );
    assert.equal(mostRecentInstalledHostId(), "cursor");
  });
});

test("doctor: install_history fails when the most recent attempt was refused under a live runner", async () => {
  await withTempHome(async () => {
    const { appendInstallHistoryEntry } = await import("../install-history.js");
    appendInstallHistoryEntry(
      asInstallHistoryEntry({
        ts: "2026-04-30T12:00:00.000Z",
        previousVersion: "0.4.0",
        newVersion: "0.5.0",
        hosts: [
          {
            host: "claude",
            status: "refused-live-runner",
            configPath: "/tmp/claude.json",
            cleanedKeys: [],
          },
        ],
      }),
    );
    const { runDoctor } = await import("../doctor.js");
    const result = runDoctor();
    const check = result.manifest.find((c) => c.id === "manifest.install_history");
    assert.ok(check);
    assert.equal(check!.status, "fail");
    assert.match(check!.detail ?? "", /Sam runner was active/i);
    // The whole doctor result rolls up to a fail when any check fails, so
    // CLI callers will see a non-zero exit and dashboards will render red.
    assert.equal(result.overallStatus, "fail");
  });
});
