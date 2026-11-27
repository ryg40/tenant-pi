import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { StoreError, hash } from "./store-files.js";
import { FeedbackStore, SCHEMA, VERSION, sessionName } from "./feedback-store.js";
import { POSIX_ONLY_CODE, posixOnlyRefusal } from "./posix-only.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PREFIX = "/_walkr/feedback/";
const STATIC = {
  "/_walkr/feedback/feedback.js": ["feedback.js", "text/javascript; charset=utf-8"],
  "/_walkr/feedback/feedback.css": ["feedback.css", "text/css; charset=utf-8"],
};
// Exact same untrusted HTML sandbox policy as Compare options (src/compare-server.js).
const OPTION_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; sandbox";
const HOST = /^[a-z0-9.-]+:\d{1,5}$/i;
const optionPolicy = (host, publicOrigin) => `${OPTION_CSP}; frame-ancestors 'self'${publicOrigin ? ` ${publicOrigin}` : HOST.test(host ?? "") ? ` http://${host}` : ""}`;
const HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
const STATUS = {
  INVALID_REQUEST: 400, INVALID_ID: 400, UNSAFE_PATH: 400, NOT_FOUND: 404, METHOD_NOT_ALLOWED: 405,
  ACTION_CONFLICT: 409, INVALID_TRANSITION: 409, OUTCOME_EXISTS: 409, FILE_CHANGED: 409,
  UNAUTHORIZED: 401, FORBIDDEN: 403, HOSTED_UNSUPPORTED: 403, [POSIX_ONLY_CODE]: 501,
  WRITE_FAILED: 503, COMMIT_UNCERTAIN: 503, RECOVERY_REQUIRED: 503,
};
const fail = (code, message) => { throw new StoreError(code, message); };

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

function sameOrigin(origin, host) {
  try {
    const sent = new URL(String(origin));
    return sent.protocol === "http:" && sent.href === `${sent.origin}/` && sent.origin === new URL(`http://${host}`).origin;
  } catch { return false; }
}

/**
 * Local-only Feedback routes under /_walkr/feedback/.
 * Shares the page capability (`page.shell`, `page.token`) with Compare so one Walkr page renders both modes.
 */
export function createFeedbackHandler({ token, root, hosted, platform = process.platform, page, pagePath }) {
  let store;
  const opened = () => store ??= new FeedbackStore({ root, platform });

  async function historyRows() {
    let found;
    try { found = await opened().history(); }
    catch (error) {
      return [{
        ref: "unreadable-feedback",
        type: "feedback",
        title: "The Feedback root is not readable",
        time: null,
        state: `Not readable: ${error.code || "UNREADABLE"}`,
        error: error.code || "UNREADABLE",
      }];
    }
    return found.map((entry) => entry.error
      ? { ref: entry.sessionId, type: "feedback", title: entry.sessionId, time: null, state: `Not readable: ${entry.error}`, error: entry.error }
      : { ...entry, ref: entry.sessionId, type: "feedback", time: entry.createdAt });
  }

  async function handle(req, res, { viaFront = false, publicOrigin = null } = {}) {
    const raw = req.url.split("?")[0];
    if (!raw.startsWith(PREFIX)) return false;
    try {
      if (hosted) fail("HOSTED_UNSUPPORTED", "Feedback is local-only. Hosted Feedback is not available.");
      const refusal = posixOnlyRefusal(platform);
      if (refusal) fail(POSIX_ONLY_CODE, refusal);
      if (req.url.includes("?") || raw.includes("#")) fail("INVALID_REQUEST", "Feedback routes do not accept query parameters or fragments.");
      opened();
      const method = (expected) => { if (req.method !== expected) fail("METHOD_NOT_ALLOWED", `Use ${expected} for this operation.`); };
      if (STATIC[raw]) {
        method("GET");
        send(res, 200, await fs.readFile(path.join(here, STATIC[raw][0])), STATIC[raw][1]);
        return true;
      }
      // o/<capability>/<sessionId>/<itemId>/preview or o/<capability>/<sessionId>/<itemId>/<optionId>
      const frame = raw.match(/^\/_walkr\/feedback\/o\/([a-f0-9]+)\/([^/]+)\/([^/]+)\/([^/]+)$/);
      if (frame) {
        if (!matches(frame[1], page.shell)) fail("NOT_FOUND", "This private Walkr URL is unavailable.");
        method("GET");
        const view = await store.read(sessionName(frame[2]));
        const item = view.items.find((entry) => entry.itemId === frame[3]);
        if (!item) fail("NOT_FOUND", "This Feedback session has no item of that name.");
        let served = null;
        if (item.kind === "component") {
          served = frame[4] === "preview" ? item.preview : null;
        } else {
          served = item.options?.find((opt) => opt.optionId === frame[4])?.overview ?? null;
        }
        if (!served || served.format !== "html") fail("NOT_FOUND", "This Feedback item has no HTML preview of that name.");
        send(res, 200, served.content, "text/html; charset=utf-8", { "content-security-policy": optionPolicy(req.headers.host, publicOrigin) });
        return true;
      }
      if (!raw.startsWith(`${PREFIX}api/`)) fail("NOT_FOUND", "Unknown Feedback route.");
      const provided = req.headers["x-human-review-token"];
      const agent = !publicOrigin && matches(provided, token);
      const browser = matches(provided, page.token);
      if (!agent && !browser) fail("UNAUTHORIZED", "A valid x-human-review-token header is required.");
      const route = raw.slice(`${PREFIX}api/`.length);
      const agentOnly = () => { if (!agent) fail("FORBIDDEN", "This operation requires the local agent credential."); };

      if (route === "capabilities") {
        agentOnly(); method("GET");
        send(res, 200, { feedback: 1, rootId: hash(store.root), schema: SCHEMA, version: VERSION });
        return true;
      }
      if (route === "page") {
        agentOnly(); method("GET");
        send(res, 200, { path: pagePath() });
        return true;
      }
      if (route === "sessions") {
        if (req.method === "GET") { send(res, 200, { sessions: await store.list() }); return true; }
        agentOnly(); method("POST");
        const answer = await store.create(await readBody(req));
        send(res, 200, { ...answer, path: pagePath(answer.view.sessionId) });
        return true;
      }
      const match = route.match(/^sessions\/([^/]+)(?:\/(seen|expand|respond|rate|patch|received|outcome))?$/);
      if (!match) fail("NOT_FOUND", "Unknown Feedback API route.");
      const sessionId = sessionName(match[1]);
      const operation = match[2] || "view";
      if (operation === "view") {
        method("GET");
        send(res, 200, { view: await store.read(sessionId), ...(agent ? { path: pagePath(sessionId) } : {}) });
        return true;
      }
      const agentWrite = operation === "patch" || operation === "received" || operation === "outcome";
      if (agentWrite) agentOnly();
      else if (!browser) fail("FORBIDDEN", "Seen, expand, respond and rate come only from the private Walkr page of the user.");
      if (viaFront && !agentWrite && req.headers.origin !== undefined && !sameOrigin(req.headers.origin, req.headers.host)) {
        fail("FORBIDDEN", "This request comes from a page of another origin.");
      }
      if (publicOrigin && !agentWrite && String(req.headers.origin ?? "").toLowerCase() !== publicOrigin) {
        fail("FORBIDDEN", "A page write of the public origin needs its Origin header.");
      }
      method("POST");
      const body = await readBody(req);
      if ((operation === "seen" || operation === "received") && (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length)) {
        fail("INVALID_REQUEST", `${operation === "seen" ? "Seen" : "Received"} expects an empty JSON object.`);
      }
      const calls = {
        seen: "markSeen",
        expand: "requestExpand",
        respond: "respond",
        rate: "rate",
        patch: "patchExpand",
        received: "markReceived",
        outcome: "recordOutcome",
      };
      send(res, 200, await store[calls[operation]](sessionId, body));
    } catch (error) {
      const known = error instanceof StoreError;
      const code = known ? error.code : "INTERNAL_ERROR";
      const message = known ? error.message : "Feedback could not complete this request. Retry the unchanged request after checking the private server.";
      send(res, STATUS[code] || 500, { error: { code, message } });
    }
    return true;
  }

  handle.historyRows = historyRows;
  return handle;
}
