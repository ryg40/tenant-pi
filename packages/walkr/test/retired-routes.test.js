import test from "./posix-only-mode.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { listen } from "./server-fixtures.js";
import { tmpRoot } from "./tmp-root.js";

// Core, Double, Coinflip, Trainer and the shared GUI are retired (CHANGELOG.md). Their write routes must reach no
// handler: each one answers 404, also with the agent token, and the server writes no file for it.
// The form of a page record name of the retired Core store: 16 hex characters.
const PAGE = randomBytes(8).toString("hex");
const WRITES = [
  ["POST", "/api/session", { target: "/tmp/page.html" }],
  ["POST", `/api/page/${PAGE}/comment`, { feedback: "text" }],
  ["POST", `/api/page/${PAGE}/edit`, { kind: "text", after: "x" }],
  ["POST", `/api/page/${PAGE}/asset`, {}],
  ["POST", `/api/page/${PAGE}/save`, { html: "<p>x</p>" }],
  ["POST", `/api/page/${PAGE}/revert`, {}],
  ["POST", `/api/page/${PAGE}/send`, { note: "x" }],
  ["POST", "/api/core/connect", { target: "/tmp/page.html", piSessionId: "a", piSessionFile: "/tmp/a" }],
  ["POST", "/api/core/wake", { target: "/tmp/page.html" }],
  ["POST", "/api/core/disconnect", { target: "/tmp/page.html" }],
  ["GET", "/api/poll?target=%2Ftmp%2Fpage.html&ack=1", undefined],
  ["POST", "/api/double/comparisons", { comparisonId: "trial" }],
  ["POST", "/api/double/sessions", { brief: "x" }],
  ["POST", "/api/double/gui/connect", {}],
  ["POST", "/api/double/modes/coinflip/sessions", { brief: "x" }],
  ["POST", "/_walkr/trainer/api/datasets", { task: "x" }],
  ["POST", `/_walkr/compare/api/core/${PAGE}/comment`, { text: "x" }],
  ["POST", `/_walkr/compare/api/core/${PAGE}/send`, {}],
];
const PAGES = ["/", "/s/abc", "/double/abc", "/double-session/abc", "/double-gui/abc", "/_walkr/modes/core", "/_walkr/trainer/s/abc",
  `/artifact/abc/${PAGE}/index.html`, "/events/abc", "/sdk.js", "/chrome.js"];

async function tree(root) {
  const names = await fs.readdir(root, { recursive: true });
  return names.sort();
}

test("the write routes of the retired modes answer 404 and create no file", async (t) => {
  const dir = await fs.mkdtemp(path.join(tmpRoot, "walkr-retired-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const f = { dir, stateDir: path.join(dir, "state"), root: path.join(dir, "walkr", "compare") };
  await fs.mkdir(f.stateDir, { mode: 0o700 });
  // The old default places of the retired stores, inside the scratch home: no request may create one of them.
  const home = path.join(dir, "home");
  await fs.mkdir(home);
  const s = await listen(t, f, { HUMAN_REVIEW_COMPARE_ROOT: f.root, HOME: home,
    HUMAN_REVIEW_DOUBLE_ARCHIVE_DIR: path.join(dir, "double"), HUMAN_REVIEW_TRAINER_ROOT: path.join(dir, "trainer") });
  // One Compare read first, so the Compare root exists before the snapshot.
  assert.equal((await s.api("/_walkr/compare/api/sessions")).status, 200);
  const before = await tree(dir);

  for (const [method, route, body] of WRITES) {
    const answer = await s.api(route, { method, body });
    assert.equal(answer.status, 404, `${method} ${route}`);
  }
  for (const route of PAGES) assert.equal((await s.api(route)).status, 404, route);

  assert.deepEqual(await tree(dir), before);
});
