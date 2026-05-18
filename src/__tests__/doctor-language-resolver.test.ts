// Task #1197 — guard the runner-doctor language catalog resolver:
//
//   1. API → cache → default fall-through order. When the API returns
//      `null` we fall through to the on-disk cache; when the cache is
//      also missing we fall through to the baked-in `RUNNABLE_LANGUAGES`.
//   2. `installHint` rehydration. The `/setup/languages` API contract
//      intentionally strips runner-only fields (see
//      `lib/api-zod/src/languages.ts` `toApiLanguage`) so the resolver
//      MUST merge the API rows with locally-baked `RUNNABLE_LANGUAGES`
//      by id to rehydrate `installHint`. Otherwise doctor would emit
//      `warn` rows without a `fixCommand` for missing runtimes.
//   3. `runDoctor` end-to-end: when the resolver hands it a row whose
//      runtime is missing on PATH, the resulting `lang.<id>` check has
//      `status === "warn"` AND a non-empty `fixCommand` carrying the
//      install hint.

import test from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { promises as fs } from "node:fs";

import { RUNNABLE_LANGUAGES } from "@workspace/api-zod";
import {
  resolveRunnableLanguages,
  runDoctor,
  type RunnableLanguage,
} from "../doctor.js";
import type { SamApi } from "../api.js";

const CACHE_FILE = path.join(
  os.homedir(),
  ".prepsavant",
  "supported-languages.json",
);

async function withCleanCache<T>(fn: () => Promise<T>): Promise<T> {
  let backup: string | null = null;
  try {
    backup = await fs.readFile(CACHE_FILE, "utf8");
  } catch {
    backup = null;
  }
  try {
    await fs.unlink(CACHE_FILE);
  } catch {
    /* ENOENT is fine */
  }
  try {
    return await fn();
  } finally {
    if (backup !== null) {
      await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
      await fs.writeFile(CACHE_FILE, backup, "utf8");
    } else {
      try {
        await fs.unlink(CACHE_FILE);
      } catch {
        /* ENOENT is fine */
      }
    }
  }
}

function fakeApi(items: RunnableLanguage[] | null): SamApi {
  return {
    fetchSupportedLanguages: async () => (items === null ? null : { items }),
  } as unknown as SamApi;
}

test("Task #1197 doctor resolver: API → cache → default fall-through", async () => {
  await withCleanCache(async () => {
    // API returns null, cache empty → falls through to baked-in default.
    const offline = await resolveRunnableLanguages(fakeApi(null));
    assert.equal(offline.source, "default");
    assert.equal(offline.items.length, RUNNABLE_LANGUAGES.length);

    // API succeeds → cache is written; subsequent offline call reads cache.
    const apiItems: RunnableLanguage[] = [
      {
        id: "go",
        label: "Go",
        status: "published",
        runtimeRequirement: "go 1.21+",
      },
    ];
    const fresh = await resolveRunnableLanguages(fakeApi(apiItems));
    assert.equal(fresh.source, "api");
    assert.equal(fresh.items.length, 1);
    assert.equal(fresh.items[0]!.id, "go");

    const cached = await resolveRunnableLanguages(fakeApi(null));
    assert.equal(cached.source, "cache");
    assert.equal(cached.items[0]!.id, "go");
  });
});

test("Task #1197 doctor resolver: installHint rehydrated from RUNNABLE_LANGUAGES", async () => {
  await withCleanCache(async () => {
    // Pick the first runnable entry that the runner ships with an
    // installHint — we will assert it survives the trip through the
    // API (which strips it) by being merged back in by id.
    const baked = RUNNABLE_LANGUAGES.find((l) => !!l.installHint);
    assert.ok(baked, "fixture: at least one RUNNABLE_LANGUAGES entry must carry installHint");

    const apiItems: RunnableLanguage[] = [
      {
        id: baked!.id,
        label: baked!.label,
        status: "published",
        runtimeRequirement: baked!.runtimeRequirement,
        // installHint deliberately omitted — mirrors the wire shape.
      },
    ];
    const resolved = await resolveRunnableLanguages(fakeApi(apiItems));
    assert.equal(resolved.source, "api");
    assert.equal(resolved.items[0]!.installHint, baked!.installHint);
  });
});

test("Task #1197 doctor resolver: blocked rows are filtered out before probing", async () => {
  await withCleanCache(async () => {
    const apiItems: RunnableLanguage[] = [
      {
        id: "go",
        label: "Go",
        status: "published",
        runtimeRequirement: "go 1.21+",
      },
      {
        id: "kotlin",
        label: "Kotlin",
        status: "blocked",
        runtimeRequirement: "n/a",
      },
    ];
    const resolved = await resolveRunnableLanguages(fakeApi(apiItems));
    assert.equal(resolved.source, "api");
    assert.equal(resolved.items.length, 1);
    assert.equal(resolved.items[0]!.id, "go");
  });
});

test("Task #1197 runDoctor: missing runtime emits warn + fixCommand from installHint", () => {
  // Use an intentionally-unknown language id ("xyz-nonexistent-lang")
  // so the runner's LANG_PROBE map has no entry and the probe falls
  // into the deterministic `warn` branch on every host (no reliance on
  // whether PHP/Go/etc happen to be installed on the CI container).
  const synthetic: RunnableLanguage[] = [
    {
      id: "xyz-nonexistent-lang",
      label: "Nonexistent",
      status: "published",
      runtimeRequirement: "n/a",
      installHint: "echo install-nonexistent-lang",
    },
  ];
  const result = runDoctor({
    runnableLanguages: synthetic,
    runnableLanguagesSource: "api",
  });
  const check = result.languages.find(
    (c) => c.id === "lang.xyz-nonexistent-lang",
  );
  assert.ok(check, "expected a lang.xyz-nonexistent-lang check in the doctor result");
  assert.equal(check!.status, "warn");
  assert.equal(check!.fixCommand, "echo install-nonexistent-lang");
});
