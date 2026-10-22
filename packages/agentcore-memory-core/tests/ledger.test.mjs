import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFileLedger, defaultLedgerPath } from "../src/index.mjs";
import { scratch } from "./helpers.mjs";

const entry = (action, proposalRecordId = "rec-chen") => ({
  at: "2026-10-15T12:00:00.000Z", action, maintainer: "bruno", projectId: "example-site", proposalRecordId, actorId: "chen",
  text: "Chen proposes a fact", metadata: { actorId: "chen" }, targetNamespace: "/project/example-site/shared/",
});
const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
// A qualification copy of the kit has no .git, so the package is then outside any work tree.
const inWorkTree = (dir) => existsSync(join(dir, ".git")) || (dirname(dir) !== dir && inWorkTree(dirname(dir)));

test("the ledger appends JSON Lines with file mode 0600 in a new directory of mode 0700", async () => {
  const home = scratch("ledger");
  const path = join(home, "state", "agentcore-memory", "review-ledger.jsonl");
  const ledger = createFileLedger(path, { cwd: home });
  assert.deepEqual(await ledger.entriesFor("rec-chen"), []);
  await ledger.append(entry("approve"));
  await ledger.append(entry("approve", "rec-other"));
  await ledger.append(entry("approve-done"));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(join(home, "state", "agentcore-memory")).mode & 0o777, 0o700);
  const lines = readFileSync(path, "utf8").split("\n");
  assert.equal(lines.length, 4);
  assert.equal(lines[3], "");
  assert.deepEqual(JSON.parse(lines[0]), entry("approve"));
  assert.deepEqual((await ledger.entriesFor("rec-chen")).map((line) => line.action), ["approve", "approve-done"]);
  // Append only: a new ledger object on the same file keeps the old lines.
  await createFileLedger(path, { cwd: home }).append(entry("reject", "rec-third"));
  assert.equal(readFileSync(path, "utf8").split("\n").length, 5);
});

test("the ledger tightens an existing file to 0600 and expands a leading tilde", async () => {
  const home = scratch("ledger-mode");
  writeFileSync(join(home, "ledger.jsonl"), "", { mode: 0o644 });
  const ledger = createFileLedger("~/ledger.jsonl", { home, cwd: home });
  await ledger.append(entry("approve"));
  assert.equal(statSync(join(home, "ledger.jsonl")).mode & 0o777, 0o600);
});

test("a ledger path in the current Git work tree or in the package work tree is refused; .local below the top is allowed", async () => {
  const home = scratch("ledger-git");
  const repo = join(home, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, "sub"), { recursive: true });
  for (const path of [join(repo, "ledger.jsonl"), join(repo, "sub", "deeper", "ledger.jsonl")]) {
    await assert.rejects(createFileLedger(path, { cwd: join(repo, "sub") }).append(entry("approve")), { code: "ledger" });
  }
  await createFileLedger(join(repo, ".local", "ledger.jsonl"), { cwd: repo }).append(entry("approve"));
  // A worktree has a .git file, not a directory.
  const worktree = join(home, "worktree");
  mkdirSync(worktree);
  writeFileSync(join(worktree, ".git"), "gitdir: elsewhere\n");
  await assert.rejects(createFileLedger(join(worktree, "ledger.jsonl"), { cwd: worktree }).append(entry("approve")),
    { code: "ledger" });
  if (inWorkTree(PACKAGE)) {
    await assert.rejects(createFileLedger(join(PACKAGE, "tests", "ledger.jsonl"), { cwd: home }).append(entry("approve")),
      { code: "ledger" });
  }
  // A symbolic link into the work tree is resolved first.
  symlinkSync(repo, join(home, "link"));
  await assert.rejects(createFileLedger(join(home, "link", "ledger.jsonl"), { cwd: repo }).append(entry("approve")),
    { code: "ledger" });
  assert.throws(() => createFileLedger(" "), { code: "ledger" });
});

test("a ledger that is a directory or holds a broken line fails closed with the code ledger", async () => {
  const home = scratch("ledger-bad");
  mkdirSync(join(home, "dir.jsonl"));
  await assert.rejects(createFileLedger(join(home, "dir.jsonl"), { cwd: home }).append(entry("approve")), { code: "ledger" });
  writeFileSync(join(home, "broken.jsonl"), "{\"proposalRecordId\": \"rec-chen\"}\n{CANARY_SECRET\n");
  await assert.rejects(createFileLedger(join(home, "broken.jsonl"), { cwd: home }).entriesFor("rec-chen"),
    (error) => error.code === "ledger" && !error.message.includes("CANARY"));
});

test("the default ledger path is below XDG_STATE_HOME or ~/.local/state", () => {
  assert.equal(defaultLedgerPath({ HOME: "/home/example" }), "/home/example/.local/state/agentcore-memory/review-ledger.jsonl");
  assert.equal(defaultLedgerPath({ HOME: "/home/example", XDG_STATE_HOME: "/state" }), "/state/agentcore-memory/review-ledger.jsonl");
});
