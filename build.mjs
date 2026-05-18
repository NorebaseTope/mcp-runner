// Bundle the runner with esbuild so workspace dependencies (e.g.
// `@workspace/sam-market-context-shared`) get inlined into the published
// tarball. Consumers install `@prepsavant/mcp` from npm and never have a
// `@workspace/...` package available — bundling is what lets the runner
// share source-of-truth data with the API server in this monorepo.
//
// We deliberately keep this script tiny: the runner has no native
// dependencies, no Sentry/pino plugins, and no source-map upload step.
// External runtime deps (the MCP SDK, zod) stay in package.json
// `dependencies` so end users still install them via npm/pnpm.

import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(here, "dist");

// Read `package.json.version` at build time and inject it into the bundle
// as a `define` constant. This makes `package.json` the single source of
// truth for the runner version: a `npm version --no-git-tag-version` bump
// in the release workflow flows through to the built `--version` output
// without any manual edit to a `*.ts` source file. The release smoke test
// (built `--version` vs `package.json.version`) is then a real safety net
// for `build.mjs` regressions, not a tripwire on a missed manual sync.
const pkg = JSON.parse(
  readFileSync(path.resolve(here, "package.json"), "utf-8"),
);
if (typeof pkg.version !== "string" || pkg.version.length === 0) {
  throw new Error(
    "packages/mcp-runner/package.json is missing a non-empty `version` field",
  );
}

await rm(distDir, { recursive: true, force: true });

await build({
  entryPoints: [path.resolve(here, "src/cli.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18.18",
  outfile: path.join(distDir, "cli.js"),
  logLevel: "info",
  // External: anything that must be resolved by Node at runtime out of the
  // consumer's node_modules. These are declared as real `dependencies` in
  // package.json so `npm install @prepsavant/mcp` pulls them down.
  // Task #1562 — `@cursor/sdk` was removed (replaced by a pure-HTTP client
  // in `coached/cursor-http-client.ts`) so it no longer appears here.
  external: ["@modelcontextprotocol/sdk", "zod"],
  // `__ADAPTER_VERSION__` is declared as a global in `src/version.ts`.
  // esbuild substitutes the bare identifier (and `typeof`-of-it) at bundle
  // time so the bundled `dist/cli.js` carries a literal version string and
  // never reads `package.json` at runtime. The unbundled tsx path reads
  // `package.json` via a `typeof __ADAPTER_VERSION__ === "undefined"`
  // fallback in `src/version.ts`.
  define: {
    __ADAPTER_VERSION__: JSON.stringify(pkg.version),
  },
  // esbuild already preserves the `#!/usr/bin/env node` shebang from the
  // entry file's first line, so no banner is needed. The output retains
  // the shebang and is marked executable by `chmod` in the npm publish step.
  sourcemap: false,
});
