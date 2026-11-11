import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import dns from "node:dns";
import https from "node:https";
import { gzipSync, deflateSync, deflateRawSync, brotliCompressSync } from "node:zlib";
import path from "node:path";
import { tmpRoot } from "./tmp-root.js";
import { createServer } from "../src/server.js";
import { Store } from "../src/state.js";
import { stateDir } from "../src/paths.js";

const httpRequest = http.request;
function checkLoopback(options) {
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(options.hostname), "no request selects an external host");
}
async function waitFor(check) {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(check(), "the expected state appears before the deadline");
}
function diagnostics() {
  return fs.readFileSync(path.join(stateDir(), "errors.log"), "utf8").trim().split("\n").map(JSON.parse);
}
function diagnosticFor(response, privateDetail) {
  assert.ok(!response.text.includes(privateDetail));
  assert.doesNotMatch(response.text, /ECONNREFUSED|ENOSPC|server\.js/);
  const code = response.text.match(/WR-[a-f0-9]{12}/)?.[0];
  assert.ok(code, "the client receives a correlation code");
  const entry = diagnostics().find((item) => item.code === code);
  assert.ok(entry, "the code identifies the private diagnostic");
  return entry;
}
async function fixture(t) {
  const tmp = fs.mkdtempSync(path.join(tmpRoot, "walkr-server-safety-"));
  const previous = process.env.HUMAN_REVIEW_STATE_DIR;
  process.env.HUMAN_REVIEW_STATE_DIR = path.join(tmp, "state");
  const service = createServer();
  await new Promise((resolve) => service.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    service.dispose();
    service.server.closeAllConnections();
    await new Promise((resolve) => service.server.close(resolve));
    if (previous === undefined) delete process.env.HUMAN_REVIEW_STATE_DIR;
    else process.env.HUMAN_REVIEW_STATE_DIR = previous;
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  return { ...service, tmp, port: service.server.address().port };
}
function request(service, route, { body, authenticated = true } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port: service.port, path: route,
      method: body ? "POST" : "GET", headers: {
        ...(authenticated ? { "x-human-review-token": service.token } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, text }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
async function app(t) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ path: req.url, host: req.headers.host, cookie: req.headers.cookie });
    if (req.url === "/redirect-away") res.writeHead(302, { location: "http://outside.invalid/blocked" });
    else if (req.url === "/redirect-local") res.writeHead(302, { location: "/app" });
    else if (req.url === "/redirect-loop") res.writeHead(302, { location: "/redirect-loop" });
    else res.writeHead(200, { "content-type": "text/html" });
    res.end("<p>Local app fixture</p>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { seen, target: `http://localhost:${server.address().port}/app`, server };
}

test("local page fetches pin DNS to loopback and refuse external targets and redirects before a request", async (t) => {
  const f = await fixture(t), upstream = await app(t);
  const lookup = dns.lookup;
  const destinations = [];
  dns.lookup = () => { throw new Error("unexpected DNS lookup"); };
  http.request = (options, callback) => {
    destinations.push(options.hostname);
    checkLoopback(options);
    return httpRequest(options, callback);
  };
  t.after(() => { dns.lookup = lookup; http.request = httpRequest; });
  const open = (target) => request(f, "/api/session", { body: { target } });
  assert.equal((await open(upstream.target)).status, 200);
  assert.equal(upstream.seen.at(-1).host, new URL(upstream.target).host);
  assert.equal((await open(new URL("/redirect-local", upstream.target).href)).status, 200);
  const before = destinations.length;
  for (const target of ["http://outside.invalid/", "http://localhost.outside.invalid/", "http://169.254.169.254/", "http://127.0.0.1@outside.invalid/", "http://user@localhost/"]) {
    assert.equal((await open(target)).status, 500);
  }
  assert.equal(destinations.length, before, "refusals send no request");
  assert.equal((await open(new URL("/redirect-away", upstream.target).href)).status, 500);
  assert.equal((await open(new URL("/redirect-loop", upstream.target).href)).status, 500);
  assert.ok(upstream.seen.filter((item) => item.path === "/redirect-loop").length <= 6, "redirects stop after five hops");
  assert.ok(destinations.every((host) => ["localhost", "127.0.0.1", "::1"].includes(host)), "no external request was attempted");
});

test("the app proxy rejects absolute external assets and untrusted stored targets at its network boundary", async (t) => {
  const f = await fixture(t), upstream = await app(t);
  const opened = JSON.parse((await request(f, "/api/session", { body: { target: upstream.target } })).text);
  const artifact = `/artifact/${opened.artifactToken}/${opened.key}/`;
  assert.equal((await request(f, artifact + "index.html")).status, 200);
  const destinations = [];
  http.request = (options, callback) => {
    destinations.push(options.hostname);
    checkLoopback(options);
    return httpRequest(options, callback);
  };
  t.after(() => { http.request = httpRequest; });
  assert.equal((await request(f, "/api/app?view=one", { authenticated: false })).text, "<p>Local app fixture</p>");
  assert.equal(upstream.seen.at(-1).path, "/api/app?view=one");
  assert.equal((await request(f, artifact + "asset.css")).status, 200);
  const before = destinations.length;
  for (const asset of ["http://outside.invalid/private", "http://169.254.169.254/private", "http://user@localhost/private", "//outside.invalid/private"]) {
    assert.equal((await request(f, artifact + asset)).status, 500, asset);
  }
  assert.equal(destinations.length, before, "unsafe asset requests never leave the review server");
  f.store.page(opened.key).url = "http://outside.invalid/app";
  assert.equal((await request(f, "/private", { authenticated: false })).status, 500);
  assert.equal((await request(f, artifact + "index.html")).status, 502);
  assert.equal(destinations.length, before, "a stored target gets the same network guard");
});

test("local HTTPS transport does not disable certificate verification", async (t) => {
  const f = await fixture(t);
  const httpsRequest = https.request;
  let transportOptions;
  https.request = (options) => {
    transportOptions = options;
    throw new Error("stop before opening a socket");
  };
  t.after(() => { https.request = httpsRequest; });
  assert.equal((await request(f, "/api/session", { body: { target: "https://localhost:4322/app" } })).status, 500);
  assert.ok(transportOptions);
  checkLoopback(transportOptions);
  assert.notEqual(transportOptions.rejectUnauthorized, false);
  assert.equal(transportOptions.checkServerIdentity, undefined, "no custom certificate bypass");
});

test("localhost page fetches retain IPv6-only app support without DNS", async (t) => {
  const f = await fixture(t);
  const server = http.createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end("<p>IPv6 app</p>"); });
  const available = await new Promise((resolve, reject) => {
    server.once("error", (error) => ["EADDRNOTAVAIL", "EAFNOSUPPORT"].includes(error.code) ? resolve(false) : reject(error));
    server.listen(0, "::1", () => resolve(true));
  });
  if (!available) return t.skip("IPv6 loopback is not available");
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const lookup = dns.lookup;
  dns.lookup = () => { throw new Error("unexpected DNS lookup"); };
  t.after(() => { dns.lookup = lookup; });
  const opened = await request(f, "/api/session", { body: { target: `http://localhost:${server.address().port}/app` } });
  assert.equal(opened.status, 200);
  const { artifactToken, key } = JSON.parse(opened.text);
  assert.match((await request(f, `/artifact/${artifactToken}/${key}/index.html`)).text, /<p>IPv6 app<\/p>/);
});

test("local HTML decoding preserves raw deflate and encoding chains with a decoded size cap", async (t) => {
  const f = await fixture(t);
  const html = "<p>Compressed app</p>";
  const bodies = {
    "/gzip": { encoding: "gzip", body: gzipSync(html) },
    "/deflate": { encoding: "deflate", body: deflateSync(html) },
    "/br": { encoding: "br", body: brotliCompressSync(html) },
    "/raw": { encoding: "deflate", body: deflateRawSync(html) },
    "/chain": { encoding: "gzip, br", body: brotliCompressSync(gzipSync(html)) },
    "/raw-chain": { encoding: "deflate, gzip", body: gzipSync(deflateRawSync(html)) },
    "/large": { encoding: "gzip, br", body: brotliCompressSync(gzipSync(Buffer.alloc(24 * 1024 * 1024 + 1, 65))) },
    "/large-raw": { encoding: "deflate", body: deflateRawSync(Buffer.alloc(24 * 1024 * 1024 + 1, 65)) },
    "/broken": { encoding: "gzip, br", body: brotliCompressSync(Buffer.from("not compressed")) },
    "/broken-raw": { encoding: "deflate", body: Buffer.from([0xff]) },
  };
  const server = http.createServer((req, res) => {
    const item = bodies[req.url];
    res.writeHead(200, { "content-type": "text/html", "content-encoding": item.encoding });
    res.end(item.body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  for (const name of Object.keys(bodies)) {
    const opened = await request(f, "/api/session", { body: { target: `http://127.0.0.1:${server.address().port}${name}` } });
    if (["/large", "/large-raw", "/broken", "/broken-raw"].includes(name)) assert.equal(opened.status, 500);
    else {
      assert.equal(opened.status, 200);
      const { artifactToken, key } = JSON.parse(opened.text);
      const response = await request(f, `/artifact/${artifactToken}/${key}/index.html`);
      assert.equal(response.status, 200);
      assert.match(response.text, /<p>Compressed app<\/p>/);
    }
  }
  assert.equal((await request(f, "/health")).status, 200);
});

test("unexpected failures log private causes and return only correlation codes with generic text", async (t) => {
  const f = await fixture(t), upstream = await app(t);
  const opened = JSON.parse((await request(f, "/api/session", { body: { target: upstream.target } })).text);
  const artifact = `/artifact/${opened.artifactToken}/${opened.key}/index.html`;
  await request(f, artifact);
  const privateDetail = "private implementation detail";
  const batchFromDisk = f.store.batchFromDisk;
  f.store.batchFromDisk = () => { throw new Error(privateDetail); };
  const status = await request(f, `/api/status?target=${encodeURIComponent(upstream.target)}`);
  assert.equal(status.status, 500);
  assert.ok(diagnosticFor(status, privateDetail).detail.includes(privateDetail));
  assert.equal(fs.statSync(path.join(stateDir(), "errors.log")).mode & 0o777, 0o600);
  f.store.batchFromDisk = batchFromDisk;
  upstream.server.closeAllConnections();
  await new Promise((resolve) => upstream.server.close(resolve));
  const proxy = await request(f, "/app", { authenticated: false });
  assert.equal(proxy.status, 502);
  assert.match(diagnosticFor(proxy, privateDetail).detail, /ECONNREFUSED/);
  const page = await request(f, artifact);
  assert.equal(page.status, 502);
  assert.match(diagnosticFor(page, privateDetail).detail, /ECONNREFUSED/);
  const file = path.join(f.tmp, "save.html");
  fs.writeFileSync(file, "<p>Original</p>");
  const local = JSON.parse((await request(f, "/api/session", { body: { file } })).text);
  const raw = JSON.parse((await request(f, `/api/page/${local.key}/raw`)).text);
  const rename = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error(privateDetail), { code: "ENOSPC" }); };
  t.after(() => { fs.renameSync = rename; });
  const save = await request(f, `/api/page/${local.key}/save`, { body: { html: "<p>Changed</p>", baseHash: raw.hash } });
  assert.equal(save.status, 500);
  assert.ok(diagnosticFor(save, privateDetail).detail.includes(privateDetail));
  assert.equal(fs.readFileSync(file, "utf8"), "<p>Original</p>");
});

test("a watcher save failure preserves feedback and retries without another source write", async (t) => {
  const f = await fixture(t);
  const rename = fs.renameSync;
  t.after(() => { fs.renameSync = rename; });
  const file = path.join(f.tmp, "watched.html");
  fs.writeFileSync(file, "<p>Original</p>");
  const opened = JSON.parse((await request(f, "/api/session", { body: { file } })).text);
  f.store.addComment(opened.key, { id: "comment", feedback: "Keep this feedback" });
  f.store.addEdit(opened.key, "Body", "edited", "Original", "Edited");
  const before = structuredClone(f.store.page(opened.key));
  const disk = new Store().page(opened.key);
  let failed = false;
  fs.renameSync = () => {
    failed = true;
    throw Object.assign(new Error("injected disk full"), { code: "ENOSPC" });
  };
  fs.writeFileSync(file, "<p>Agent rewrite</p>");
  await waitFor(() => failed);
  assert.deepEqual(f.store.page(opened.key), before, "unsaved edits and comments stay in memory");
  const persisted = new Store().page(opened.key);
  assert.deepEqual(persisted.edits, disk.edits);
  assert.deepEqual(persisted.comments, disk.comments);
  assert.ok(diagnostics().some((entry) => entry.detail.includes("injected disk full")));
  assert.equal((await request(f, "/health")).status, 200);
  fs.renameSync = rename;
  await waitFor(() => f.store.page(opened.key).pristine === "<p>Agent rewrite</p>");
  const after = f.store.page(opened.key);
  assert.equal(after.pristine, "<p>Agent rewrite</p>");
  assert.deepEqual(after.edits, [], "only the successful refresh clears edits already present in HTML");
  assert.deepEqual(after.comments, before.comments);
  assert.equal(fs.readFileSync(file, "utf8"), "<p>Agent rewrite</p>");
  const saved = new Store().page(opened.key);
  assert.equal(saved.pristine, "<p>Agent rewrite</p>");
  assert.deepEqual(saved.edits, []);
  assert.deepEqual(saved.comments, before.comments);
});
