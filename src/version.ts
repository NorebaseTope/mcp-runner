// Source of truth for the runner's `ADAPTER_VERSION` constant.
//
// `package.json.version` is the single source of truth for the published
// runner version. There are two paths into this module:
//
//   1. Bundled (`dist/cli.js`, what we publish to npm). `build.mjs` reads
//      `package.json.version` at build time and uses esbuild's `define`
//      option to substitute the bare identifier `__ADAPTER_VERSION__`
//      with a literal string. The bundled output therefore carries a
//      literal version and never touches the filesystem at startup.
//
//   2. Unbundled (`tsx packages/mcp-runner/src/cli.ts`, dev workflow).
//      `__ADAPTER_VERSION__` is undeclared at runtime, so the
//      `typeof ... === "undefined"` branch falls back to reading
//      `packages/mcp-runner/package.json` from disk via `import.meta.url`.
//      `typeof` against an undeclared identifier returns `"undefined"`
//      without throwing a `ReferenceError`, which is what makes this
//      pattern work in both modes from a single source file.
//
// The export shape (`export const ADAPTER_VERSION: string`) is held
// byte-stable so the 11 consumer files (config.ts re-exports it, then
// auth/server/api/doctor/cli/ai-assisted/* import from there) keep
// compiling without edits.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

declare const __ADAPTER_VERSION__: string;

function resolveAdapterVersion(): string {
  // Bundled path: esbuild's `define` rewrites the identifier — and the
  // surrounding `typeof` — to literals at build time, so this branch
  // collapses to `return "x.y.z";` in the published `dist/cli.js`.
  if (typeof __ADAPTER_VERSION__ !== "undefined") {
    return __ADAPTER_VERSION__;
  }

  // Unbundled tsx path. `import.meta.url` points at this file inside
  // `packages/mcp-runner/src/`, so the sibling `package.json` is one
  // directory up. Reading it eagerly at module-load time keeps the
  // export a `const string` (matching the bundled shape) and makes any
  // I/O failure loud instead of deferred.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkgPath = path.resolve(here, "..", "package.json");
  const raw = readFileSync(pkgPath, "utf-8");
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error(
      `Could not resolve ADAPTER_VERSION: ${pkgPath} is missing a non-empty "version" field`,
    );
  }
  return parsed.version;
}

export const ADAPTER_VERSION: string = resolveAdapterVersion();
