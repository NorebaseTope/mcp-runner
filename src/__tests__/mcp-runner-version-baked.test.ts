// End-to-end tests for the "bake runner version from package.json"
// contract introduced by Task #503.
//
// `packages/mcp-runner/src/version.ts` resolves `ADAPTER_VERSION` two
// ways depending on how the runner is run:
//
//   1. Bundled (`dist/cli.js`, what we publish to npm). `build.mjs`
//      reads `package.json.version` at build time and uses esbuild's
//      `define` option to substitute the bare identifier
//      `__ADAPTER_VERSION__` with a literal string. The bundled output
//      carries a literal version and never reads `package.json` at
//      startup.
//
//   2. Unbundled (tsx dev workflow). `__ADAPTER_VERSION__` is
//      undeclared; the `typeof ... === "undefined"` branch falls back
//      to reading `packages/mcp-runner/package.json` from disk.
//
// Both paths must report the same value as `package.json.version`. This
// file pins both paths against a real `pnpm --filter @prepsavant/mcp
// run build` + a real `tsx src/cli.ts --version` so a regression in
// either resolution mechanism (a busted `define` block, a missing
// fallback import, a hand-edit to `version.ts` that drops the typeof
// guard) fails the suite loudly instead of slipping into the public
// repo's release smoke test.
//
// The release workflow on `NorebaseTope/mcp-runner` runs an equivalent
// post-build assertion (`node dist/cli.js --version` vs
// `node -p require('./package.json').version`); these tests are the
// monorepo-side analogue so the same regression can't reach the public
// repo to begin with.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
// HERE = packages/mcp-runner/src/__tests__ → up 4 to reach the repo root.
const REPO_ROOT = path.resolve(HERE, "..", "..", "..", "..");
const RUNNER_DIR = path.join(REPO_ROOT, "packages", "mcp-runner");
const RUNNER_PKG_JSON = path.join(RUNNER_DIR, "package.json");
const RUNNER_DIST_CLI = path.join(RUNNER_DIR, "dist", "cli.js");
const RUNNER_SRC_CLI = path.join(RUNNER_DIR, "src", "cli.ts");

function readRunnerVersion(): string {
  const raw = fs.readFileSync(RUNNER_PKG_JSON, "utf-8");
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error(
      `Test fixture is broken: ${RUNNER_PKG_JSON} has no string \`version\``,
    );
  }
  return parsed.version;
}

// Building once and reusing dist/cli.js for both the built-binary
// assertion and any future bundled-path assertions keeps the suite under
// a sane wall-clock budget. The build is fast (~70ms with a warm cache)
// but the surrounding `pnpm` boot is ~5s, so we deliberately do it once.
function buildRunnerOnce(): { stdout: string; stderr: string } {
  const r = spawnSync(
    "pnpm",
    ["--filter", "@prepsavant/mcp", "run", "build"],
    { cwd: REPO_ROOT, encoding: "utf-8", timeout: 120_000 },
  );
  if (r.status !== 0) {
    throw new Error(
      `pnpm --filter @prepsavant/mcp run build failed (status=${r.status}):\n` +
        `stdout:\n${r.stdout}\n` +
        `stderr:\n${r.stderr}\n`,
    );
  }
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("mcp-runner ADAPTER_VERSION is baked from package.json", () => {
  it("bundled path: built `dist/cli.js --version` matches package.json.version", () => {
    buildRunnerOnce();
    assert.ok(
      fs.existsSync(RUNNER_DIST_CLI),
      `expected build to produce ${RUNNER_DIST_CLI}`,
    );

    const expected = readRunnerVersion();
    const r = spawnSync("node", [RUNNER_DIST_CLI, "--version"], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      timeout: 30_000,
    });
    assert.equal(
      r.status,
      0,
      `dist/cli.js --version exited ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );
    const actual = (r.stdout ?? "").trim();
    assert.equal(
      actual,
      expected,
      `built runner reports version "${actual}" but package.json is "${expected}". ` +
        `This is the same drift the public repo's release smoke test catches — ` +
        `something has broken the esbuild \`define\` injection in build.mjs.`,
    );
  });

  it("unbundled tsx path: src/cli.ts --version matches package.json.version", () => {
    // The fallback path inside `version.ts` reads
    // `packages/mcp-runner/package.json` via `import.meta.url` when
    // `__ADAPTER_VERSION__` is undeclared. Running the source under tsx
    // exercises exactly that branch — no `define` substitution applies.
    const expected = readRunnerVersion();

    const r = spawnSync(
      "pnpm",
      [
        "--filter",
        "@prepsavant/mcp",
        "exec",
        "tsx",
        // Path is relative to the runner package, since `--filter` cd's
        // into it for `exec`.
        path.relative(RUNNER_DIR, RUNNER_SRC_CLI),
        "--version",
      ],
      { cwd: REPO_ROOT, encoding: "utf-8", timeout: 60_000 },
    );
    assert.equal(
      r.status,
      0,
      `tsx src/cli.ts --version exited ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );
    // pnpm prefixes lines with the package name in some configs; trim
    // and grab the last non-empty line to be robust against that.
    const lines = (r.stdout ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const actual = lines[lines.length - 1] ?? "";
    assert.equal(
      actual,
      expected,
      `tsx-run runner reports version "${actual}" but package.json is "${expected}". ` +
        `The runtime fallback in packages/mcp-runner/src/version.ts is broken — ` +
        `most likely the \`typeof __ADAPTER_VERSION__ === "undefined"\` guard, ` +
        `the \`import.meta.url\` resolution, or the package.json read path.`,
    );
  });
});
