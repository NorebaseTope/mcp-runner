// Task #1479 — folder-driven AI-Assisted launcher.
//
// `prepsavant start` from inside a question-package folder whose
// `.prepsavant/question.json` manifest declares `mode: "ai_assisted"`
// routes here. We:
//   1. Read + parse the manifest (no HMAC check client-side — the
//      server does the canonical verification).
//   2. Mint an ephemeral Ed25519 keypair + capability manifest exactly
//      like the in-chat `ai_assisted_start_session` tool.
//   3. POST /runner/sessions/from-question-package with the
//      `aiAssisted` block; the server creates the sessions +
//      ai_assisted_sessions rows and returns a certificate JWT.
//   4. Persist `.prepsavant/last-session.json` so subsequent
//      `prepsavant upload-cursor-export` calls from the same folder
//      auto-resolve the session id without flags.
//   5. Print a short, copy-pasteable next-step block telling the user
//      to drive their work in Cursor and upload the chat export when
//      done. Unlike coached, the runner does NOT take over the
//      terminal — the user owns the Cursor chat.
import * as fs from "node:fs";
import * as path from "node:path";
import { ADAPTER_VERSION, readConfig } from "../config.js";
import { SamApi, ApiError } from "../api.js";
import { generateEphemeralKeyPair } from "./signing.js";
import { writeLastSession } from "../last-session.js";

interface QuestionManifestShape {
  v?: unknown;
  questionId?: unknown;
  questionTitle?: unknown;
  language?: unknown;
  apiBaseUrl?: unknown;
  ownerId?: unknown;
  issuedAt?: unknown;
  hmac?: unknown;
  mode?: unknown;
}

// Capability-manifest shape mirrors `buildCapabilityManifest` in
// `src/server.ts`. Kept in sync deliberately — the server validates
// these fields, so divergence shows up immediately as a 400 from the
// from-question-package route.
function buildAiAssistedCapabilityManifest(tool: string): {
  captures: string[];
  notCaptures: string[];
  toolLabel: string;
  consentVersion: string;
} {
  return {
    captures: [
      "Cursor chat export uploaded at end of session",
      "Sam's split-loop coaching turns (context + feedback)",
    ],
    notCaptures: [
      "Live in-process Cursor hook events (retired in 2.0.0)",
    ],
    toolLabel: tool === "cursor" ? "Cursor" : tool,
    consentVersion: "2025-05",
  };
}

export async function runAiAssistedFolderStart(args: {
  manifestPath: string;
  flags: Record<string, string | boolean>;
}): Promise<void> {
  const { manifestPath, flags } = args;
  const isJson = !!flags.json;
  const replaceFlag = flags["replace"] === true;
  const noReplaceFlag = flags["no-replace"] === true;

  const cfg = readConfig();
  if (!cfg.token) {
    fail(
      isJson,
      "not_authenticated",
      "No device token. Run `prepsavant auth` first.",
    );
    return;
  }
  const api = new SamApi(cfg);

  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, "utf-8");
  } catch (err) {
    fail(
      isJson,
      "question_package_read_failed",
      `Could not read ${manifestPath}: ${(err as Error).message}`,
    );
    return;
  }
  let manifest: QuestionManifestShape;
  try {
    manifest = JSON.parse(raw) as QuestionManifestShape;
  } catch (err) {
    fail(
      isJson,
      "question_package_parse_failed",
      `Manifest is not valid JSON: ${(err as Error).message}. Re-download the question package from the dashboard.`,
    );
    return;
  }
  const questionId =
    typeof manifest.questionId === "string" ? manifest.questionId : "";
  if (!questionId || typeof manifest.hmac !== "string") {
    fail(
      isJson,
      "question_package_invalid",
      "Manifest is missing required fields. Re-download the question package from the dashboard.",
    );
    return;
  }

  // Task #1479 — fail fast if the manifest is NOT an AI-Assisted
  // package. Without this guard, the explicit dispatcher path
  // (`prepsavant start --mode ai-assisted` inside a coached
  // package folder) would let us POST to
  // /runner/sessions/from-question-package, which routes by manifest
  // mode and silently creates a *coached* session — leaving the
  // user with AI-Assisted CLI instructions, a `mode: "ai_assisted"`
  // breadcrumb, and a coached server-side session. Mismatched flow
  // is far worse than a clear refusal; refuse here.
  if (manifest.mode !== "ai_assisted") {
    fail(
      isJson,
      "question_package_mode_mismatch",
      [
        `This question package is ${manifest.mode === "coached" || manifest.mode == null ? "coached" : String(manifest.mode)}, not AI-Assisted.`,
        "Either re-run `prepsavant start` without `--mode ai-assisted`, or",
        "download the AI-Assisted package from the dashboard and start from",
        "that folder instead.",
      ].join("\n"),
    );
    return;
  }

  // Replace gate — for AI-Assisted we always pass-through the flag.
  // We deliberately skip the client-side active-session prompt the
  // coached path uses: AI-Assisted sessions are silent state on the
  // server (no in-terminal coach to interrupt), so a 409 from the
  // server is a clearer signal than a prompt.
  const replace = replaceFlag && !noReplaceFlag;

  const tool = "cursor";
  const keyPair = generateEphemeralKeyPair();
  const capabilityManifest = buildAiAssistedCapabilityManifest(tool);

  let res: Awaited<ReturnType<SamApi["createSessionFromQuestionPackage"]>>;
  try {
    res = await api.createSessionFromQuestionPackage({
      manifest,
      replace,
      aiAssisted: {
        tool,
        toolVersion: "mcp-host",
        adapterVersion: ADAPTER_VERSION,
        runnerVersion: ADAPTER_VERSION,
        runnerPublicKey: keyPair.publicKeyBase64Url,
        capabilityManifest,
      },
    });
  } catch (err) {
    if (err instanceof ApiError) {
      const code = describeApiError(err);
      const dashboardUrl = buildDashboardUrl(manifest);
      if (err.status === 409 && code === "active_session_exists") {
        fail(
          isJson,
          "active_session_exists",
          [
            "An active AI-Assisted session for this question already exists.",
            "Re-run with `--replace` to end it and start a new one.",
          ].join("\n"),
        );
        return;
      }
      if (err.status === 403 && code === "entitlement_required") {
        fail(
          isJson,
          "entitlement_required",
          [
            "AI-Assisted sessions require a PrepSavant Pro or Lifetime plan.",
            `Upgrade at ${dashboardUrl.replace(/\/dashboard$/, "/pricing")}.`,
          ].join("\n"),
        );
        return;
      }
      if (err.status === 403 && code === "manifest_owner_mismatch") {
        fail(
          isJson,
          "manifest_owner_mismatch",
          [
            "This question package was downloaded by a different account.",
            `Re-download from your own dashboard: ${dashboardUrl}`,
          ].join("\n"),
        );
        return;
      }
      if (err.status === 400 && code === "manifest_signature_invalid") {
        fail(
          isJson,
          "manifest_signature_invalid",
          [
            "The question package manifest signature is invalid (likely hand-edited).",
            `Re-download a fresh copy from ${dashboardUrl}.`,
          ].join("\n"),
        );
        return;
      }
      if (err.status === 426) {
        const minVer =
          (err.body && typeof err.body === "object"
            ? (err.body as Record<string, unknown>)["minimumRunnerVersion"]
            : undefined) ?? "the latest version";
        fail(
          isJson,
          "runner_too_old",
          `This AI-Assisted session requires PrepSavant runner ${String(minVer)} or newer. Re-install in two steps (the uninstall is required because npm can retain the old global shim on top of the new one):\n  npm uninstall -g @prepsavant/mcp\n  npm install -g @prepsavant/mcp@latest`,
        );
        return;
      }
      if (err.status === 503 && code === "ai_assisted_standing_frame_unavailable") {
        fail(
          isJson,
          "ai_assisted_standing_frame_unavailable",
          "AI-Assisted is temporarily unavailable (no active standing frame). Try again shortly.",
        );
        return;
      }
      fail(
        isJson,
        "start_failed",
        `Failed to start AI-Assisted session (HTTP ${err.status}): ${code}`,
      );
      return;
    }
    fail(
      isJson,
      "start_failed",
      `Failed to start AI-Assisted session: ${(err as Error).message}`,
    );
    return;
  }

  const sessionId = res.session.id;
  const packRoot = path.resolve(path.dirname(path.dirname(manifestPath)));
  const startedAt = new Date().toISOString();

  // Persist `.prepsavant/last-session.json` so
  // `prepsavant upload-cursor-export` can auto-resolve the session id.
  writeLastSession(packRoot, {
    sessionId,
    mode: "ai_assisted",
    questionId: res.question.id,
    questionTitle: res.question.title,
    startedAt,
  });

  if (isJson) {
    process.stdout.write(
      JSON.stringify({
        sessionId,
        mode: "ai_assisted",
        startedAt,
        ...(res.replacedSessionId
          ? { replacedSessionId: res.replacedSessionId }
          : {}),
      }) + "\n",
    );
    return;
  }

  // Task #1479 acceptance: human-readable AI-Assisted output is
  // intentionally ID-free. The session id is persisted in
  // `.prepsavant/last-session.json` and consumed automatically by
  // `prepsavant upload-cursor-export`; the user never needs to copy
  // it. Automation (`--json` mode above) still receives `sessionId`.
  const lines = [
    `AI-Assisted session started — ${res.question.title}`,
    `  folder:  ${packRoot}`,
    "",
    // Task #1507 — short pointer to the on-disk question file
    // instead of dumping the full markdown prompt into the terminal.
    // The unzipped question package always contains PROBLEM.md at
    // its root (see `artifacts/api-server/src/lib/question-package.ts`).
    "Question:",
    `  Full statement: ${path.join(packRoot, "PROBLEM.md")}`,
  ];
  const preview = summariseForBanner(res.kickoffBriefVerbatim ?? "");
  if (preview.length > 0) {
    lines.push(`  ${preview}`);
  }
  lines.push("");
  lines.push(
    "Next steps:",
    "  1. Open Cursor on this folder and drive the work however you like.",
    "  2. When you're done, export the Cursor chat",
    "     (Cmd/Ctrl+Shift+P → \"Cursor Chat: Export\").",
    "  3. From this folder run:",
    "       prepsavant upload-cursor-export",
    "     (the session id is read from .prepsavant/last-session.json).",
    "",
  );
  // Task #1507 — informative CURSOR_API_KEY tip surfaced ONLY when
  // the env var is not already set. Skipped wholesale when the key
  // is present so the banner stays uncluttered for repeat users.
  const apiKeySet =
    typeof process.env["CURSOR_API_KEY"] === "string" &&
    process.env["CURSOR_API_KEY"].length > 0;
  if (!apiKeySet) {
    let tipText: string | null = null;
    try {
      const tip = await api.getSamVoice("cursor_api_key_tip");
      tipText = tip?.text ?? null;
    } catch {
      tipText = null;
    }
    if (tipText && tipText.trim().length > 0) {
      lines.push(tipText);
      lines.push("");
    } else {
      lines.push(
        "Optional: set CURSOR_API_KEY in your shell for persistent multi-turn context",
        "  (get a key at https://cursor.com/dashboard).",
        "",
      );
    }
  }
  process.stdout.write(lines.join("\n"));
}

// Task #1507 — pull a 1-2 line summary out of the kickoff brief for
// the AI-Assisted folder banner. Skips markdown headings and HOST
// INSTRUCTIONS fences, soft-caps at ~200 chars on a word boundary.
// Duplicates the coached banner's `summariseBrief` so the runner
// package's two surface renderers stay independently changeable.
function summariseForBanner(brief: string): string {
  if (!brief) return "";
  const paras: string[] = [];
  let buf: string[] = [];
  let inHostInstructions = false;
  for (const raw of brief.split("\n")) {
    const line = raw.trim();
    if (/^HOST INSTRUCTIONS/i.test(line)) {
      inHostInstructions = true;
      continue;
    }
    if (inHostInstructions) continue;
    if (line.length === 0) {
      if (buf.length > 0) {
        paras.push(buf.join(" "));
        buf = [];
      }
      continue;
    }
    if (/^#{1,6}\s/.test(line)) continue;
    if (/^[-*]\s/.test(line) && buf.length === 0) continue;
    buf.push(line);
  }
  if (buf.length > 0) paras.push(buf.join(" "));
  const first = paras.find((p) => p.length > 0) ?? "";
  if (first.length === 0) return "";
  if (first.length <= 200) return first;
  const truncated = first.slice(0, 200);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > 80 ? truncated.slice(0, lastSpace) : truncated) + "…";
}

function buildDashboardUrl(manifest: { apiBaseUrl?: unknown }): string {
  const raw =
    typeof manifest.apiBaseUrl === "string" ? manifest.apiBaseUrl : "";
  const trimmed = raw.replace(/\/+$/, "");
  if (trimmed.length === 0) return "your PrepSavant dashboard";
  return `${trimmed}/dashboard`;
}

function describeApiError(err: ApiError): string {
  const body = err.body as Record<string, unknown> | null;
  if (body && typeof body === "object" && typeof body["error"] === "string") {
    return body["error"] as string;
  }
  return err.message;
}

function fail(isJson: boolean, code: string, message: string): void {
  if (isJson) {
    process.stderr.write(JSON.stringify({ error: code, message }) + "\n");
  } else {
    process.stderr.write(message + "\n");
  }
  process.exitCode = 1;
}

// Sniff the manifest's `mode` field without doing the full HMAC parse
// — used by the CLI dispatcher to decide between coached and
// ai_assisted folder-start without a server round-trip. Tolerant of
// malformed manifests (returns "coached" as the safe default so the
// coached path can produce the canonical "re-download" error message).
export function sniffManifestMode(
  manifestPath: string,
): "coached" | "ai_assisted" {
  try {
    const raw = fs.readFileSync(manifestPath, "utf-8");
    const parsed = JSON.parse(raw) as { mode?: unknown };
    return parsed.mode === "ai_assisted" ? "ai_assisted" : "coached";
  } catch {
    return "coached";
  }
}
