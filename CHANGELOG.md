# Changelog

All notable changes to `@prepsavant/mcp` are documented here.

## 2.3.0 — Task #1562 (drop `@cursor/sdk` for HTTP-only client; not yet published)

### Changed
- **Dropped `@cursor/sdk` optional dependency entirely.** `CursorSdkAdapter`
  (still named `cursor-sdk` for backward compat with `agent.id` consumers) now
  calls Cursor's cloud-agent HTTPS API directly via `node:fetch` +
  `Authorization: Bearer ${CURSOR_API_KEY}`. The new pure-HTTP client lives in
  `packages/mcp-runner/src/coached/cursor-http-client.ts`; surface contract is
  documented in `packages/mcp-runner/docs/cursor-http-api.md`. Multi-turn
  context still works — we persist the server-side `agentId` returned by
  `POST /v1/agents` and reuse it for subsequent `POST /v1/agents/:id/runs`
  follow-ups, polling `GET /v1/agents/:id/runs/:runId` until
  `status === "FINISHED"`.
- **Default install "just works" on `win32-arm64`.** The dropped `@cursor/sdk`
  pulled in `sqlite3`, whose native binding has no prebuilt binary for
  `win32-arm64` (Snapdragon X / Surface Pro 11) — that was the dominant cause
  of `npm install -g @prepsavant/mcp` failures on those hosts. The runner now
  has **zero native dependencies** on any platform.
- **`prepsavant doctor` no longer emits the win32-arm64 advisory.** The
  `coaching.win32_arm64_sqlite3` check is gone (the underlying breakage was
  the sqlite3 dep we just removed). The `coaching.cursor_sdk` check's label is
  now "Coding agent (Cursor cloud-agent HTTP API)" and detail explains the
  401/403→CLI fallback contract.
- **`CursorAgentAdapter` CLI fallback unchanged.** The no-API-key path
  (`cursor-agent login` / `cursor agent login`) is preserved bit-for-bit so
  users without `CURSOR_API_KEY` get identical behaviour to 2.2.x.
- **`CodingAgentAdapter` interface unchanged.** Existing consumers
  (`cli-start.ts`, `startup-banner.ts`, terminal-coach renderer) compile and
  run without churn — `agent.id === "cursor-sdk"`, `dispose?()`,
  `_didFallBackToCli()` test seam, and the `cliFallback` constructor option
  all behave identically. The only adapter constructor change: the
  `sdkLoaderForTests` injection seam was replaced with `fetchImplForTests`
  (the only call sites are the in-repo tests).

### Bundle size
- Pre-2.3 unpacked install: ~5.5 MB `@cursor/sdk` + sqlite3 native build
  (~10 MB on platforms that *do* prebuild, infinite on platforms that don't).
- 2.3.0 unpacked install: zero additional bytes beyond the runner bundle —
  `node:fetch` is built into Node 18+.

### Floor
- `MIN_SUPPORTED_RUNNER_VERSION` unchanged at `2.0.0`. The floor bump to
  2.3.0 is held for a follow-up task that lands AFTER `@prepsavant/mcp@2.3.0`
  publishes to npm (so we don't 426 every host before the new tarball is
  installable). See `replit.md` gotcha "`426 runner_upgrade_required` after a
  floor rollback needs a redeploy, NOT a new npm publish" for the operational
  contract.

### Not published
- This version has NOT been published to npm yet. Cut the release from the
  public `NorebaseTope/mcp-runner` repo (see `README.md` §"Releasing a new
  version") when ready, then re-run `pnpm sync-mcp-runner-version` to sync.
## 2.2.5 — Task #1561 (Hint & cadence polish; not yet published to npm)

### Added
- **Substantive first-hint path.** When the candidate types `/hint`
  (or any free-form utterance) before there's any code activity —
  no diff captured, no edited files since the watcher started, no
  submitted attempts, empty conversation memory — the runner now
  composes a dedicated "orient the candidate" prompt that restates
  the question in plain English and asks ONE targeted orienting
  question. The prompt carries a hard "do NOT solve anything, do NOT
  hint at an algorithm or data structure, do NOT write code"
  constraint so an over-eager model can't blow the first hint. Once
  any activity appears, the regular hint-ladder path takes back over.
  See `src/coached/intro-hint.ts`.
- **Broadened stall-nudge template pool.** `STALL_PROBE_LINES`
  (~6 lines) was producing visible repeats within 90s on idle
  sessions (`ses_3tofurxbf1`). The new `stall-nudge-pool.ts` ships
  ~20 distinct lines per cadence stage (`early_stall`, `mid_stall`,
  `late_stall`, `hint_offer`), with a ring-buffer recency tracker
  in the cadence sink so the picker avoids recently-emitted lines
  even after the dedupe window expires. Voice constraint: every
  line is measured/curious, no emoji, no markdown, no code.
- **Session-end summary of saved SDK calls.** `cli-start` now logs a
  one-line summary at session end with the count of empty-tick SDK
  calls that the skip heuristic avoided.

### Changed
- **Text-based emit dedupe.** `emitDedupeKey` previously mixed
  directive kind + hint metadata into the key, which let three
  different directives that happened to fall back to the same
  templated wording slip past the 4-second guard and emit 3x in
  ~90s. The key is now derived from the normalized text alone, so
  ANY exact-text repeat collapses regardless of which directive
  produced it. The 4-second `DEDUPE_WINDOW_MS` is unchanged.
- **Skip SDK on empty-content cadence ticks.** When a `stall_nudge`
  tick fires with no new diff, no new failing test, and no new user
  utterance since the previous tick, the cadence sink now skips the
  `agent.ask()` round-trip entirely and rewrites the directive into
  `verbatim_relay` mode with a fresh line picked from the broadened
  pool. Saves ~1-3s of latency per pure-idle tick and a non-trivial
  slice of Cursor API quota over a 30-minute session.

### Notes
- `MIN_SUPPORTED_RUNNER_VERSION` is **NOT** raised in this release.
  All changes are runner-internal voice/cadence polish; 2.2.5 is a
  drop-in upgrade for any host already on the ≥2.0.0 floor.

## 2.2.4 — Task #1560 (P0 runner fixes; not yet published to npm)

### Fixed
- **CursorSdkAdapter reply parsing.** The persistent-Agent `ask()` path
  used to check `status === "completed" || "success"` and read
  `result.result`, but the real `@cursor/sdk@1.0.13` surface uses
  `status === "finished"` and streams assistant text via
  `SendOptions.onStep` callbacks as `ConversationStep` objects of type
  `"assistantMessage"` (text in `.message.text`). The bug made every
  host-reasoning tick return an empty Sam line, so the renderer's
  generic "Let's pause and talk through where you are." fallback shipped
  on every coached cadence beat for users with `CURSOR_API_KEY` set.
  We now collect assistant-message text via `onStep`, gate on
  `status === "finished"`, and fall back to `result.result` only when
  no steps fired (defensive against future SDK revisions). A
  `PREPSAVANT_DEBUG_CODING_AGENT=1` env var enables a one-line stderr
  trace per `ask()` for triage.
- **Input-row stomp on status emit.** `handleUserUtterance` emits
  `"Sam is thinking…"` immediately after the user presses Enter; the
  status renderer now routes through `scrollIntoTranscript`, which
  calls the `refreshInput()` hook after writing so the readline
  buffer repaints cleanly. Confirmed via regression test that mirrors
  the Task #1505 wiring for Sam lines.

### Added
- **`prepsavant doctor` advisory on Windows ARM64.** `sqlite3` (the
  only native dep of `@cursor/sdk`) has no prebuilt binary for
  win32-arm64, so the persistent-Agent import silently fails and the
  runner falls back to the `cursor-agent` CLI shell-out (losing
  multi-turn context). The new `coaching.win32_arm64_sqlite3` check
  surfaces this as a `warn` with concrete remediation (install MSVC
  build tools, or switch to an x64 shell) before the user's first
  coached session.

### Floor
- `MIN_SUPPORTED_RUNNER_VERSION` unchanged at `2.0.0`. These fixes are
  additive runtime behaviour; older runners continue to work.

### Not published
- This version has NOT been published to npm yet. Cut the release from
  the public `NorebaseTope/mcp-runner` repo (see `README.md`
  §"Releasing a new version") when ready, then re-run
  `pnpm sync-mcp-runner-version` to sync.
