#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createCompareHandler } from "../src/compare-server.js";
import { compareRoot } from "../src/compare-store.js";
import { allowedHosts } from "../src/allowed-hosts.js";

const src = fileURLToPath(new URL("../src/", import.meta.url));
const PREFIX = "/_walkr/compare/";
const HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
// The file name comes from this table, never from the request.
const THEME = { "/theme.css": ["theme.css", "text/css; charset=utf-8"], "/theme.js": ["theme.js", "text/javascript; charset=utf-8"] };
const READ_ONLY = "This page is a read-only mirror. Pick, rate and submit on the Walkr page of the computer that made the session.";

function json(res, status, body) {
  res.writeHead(status, { ...HEADERS, "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/**
 * A persistent, read-only Compare page over one root of session records. It is optional: no install step of the kit
 * starts it. It writes nothing and accepts GET only, so the root can be a read-only copy of the records of other
 * computers. The address `/` always leads to the page, also after a restart. The server has no login of its own:
 * each client that reaches the port reads each session. Keep it on loopback or behind a proxy that asks for a login.
 */
export async function startMirror({ root = compareRoot(), port = 0, bind = "127.0.0.1", hosts = allowedHosts() } = {}) {
  const agent = randomBytes(32).toString("hex");
  const compare = createCompareHandler({ token: agent, root, hosted: false });
  let page;

  const server = http.createServer(async (req, res) => {
    try {
      const pathname = req.url.split("?")[0];
      const bound = server.address().port;
      const host = String(req.headers.host || "").toLowerCase();
      // The Host check refuses a DNS-rebound name, as the local Walkr server does.
      if (![`127.0.0.1:${bound}`, `localhost:${bound}`, `[::1]:${bound}`, ...hosts].includes(host)) {
        return json(res, 403, { error: { code: "FORBIDDEN", message: "This Host is not allowed. Name it in HUMAN_REVIEW_ALLOWED_HOSTS." } });
      }
      if (req.method !== "GET") return json(res, 403, { error: { code: "READ_ONLY", message: READ_ONLY } });
      if (pathname === "/health") return json(res, 200, { ok: true });
      if (pathname === "/" || pathname === PREFIX || pathname === PREFIX.slice(0, -1)) {
        res.writeHead(302, { ...HEADERS, location: page });
        return res.end();
      }
      if (Object.hasOwn(THEME, pathname)) {
        const [file, type] = THEME[pathname];
        res.writeHead(200, { ...HEADERS, "content-type": type });
        return res.end(await fs.readFile(path.join(src, file)));
      }
      // The agent credential stays inside this process: a client never sends it.
      if (pathname.startsWith(PREFIX) && pathname !== `${PREFIX}api/page` && pathname !== `${PREFIX}api/capabilities`) {
        return void await compare(req, res);
      }
      json(res, 404, { error: { code: "NOT_FOUND", message: "Unknown route of the Compare mirror." } });
    } catch {
      if (!res.headersSent) json(res, 500, { error: { code: "INTERNAL_ERROR", message: "The Compare mirror could not complete this request." } });
      else res.end();
    }
  });

  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, bind, resolve); });
  // The page path holds the secret of this run. Read it one time through the handler itself.
  const answer = await new Promise((resolve, reject) => {
    const fake = { url: `${PREFIX}api/page`, method: "GET", headers: { "x-human-review-token": agent } };
    const sink = { writeHead(status) { this.status = status; }, end(body) { this.status === 200 ? resolve(JSON.parse(body)) : reject(new Error(String(body))); } };
    compare(fake, sink).catch(reject);
  });
  page = answer.path;
  return { server, port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { port } = await startMirror({ port: Number(process.env.HUMAN_REVIEW_PORT || 0), bind: process.env.HUMAN_REVIEW_BIND || "127.0.0.1" });
    console.log(`Walkr Compare mirror (read-only): port ${port}, root ${compareRoot()}`);
  } catch (error) {
    console.error(`walkr mirror: ${error.message}`);
    process.exit(1);
  }
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => process.exit(0));
}
