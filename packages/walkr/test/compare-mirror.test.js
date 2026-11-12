import test from "./posix-only-mode.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { CompareStore } from "../src/compare-store.js";
import { startMirror } from "../mirror/server.js";
import { tmpRoot } from "./tmp-root.js";

const run = promisify(execFile);
const SYNC = fileURLToPath(new URL("../mirror/sync.sh", import.meta.url));

async function roots(t) {
  const dir = await fs.mkdtemp(path.join(tmpRoot, "walkr-mirror-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, "source");
  const store = new CompareStore({ root: source });
  const { view } = await store.create({
    actionId: "create-1", workflow: "text-options", title: "Mirror trial", brief: "Two options.",
    options: [
      { optionId: "a", label: "Option A", format: "html", content: "<h1>Option A</h1>" },
      { optionId: "b", label: "Option B", format: "html", content: "<h1>Option B</h1>" },
    ],
  });
  return { dir, source, sessionId: view.sessionId };
}

async function mirror(t, root, options = {}) {
  const started = await startMirror({ root, ...options });
  t.after(started.close);
  const origin = `http://127.0.0.1:${started.port}`;
  return { origin, get: (route, init = {}) => fetch(origin + route, { redirect: "manual", ...init }) };
}

test("the mirror shows the sessions of its root at a fixed address and refuses each write", async (t) => {
  const f = await roots(t);
  const m = await mirror(t, f.source);
  const before = await fs.readFile(path.join(f.source, "sessions", f.sessionId, "session.json"));

  const entry = await m.get("/");
  assert.equal(entry.status, 302);
  const pagePath = entry.headers.get("location");
  assert.match(pagePath, /^\/_walkr\/compare\/g\/[a-f0-9]{64}$/);
  assert.equal((await m.get("/_walkr/compare/")).headers.get("location"), pagePath);

  const shell = await (await m.get(pagePath)).text();
  const token = shell.match(/data-token="([a-f0-9]+)"/)[1];
  const headers = { "x-human-review-token": token, "content-type": "application/json" };
  const list = await (await m.get("/_walkr/compare/api/sessions", { headers })).json();
  assert.deepEqual(list.sessions.map((item) => item.sessionId), [f.sessionId]);
  const one = await (await m.get(`/_walkr/compare/api/sessions/${f.sessionId}`, { headers })).json();
  assert.equal(one.view.title, "Mirror trial");
  assert.equal((await m.get(`${pagePath.replace("/g/", "/o/")}/${f.sessionId}/a`)).status, 200);
  for (const file of ["/theme.css", "/theme.js", "/_walkr/compare/app.js", "/health"]) assert.equal((await m.get(file)).status, 200, file);

  for (const route of ["seen", "submit", "rate", "outcome"]) {
    const answer = await m.get(`/_walkr/compare/api/sessions/${f.sessionId}/${route}`, { method: "POST", headers, body: "{}" });
    assert.equal(answer.status, 403, route);
    assert.equal((await answer.json()).error.code, "READ_ONLY");
  }
  assert.equal((await m.get("/_walkr/compare/api/sessions", { method: "POST", headers, body: "{}" })).status, 403);
  // The routes of the agent credential do not exist on the mirror, and no other Walkr route does.
  for (const route of ["/_walkr/compare/api/page", "/_walkr/compare/api/capabilities", "/api/sessions", "/_walkr/modes/core"]) {
    assert.equal((await m.get(route, { headers })).status, 404, route);
  }
  assert.deepEqual(await fs.readFile(path.join(f.source, "sessions", f.sessionId, "session.json")), before);
});

test("the mirror refuses a Host that the owner did not name", async (t) => {
  const f = await roots(t);
  const started = await startMirror({ root: f.source, hosts: ["walkr.example.test:443"] });
  t.after(started.close);
  const ask = (host) => new Promise((resolve, reject) => {
    import("node:http").then(({ default: http }) => http.get({ host: "127.0.0.1", port: started.port, path: "/", headers: { host } }, (res) => { res.resume(); resolve(res.statusCode); }).on("error", reject));
  });
  assert.equal(await ask("rebound.example.test"), 403);
  assert.equal(await ask("walkr.example.test:443"), 302);
});

test("sync.sh copies only the records, with the modes that the store accepts, and deletes nothing", async (t) => {
  const f = await roots(t);
  const dest = path.join(f.dir, "mirror");
  await fs.writeFile(path.join(f.source, "sessions", f.sessionId, "other.txt"), "not a record");
  await run("sh", [SYNC, dest, f.source]);
  assert.deepEqual(await fs.readdir(path.join(dest, "sessions", f.sessionId)), ["session.json"]);

  const m = await mirror(t, dest);
  const shell = await (await m.get((await m.get("/")).headers.get("location"))).text();
  const headers = { "x-human-review-token": shell.match(/data-token="([a-f0-9]+)"/)[1] };
  assert.equal((await (await m.get("/_walkr/compare/api/sessions", { headers })).json()).sessions.length, 1);

  // A source that is gone fails the run, and the earlier copy stays.
  await assert.rejects(run("sh", [SYNC, dest, path.join(f.dir, "absent")]));
  assert.deepEqual(await fs.readdir(path.join(dest, "sessions")), [f.sessionId]);
});
