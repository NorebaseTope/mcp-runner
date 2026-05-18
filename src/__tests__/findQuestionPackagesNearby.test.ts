// Task #1478 — regression coverage for the "wrong folder" hint.
//
// When the user runs `prepsavant start` from a directory that has no
// .prepsavant/question.json, the runner now scans a small set of
// "obvious" places (CWD, CWD's parent, ~/Downloads, ~/Desktop,
// ~/Documents — one level deep on each) and surfaces any unzipped
// question packages so the user knows exactly where to `cd`.
//
// This test exercises findQuestionPackagesNearby() directly against a
// tmpdir tree. We monkey-patch os.homedir() so the search picks up
// our fake "Downloads" folder instead of the real one on the test
// machine.

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { findQuestionPackagesNearby, renderCdCommand } from "../coached/cli-start.js";

function makeTmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "prepsavant-nearby-"));
}

function writeManifest(dir: string, opts: { questionTitle?: string }): void {
  const dot = path.join(dir, ".prepsavant");
  fs.mkdirSync(dot, { recursive: true });
  fs.writeFileSync(
    path.join(dot, "question.json"),
    JSON.stringify({
      v: 1,
      questionId: "q_test",
      questionTitle: opts.questionTitle ?? "Untitled",
      language: "typescript",
      apiBaseUrl: "https://example.test",
      ownerId: "usr_test",
      issuedAt: new Date().toISOString(),
      hmac: "deadbeef",
    }),
  );
}

test("findQuestionPackagesNearby picks up siblings of CWD", () => {
  const root = makeTmpRoot();
  const cwd = path.join(root, "some-other-repo");
  const sibling = path.join(root, "prepsavant-q-abc123-typescript");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(sibling, { recursive: true });
  writeManifest(sibling, { questionTitle: "Two Sum" });

  const got = findQuestionPackagesNearby(cwd, {
    homedir: path.join(root, "no-such-home"),
  });
  assert.equal(got.length, 1, "should surface the one sibling package");
  const [first] = got;
  assert.ok(first);
  assert.equal(first.dir, sibling);
  assert.equal(first.title, "Two Sum");
});

test("findQuestionPackagesNearby picks up packages in ~/Downloads", () => {
  const root = makeTmpRoot();
  const fakeHome = path.join(root, "home");
  const downloads = path.join(fakeHome, "Downloads");
  const pkg = path.join(downloads, "prepsavant-q-xyz-python");
  fs.mkdirSync(pkg, { recursive: true });
  writeManifest(pkg, { questionTitle: "Reverse Linked List" });

  // CWD is somewhere unrelated.
  const got = findQuestionPackagesNearby(path.join(root, "elsewhere"), {
    homedir: fakeHome,
  });
  assert.equal(got.length, 1);
  const [first] = got;
  assert.ok(first);
  assert.equal(first.dir, pkg);
  assert.equal(first.title, "Reverse Linked List");
});

test("findQuestionPackagesNearby returns [] when nothing is found", () => {
  const root = makeTmpRoot();
  const fakeHome = path.join(root, "empty-home");
  fs.mkdirSync(path.join(fakeHome, "Downloads"), { recursive: true });
  fs.mkdirSync(path.join(root, "empty-cwd"), { recursive: true });

  const got = findQuestionPackagesNearby(path.join(root, "empty-cwd"), {
    homedir: fakeHome,
  });
  assert.deepEqual(got, []);
});

test("findQuestionPackagesNearby deduplicates when CWD === ~/Downloads", () => {
  // Edge case: user runs from inside ~/Downloads itself. CWD-children
  // and Downloads-children scan the same directory; the realpath dedupe
  // should collapse them.
  const root = makeTmpRoot();
  const fakeHome = path.join(root, "home");
  const downloads = path.join(fakeHome, "Downloads");
  const pkg = path.join(downloads, "prepsavant-q-dedupe");
  fs.mkdirSync(pkg, { recursive: true });
  writeManifest(pkg, { questionTitle: "Dupe Check" });

  const got = findQuestionPackagesNearby(downloads, { homedir: fakeHome });
  assert.equal(got.length, 1, "the same package must not be listed twice");
});

test("findQuestionPackagesNearby tolerates malformed manifest (no title)", () => {
  const root = makeTmpRoot();
  const cwd = path.join(root, "cwd");
  const sibling = path.join(root, "weird-package");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(sibling, ".prepsavant"), { recursive: true });
  // Write garbage instead of valid JSON — the package should still be
  // listed (the hint is about location, not content), just without a
  // title decoration.
  fs.writeFileSync(path.join(sibling, ".prepsavant", "question.json"), "not json {{");

  const got = findQuestionPackagesNearby(cwd, {
    homedir: path.join(root, "no-home"),
  });
  assert.equal(got.length, 1);
  const [first] = got;
  assert.ok(first);
  assert.equal(first.title, null);
});

test("renderCdCommand escapes shell metacharacters in folder names", () => {
  // A malicious or just unfortunately-named folder in ~/Downloads must
  // not be able to inject extra shell tokens via the hint line. We
  // wrap in double quotes and escape `$`, backtick, `"`, and `\`.
  const evil = "/tmp/weird;rm -rf $HOME `whoami` \"quoted\" \\path";
  const out = renderCdCommand(evil);
  assert.ok(out, "should render a command");
  // The semicolon, backticks, $, " and \ must all be defanged: each
  // potentially-active token appears only inside the quoted span,
  // with escapes where required.
  assert.match(out, /^cd "/);
  assert.match(out, /" && prepsavant start$/);
  // Inside the quoted span, $ ` " \ are backslash-escaped.
  assert.ok(out.includes("\\$HOME"), "$ must be escaped");
  assert.ok(out.includes("\\`whoami\\`"), "backticks must be escaped");
  assert.ok(out.includes('\\"quoted\\"'), "double quotes must be escaped");
  assert.ok(out.includes("\\\\path"), "backslash must be escaped");
});

test("renderCdCommand refuses to render paths with newlines", () => {
  const evil = "/tmp/with\nnewline";
  assert.equal(renderCdCommand(evil), null);
});

test("renderCdCommand handles ordinary paths cleanly", () => {
  assert.equal(
    renderCdCommand("/home/me/Downloads/prepsavant-q-abc"),
    'cd "/home/me/Downloads/prepsavant-q-abc" && prepsavant start',
  );
});

test("findQuestionPackagesNearby caps results at 5", () => {
  const root = makeTmpRoot();
  const fakeHome = path.join(root, "home");
  const downloads = path.join(fakeHome, "Downloads");
  fs.mkdirSync(downloads, { recursive: true });
  for (let i = 0; i < 8; i++) {
    const dir = path.join(downloads, `prepsavant-q-${i}`);
    fs.mkdirSync(dir, { recursive: true });
    writeManifest(dir, { questionTitle: `Q${i}` });
  }

  const got = findQuestionPackagesNearby(path.join(root, "cwd"), {
    homedir: fakeHome,
  });
  assert.equal(got.length, 5, "must cap at 5 to keep the hint readable");
});
