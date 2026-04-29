<!--
This repository is the canonical, public source for `@prepsavant/mcp`.
It is materialised by a one-way sync from the private PrepSavant monorepo
(see scripts/src/sync-mcp-runner-public.ts there). File bugs against this
repo, but coordinate larger changes through the private monorepo.
-->

# @prepsavant/mcp

Local Sam MCP runner: an npm-publishable Model Context Protocol server that
runs inside Claude Desktop, Cursor, or Codex. It executes pinned tests in a
local sandbox (Python and JavaScript/TypeScript), uses MCP sampling to ask the
host's model to speak in Sam's voice, and pushes attempts and enrichment back
to your Sam account through long-lived device tokens.

## Quick start

```sh
# 1. Install the runner into your MCP host (Claude Desktop / Cursor / Codex):
npx -y @prepsavant/mcp install --host claude

# 2. Authorize the runner against your Sam account (one-time):
npx -y @prepsavant/mcp auth

# 3. Restart your MCP host. The runner will appear as the `sam` server.

# 4. (Optional) Verify your environment is healthy:
npx -y @prepsavant/mcp doctor
```

Once the runner is registered, the `practice_*` MCP tools (e.g.
`practice_start`, `practice_hint`, `practice_submit`) start a **Coached**
session right inside your host — same question brief, hint ladder, scored
attempts, and recap as the browser. Sam's voice is supplied via MCP sampling
so your host model speaks as Sam. AI-Assisted observation is a separate flow
documented further below.

## Two surfaces, one Coached experience

Coached isn't browser-only. Once the runner is installed, the same Coached
loop is available in two surfaces:

- **Browser** — go to your Sam dashboard and start a Coached session, no
  install required.
- **IDE** — call the `practice_*` tools from Cursor, Claude Desktop, or Codex
  and Sam runs the same Coached loop in your host.

These are two surfaces on the **same** Coached experience: same job briefs,
same question banks, same hint ladder, same scoring. The only difference is
*where* you practice. AI-Assisted mode (covered below) is a separate,
silent-capture flow — not a third Coached surface.

## What lives where

- `~/.prepsavant/config.json` — long-lived device token, chmod 600.
- `~/.prepsavant/sandbox/` — temp working directories for sandboxed runs.
- Your MCP host's config file (e.g. `claude_desktop_config.json`) — patched by
  `prepsavant install` to register the `sam` server.

## AI-Assisted Mode

AI-Assisted mode lets you solve problems using Claude Code, Cursor, or Codex CLI
while PrepSavant silently captures a signed, tamper-evident evidence log for
post-session grading. Sam stays completely out of your tool's way — no MCP hooks,
no tool interruptions.

```sh
# Start an AI-Assisted capture session (v0.4.0+)
npx -y @prepsavant/mcp start
```

The `start` command walks you through:

1. **Tool selector** — choose from Claude Code (Full support), Cursor (Beta),
   or Codex CLI (Beta).
2. **Cross-platform preflight** — detects the tool binary in PATH, checks the
   minimum version (Cursor 0.45+), verifies snapshot store is writable, and
   cleans up stale hooks from a previous crash.
3. **Consent dialog** — shows exactly what is and is not captured including
   tool-specific beta caveats and OS-specific coverage notes.
4. **Hook install** — installs hooks for the selected tool:
   - Claude Code: `.claude/settings.json` (workspace-scoped)
   - Cursor: `.cursor/settings.json` (workspace-scoped)
   - Codex CLI: `~/.codex/hooks.json` (global, requires `CODEX_HOOKS=1`)
5. **Capture loop** — runs silently in the background. Press `Ctrl+C` to end
   the session and upload the evidence bundle.

### Tool support matrix

| Tool | Status | Confidence ceiling | Hook scope |
| --- | --- | --- | --- |
| Claude Code | **GA** | High | Workspace `.claude/settings.json` |
| Cursor | Beta (≥0.45) | Medium | Workspace `.cursor/settings.json` |
| Codex CLI (interactive) | Beta | Medium | Global `~/.codex/hooks.json` |
| Codex CLI (exec --json) | Beta | High | JSONL stream (no hooks required) |

### What is captured

| Captured | Not captured |
| --- | --- |
| Prompts and AI responses | Screen or webcam |
| Tool calls and results | Microphone |
| File edits the AI applies | Keystroke timing |
| Shell commands (capped output) | Private API keys or credentials |
| Test outcomes | Files outside the problem workspace |
| Workspace diffs at key boundaries | |

### Codex exec mode (high confidence)

When using Codex CLI, choose `codex exec --json` mode at the prompt for the
highest capture fidelity. PrepSavant consumes the full JSONL event stream
(messages, tool_use, tool_result, file_change, command, web_search,
plan_update, reasoning) without requiring hooks. Interactive mode requires
`export CODEX_HOOKS=1` and is limited to medium confidence.

### Troubleshooting AI-Assisted mode

**Tool not found**: ensure the binary is in your PATH and re-run `prepsavant start`.
- Claude Code: [docs.anthropic.com/en/docs/claude-code](https://docs.anthropic.com/en/docs/claude-code)
- Cursor: [cursor.com](https://cursor.com)
- Codex CLI: [github.com/openai/codex](https://github.com/openai/codex)

**Cursor version too old**: Cursor 0.45+ is required for hook support.
Update at [cursor.com](https://cursor.com).

**Stale hooks warning**: the runner crashed without cleaning up. Run
`prepsavant start` again and accept the prompt to remove stale hooks. Or
delete the hook config manually (see hook scope table above).

**Hooks not firing (Cursor)**: ensure you opened Cursor in the same directory
you passed to `prepsavant start`. The hooks are workspace-scoped.

**Codex hooks not firing**: set `CODEX_HOOKS=1` in your environment before
starting Codex interactive mode. Or use `codex exec --json` mode (no hooks required).

**Run AI-Assisted diagnostics**:

```sh
npx -y @prepsavant/mcp doctor --ai-assisted
```

Checks: tool versions, hook config status per tool, snapshot store writability,
stale hook detection, CODEX_HOOKS env var, last 5 session IDs.

## Subcommands

| Subcommand | What it does |
| --- | --- |
| `start` | Start an AI-Assisted capture session (Claude Code GA, Cursor Beta, Codex CLI Beta). |
| `install [--host claude\|cursor\|codex]` | Patch the chosen host's config so it launches `prepsavant mcp` on stdio. |
| `auth` | Run the device-link flow against the Sam API and store the resulting token. |
| `doctor [--ai-assisted]` | Run local environment checks. `--ai-assisted` adds tool version detection, hook config status, and snapshot store diagnostics. |
| `mcp` (default) | Start the MCP server on stdio. Used by your MCP host, not by you directly. |

## Security model

The runner never sees your account password. It authenticates with a
long-lived device token issued by the Sam dashboard. Tokens can be revoked at
any time from `Settings → Local Sam runner devices`.

Pinned test cases are downloaded from the Sam API. Your code is executed
locally in a temp directory with a wall-clock timeout. The runner does **not**
sandbox the network or filesystem beyond Node's defaults — only run code you
wrote.

## Releasing a new version (automated)

`@prepsavant/mcp` is built and published from a dedicated public repo,
[`NorebaseTope/mcp-runner`](https://github.com/NorebaseTope/mcp-runner),
so each tarball can carry an npm Sigstore provenance attestation. (npm
will not verify provenance for tarballs whose source repo is private,
which is why the runner lives outside the rest of the product.)

The runner package itself is still developed in the private PrepSavant
monorepo under `packages/mcp-runner/`. Releases happen in two stages:
first, sync the latest source from the monorepo into the public repo;
second, bump the version in the public repo and let its release workflow
publish.

### Stage 1 — sync source into the public repo

From the private monorepo:

```sh
# Materialise + commit + force-push to the public repo's main branch.
# The default target is `.local/mcp-runner-public/` (gitignored, persistent
# across container restarts so the staged repo's `npm install` is reused
# between sessions). Pass `--target <dir>` to override.
pnpm sync-mcp-runner-public \
  --push \
  --remote https://github.com/NorebaseTope/mcp-runner.git \
  --branch main
```

The sync script copies `packages/mcp-runner/src/**` byte-for-byte and
vendors the workspace dependencies (`@workspace/sam-market-context-shared`,
`@workspace/ai-assisted-events`, `@workspace/mcp-runner-version`) under
`vendor/<name>/`. Workspace imports keep working because the generated
`tsconfig.json` declares `paths` and the generated `build.mjs` declares
matching esbuild aliases. Never edit the public repo by hand; always
re-sync from the monorepo.

There is also a `--check` mode (no `--push`, no writes) that fails if the
target is out of date with the monorepo — used by CI on the private repo.

### Stage 2 — bump and release in the public repo

Two ways to trigger the public repo's `Release @prepsavant/mcp` workflow:

- **Push to `main` that bumps `package.json`** — auto-publish. If the
  version is already on npm the workflow exits cleanly without
  re-publishing, so non-version-bumping syncs are safe.
- **`workflow_dispatch`** — open the workflow in GitHub Actions, either
  fill in `version` with an explicit semver (e.g. `0.4.2`, `0.5.0-rc.0`)
  or leave it blank and pick a `bump` (`patch`, `minor`, `major`,
  `prerelease`). Tick `dry_run` to validate end-to-end without publishing.

Either path runs the same pipeline:

1. *(workflow_dispatch only)* Bumps `package.json` to the requested version.
2. *(push trigger only)* Exits cleanly if the version in `package.json` is
   already on npm.
3. Runs `npm run typecheck`, `npm test`, and `npm run build`.
4. Runs `npm pack --dry-run` so the tarball contents are visible in logs.
5. Generates a CycloneDX SBOM (`prepsavant-mcp-X.Y.Z.cdx.json`) and
   uploads it as a workflow artifact.
6. Runs `npm publish --access public --provenance`, authenticated via the
   `NPM_TOKEN` repo secret. The `--provenance` flag makes npm sign a
   Sigstore attestation tying the tarball to this exact workflow run.
7. *(workflow_dispatch)* Commits the version bump back to `main` and
   pushes a `v<version>` tag. *(push trigger)* Skips the commit and only
   pushes the tag.
8. Creates a matching GitHub Release with the SBOM attached.

If any step fails before `npm publish`, no side effects occur. If
`npm publish` itself fails, the tag is not pushed, so retrying with the
same version after fixing the issue is safe.

### Stage 3 — refresh version constants in the monorepo

After the release lands on npm, run **in the private monorepo**:

```sh
pnpm sync-mcp-runner-version    # reads `npm view @prepsavant/mcp version`
                                # and updates the two AUTO-GENERATED files:
                                #   - lib/mcp-runner-version/src/index.ts
                                #     (MCP_RUNNER_VERSION; powers dashboard
                                #      install snippets)
                                #   - packages/mcp-runner/src/version.ts
                                #     (ADAPTER_VERSION; baked into local
                                #      dev builds)
                                # plus the version field in
                                # packages/mcp-runner/package.json.
```

A CI guardrail (`.github/workflows/mcp-runner-version-sync.yml`) runs
`pnpm sync-mcp-runner-version --check` on every PR that touches the
relevant files and on a daily cron, so the constants don't silently lag
behind npm if no one happens to touch the runner files between releases.

### Required secrets (public repo)

- `NPM_TOKEN` — Classic Automation token for the `@prepsavant` scope, or
  a Granular token with publish access scoped to `@prepsavant/*` and
  `Bypass 2FA` enabled. A token that requires an OTP will fail in CI
  with `EOTP: This operation requires a one-time password`.

The default `GITHUB_TOKEN` is sufficient for pushing the tag and
creating the GitHub Release; no extra PAT is needed.

### Verifying a release

Once the workflow goes green, sanity-check from a clean shell:

```sh
npm view @prepsavant/mcp version             # should report the new version
npx -y @prepsavant/mcp@<new-version> --help  # may take ~5 min the first time
```

Cloudflare negative-caches "package not found" lookups for a few minutes.
A `npm view` 404 immediately after publish does not mean the publish failed —
the workflow logs are the source of truth.

#### Provenance attestation

Every release is signed via [npm provenance](https://docs.npmjs.com/generating-provenance-statements),
which links the published tarball to the GitHub Actions workflow run and
commit that built it. There are two easy ways to verify it:

1. **On the npm website.** Open
   `https://www.npmjs.com/package/@prepsavant/mcp` (or the versioned URL
   `/v/<version>`). Releases produced by this workflow show a green
   **"Provenance"** badge with a link back to the exact `Release @prepsavant/mcp`
   workflow run. If you see the badge, the tarball came from this repo. No
   badge → do not trust the install.

2. **From the command line.** After installing, run:

   ```sh
   npm install @prepsavant/mcp@<version>
   npm audit signatures
   ```

   You should see `verified registry signatures` and
   `verified attestations` for `@prepsavant/mcp`. A failure here means
   either the tarball was tampered with or it predates provenance — install
   a newer version.

   To go further and inspect the attestation directly:

   ```sh
   npm view @prepsavant/mcp@<version> --json | jq '.dist.attestations'
   ```

#### SBOM (CycloneDX)

Each release also has a CycloneDX SBOM
(`prepsavant-mcp-<version>.cdx.json`) attached to the matching GitHub
Release at `https://github.com/NorebaseTope/mcp-runner/releases/tag/v<version>`.
It is also uploaded as a workflow artifact on the `Release @prepsavant/mcp`
run for that version. Enterprise consumers can ingest it directly into
tooling like Dependency-Track, Grype, or Trivy:

```sh
# Vulnerability scan against the SBOM
grype sbom:./prepsavant-mcp-<version>.cdx.json
```

### Local dry-run (without GitHub Actions)

You can verify the runner end-to-end locally without ever calling
`npm publish`:

```sh
# In the private monorepo — full typecheck + tests + build:
pnpm --filter @prepsavant/mcp run typecheck
pnpm --filter @prepsavant/mcp run test
pnpm --filter @prepsavant/mcp run build
( cd packages/mcp-runner && pnpm pack --dry-run )

# To also rehearse the standalone build the public repo will run
# (default target: `.local/mcp-runner-public/`, persistent across restarts).
# Once the staged target has a `node_modules/` (from the first manual
# `npm install` below), subsequent syncs auto-run `npm install` again
# whenever `packages/mcp-runner/package.json` deps change — so the
# cached `node_modules` never silently lags behind the staged sources.
# On a no-op sync (deps unchanged) install is skipped and the cache is
# reused:
pnpm sync-mcp-runner-public
( cd .local/mcp-runner-public \
    && [ -d node_modules ] || npm install \
    && npm run typecheck && npm test && npm run build && npm pack --dry-run )
```

Pass `--skip-install` to `pnpm sync-mcp-runner-public` if you want to
opt out of the auto-install (e.g. offline mode or to inspect the staged
`package.json` before installing). The script will still detect the
drift and print a loud warning so you can run `npm install` yourself
before testing/building.

For an end-to-end publish rehearsal, use the public repo's
`Release @prepsavant/mcp` workflow with `dry_run` ticked — that runs
`npm publish --dry-run` against the same registry credentials a real
release would use, without actually uploading.

### Updating the dashboard install snippets

You don't — and there's nothing to keep in sync. The dashboard always
installs the npm `latest` dist-tag (e.g. `npx -y @prepsavant/mcp install
--host claude`), with no version suffix anywhere a user can copy. What
`latest` points to is controlled entirely by the release workflow: stable
releases are published with `--tag latest`, prereleases with `--tag next`.

`MCP_RUNNER_VERSION` (and `@workspace/mcp-runner-version`) is still the
single source of truth for the *currently shipped* runner version — it
feeds the runner's `--version` output, `doctor` diagnostics, and any "Sam
runner vX.Y.Z detected" UI — but it is no longer used to construct install
commands.
