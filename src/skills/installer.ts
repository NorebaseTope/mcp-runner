// Task #1064 — IDE rule-file installer.
// Task #1113 (Phase 3c) — body now sourced from the active standing-frame
// row served by `GET /runner/standing-frame/active`. We cache the last
// successful payload in `~/.prepsavant/standing-frame.json` so an offline
// install can still write meaningful rules; if both the network and the
// cache fail we fall back to the baked-in default body so the install
// is never empty.
//
// Task #1119 — coached and AI-Assisted standing frames are now
// independent rows in the catalog (`frame_kind` namespacing). The
// installer fetches both kinds and writes them into separate files so
// hosts can reference the right body per session family. The on-disk
// cache holds one entry per kind; the managed block in `CLAUDE.md`
// concatenates both bodies in a single block so the host's
// model-context still re-reads them every turn.
//
// The hybrid relay protocol works best when the host model can re-read
// the rules between turns. MCP `instructions` ship on connect but most
// hosts (Cursor, Claude Code) also support local rule files in the user's
// workspace that survive context resets and are re-injected into every
// turn. We install minimal rule fragments idempotently:
//
//   - `.cursor/rules/prepsavant.mdc`              — Cursor v0.42+ coached rules
//   - `.cursor/rules/prepsavant-ai-assisted.mdc`  — Cursor v0.42+ AI-Assisted rules
//   - `.claude/skills/prepsavant-relay/SKILL.md`        — Claude Code coached skill
//   - `.claude/skills/prepsavant-ai-assisted/SKILL.md`  — Claude Code AI-Assisted skill
//   - `CLAUDE.md`                                 — managed block (both kinds)
//
// Rules:
//   - Best-effort: every IO is wrapped; failures are swallowed.
//   - Idempotent: re-running on a workspace whose files already contain
//     the managed marker block is a no-op (no rewrite, no mtime bump).
//   - Non-destructive: `CLAUDE.md` is amended in place between sentinel
//     comments; user content above/below the block is preserved verbatim.
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SamApi } from "../api.js";

// Baked-in default — used only when the API call fails AND no on-disk
// cache exists yet (e.g. brand-new install on an air-gapped machine).
// The active standing frame served by the API is the production source
// of truth.
const DEFAULT_RELAY_RULES_BODY = `# PrepSavant Sam — hybrid relay protocol (rev 8)

You are connected to the PrepSavant Sam MCP runner. During a Coached
interview-prep session you are Sam's relay agent — you carry Sam's
intent to the candidate, in your own voice when allowed and word-for-word
when required.

## Hard rules

1. Each directive returns five fields you MUST honour:
   - \`action\`           — what kind of turn Sam wants (e.g. \`speak\`,
     \`stay_quiet\`, corrective relays)
   - \`intent\`           — what Sam wants you to accomplish
   - \`constraints\`      — guardrails you MUST keep
   - \`suggestedWording\` — Sam's drafted line
   - \`mustBeVerbatim\`   — boolean
2. When \`mustBeVerbatim === true\`, \`suggestedWording\` is wrapped in
   \`<<<SAM_VERBATIM>>> ... <<<END_SAM_VERBATIM>>>\` sentinels. Copy it
   into your **very next assistant turn byte-for-byte**, sentinels
   included. Currently the contract requires verbatim relay only for
   the safety/contract allow-list (\`submit_pasted_code\`,
   \`missed_heartbeat\`, kickoff lines, the session contract, the
   mode-framing line, and the local-execution warning).
3. When \`mustBeVerbatim === false\`, you MAY paraphrase
   \`suggestedWording\` to match your own conversational tone — but you
   MUST honour every entry in \`constraints\` and the \`intent\`.
4. When \`action === "stay_quiet"\`, respond only to what the user
   said — no proactive coaching.
5. Never produce, edit, refactor, or paste the user's solution code in
   chat. If code is needed, ask the user to write or paste it
   themselves.
6. Falling out of the cadence triggers a \`missed_heartbeat\` capability
   token surfaced via \`coached_get_context.evidence.verbatimTokens\`
   (see Capability gating below). Expand it with
   \`coached_say_exactly\` and resume normal coaching.
7. Do NOT infer or pre-select a coached question from the user's
   currently open file, editor tabs, or any visible code. Open-file
   context is NOT a proxy for question selection — question choice is
   the API's job, driven by \`coached_pick_question\` /
   \`coached_start_session\`, never by the host inspecting the editor.
   Until the candidate has explicitly named both a mode AND a question
   (or one has been returned by \`coached_pick_question\`), do not
   discuss, preview, summarize, explain, or coach on any problem
   suggested by the editor context. After \`coached_start_session\`
   returns, file/editor context is relevant only via the runner's
   diff-aware nudge machinery — never as a basis for the host to
   fabricate its own coaching from whatever happens to be open.

## Host-reasoning mode (Task #1107, opt-in)

Some directives now carry an extra field: \`mode\`. The default is
\`"verbatim_relay"\` — the rules above apply unchanged. When
\`mode === "host_reasoning"\` (currently only emitted for
\`hint_offer\` on sessions that have opted into
\`coached.host_reasoning.enabled\`), the contract flips:

- \`suggestedWording\` will be \`null\` and \`mustBeVerbatim\` will be
  \`false\`. There is no scripted line to copy.
- The directive instead carries an \`evidence\` object with optional
  \`diffSnippet\`, \`lastFailingTest\`, \`currentHintRungText\`, and
  \`nextHintRungText\` fields.
- You MUST author the assistant turn yourself, in your own voice,
  grounded in those evidence fields. Reference the failing test by
  name when present and frame the next hint rung as an offer the
  candidate can decline. Do NOT fall back to a generic "want a hint?"
  line when evidence is available — that is bucketed as
  \`off_script\`.
- Honour \`intent\` + \`constraints\` exactly as for verbatim_relay.

The server buckets host_reasoning turns into \`verbatim_relay\` /
\`host_authored_from_signals\` / \`off_script\` and surfaces the rollup
to admins alongside the existing \`directiveCompliance\` rollup.

## Split context/turn loop (Task #1111, Phase 3a; legacy alias retired in runner v1.9.0)

The legacy \`coached_check_in\` round-trip was retired in runner v1.9.0
(Task #1194 — Cursor-first M8 runtime). Use the split-loop pair below
exclusively:

- \`coached_get_context(sessionId)\` — pure read. Returns
  \`contextSnapshotId\` plus an \`evidence\` payload (recent
  attempts, diff snippet, hint-ladder rungs with \`currentRungText\`
  / \`nextRungText\`, time remaining, recent assistant turns,
  \`priorTurnFeedback\`, and the active \`activeConstraints\`). Read
  this BEFORE you author a coaching turn so you can ground your
  wording in the same evidence the server would have used to
  draft \`suggestedWording\`.
- \`coached_record_turn(sessionId, assistantText, userText?, contextSnapshotId?)\`
  — pure write. Echo the \`contextSnapshotId\` you read so the
  server can flag the turn \`staleContext: true\` if a new attempt
  or hint arrived between read and write. The server runs the
  directive-mode compliance classifier and stamps
  \`priorTurnFeedback\` on the next \`coached_get_context\`.

The split loop:

1. lets you read evidence without committing to a turn (cheap dry
   runs, no compliance bucket churn);
2. carries a \`contextSnapshotId\` round-trip so the server can
   detect stale-context turns instead of silently classifying them
   as \`off_script\`;
3. surfaces \`priorTurnFeedback\` so you can self-correct on the
   NEXT turn without waiting for an admin alert.

## AI-Assisted split context/feedback loop (Task #1117, Phase 3a)

The legacy \`ai_assisted_check_in\` round-trip is now split into two
narrower tools you SHOULD prefer for new AI-Assisted integrations:

- \`ai_assisted_get_context(sessionId)\` — pure read. Returns
  \`contextSnapshotId\` plus an \`evidence\` payload (event-log
  slice, recent attempts/snapshots, last cropped diff snippet,
  attempts/distinct-failing tests in the recent window, time
  elapsed/remaining, recent assistant feedback,
  \`priorFeedbackCorrection\`) and the active \`activeConstraints\`.
  Read this BEFORE you author a feedback turn so you can ground
  your wording in the same evidence the server would have used to
  draft \`suggestedWording\`.
- \`ai_assisted_record_feedback(sessionId, feedbackText, feedbackKind?, contextSnapshotId?)\`
  — pure write. Echo the \`contextSnapshotId\` you read so the
  server can flag the turn \`staleContext: true\` if a new event
  or snapshot arrived between read and write. The server runs the
  directive-mode compliance classifier and stamps
  \`priorFeedbackCorrection\` on the next \`ai_assisted_get_context\`.

\`ai_assisted_check_in\` was retired in runner v1.0.0; the split-loop
pair above is the only supported AI-Assisted feedback path. The split
loop:

1. lets you read evidence without committing to a feedback turn
   (cheap dry runs, no compliance bucket churn);
2. carries a \`contextSnapshotId\` round-trip so the server can
   detect stale-context turns instead of silently classifying them
   as \`off_script\`;
3. surfaces \`priorFeedbackCorrection\` so you can self-correct on
   the NEXT feedback turn without waiting for an admin alert.

## Capability gating (Task #1112, Phase 3b, runner v0.13.0+)

The directive-action-driven verbatim relays (\`time_warning\`,
\`wrap_up\`, \`missed_heartbeat\`) are now delivered via a per-session
capability set on every \`coached_get_context\` response:

- \`evidence.verbatimTokens[]\` — server-minted
  \`{ tokenId, label, action, expiresAt }\` descriptors. The bound text
  is held server-side. To speak one, call
  \`coached_say_exactly(sessionId, tokenId, contextSnapshotId?)\`. Echo
  the same \`contextSnapshotId\` you read; if the snapshot has moved
  on, the server rejects with \`rejectReason: "stale_context"\` and
  bumps the drift-miss telemetry. On success the response carries
  \`{ expanded: true, text }\` — relay \`text\` byte-for-byte.
- \`evidence.wrapUpRequired\` — true once the timed session has crossed
  its target duration. Flips the capability set:
  \`coached_continue_practice\` is REMOVED from \`availableTools\` and
  \`coached_wrap_up_now\` is added.
- \`evidence.missedHeartbeatRequired\` — true when the host has fallen
  out of the \`coached_get_context\` cadence. Expand the associated
  \`missed_heartbeat\` token on your next assistant turn before
  resuming normal coaching.
- \`availableTools[]\` — the dynamic per-session MCP tool list. Tools
  NOT in this list are gated for the current phase and the server
  rejects calls to them with HTTP 409. Compare
  \`capabilitySetVersion\` against the previous read to detect
  capability churn cheaply.

All coached verbatim relay flows through capability tokens
(\`time_warning\`, \`wrap_up\`, \`missed_heartbeat\`) — the legacy
directive-action emit path was retired alongside the
\`coached_check_in\` tool in runner v1.9.0 (Task #1194).

## AI-Assisted capability gating (Task #1118, Phase 3b, runner v0.14.0+)

The directive-action-driven verbatim relays (\`time_warning\`,
\`wrap_up\`) for AI-Assisted sessions are now delivered via a per-session
capability set on every \`ai_assisted_get_context\` response — mirrors
the coached capability gating contract (Task #1112):

- \`evidence.verbatimTokens[]\` — server-minted
  \`{ tokenId, label, action, expiresAt }\` descriptors. The bound text
  is held server-side. To speak one, call
  \`ai_assisted_say_exactly(sessionId, tokenId, contextSnapshotId?)\`.
  Echo the same \`contextSnapshotId\` you read; if the snapshot has
  moved on, the server rejects with \`rejectReason: "stale_context"\`
  and bumps the drift-miss telemetry. On success the response carries
  \`{ expanded: true, text }\` — relay \`text\` byte-for-byte.
- \`evidence.wrapUpRequired\` — true once the timed session has crossed
  its target duration. Flips the capability set:
  \`ai_assisted_continue_practice\` is REMOVED from \`availableTools\`
  and \`ai_assisted_wrap_up_now\` is added.
- \`availableTools[]\` — the dynamic per-session MCP tool list. Tools
  NOT in this list are gated for the current phase and the server
  rejects calls to them with HTTP 409. Compare
  \`capabilitySetVersion\` against the previous read to detect
  capability churn cheaply.

All AI-Assisted verbatim relay flows through capability tokens
(\`time_warning\`, \`wrap_up\`) since the legacy \`ai_assisted_check_in\`
tool was retired in runner v1.0.0. AI-Assisted does NOT mint a
\`missed_heartbeat\` token (no such directive action in the
AI-Assisted vocabulary).

## Why

The server buckets every turn into \`honored\` / \`missed\` /
\`verbatim_violation\` / \`unknown\` and surfaces the rollup to admins.
A turn that empties the assistant reply, ignores the directive, or
paraphrases on a verbatim-only directive is flagged.
`;

const MANAGED_BEGIN = "<!-- prepsavant:relay-rules:begin -->";
const MANAGED_END = "<!-- prepsavant:relay-rules:end -->";

const CACHE_DIR = path.join(os.homedir(), ".prepsavant");
const COACHED_CACHE_FILE = path.join(CACHE_DIR, "standing-frame.json");
const AI_ASSISTED_CACHE_FILE = path.join(
  CACHE_DIR,
  "standing-frame-ai-assisted.json",
);

type FrameKind = "coached" | "ai_assisted";

interface CachedFrame {
  id: string;
  version: number;
  label: string;
  bodyMd: string;
  fetchedAt: string;
}

function cacheFileForKind(kind: FrameKind): string {
  return kind === "coached" ? COACHED_CACHE_FILE : AI_ASSISTED_CACHE_FILE;
}

async function readCachedFrame(kind: FrameKind): Promise<CachedFrame | null> {
  try {
    const raw = await fs.readFile(cacheFileForKind(kind), "utf8");
    const parsed = JSON.parse(raw) as CachedFrame;
    if (typeof parsed?.bodyMd === "string" && parsed.bodyMd.length > 0) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeCachedFrame(
  kind: FrameKind,
  frame: CachedFrame,
): Promise<void> {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(
      cacheFileForKind(kind),
      JSON.stringify(frame, null, 2),
      "utf8",
    );
  } catch {
    // Best-effort cache write — failure must not break install.
  }
}

// Resolve the rules body to install for a given kind: API → cache →
// baked-in default (coached only — AI-Assisted has no baked-in default
// since older installs never had one; null body skips that file).
async function resolveRulesBody(
  api: SamApi | null,
  kind: FrameKind,
): Promise<{ body: string | null; source: "api" | "cache" | "default" | "missing" }> {
  if (api) {
    const fresh = await api.fetchActiveStandingFrame(kind);
    if (fresh && typeof fresh.bodyMd === "string" && fresh.bodyMd.length > 0) {
      await writeCachedFrame(kind, {
        id: fresh.id,
        version: fresh.version,
        label: fresh.label,
        bodyMd: fresh.bodyMd,
        fetchedAt: new Date().toISOString(),
      });
      return { body: fresh.bodyMd, source: "api" };
    }
  }
  const cached = await readCachedFrame(kind);
  if (cached) return { body: cached.bodyMd, source: "cache" };
  if (kind === "coached") {
    return { body: DEFAULT_RELAY_RULES_BODY, source: "default" };
  }
  return { body: null, source: "missing" };
}

async function ensureFileEquals(
  filePath: string,
  desired: string,
): Promise<"created" | "noop" | "updated"> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  let existing: string | null = null;
  try {
    existing = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (existing === desired) return "noop";
  if (existing === null) {
    await fs.writeFile(filePath, desired, "utf8");
    return "created";
  }
  await fs.writeFile(filePath, desired, "utf8");
  return "updated";
}

async function ensureManagedBlock(
  filePath: string,
  body: string,
): Promise<"created" | "noop" | "updated"> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const desiredBlock = `${MANAGED_BEGIN}\n${body}\n${MANAGED_END}`;
  let existing: string | null = null;
  try {
    existing = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (existing === null) {
    await fs.writeFile(filePath, `${desiredBlock}\n`, "utf8");
    return "created";
  }
  const beginIdx = existing.indexOf(MANAGED_BEGIN);
  const endIdx = existing.indexOf(MANAGED_END);
  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const before = existing.slice(0, beginIdx);
    const after = existing.slice(endIdx + MANAGED_END.length);
    const next = `${before}${desiredBlock}${after}`;
    if (next === existing) return "noop";
    await fs.writeFile(filePath, next, "utf8");
    return "updated";
  }
  // No managed block yet — append one with a leading blank line so we
  // do not collide with whatever the user has at the bottom of CLAUDE.md.
  const sep = existing.endsWith("\n") ? "\n" : "\n\n";
  await fs.writeFile(filePath, `${existing}${sep}${desiredBlock}\n`, "utf8");
  return "updated";
}

export interface IdeRulesInstallReport {
  workspaceDir: string;
  // Per-kind source so callers can log where each body came from.
  source: "api" | "cache" | "default" | "missing";
  aiAssistedSource: "api" | "cache" | "default" | "missing";
  files: Array<{ path: string; result: "created" | "noop" | "updated" | "failed" | "skipped"; error?: string }>;
}

export async function installIdeRules(
  workspaceDir: string,
  api?: SamApi | null,
): Promise<IdeRulesInstallReport> {
  const coached = await resolveRulesBody(api ?? null, "coached");
  const aiAssisted = await resolveRulesBody(api ?? null, "ai_assisted");

  const report: IdeRulesInstallReport = {
    workspaceDir,
    source: coached.source,
    aiAssistedSource: aiAssisted.source,
    files: [],
  };

  type Target =
    | { rel: string; mode: "file"; body: string | null }
    | { rel: string; mode: "managed"; body: string };

  // CLAUDE.md is the host-agnostic block that holds both bodies (when
  // both are present) so a host that re-reads CLAUDE.md every turn
  // sees both rule sets in one fetch.
  const combinedManagedBody = [
    coached.body ?? "",
    aiAssisted.body ? `\n\n${aiAssisted.body}` : "",
  ]
    .join("")
    .trim();

  const targets: Target[] = [
    { rel: ".cursor/rules/prepsavant.mdc", mode: "file", body: coached.body },
    {
      rel: ".cursor/rules/prepsavant-ai-assisted.mdc",
      mode: "file",
      body: aiAssisted.body,
    },
    {
      rel: ".claude/skills/prepsavant-relay/SKILL.md",
      mode: "file",
      body: coached.body,
    },
    {
      rel: ".claude/skills/prepsavant-ai-assisted/SKILL.md",
      mode: "file",
      body: aiAssisted.body,
    },
    { rel: "CLAUDE.md", mode: "managed", body: combinedManagedBody },
  ];

  for (const t of targets) {
    const abs = path.join(workspaceDir, t.rel);
    if (t.mode === "file" && (t.body === null || t.body.length === 0)) {
      report.files.push({ path: t.rel, result: "skipped" });
      continue;
    }
    try {
      const result =
        t.mode === "file"
          ? await ensureFileEquals(abs, t.body!)
          : await ensureManagedBlock(abs, t.body);
      report.files.push({ path: t.rel, result });
    } catch (err) {
      report.files.push({
        path: t.rel,
        result: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return report;
}

// Task #1401 — Retired. The runner-driven terminal coach owns the
// Coached session end-to-end now; there is no MCP host that re-reads
// `.cursor/rules/prepsavant.mdc` between turns, so writing those rule
// files just adds noise to the user's workspace. The signature is
// preserved as a no-op for one release so any third-party caller
// importing this symbol continues to compile and link. The underlying
// `installIdeRules` helper is left in place (it still has unit-test
// coverage) but is no longer invoked from server.ts or cli-start.ts.
export function installIdeRulesBestEffort(
  _workspaceDir: string | undefined,
  _api?: SamApi | null,
): void {
  // Intentionally empty — see comment above.
}

// Task #1416 — AI-Assisted still relies on a real MCP host (Cursor)
// re-reading `.cursor/rules/prepsavant-ai-assisted.mdc` between turns,
// so for AI-Assisted we DO want to install the standing-frame rule
// files. We also surface the install outcome so the runner can tell
// the api-server "the host already has the HOST INSTRUCTIONS prose on
// disk" — when that's true the api-server suppresses the duplicated
// guardrails from the per-`get_context` `activeConstraints` payload
// (Task #1413's safety net is unnecessary then). Best-effort: any IO
// failure → `{ installed: false }` so the api-server keeps shipping
// the full guardrail fallback.
export async function installAiAssistedIdeRulesBestEffort(
  workspaceDir: string | undefined,
  api?: SamApi | null,
): Promise<{ installed: boolean }> {
  if (!workspaceDir) return { installed: false };
  try {
    const report = await installIdeRules(workspaceDir, api ?? null);
    // Consider the AI-Assisted standing frame "installed" when the
    // Cursor rule file write didn't fail or skip. `noop`/`created`/
    // `updated` all mean the host can read the body on its next turn.
    const aiCursorRule = report.files.find(
      (f) => f.path === ".cursor/rules/prepsavant-ai-assisted.mdc",
    );
    const ok =
      !!aiCursorRule &&
      (aiCursorRule.result === "created" ||
        aiCursorRule.result === "updated" ||
        aiCursorRule.result === "noop");
    return { installed: ok };
  } catch {
    return { installed: false };
  }
}
