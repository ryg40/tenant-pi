import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { tmpRoot } from "./tmp-root.js";

const tmp = fs.mkdtempSync(path.join(tmpRoot, "human-review-security-"));
process.env.HUMAN_REVIEW_STATE_DIR = path.join(tmp, "state");

const { createServer, start } = await import("../src/server.js");

function request(port, { method = "GET", route = "/", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: route,
        headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, raw }));
      }
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test("the local server refuses strangers", async (t) => {
  const { port, token, dispose } = await start();
  t.after(() => dispose());

  const file = path.join(tmp, "page.html");
  fs.writeFileSync(file, "<!doctype html><html><body><p>Hi</p></body></html>");

  await t.test("api calls without the token are rejected", async () => {
    const res = await request(port, { method: "POST", route: "/api/session", body: { file } });
    assert.equal(res.status, 401);
  });

  await t.test("api calls with the token succeed", async () => {
    const res = await request(port, {
      method: "POST",
      route: "/api/session",
      headers: { "x-human-review-token": token },
      body: { file },
    });
    assert.equal(res.status, 200);
  });

  await t.test("browser modules imported by the review client are served", async () => {
    const res = await request(port, { route: "/chrome-session.js" });
    assert.equal(res.status, 200);
    assert.match(res.raw, /export function replacePage/);
    // sdk.js imports this at boot; if the route vanishes the editor never loads.
    const editing = await request(port, { route: "/editing.js" });
    assert.equal(editing.status, 200);
    assert.match(editing.raw, /export function listCommandFor/);
  });

  await t.test("a DNS-rebound host header is rejected everywhere", async () => {
    const res = await request(port, { route: "/health", headers: { host: "evil.example.com" } });
    assert.equal(res.status, 403);
  });

  await t.test("a host named in HUMAN_REVIEW_ALLOWED_HOSTS is accepted, and only that exact value", async (t) => {
    process.env.HUMAN_REVIEW_ALLOWED_HOSTS = `evil.example.com:1, Review.Example:${port}`;
    t.after(() => { delete process.env.HUMAN_REVIEW_ALLOWED_HOSTS; });
    const from = (host, route) => request(port, { route, headers: { host } }).then((res) => res.status);
    const css = "/_walkr/compare/compare.css";
    assert.equal(await from(`review.example:${port}`, css), 200);
    assert.equal(await from(`review.example:${port}`, "/theme.css"), 200);
    assert.equal(await from("review.example", css), 403);
    assert.equal(await from(`evil.example.com:${port}`, css), 403);
    assert.equal(await from(`x.review.example:${port}`, css), 403);
    // The allowed host opens the Compare page only. The review proxy and the Core routes stay loopback-only.
    for (const route of ["/health", "/", "/api/session", "/private-admin/delete", "/_walkr/double/api/capabilities"]) {
      assert.equal(await from(`review.example:${port}`, route), 403, route);
    }
  });

  await t.test("status reports idle before any feedback is sent", async () => {
    const res = await request(port, {
      route: `/api/status?file=${encodeURIComponent(file)}`,
      headers: { "x-human-review-token": token },
    });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.raw);
    assert.equal(body.status, "idle");
    assert.equal(body.feedback_waiting, false);
    assert.equal(body.server_running, true);
  });

  await t.test("the raw route hands back the on-disk html", async () => {
    const opened = await request(port, {
      method: "POST",
      route: "/api/session",
      headers: { "x-human-review-token": token },
      body: { file },
    });
    const { key } = JSON.parse(opened.raw);
    const res = await request(port, {
      route: `/api/page/${key}/raw`,
      headers: { "x-human-review-token": token },
    });
    assert.equal(res.status, 200);
    assert.match(JSON.parse(res.raw).html, /<p>Hi<\/p>/);
  });

  await t.test("the server record keeps its token private", () => {
    const record = path.join(process.env.HUMAN_REVIEW_STATE_DIR, "server.json");
    const saved = JSON.parse(fs.readFileSync(record, "utf8"));
    assert.equal(saved.token, token);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(record).mode & 0o777, 0o600);
    }
  });
});

test("a loopback Host reaches legacy routes only from a loopback peer", async (t) => {
  const service = createServer();
  t.after(() => service.dispose());
  const [handle] = service.server.listeners("request");
  const status = async (host, remoteAddress, url) => {
    let code;
    await handle({ method: "GET", url, headers: { host }, socket: { localPort: 4802, remoteAddress } }, {
      writeHead(value) { code = value; }, end() {},
    });
    return code;
  };
  for (const host of ["127.0.0.1:4802", "localhost:4802", "[::1]:4802"]) {
    for (const peer of ["198.51.100.8", "2001:db8::8", "::ffff:198.51.100.8", undefined]) {
      assert.equal(await status(host, peer, "/health"), 403);
      assert.equal(await status(host, peer, "/_walkr/compare/api/sessions"), process.platform === "win32" ? 501 : 401);
    }
    for (const peer of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1"]) {
      assert.equal(await status(host, peer, "/health"), 200);
    }
  }
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
