// Bundle the runner with esbuild so the vendored `@workspace/*` modules
// (sam-market-context-shared, ai-assisted-events, mcp-runner-version) get
// inlined into the published tarball. Consumers install `@prepsavant/mcp`
// from npm and never have a `@workspace/...` package available — bundling
// is what lets the runner ship those internal helpers.
//
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
// truth for the runner version: the release workflow's
// `npm version --no-git-tag-version` bump flows through to the built
// `--version` output without any manual edit to a `*.ts` source file.
// The release smoke test (built `--version` vs `package.json.version`) is
// then a real safety net for build regressions, not a tripwire on a
// missed manual sync.
const pkg = JSON.parse(
  readFileSync(path.resolve(here, "package.json"), "utf-8"),
);
if (typeof pkg.version !== "string" || pkg.version.length === 0) {
  throw new Error(
    "package.json is missing a non-empty `version` field",
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
  // Mirror the tsconfig `paths` so esbuild can resolve the vendored modules
  // when bundling. Without these aliases, esbuild would try to look up the
  // `@workspace/*` specifiers in node_modules and fail.
  alias: {
    "@workspace/sam-market-context-shared": path.resolve(
      here,
      "vendor/sam-market-context-shared/index.ts",
    ),
    "@workspace/ai-assisted-events": path.resolve(
      here,
      "vendor/ai-assisted-events/index.ts",
    ),
    "@workspace/mcp-runner-version": path.resolve(
      here,
      "vendor/mcp-runner-version/index.ts",
    ),
    "@workspace/mcp-runner-version/compare": path.resolve(
      here,
      "vendor/mcp-runner-version/compare.ts",
    ),
  },
  // Anything that must be resolved by Node at runtime out of the consumer's
  // node_modules. These are declared as real `dependencies` in package.json.
  external: ["@modelcontextprotocol/sdk", "zod"],
  // `__ADAPTER_VERSION__` is declared as a global in `src/version.ts`.
  // esbuild substitutes the bare identifier (and `typeof`-of-it) at bundle
  // time so the bundled `dist/cli.js` carries a literal version string and
  // never reads `package.json` at runtime.
  define: {
    __ADAPTER_VERSION__: JSON.stringify(pkg.version),
  },
  // esbuild already preserves the `#!/usr/bin/env node` shebang from the
  // entry file's first line.
  sourcemap: false,
});
