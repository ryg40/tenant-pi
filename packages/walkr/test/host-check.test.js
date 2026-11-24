import "./no-outer-config.js"; // First: no test reads the artifacts config of the outer user.
import test from "./posix-only-mode.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createServer } from "../src/server.js";
import { listen, request } from "./server-fixtures.js";
import { tmpRoot } from "./tmp-root.js";

// Exercise the request handler without binding an interface or trusting the host of the test machine.
test("an allowed host opens Compare, not health; health also needs a loopback peer", async (t) => {
  const port = 4802;
  const host = `review.example:${port}`;
  const saved = process.env.HUMAN_REVIEW_ALLOWED_HOSTS;
  process.env.HUMAN_REVIEW_ALLOWED_HOSTS = host;
  t.after(() => {
    if (saved === undefined) delete process.env.HUMAN_REVIEW_ALLOWED_HOSTS;
    else process.env.HUMAN_REVIEW_ALLOWED_HOSTS = saved;
  });
  const service = createServer();
  t.after(() => service.dispose());
  const [handle] = service.server.listeners("request");
  async function status(host, url, remoteAddress = "127.0.0.1") {
    let code;
    await handle({ method: "GET", url, headers: { host }, socket: { localPort: port, remoteAddress } }, {
      writeHead(value) { code = value; }, end() {},
    });
    return code;
  }
  const css = "/_walkr/compare/compare.css";
  assert.equal(await status(`other.example:${port}`, "/health"), 403);
  assert.equal(await status(host, css), 200);
  assert.equal(await status(host, "/theme.css"), 200);
  assert.equal(await status(host, "/health"), 403);
  assert.equal(await status(`review.example:${port + 1}`, css), 403);
  assert.equal(await status(`localhost:${port}`, "/health", "198.51.100.8"), 403);
});

// The key walkrPublicOrigin of the artifacts config file (src/allowed-hosts.js): the public host reaches the page with
// the rules of the public origin; without the key it is refused as before.
test("the public host needs the public Origin for a page write and never takes the agent token", async (t) => {
  const dir = await fs.mkdtemp(path.join(tmpRoot, "walkr-public-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = path.join(dir, "config", "tenant-artifacts");
  await fs.mkdir(config, { recursive: true });
  await fs.mkdir(path.join(dir, "state"), { mode: 0o700 });
  const f = { stateDir: path.join(dir, "state"), root: path.join(dir, "compare") };
  const name = ["walkr", "example", "org"].join(".");
  const origin = `https://${name}`;
  const env = { HUMAN_REVIEW_COMPARE_ROOT: f.root, XDG_CONFIG_HOME: path.join(dir, "config") };
  const write = (data) => fs.writeFile(path.join(config, "config.json"), JSON.stringify(data));

  await write({ walkrPublicOrigin: origin });
  const s = await listen(t, f, env);
  const api = "/_walkr/compare/api";
  const made = await s.api(`${api}/sessions`, { method: "POST", body: {
    actionId: "public-1", workflow: "text-options", title: "Pick one", brief: "Two texts.",
    options: [{ optionId: "a", label: "A", format: "text", content: "one" }, { optionId: "b", label: "B", format: "text", content: "two" }],
  } });
  assert.equal(made.status, 200);
  const sessionId = made.json.result.sessionId;
  const page = await request(s.port, made.json.path.split("#")[0]);
  const pageToken = page.text.match(/data-token="([a-f0-9]{64})"/)[1];
  const as = (headers, options = {}) => request(s.port, options.route, { ...options, headers: { host: name, ...headers } });
  const submit = (headers) => as(headers, { route: `${api}/sessions/${sessionId}/seen`, method: "POST", token: pageToken, body: {} });

  // The page and its reads work on the public host.
  assert.equal((await as({}, { route: made.json.path.split("#")[0] })).status, 200);
  assert.equal((await as({}, { route: `${api}/history`, token: pageToken })).status, 200);
  // A page write: no Origin and a foreign Origin are refused; the public Origin passes.
  assert.equal((await submit({})).status, 403);
  assert.equal((await submit({ origin: "http://" + name })).status, 403);
  assert.equal((await submit({ origin: `https://other.${name}` })).status, 403);
  assert.equal((await submit({ origin })).status, 200);
  // The agent token is never valid for the public host.
  for (const [route, method, body] of [["capabilities", "GET"], ["page", "GET"], ["sessions", "POST", {}],
    [`sessions/${sessionId}/received`, "POST", {}], [`sessions/${sessionId}/outcome`, "POST", {}]]) {
    const answer = await as({ origin }, { route: `${api}/${route}`, method, body, token: s.token });
    assert.equal(answer.status, 401, route);
  }
  assert.equal((await as({}, { route: "/health" })).status, 403);
  await s.close();

  // Without the key, the same host is refused.
  await write({});
  const plain = await listen(t, f, env);
  const refused = await request(plain.port, `${api}/history`, { token: pageToken, headers: { host: name } });
  assert.equal(refused.status, 403);
});
