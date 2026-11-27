import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { StoreError, hash } from "./store-files.js";
import { CompareStore, SCHEMA, VERSION, sessionName } from "./compare-store.js";
import { POSIX_ONLY_CODE, posixOnlyRefusal } from "./posix-only.js";
import { withFoot } from "./brand.js";
import { createCompareSocketHub, rejectUpgrade } from "./compare-socket.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PREFIX = "/_walkr/compare/";
const SCRIPT = "text/javascript; charset=utf-8";
const STATIC = {
  "/_walkr/compare/compare-a2ui.js": ["compare-a2ui.js", SCRIPT],
  "/_walkr/compare/app.js": ["compare.js", SCRIPT],
  "/_walkr/compare/a2ui.js": ["a2ui.js", SCRIPT],
  "/_walkr/compare/a2ui.css": ["a2ui.css", "text/css; charset=utf-8"],
  "/_walkr/compare/compare-stars.js": ["compare-stars.js", SCRIPT],
  "/_walkr/compare/feedback.js": ["feedback.js", SCRIPT],
  "/_walkr/compare/feedback.css": ["feedback.css", "text/css; charset=utf-8"],
  "/_walkr/compare/frame-zoom.js": ["frame-zoom.js", SCRIPT],
  "/_walkr/compare/compare.css": ["compare.css", "text/css; charset=utf-8"],
};
// The page frames only option documents of this server. No other origin can frame the page.
const SHELL_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
// An HTML option is untrusted. The sandbox gives it an opaque origin and no scripts; the policy allows no network at all.
// Inline styles, inline SVG and data: images render, so a diagram needs no file beside the option.
const OPTION_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; sandbox";
// Only the page of this server frames an option. The policy also names the origin of the request: an engine that
// compares 'self' with the sandboxed, opaque origin of the option (Servo 0.8) blocks every frame without it.
// The server refuses an unknown Host before this handler; the pattern keeps any other text out of the header.
// An IPv6 literal is not a valid CSP source, so such a Host gets 'self' alone.
const HOST = /^[a-z0-9.-]+:\d{1,5}$/i;
// A request of the public host names the public origin (https) instead.
const optionPolicy = (host, publicOrigin) => `${OPTION_CSP}; frame-ancestors 'self'${publicOrigin ? ` ${publicOrigin}` : HOST.test(host ?? "") ? ` http://${host}` : ""}`;
const HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
const STATUS = {
  INVALID_REQUEST: 400, INVALID_ID: 400, UNSAFE_PATH: 400, NOT_FOUND: 404, METHOD_NOT_ALLOWED: 405,
  ACTION_CONFLICT: 409, INVALID_TRANSITION: 409, OUTCOME_EXISTS: 409, FILE_CHANGED: 409,
  UNAUTHORIZED: 401, FORBIDDEN: 403, HOSTED_UNSUPPORTED: 403, [POSIX_ONLY_CODE]: 501,
  WRITE_FAILED: 503, COMMIT_UNCERTAIN: 503, RECOVERY_REQUIRED: 503,
};
const fail = (code, message) => { throw new StoreError(code, message); };
const secret = () => randomBytes(32).toString("hex");
// The sections of the local web app, for a page that a local front passes (the artifacts server of the kit): the same
// three links as in the band of each section there. On the own port of the Walkr server these paths do not exist, so
// the page has the links only through a front. The last link ends the login session of the artifacts server.
const SECTIONS = '<nav class="app-nav" aria-label="Sections"><a href="/artifacts">Artifacts</a>' +
  '<a href="/walkr" aria-current="page">Walkr</a><a href="/memory/">Memory</a>' +
  '<a class="logout" href="/logout">Log out</a></nav>';
const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

/** How to start a Compare session, as static HTML: the page shows it while no session exists. */
function guidance(mirror) {
  return `<p>Launch name: <code>walkr-compare</code>. An agent starts a session with <code>walkr-compare create</code> and 2 or 3 prepared options.</p>
      <p>${mirror ? "This read-only page shows the result. Pick, rate and submit on the Walkr page of the computer that made the session." : "<code>walkr-compare open</code> prints the private URL of this page. You pick one option, comment, submit and rate here."}</p>`;
}

function matches(provided, expected) {
  const a = Buffer.from(String(provided || ""));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res, status, body, type = "application/json; charset=utf-8", headers = {}) {
  res.writeHead(status, { ...HEADERS, "content-type": type, ...headers });
  res.end(type.startsWith("application/json") ? JSON.stringify(body) : body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) fail("INVALID_REQUEST", "The JSON request exceeds 8 MiB.");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { fail("INVALID_REQUEST", "Supply a JSON request body."); }
}

// Canonical compare: lower-case host name, numeric port (80 when absent). `null` and other schemes never match.
function sameOrigin(origin, host) {
  try {
    const sent = new URL(String(origin));
    return sent.protocol === "http:" && sent.href === `${sent.origin}/` && sent.origin === new URL(`http://${host}`).origin;
  } catch { return false; }
}

/**
 * Local-only Compare routes under /_walkr/compare/.
 * The agent credential creates sessions, reads them, confirms that it received a submitted result and records its
 * outcome. It cannot submit, rate or mark a session as seen: only the credential of the private page can. The page
 * credential cannot send the receipt or the outcome. The page is one view of every session of the root, with one
 * capability URL for each server run. The agent relays that URL to the owner and can therefore reach the page
 * credential, so this split guards against mistakes, not against a hostile or steered agent.
 */
/**
 * The page lists the Compare sessions of the root, newest first. `mirror` marks the read-only mirror: the start
 * guidance then says that this page cannot take a pick.
 */
export function createCompareHandler({ token, root, hosted, platform = process.platform, mirror = false, onSocketActivity = null, socketPoll = null, page: sharedPage = null, extraHistoryRows = null }) {
  let store;
  const opened = () => store ??= new CompareStore({ root, platform });
  // One shared submit function for the private page HTTP route and the local A2UI WebSocket route.
  const submitSession = (sessionId, body) => opened().submit(sessionName(sessionId), body);
  const sockets = createCompareSocketHub({ getStore: opened, submitSession, onActivity: onSocketActivity, errorHeaders: HEADERS, poll: socketPoll });
  const guide = `<template data-guide="compare">${guidance(mirror)}</template>`;
  const page = sharedPage ?? { shell: secret(), token: secret() };
  const SESSION_TIME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/;
  const sessionTime = (id) => { const m = SESSION_TIME.exec(id ?? ""); return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z` : ""; };
  async function rows() {
    let list;
    try {
      const found = await store.history();
      list = found.map((entry) => entry.error
        ? { ref: entry.sessionId, type: "compare", title: entry.sessionId, time: null, state: `Not readable: ${entry.error}`, error: entry.error }
        : { ...entry, ref: entry.sessionId, type: "compare", time: entry.createdAt });
    } catch (error) {
      list = [{ ref: "unreadable", type: "compare", title: "The Compare root is not readable", time: null, state: `Not readable: ${error.code || "UNREADABLE"}`, error: error.code || "UNREADABLE" }];
    }
    if (extraHistoryRows) list = [...list, ...(await extraHistoryRows())];
    return list.sort((a, b) => String(b.time ?? sessionTime(b.ref)).localeCompare(String(a.time ?? sessionTime(a.ref))));
  }
  const pagePath = (sessionId) => `${PREFIX}g/${page.shell}${sessionId ? `#${sessionId}` : ""}`;

  // `viaFront`: only the any-port loopback Host of a local front admitted the request (src/server.js).
  // `publicOrigin`: the request has the host of the public origin (walkrPublicOrigin). The agent token is then never
  // valid, so the agent routes refuse it, and a page write needs an Origin header equal to that origin.
  async function handle(req, res, { viaFront = false, publicOrigin = null } = {}) {
    const raw = req.url.split("?")[0];
    if (!raw.startsWith(PREFIX)) return false;
    try {
      if (hosted) fail("HOSTED_UNSUPPORTED", "Compare is local-only. Hosted Compare is not available.");
      const refusal = posixOnlyRefusal(platform);
      if (refusal) fail(POSIX_ONLY_CODE, refusal);
      if (req.url.includes("?") || raw.includes("#")) fail("INVALID_REQUEST", "Compare routes do not accept query parameters or fragments.");
      opened();
      const method = (expected) => { if (req.method !== expected) fail("METHOD_NOT_ALLOWED", `Use ${expected} for this operation.`); };
      if (STATIC[raw]) {
        method("GET");
        send(res, 200, await fs.readFile(path.join(here, STATIC[raw][0])), STATIC[raw][1]);
        return true;
      }
      if (raw.startsWith(`${PREFIX}g/`)) {
        if (!matches(raw.slice(`${PREFIX}g/`.length), page.shell)) fail("NOT_FOUND", "This private Compare URL is unavailable. Use walkr-compare open for a new one.");
        method("GET");
        const shell = withFoot(await fs.readFile(path.join(here, "compare.html"), "utf8"));
        const values = { __TOKEN__: page.token, __FRAMES__: `${PREFIX}o/${page.shell}`, __FEEDBACK_FRAMES__: `/_walkr/feedback/o/${page.shell}` };
        send(res, 200, shell.replace(/__TOKEN__|__FRAMES__|__FEEDBACK_FRAMES__/g, (name) => escapeHtml(values[name])).replace("<!--walkr-guides-->", guide)
          .replace("<!--walkr-sections-->", viaFront ? SECTIONS : ""),
          "text/html; charset=utf-8", { "content-security-policy": SHELL_CSP });
        return true;
      }
      // o/<capability>/<session>/<optionId>: an HTML option. o/<capability>/<session>/next/<roundId>: the HTML preview of
      // a next round. Both get the same policy, so a preview has no right that an option frame does not have.
      const frame = raw.match(/^\/_walkr\/compare\/o\/([a-f0-9]+)\/([^/]+)\/(?:(next)\/)?([^/]+)$/);
      if (frame) {
        if (!matches(frame[1], page.shell)) fail("NOT_FOUND", "This private Compare URL is unavailable.");
        method("GET");
        const view = await store.read(sessionName(frame[2]));
        const served = frame[3]
          ? view.nextRounds?.find((item) => item.roundId === frame[4])?.preview
          : view.options.find((item) => item.optionId === frame[4]);
        if (!served || served.format !== "html") fail("NOT_FOUND", frame[3] ? "This session has no HTML preview of that next round." : "This session has no HTML option of that name.");
        send(res, 200, served.content, "text/html; charset=utf-8", { "content-security-policy": optionPolicy(req.headers.host, publicOrigin) });
        return true;
      }
      if (!raw.startsWith(`${PREFIX}api/`)) fail("NOT_FOUND", "Unknown Compare route.");
      const provided = req.headers["x-human-review-token"];
      const agent = !publicOrigin && matches(provided, token);
      const browser = matches(provided, page.token);
      if (!agent && !browser) fail("UNAUTHORIZED", "A valid x-human-review-token header is required.");
      const route = raw.slice(`${PREFIX}api/`.length);
      const agentOnly = () => { if (!agent) fail("FORBIDDEN", "This operation requires the local agent credential."); };

      if (route === "capabilities") {
        agentOnly(); method("GET");
        send(res, 200, { compare: 1, rootId: hash(store.root), schema: SCHEMA, version: VERSION });
        return true;
      }
      if (route === "page") {
        agentOnly(); method("GET");
        send(res, 200, { path: pagePath() });
        return true;
      }
      // The rows of the page: one for each Compare session of the root, newest first. A record that cannot be read
      // gives one row with an error. No other record type is read.
      if (route === "history") {
        method("GET");
        send(res, 200, { rows: await rows() });
        return true;
      }
      if (route === "sessions") {
        if (req.method === "GET") { send(res, 200, { sessions: await store.list() }); return true; }
        agentOnly(); method("POST");
        const answer = await store.create(await readBody(req));
        sockets.notify(answer.view.sessionId, answer);
        send(res, 200, { ...answer, path: pagePath(answer.view.sessionId) });
        return true;
      }
      const match = route.match(/^sessions\/([^/]+)(?:\/(seen|submit|rate|outcome|received))?$/);
      if (!match) fail("NOT_FOUND", "Unknown Compare API route.");
      const sessionId = sessionName(match[1]);
      const operation = match[2] || "view";
      if (operation === "view") {
        method("GET");
        send(res, 200, { view: await store.read(sessionId), ...(agent ? { path: pagePath(sessionId) } : {}) });
        return true;
      }
      // The receipt and the outcome are writes of the agent. The other writes come from the page.
      const agentWrite = operation === "outcome" || operation === "received";
      if (agentWrite) agentOnly();
      else if (!browser) fail("FORBIDDEN", "The pick, the rating and the seen mark come only from the private Compare page of the user.");
      // Through a local front, a page write with an Origin must name the HTTP origin of the Host. No Origin passes.
      if (viaFront && !agentWrite && req.headers.origin !== undefined && !sameOrigin(req.headers.origin, req.headers.host)) {
        fail("FORBIDDEN", "This request comes from a page of another origin.");
      }
      // Through the public origin, a page write needs one Origin header with exactly that origin.
      if (publicOrigin && !agentWrite && String(req.headers.origin ?? "").toLowerCase() !== publicOrigin) {
        fail("FORBIDDEN", "A page write of the public origin needs its Origin header.");
      }
      method("POST");
      const body = await readBody(req);
      if ((operation === "seen" || operation === "received") && (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length)) {
        fail("INVALID_REQUEST", `${operation === "seen" ? "Seen" : "Received"} expects an empty JSON object.`);
      }
      if (operation === "submit") {
        const answer = await submitSession(sessionId, body);
        sockets.notify(sessionId, answer);
        send(res, 200, answer);
      } else {
        const call = { seen: "markSeen", rate: "rate", outcome: "recordOutcome", received: "markReceived" }[operation];
        send(res, 200, await store[call](sessionId, body));
      }
    } catch (error) {
      const known = error instanceof StoreError;
      const code = known ? error.code : "INTERNAL_ERROR";
      const message = known ? error.message : "Compare could not complete this request. Retry the unchanged request after checking the private server.";
      send(res, STATUS[code] || 500, { error: { code, message } });
    }
    return true;
  }

  /**
   * Local-only A2UI WebSocket upgrade at GET /_walkr/compare/a/<capability>.
   * Uses the page capability for submit only; refuses hosted, mirror, public origin, query/fragment and any Origin.
   */
  handle.upgrade = function upgrade(req, socket, head, { publicOrigin = null } = {}) {
    const url = String(req.url || "");
    const raw = url.split("?")[0];
    if (!raw.startsWith(`${PREFIX}a/`)) return false;
    const deny = (code, message) => {
      rejectUpgrade(socket, STATUS[code] || 500, { error: { code, message } }, { headers: HEADERS });
      return true;
    };
    if (hosted) return deny("HOSTED_UNSUPPORTED", "Compare is local-only. Hosted Compare is not available.");
    if (mirror) return deny("FORBIDDEN", "The A2UI socket is not available on a read-only mirror.");
    if (publicOrigin) return deny("FORBIDDEN", "The A2UI socket is local-only.");
    const refusal = posixOnlyRefusal(platform);
    if (refusal) return deny(POSIX_ONLY_CODE, refusal);
    if (url.includes("?") || raw.includes("#")) return deny("INVALID_REQUEST", "Compare routes do not accept query parameters or fragments.");
    if (req.headers.origin !== undefined) return deny("FORBIDDEN", "The A2UI socket refuses Origin headers.");
    if (req.method !== "GET") return deny("METHOD_NOT_ALLOWED", "Use GET for this operation.");
    if (!matches(raw.slice(`${PREFIX}a/`.length), page.shell)) {
      return deny("NOT_FOUND", "This private Compare URL is unavailable. Use walkr-compare open for a new one.");
    }
    sockets.upgrade(req, socket, head);
    return true;
  };
  handle.openSockets = () => sockets.openSockets();
  handle.close = () => sockets.close();
  handle.page = page;
  handle.pagePath = pagePath;

  return handle;
}
