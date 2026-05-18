// Task #1477 — Windows PATHEXT resolution for cursor-agent.
//
// Repro: on Windows, Node's `spawnSync(bin, args)` does NOT walk
// PATHEXT, so a `cursor-agent.cmd` shim returns ENOENT even though the
// command resolves fine from PowerShell. We exercise the new
// `resolveBinOnPath` helper plus `CursorAgentAdapter.probe()` end-to-end
// under a stubbed `process.platform = "win32"` and a temp PATH dir
// containing only a `.cmd` shim, asserting (a) probe returns ok, (b)
// `_chosenInvocation()` reports the standalone form, and (c) POSIX
// behaviour is preserved.

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  CursorAgentAdapter,
  resolveBinOnPath,
} from "../coached/coding-agent.js";

async function withPlatform<T>(p: NodeJS.Platform, fn: () => Promise<T> | T): Promise<T> {
  const desc = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: p, configurable: true });
  try {
    return await fn();
  } finally {
    if (desc) Object.defineProperty(process, "platform", desc);
  }
}

test("Task #1477 — resolveBinOnPath finds a .cmd shim on Windows via PATHEXT", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "task1477-"));
  try {
    fs.writeFileSync(path.join(tmp, "cursor-agent.cmd"), "@echo off\r\necho 0.45.0\r\n");
    // Lowercase PATHEXT entry so the lookup matches on case-sensitive
    // filesystems (this test runs on Linux CI).
    const hit = resolveBinOnPath("cursor-agent", {
      platform: "win32",
      env: { PATH: tmp, PATHEXT: ".com;.exe;.bat;.cmd" },
    });
    assert.equal(hit, path.join(tmp, "cursor-agent.cmd"));

    // No match → null (only the .cmd exists; we look for `cursor` bare).
    const miss = resolveBinOnPath("cursor", {
      platform: "win32",
      env: { PATH: tmp, PATHEXT: ".com;.exe;.bat;.cmd" },
    });
    assert.equal(miss, null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("Task #1477 follow-up — resolveBinOnPath prefers PATHEXT shim over extensionless POSIX script on Windows", () => {
  // Repro of the in-the-wild Cursor 3.x layout that broke 2.1.3:
  //   C:\Program Files\cursor\resources\app\bin\cursor       ← POSIX shell script for WSL/Git Bash
  //   C:\Program Files\cursor\resources\app\bin\cursor.cmd   ← the actual Windows shim
  // The resolver MUST return the .cmd, not the extensionless file —
  // otherwise spawn() can't execute it on win32 and the probe falsely
  // reports `Coding-agent not_installed`.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "task1477-followup-"));
  try {
    fs.writeFileSync(path.join(tmp, "cursor"), "#!/usr/bin/env bash\necho 0.45.0\n");
    fs.writeFileSync(path.join(tmp, "cursor.cmd"), "@echo off\r\necho 0.45.0\r\n");
    const hit = resolveBinOnPath("cursor", {
      platform: "win32",
      env: { PATH: tmp, PATHEXT: ".com;.exe;.bat;.cmd" },
    });
    assert.equal(hit, path.join(tmp, "cursor.cmd"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("Task #1477 — resolveBinOnPath is a no-op on POSIX platforms", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "task1477-"));
  try {
    fs.writeFileSync(path.join(tmp, "cursor-agent.cmd"), "x");
    // Even if the .cmd is there, on linux/darwin we return null so the
    // OS-level PATH lookup in spawn() runs unchanged.
    assert.equal(
      resolveBinOnPath("cursor-agent", {
        platform: "linux",
        env: { PATH: tmp, PATHEXT: ".CMD" },
      }),
      null,
    );
    assert.equal(
      resolveBinOnPath("cursor-agent", {
        platform: "darwin",
        env: { PATH: tmp },
      }),
      null,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("Task #1477 — resolveBinOnPath defaults PATHEXT when unset", () => {
  // Use a fake existsSync for determinism — the default PATHEXT
  // (`.COM;.EXE;.BAT;.CMD`) is uppercase, which wouldn't match on
  // case-sensitive Linux filesystems where this test runs. We use a
  // POSIX-style fake PATH dir so the host's `path.join` produces a key
  // that matches the set on whichever OS the tests run on.
  const fakeDir = path.join(os.tmpdir(), "fake-bin");
  const present = new Set([path.join(fakeDir, "cursor-agent.CMD")]);
  const hit = resolveBinOnPath("cursor-agent", {
    platform: "win32",
    env: { PATH: fakeDir },
    existsSync: (p) => present.has(p),
  });
  assert.equal(hit, path.join(fakeDir, "cursor-agent.CMD"));
});

test("Task #1477 — resolveBinOnPath honours a custom existsSync (deterministic on case-sensitive FS)", () => {
  const fakeDir = path.join(os.tmpdir(), "fake-bin2");
  const present = new Set([
    path.join(fakeDir, "cursor-agent.cmd"),
  ]);
  const hit = resolveBinOnPath("cursor-agent", {
    platform: "win32",
    env: { PATH: fakeDir, PATHEXT: ".exe;.cmd" },
    existsSync: (p) => present.has(p),
  });
  assert.equal(hit, path.join(fakeDir, "cursor-agent.cmd"));
});

test("Task #1477 — CursorAgentAdapter.probe() picks up a .cmd shim on Windows", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "task1477-"));
  try {
    // A real `.cmd` would need cmd.exe to execute; instead we ship a
    // shebang shell script and rely on spawnSync invoking it directly
    // on POSIX. The Windows-specific code path we care about is the
    // PATHEXT lookup, which `resolveBinOnPath` handles in pure JS — by
    // the time we reach `spawnSync(absPath, ...)`, the OS just runs
    // whatever's at that path. We therefore write an executable shell
    // script with a `.cmd` extension so probe() can actually invoke it
    // under the test runner's host OS while still exercising the
    // PATHEXT branch of the adapter.
    const shimPath = path.join(tmp, "cursor-agent.cmd");
    // Use an absolute shebang since we narrow PATH to the temp dir
    // below — `/usr/bin/env bash` would fail (env's `bash` lookup uses
    // PATH).
    fs.writeFileSync(shimPath, "#!/bin/sh\necho 'cursor-agent 0.45.7'\n");
    fs.chmodSync(shimPath, 0o755);

    const adapter = new CursorAgentAdapter();
    const origPath = process.env["PATH"];
    const origPathExt = process.env["PATHEXT"];
    process.env["PATH"] = tmp;
    // Lowercase PATHEXT so the lookup matches the lowercase `.cmd` shim
    // on case-sensitive Linux CI filesystems.
    process.env["PATHEXT"] = ".com;.exe;.bat;.cmd";
    // Task #1477 follow-up #2 — disable the production shell:true wrap
    // so the shim's shebang+chmod runs directly on the Linux test host
    // (real Windows uses cmd.exe, which doesn't exist here).
    process.env["PREPSAVANT_WIN_SPAWN_NO_SHELL"] = "1";
    try {
      await withPlatform("win32", async () => {
        const probe = await adapter.probe();
        assert.equal(probe.ok, true, `probe should succeed, got ${JSON.stringify(probe)}`);
        assert.match(probe.version ?? "", /0\.45\.7/);
        const chosen = adapter._chosenInvocation();
        assert.deepEqual(chosen, ["cursor-agent"]);
      });
    } finally {
      if (origPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = origPath;
      if (origPathExt === undefined) delete process.env["PATHEXT"];
      else process.env["PATHEXT"] = origPathExt;
      delete process.env["PREPSAVANT_WIN_SPAWN_NO_SHELL"];
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("Task #1477 — CursorAgentAdapter.probe() still delegates an explicit relative binPath to spawn on Windows", async () => {
  // Regression guard: on Windows the PATHEXT skip-guard must only fire
  // for BARE command names. An explicit relative/absolute binPath the
  // user pinned in config must still be passed through to spawn so the
  // OS can resolve it — otherwise the probe would falsely report
  // not_installed for valid user-configured paths.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "task1477-"));
  try {
    // Use a non-PATHEXT extension here so this test exercises the
    // explicit-binPath delegation path WITHOUT triggering the
    // Task #1477 follow-up #2 shell:true branch (which is real-Windows
    // only — Node's `shell: true` under stubbed `process.platform =
    // "win32"` on Linux tries to invoke `cmd.exe` and ENOENTs).
    const shimPath = path.join(tmp, "cursor-agent-shim");
    fs.writeFileSync(shimPath, "#!/bin/sh\necho 'cursor-agent 1.2.3'\n");
    fs.chmodSync(shimPath, 0o755);

    // Use an explicit absolute path (which contains `/` / `\\`) so the
    // helper returns null and the skip-guard does NOT trip; spawn then
    // runs the file directly.
    const adapter = new CursorAgentAdapter({ binPath: shimPath });
    await withPlatform("win32", async () => {
      const probe = await adapter.probe();
      assert.equal(probe.ok, true, `probe should succeed, got ${JSON.stringify(probe)}`);
      assert.match(probe.version ?? "", /1\.2\.3/);
      assert.deepEqual(adapter._chosenInvocation(), [shimPath]);
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("Task #1477 — CursorAgentAdapter.probe() surfaces Windows-specific remediation when nothing resolves", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "task1477-"));
  try {
    // Empty PATH dir → nothing resolves → not_installed.
    const adapter = new CursorAgentAdapter();
    const origPath = process.env["PATH"];
    process.env["PATH"] = tmp;
    try {
      await withPlatform("win32", async () => {
        const probe = await adapter.probe();
        assert.equal(probe.ok, false);
        assert.equal(probe.reason, "not_installed");
        assert.match(probe.remediation ?? "", /cursor-agent\.cmd/);
        assert.match(probe.remediation ?? "", /cursor\.cmd/);
        assert.match(probe.remediation ?? "", /https:\/\/cursor\.com/);
      });
    } finally {
      if (origPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = origPath;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
