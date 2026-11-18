import test from "./posix-only-mode.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { fixture, listen, request } from "./double-fixtures.js";
import { candidate, coinflip } from "./coinflip-fixtures.js";
import { createHistory, liveCommand, mirrorSources } from "../src/history.js";
import { CompareStore } from "../src/compare-store.js";
import { TrainerStore } from "../src/trainer-store.js";
import { DoubleStore } from "../src/double-store.js";
import { configuration as doubleConfiguration } from "../src/double-client.js";
import { configuration as trainerConfiguration } from "../src/trainer-cli.js";
import { doubleArchiveRoot } from "../src/double-archive.js";
import { startMirror } from "../mirror/server.js";

const run = promisify(execFile);
const SYNC = fileURLToPath(new URL("../mirror/sync.sh", import.meta.url));

// Every entry under the given places: kind, mode, owner, size, times and a hash of the bytes. Reading changes none of it.
async function snapshot(...places) {
  const seen = {};
  async function visit(file) {
    let stat;
    try { stat = await fs.lstat(file); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    const bytes = stat.isFile() ? createHash("sha256").update(await fs.readFile(file)).digest("hex") : null;
    seen[file] = [stat.isDirectory() ? "dir" : "file", stat.mode, stat.uid, stat.size, stat.mtimeMs, stat.ctimeMs, bytes];
    if (stat.isDirectory()) for (const name of await fs.readdir(file)) await visit(path.join(file, name));
  }
  for (const place of places) await visit(place);
  return seen;
}

// One record of each type, made through the real servers and stores of Walkr, in one disposable home.
async function records(t) {
  const f = await fixture(t);
  const places = { core: path.join(f.stateDir, "state.json"), archive: f.archiveDir, trainer: path.join(f.root, "trainer"), compare: path.join(f.root, "compare") };
  const s = await listen(t, f, { HUMAN_REVIEW_TRAINER_ROOT: places.trainer, HUMAN_REVIEW_COMPARE_ROOT: places.compare });
  assert.equal((await s.api("/api/double", { method: "POST", body: f.manifest })).status, 200);
  const flip = await coinflip(t, s, f);
  const id = await flip.start();
  assert.equal((await flip.attach(id, { left: await candidate(f, "plain"), right: await candidate(f, "bold") })).status, 200);
  await s.close();
  const items = Array.from({ length: 3 }, (_, i) => ({ sourceId: `S-${i}`, format: "text", title: `Story ${i}`, content: `Story ${i}` }));
  await new TrainerStore({ root: places.trainer }).create({ actionId: "t-1", repo: { name: "example-app" }, task: "Rank the stories.", items,
    plan: { explanation: "One group.", groups: [{ groupId: "g1", sourceIds: items.map((x) => x.sourceId), explanation: "All" }], leftovers: [] } });
  await new CompareStore({ root: places.compare }).create({ actionId: "c-1", workflow: "text-options", title: "Two texts", brief: "Pick one.",
    options: [{ optionId: "a", label: "A", format: "text", content: "One" }, { optionId: "b", label: "B", format: "text", content: "Two" }] });
  const page = path.join(f.root, "page.html");
  await fs.writeFile(page, "<p>Page</p>");
  // A Core state file in the format of src/state.js: one page with a comment, one without feedback.
  await fs.writeFile(places.core, JSON.stringify({ pages: {
    aaaaaaaaaaaaaaaa: { key: "aaaaaaaaaaaaaaaa", kind: "file", file: page, comments: [{ id: "c1", kind: "selection", quote: "Page", feedback: "Shorter", createdAt: Date.now() }], edits: [], updatedAt: Date.now() },
    bbbbbbbbbbbbbbbb: { key: "bbbbbbbbbbbbbbbb", kind: "url", url: "http://localhost:5173/", comments: [], edits: [], updatedAt: Date.now() },
  }, batches: {}, bindings: {} }), { mode: 0o600 });
  return { f, places, history: createHistory({ compare: () => new CompareStore({ root: places.compare }), sources: () => [{ host: null, ...places }] }) };
}

test("the history reader lists each type, writes nothing, and turns broken or missing records into error rows", async (t) => {
  const { f, places, history } = await records(t);
  const before = await snapshot(f.stateDir, places.archive, places.trainer, places.compare);
  const { rows } = await history.list();
  assert.deepEqual([...new Set(rows.map((row) => row.type))].sort(), ["coinflip", "compare", "core", "double", "trainer"]);
  assert.equal(rows.filter((row) => row.type === "core").length, 1, "a Core page without feedback is not listed");
  for (const row of rows.filter((item) => item.type !== "compare")) assert.equal((await history.read(row.ref)).ref, row.ref);
  // A value from a record stays one shell word in the live command.
  assert.equal(liveCommand({ type: "double" }, { kind: "comparison", id: "a';b" }), "walkr-double reopen 'a'\\'';b'");
  assert.deepEqual(await snapshot(f.stateDir, places.archive, places.trainer, places.compare), before, "the reader changed a record place");

  // A broken record of each store, a record of a newer schema, and a missing place.
  await fs.writeFile(path.join(places.archive, `double-${"0".repeat(64)}.json`), "{not json", { mode: 0o600 });
  const compareDir = path.join(places.compare, "sessions", "20990101T000000Z-000000000000");
  await fs.mkdir(compareDir, { mode: 0o700 });
  await fs.writeFile(path.join(compareDir, "session.json"), JSON.stringify({ schema: "walkr-compare-session", version: 99 }), { mode: 0o600 });
  const dataset = (await fs.readdir(path.join(places.trainer, "example-app", "dataset")))[0];
  await fs.writeFile(path.join(places.trainer, "example-app", "dataset", dataset, "dataset.json"), "broken", { mode: 0o600 });
  const broken = await history.list();
  const errors = broken.rows.filter((row) => row.error);
  assert.deepEqual(errors.map((row) => row.type).sort(), ["compare", "double", "trainer"]);
  assert.equal(broken.rows.length, rows.length + 2, "one error row for each broken record, and the healthy rows stay");
  for (const row of errors) assert.ok((await history.read(row.ref)).error);
  const missing = createHistory({ compare: () => new CompareStore({ root: path.join(f.root, "none", "compare") }),
    sources: () => [{ host: null, core: path.join(f.root, "none", "state.json"), archive: path.join(f.root, "none", "double"), trainer: path.join(f.root, "none", "trainer") }] });
  assert.deepEqual((await missing.list()).rows, []);
  await assert.rejects(fs.lstat(path.join(f.root, "none")), { code: "ENOENT" }, "the reader created a missing place");
});

test("the reader reads a changed Double record again, retries one failed read, and a deleted record leaves the list", async (t) => {
  const { f, history } = await records(t);
  const id = f.manifest.comparisonId, read = DoubleStore.prototype.read;
  let reads = 0, failures = 0;
  t.mock.method(DoubleStore.prototype, "read", function (comparisonId) {
    if (comparisonId !== id) return read.call(this, comparisonId);
    reads++;
    if (failures-- > 0) return Promise.reject(Object.assign(new Error("injected"), { code: "RECOVERY_REQUIRED" }));
    return read.call(this, comparisonId);
  });
  // The fixture has one Double record: the comparison.
  const doubles = async () => (await history.list()).rows.filter((row) => row.type === "double");
  const replace = async () => { await fs.copyFile(f.record, `${f.record}.new`); await fs.rename(`${f.record}.new`, f.record); reads = 0; };
  await history.list();
  reads = 0;
  await history.list();
  assert.equal(reads, 0, "an unchanged record is read again");
  await replace(); await history.list();
  assert.equal(reads, 1, "a record replaced by rename is not read again");
  await replace(); failures = 1;
  assert.deepEqual((await doubles()).map((row) => !!row.error), [false], "one failed read gives an error row");
  await replace(); failures = 2;
  assert.deepEqual((await doubles()).map((row) => !!row.error), [true], "two failed reads do not give one error row");
  await fs.rm(f.record);
  assert.deepEqual(await doubles(), [], "a deleted record stays in the list");
});

test("a list entry that fails once is listed again; one that fails twice gives one error row", async (t) => {
  const { history } = await records(t);
  const identities = DoubleStore.prototype.identities;
  let calls = 0, failures = 0;
  // A writer rename during the list gives an entry with an error; the second list sees the new version.
  t.mock.method(DoubleStore.prototype, "identities", async function (...args) {
    calls++;
    const found = await identities.apply(this, args);
    return failures-- > 0 ? [...found, { id: null, file: "double-race.json", error: "FILE_CHANGED" }] : found;
  });
  const errors = async () => (await history.list()).rows.filter((row) => row.type === "double" && row.error);
  failures = 1;
  assert.deepEqual(await errors(), [], "one failed list gives an error row");
  failures = 2;
  assert.equal((await errors()).length, 1, "two failed lists do not give one error row");
  calls = 0; failures = 0;
  await history.list();
  assert.equal(calls, 1, "a healthy place is listed more than once");
});

test("the mirror stays GET-only, and its copy script never copies server.json, a lock, a token or a review copy", async (t) => {
  const { f, places } = await records(t);
  // A home in the layout that the copy script reads, with the files that it must leave behind.
  const home = path.join(f.root, "home");
  await fs.mkdir(path.join(home, ".local", ".walkr"), { recursive: true, mode: 0o700 });
  await fs.cp(f.stateDir, path.join(home, ".human-review"), { recursive: true });
  await fs.cp(places.core, path.join(home, ".human-review", "state.json"));
  for (const [name, place] of [["double", places.archive], ["trainer", places.trainer], ["compare", places.compare]]) await fs.cp(place, path.join(home, ".local", ".walkr", name), { recursive: true });
  await fs.writeFile(path.join(home, ".human-review", "server.json"), JSON.stringify({ port: 1, token: "planted-token" }));
  await fs.writeFile(path.join(home, ".human-review", "server.lock"), "1");
  await fs.mkdir(path.join(home, ".human-review", "pristine"));
  await fs.writeFile(path.join(home, ".human-review", "pristine", "x.html"), "planted-copy");
  await fs.writeFile(path.join(home, ".local", ".walkr", "double", ".double-x.tmp"), "planted-temporary");
  const dest = path.join(f.root, "mirror");
  await run("sh", [SYNC, dest, `desk=${home}`, `laptop=${home}`]);
  const copied = Object.keys(await snapshot(dest)).map((file) => path.relative(dest, file));
  for (const file of copied) {
    assert.doesNotMatch(path.basename(file), /^(server\.json|server\.lock|shared-gui-.*|\..*\.tmp)$|pristine/, file);
    if (!file.endsWith(".json")) continue;
    assert.equal((await fs.readFile(path.join(dest, file), "utf8")).includes("planted"), false, file);
  }
  assert.ok(copied.includes(path.join("hosts", "desk", "core", "state.json")));
  // A name that leaves DEST/hosts/ is refused and creates nothing. A home with no Walkr records yet gives notes only.
  for (const name of ["../evil", "a/b", ".."]) {
    await assert.rejects(run("sh", [SYNC, dest, `${name}=${home}`]), (error) => error.code !== 0, name);
  }
  await assert.rejects(fs.lstat(path.join(f.root, "evil")), { code: "ENOENT" });
  assert.deepEqual((await fs.readdir(path.join(dest, "hosts"))).sort(), ["desk", "laptop"]);
  const bare = path.join(f.root, "bare-home");
  await fs.mkdir(bare);
  await run("sh", [SYNC, path.join(f.root, "mirror-bare"), `new=${bare}`]);

  const m = await startMirror({ root: dest });
  t.after(m.close);
  assert.deepEqual(mirrorSources(dest).map((source) => source.host), ["desk", "laptop"]);
  const origin = `http://127.0.0.1:${m.port}`;
  const pagePath = (await fetch(`${origin}/`, { redirect: "manual" })).headers.get("location");
  const token = (await (await fetch(origin + pagePath)).text()).match(/data-token="([a-f0-9]+)"/)[1];
  const headers = { "x-human-review-token": token, "content-type": "application/json" };
  const listed = await (await fetch(`${origin}/_walkr/compare/api/history`, { headers })).json();
  assert.deepEqual(listed.hosts, ["desk", "laptop"]);
  const before = await snapshot(dest);
  for (const route of ["/_walkr/compare/api/history", `/_walkr/compare/api/history/${listed.rows.find((row) => row.type === "trainer").ref}`]) {
    assert.equal((await fetch(origin + route, { headers })).status, 200, route);
    for (const method of ["POST", "PUT", "DELETE"]) {
      const answer = await fetch(origin + route, { method, headers, body: "{}" });
      assert.equal(answer.status, 403, `${method} ${route}`);
      assert.equal((await answer.json()).error.code, "READ_ONLY");
    }
  }
  assert.deepEqual(await snapshot(dest), before, "the mirror changed its root");
});

test("Double and Coinflip use ~/.local/.walkr/double when the variable is unset, and an explicit value wins", () => {
  const stateDir = path.join(os.tmpdir(), "walkr-state-for-a-path-check");
  assert.equal(doubleArchiveRoot({}, "/home/someone"), path.join("/home/someone", ".local", ".walkr", "double"));
  assert.equal(doubleConfiguration({ HUMAN_REVIEW_STATE_DIR: stateDir }).archiveDir, path.join(os.homedir(), ".local", ".walkr", "double"));
  assert.equal(doubleConfiguration({ HUMAN_REVIEW_STATE_DIR: stateDir, HUMAN_REVIEW_DOUBLE_ARCHIVE_DIR: "/srv/walkr-archive" }).archiveDir, "/srv/walkr-archive");
  // A set value always wins: an empty or relative value is refused, not replaced by the default.
  for (const value of ["", "relative"]) assert.throws(() => doubleConfiguration({ HUMAN_REVIEW_STATE_DIR: stateDir, HUMAN_REVIEW_DOUBLE_ARCHIVE_DIR: value }));
  assert.throws(() => doubleConfiguration({}), /HUMAN_REVIEW_STATE_DIR/, "the state directory stays explicit");
});

test("the hosted server and the hosted commands still refuse Double, Coinflip and Trainer without an archive variable", async (t) => {
  for (const configuration of [doubleConfiguration, trainerConfiguration]) {
    assert.throws(() => configuration({ HUMAN_REVIEW_HOSTED: "1", HUMAN_REVIEW_STATE_DIR: "/srv/state" }), /hosted mode/);
  }
  const f = await fixture(t);
  const names = ["HUMAN_REVIEW_HOSTED", "HUMAN_REVIEW_STATE_DIR", "HUMAN_REVIEW_DOUBLE_ARCHIVE_DIR", "HUMAN_REVIEW_TRAINER_ROOT"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, { HUMAN_REVIEW_HOSTED: "1", HUMAN_REVIEW_STATE_DIR: f.stateDir, HUMAN_REVIEW_TRAINER_ROOT: path.join(f.root, "trainer") });
  delete process.env.HUMAN_REVIEW_DOUBLE_ARCHIVE_DIR;
  const { createServer } = await import("../src/server.js");
  const service = createServer();
  for (const name of names) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
  await new Promise((resolve) => service.server.listen(0, "127.0.0.1", resolve));
  t.after(() => { service.dispose(); service.server.closeAllConnections(); return new Promise((resolve) => service.server.close(resolve)); });
  // The other routes and commands have their hosted tests; this one adds the case of an unset archive variable.
  const answer = await request(service.server.address().port, "/api/double/capabilities", { token: service.token });
  assert.equal(answer.status, 403);
  assert.equal(answer.json.error.code, "HOSTED_UNSUPPORTED");
});
