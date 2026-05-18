# @prepsavant/mcp

> **The Sam coach that lives inside your code editor.**
> Currently shipping: **v2.3.0**.

---

## What is this? (in plain English)

Imagine you have a really patient coach named **Sam** who helps people
practice for job interviews. Most coaches live in a website — you open a
browser tab, sit there, and practice. That's fine, but most engineers
spend their whole day in their **code editor** (the app where they write
code), not in a browser.

This little program plugs Sam straight into your code editor. So instead
of switching to a website to practice, Sam shows up *right where you
already work*. You can ask for a question, write your answer in the
editor, and Sam quietly times you, gives hints when you're stuck, and
warns you when you're running out of time — all without you ever
leaving the editor.

It works in three popular editors:

- **Cursor** ([cursor.com](https://cursor.com))
- **Claude Desktop** (from Anthropic)
- **Codex CLI** (from OpenAI)

There are two modes:

1. **Coached mode** — Sam picks a practice question, sits next to you
   while you solve it, and gives you a recap at the end (like a tennis
   coach watching you hit balls).
2. **AI-Assisted mode** — you solve a real problem using your AI
   coding tool like normal. Sam just *quietly takes notes* in the
   background so you can look back later and see how you did. Sam
   doesn't interrupt and doesn't change anything you do.

You also need a Sam account ([the dashboard website](https://prepsavant.com)
is where you sign up and see your history). This program connects to that
account using a one-time login, then remembers it on your laptop so you
don't have to sign in again.

That's it. The rest of this README is reference material for engineers
who want to know exactly how it works under the hood.

---

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

Once the runner is registered, the `coached_*` MCP tools (e.g.
`coached_start_session`, `coached_ask`, `coached_check_in`,
`coached_end_session`) start a **Coached** session right inside your host —
same question brief, hint ladder, scored attempts, and recap as the browser.
Sam's voice is supplied via MCP sampling so your host model speaks as Sam.
AI-Assisted observation is a separate flow documented further below.

### Coached tool family

- `coached_orient` — pick up where the candidate left off; surfaces a
  per-mode `nextTool` slug telling the host which tool to call next.
- `coached_pick_question` — search the question bank. **Filters: `topic`
  AND `company`.** Pass `company` as a company id, slug, or
  case-insensitive display name (e.g. `"Anthropic"`).
- `coached_list_companies` — discover which companies have questions
  attached, sorted by question count desc. Use this *before*
  `coached_pick_question` when the candidate names a target firm.
- `coached_start_session`, `coached_ask`, `coached_check_in`,
  `coached_end_session` — Coached session loop.

### AI-Assisted tool family

These tools are intentionally separate from `coached_*` — the host MUST
write code, run shells, and edit files in AI-Assisted mode. The
`ai_assisted_start_session` description includes an explicit "DO NOT
refuse to write code" instruction so hosts don't fall back to a Coached
"no code" posture.

- `ai_assisted_start_session` — issues an ephemeral Ed25519 keypair,
  registers a capability manifest with the server, returns host
  instructions.
- `ai_assisted_log_event` — append a signed event (prompt, response,
  edit, shell, tool call, permission decision, etc.) to the evidence
  log; uploads best-effort.
- `ai_assisted_snapshot` — record a point-in-time workspace snapshot
  reference.
- `ai_assisted_end_session` — finalize the bundle, returning the
  capability manifest hash, log hash, and event count.

> **Migrating from `practice_*` (≤ 0.4.x)?** The legacy `practice_*` aliases
> were removed in 0.5.0. Replace `practice_list_questions` →
> `coached_pick_question`, `practice_start_session` → `coached_start_session`,
> `practice_request_hint` → `coached_ask`, `practice_check_in` →
> `coached_check_in`, `practice_end_session` → `coached_end_session`.
> `practice_submit_attempt` has no replacement — Coached sessions submit code
> via the host editor's native run/test tools.

## Two surfaces, one Coached experience

Coached isn't browser-only. Once the runner is installed, the same Coached
loop is available in two surfaces:

- **Browser** — go to your Sam dashboard and start a Coached session, no
  install required.
- **IDE** — call the `coached_*` tools from Cursor, Claude Desktop, or Codex
  and Sam runs the same Coached loop in your host.

These are two surfaces on the **same** Coached experience: same job briefs,
same question banks, same hint ladder, same scoring. The only difference is
*where* you practice. AI-Assisted mode (covered below) is a separate,
silent-capture flow — not a third Coached surface.

## Coached cadence: who owns the timer (1.5.0+)

Starting in `@prepsavant/mcp@1.5.0` (Task #1169 / Cursor-first M4) the
Coached cadence loop is **runner-owned**. The runner is the system of
record for time warnings, stall nudges, and hint-ladder escalations —
the api-server is no longer in the timing critical path.

How a directive reaches the user:

1. Per-session `CadenceDriver`
   (`src/coached/cadence-loop.ts`, ticking every `CADENCE_TICK_MS = 15s`)
   classifies the candidate's stuck shape against the same
   `STUCK_SHAPES` / `LADDER_RUNGS` / `nextRung` table the api-server
   used to drive the check-in flow (ported byte-for-byte in
   `src/coached/stuck-shape.ts`) and emits a `CadenceDirective`.
2. The directive is pushed out-of-band to the host via an
   **MCP server-initiated `notifications/message`** with
   `logger: "coached_cadence"` on the standard MCP logging channel.
   Hosts that surface MCP logs in their chat
   transcript (Cursor, Claude Desktop) render Sam's nudge without the
   host ever calling a tool.
3. The same directive — stamped with a stable `directiveId` — is
   ALSO mirrored onto a per-session `pendingDirectives` queue so a
   host that does NOT surface MCP notifications still sees every
   nudge on its next acknowledgement call.

### Why MCP `notifications/message` and not a custom JSON-RPC method

- **It already works in every host.** `notifications/message` is part
  of the base MCP logging spec, so Cursor, Claude Desktop, and Codex
  surface it today with no plugin work and no host-vendor coordination.
  A custom method (`prepsavant/cadence` etc.) would land as silent dead
  weight in every host that hadn't shipped explicit support.
- **It's a standard MCP logging channel**, so the host's surface area
  for "Sam is talking" is unified — one logger namespace (`coached_*`),
  one rendering path, one place for hosts to filter or theme.
- **It's truly out-of-band.** Server-initiated notifications don't
  consume the host's tool-call budget and don't show up in the
  candidate's tool-call audit trail, which is the whole point of
  decoupling cadence from host compliance.
- **It's resilient by construction.** The push is best-effort and the
  mirrored queue is the durable backstop: if the notification fails
  mid-shutdown or the host transport is mid-reconnect, the directive
  still reaches the user the next time the demoted `coached_check_in`
  drainer is called.

### Demoted `coached_check_in` (queue drainer)

`coached_check_in` no longer authors a directive on each call.
It accepts the same input shape (so pre-1.5.0 hosts don't see a
schema validation error) plus an optional
`acknowledgedDirectiveIds: string[]` listing the `directiveId` values
the host has already relayed via the notifications path. The drainer
drops those IDs BEFORE returning the rest, so a host that subscribes
to BOTH the notifications channel AND the tool drainer never relays
the same directive twice.

### End-of-session recap draft

On `coached_end_session` the runner posts an additive `recapDraft`
body to the existing `POST /runner/sessions/:id/end` endpoint — the
file-edit timeline, AI-assist beats, hint usage, and stall +
time-warning fires the runner observed locally. The api-server logs
the draft (`runner_recap_draft_received`) until M5 wires it into the
post-mortem surface; the body is schema-additive, so older runners
that POST nothing continue to work.

The full design rationale and the milestone scope live in
[`docs/cursor-first-v1.md`](../../docs/cursor-first-v1.md) §4.

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

## Releasing a new version (manual, from your laptop)

`@prepsavant/mcp` is published to npm **manually from the operator's
laptop**, as of task #834. There is no CI publish, no public mirror
repo, and no Sigstore provenance attestation — the package is published
"uncertified", which is fine for this project's threat model. The
monorepo lives only in the Replit workspace.

### Pre-flight (one-time, on your laptop)

1. Install Node ≥ 18.18 and pnpm.
2. Log in to npm with an account that has publish rights to the
   `@prepsavant` scope:
   ```sh
   npm login        # opens a browser for OTP
   npm whoami       # confirms you're authenticated
   ```
3. Make sure your npm 2FA is set to "Authorization and writes" (so
   `npm publish` will prompt for an OTP at publish time — this is the
   only thing standing between a stolen npm session and a poisoned
   release).

### Releasing

> **Order matters (Task #1214).** The `mcp-runner-floor-vs-npm` merge gate
> rejects any PR whose `MIN_SUPPORTED_RUNNER_VERSION` is greater than the
> version currently tagged `latest` on npm for `@prepsavant/mcp`. The
> local `pnpm sync-mcp-runner-version` script enforces the same rule, so
> the regression is caught before the PR is even opened. **Always publish
> first, THEN bump the floor** — never the other way around. The worked
> sequence below is built around that ordering.
>
> Worked example (releasing 1.9.0 in lockstep with a server-side floor bump):
> 1. From your laptop: bump `packages/mcp-runner/package.json` → 1.9.0,
>    `pnpm --filter @prepsavant/mcp run build`, `npm publish` (OTP).
> 2. Verify: `npm view @prepsavant/mcp dist-tags.latest` reports `1.9.0`.
> 3. Only NOW, back in the Replit workspace, edit
>    `MIN_SUPPORTED_RUNNER_VERSION` in
>    `scripts/src/sync-mcp-runner-version.ts` to `1.9.0` and run
>    `pnpm sync-mcp-runner-version`. The script will re-verify against
>    npm `latest`, regenerate `lib/mcp-runner-version/src/index.ts`, and
>    write the runner `package.json` version.
> 4. Open the PR. The `mcp-runner-floor-vs-npm` CI workflow re-runs the
>    same check on every push and is a required merge gate alongside
>    `api-test` and `mcp-runner-version-bump`.
>
> If you skip step 1 and try to land step 3 first, both the local sync
> and the CI workflow will fail with a message naming both versions and
> linking back to this section. That's the guard working as intended —
> publish first, then bump.

From your laptop, in a fresh checkout of the monorepo:

```sh
# 1. Get the current code from Replit. Easiest: download the workspace
#    as a zip from Replit (Tools → "Download as zip"), unzip, and cd in.
#    Or use any other transport you've set up — there is no GitHub remote
#    by design.
cd path/to/prepsavant-monorepo

# 2. Install deps (uses pnpm-workspace.yaml + pnpm-lock.yaml).
pnpm install --frozen-lockfile

# 3. Bump the version. Pick one (semver):
#      patch (0.6.0 → 0.6.1) — bug fix, no API change
#      minor (0.6.0 → 0.7.0) — additive change, backwards-compatible
#      major (0.13.0 → 1.0.0) — breaking change
( cd packages/mcp-runner && npm version patch --no-git-tag-version )
# (or edit `version` in packages/mcp-runner/package.json by hand)
#
# Recent breaking releases:
#   1.3.0 (Task #1163) — Coached post-mortem reads `question.reviewKind`
#     off the session payload and swaps the hardcoded "hidden tests"
#     wording for rubric-aware copy on chat-reviewed sessions when the
#     question is graded by rubric. `MIN_SUPPORTED_RUNNER_VERSION` was
#     raised to 1.3.0 in lock-step so older runners — which would still
#     emit "no hidden tests ran" on a rubric question — get a 426
#     `runner_upgrade_required` and prompt the upgrade. See
#     `docs/runbooks/task-1163-rubric-post-mortem-cutover.md`.
#   1.0.0 (Task #1113, Phase 3c + Task #1119) — RETIRED `coached_check_in`
#     and `ai_assisted_check_in` MCP tools and their HTTP endpoints
#     (`POST /runner/sessions/:id/check-in` and
#     `POST /runner/ai-sessions/:id/check-in`). Hosts must drive both
#     coached and AI-Assisted sessions via their split-loop pairs
#     (`*_get_context` read + `*_record_turn` / `*_record_feedback`
#     write). The IDE-rules installer now fetches BOTH the active
#     coached and AI-Assisted standing frames from the API at install
#     time (each via `?kind=` namespace) and falls back to per-kind
#     local caches (`~/.prepsavant/standing-frame.json` and
#     `~/.prepsavant/standing-frame-ai-assisted.json`) when offline.

# 4. Run the local validation suite. Catches the common breakages
#    BEFORE publishing — the version-bump guard is the same one that
#    runs as a Replit workflow on every commit.
pnpm --filter @workspace/scripts run check-mcp-runner-version-bump
pnpm --filter @prepsavant/mcp run typecheck
pnpm --filter @prepsavant/mcp run test
pnpm --filter @prepsavant/mcp run build

# 5. Inspect what will actually be in the tarball — sanity check before
#    uploading it to a public registry.
( cd packages/mcp-runner && npm pack --dry-run )

# 6. Publish. npm will prompt for your 2FA OTP.
( cd packages/mcp-runner && npm publish --access public )
```

### Post-publish (back in the Replit workspace)

```sh
# 1. Refresh the in-repo version constants so the dashboard install
#    snippets, the runner adapter, and the version-bump guard all
#    agree with what's now on npm. This script reads
#    `npm view @prepsavant/mcp version` and writes:
#      - lib/mcp-runner-version/src/index.ts (MCP_RUNNER_VERSION)
#      - packages/mcp-runner/src/version.ts  (ADAPTER_VERSION)
#      - packages/mcp-runner/package.json    (version field)
pnpm sync-mcp-runner-version

# 2. Commit the regenerated constants. The Replit auto-checkpoint will
#    capture this; no push step is needed since there's no GitHub remote.
git add lib/mcp-runner-version packages/mcp-runner
git commit -m "chore(mcp-runner): sync version constants to <new-version>"
```

### Verifying the release

```sh
npm view @prepsavant/mcp version             # should report the new version
npx -y @prepsavant/mcp@<new-version> --help  # smoke the install path
```

Cloudflare negative-caches "package not found" for a few minutes after
publish — a 404 from `npm view` immediately after `npm publish` does
not mean the publish failed, just wait 1–2 min and retry.

### Pre-merge guard: version bump on runner-code changes

`scripts/src/check-mcp-runner-version-bump.ts` (registered as the
`mcp-runner-version-bump` Replit workflow) fails when a commit changes
runner-published code without also bumping
`packages/mcp-runner/package.json` `version`. This catches the case
where you forget to bump the version before publishing — the validator
will block the merge until you fix it.

Release-relevant changes are: `packages/mcp-runner/src/**`
(excluding tests), `build.mjs`, `README.md`, `LICENSE`, the vendored
libs (`lib/sam-market-context-shared/src/**`,
`lib/ai-assisted-events/src/**`), and any non-`version` field in the
runner `package.json`.

**Escape hatch:** if a runner-code change genuinely doesn't need a
publish (a comment-only fix, a pure rename, a refactor with no
behavioural delta), add a `Skip-Mcp-Runner-Bump: <reason>` trailer to
the commit:

```
fix(runner): rename internal helper for clarity

Skip-Mcp-Runner-Bump: pure rename, no shipped behavioural change
```

The reason is required (empty trailer doesn't pass) and is logged for
auditability.

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
