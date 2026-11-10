import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { DoubleStoreError, hash } from "./double-archive.js";
import { escapeHtml } from "./hosted.js";
import { CompareStore, SCHEMA, VERSION, sessionName } from "./compare-store.js";
import { POSIX_ONLY_CODE, posixOnlyRefusal } from "./posix-only.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PREFIX = "/_walkr/compare/";
const SCRIPT = "text/javascript; charset=utf-8";
const STATIC = {
  "/_walkr/compare/app.js": ["compare.js", SCRIPT],
  "/_walkr/compare/compare-stars.js": ["compare-stars.js", SCRIPT],
  "/_walkr/compare/frame-zoom.js": ["frame-zoom.js", SCRIPT],
  "/_walkr/compare/compare.css": ["compare.css", "text/css; charset=utf-8"],
};
// The page frames only option documents of this server. No other origin can frame the page.
const SHELL_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
// An HTML option is untrusted. The sandbox gives it an opaque origin and no scripts; the policy allows no network at all.
// Inline styles, inline SVG and data: images render, so a diagram needs no file beside the option.
const OPTION_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox";
const HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
const STATUS = {
  INVALID_REQUEST: 400, INVALID_ID: 400, UNSAFE_PATH: 400, NOT_FOUND: 404, METHOD_NOT_ALLOWED: 405,
  ACTION_CONFLICT: 409, INVALID_TRANSITION: 409, OUTCOME_EXISTS: 409, FILE_CHANGED: 409,
  UNAUTHORIZED: 401, FORBIDDEN: 403, HOSTED_UNSUPPORTED: 403, [POSIX_ONLY_CODE]: 501,
  WRITE_FAILED: 503, COMMIT_UNCERTAIN: 503, RECOVERY_REQUIRED: 503,
};
const fail = (code, message) => { throw new DoubleStoreError(code, message); };
const secret = () => randomBytes(32).toString("hex");

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

/**
 * Local-only Compare routes under /_walkr/compare/.
 * The agent credential creates sessions, reads them and records its outcome. It cannot submit, rate or mark a session
 * as seen: only the credential of the private page can. The page is one view of every session of the root, with one
 * capability URL for each server run. The agent relays that URL to the owner and can therefore reach the page
 * credential, so this split guards against mistakes, not against a hostile or steered agent.
 */
export function createCompareHandler({ token, root, hosted, platform = process.platform }) {
  let store;
  const opened = () => store ??= new CompareStore({ root, platform });
  const page = { shell: secret(), token: secret() };
  const pagePath = (sessionId) => `${PREFIX}g/${page.shell}${sessionId ? `#${sessionId}` : ""}`;

  return async function handle(req, res) {
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
        const shell = await fs.readFile(path.join(here, "compare.html"), "utf8");
        send(res, 200, shell.replace(/__TOKEN__|__FRAMES__/g, (name) => escapeHtml(name === "__TOKEN__" ? page.token : `${PREFIX}o/${page.shell}`)),
          "text/html; charset=utf-8", { "content-security-policy": SHELL_CSP });
        return true;
      }
      const frame = raw.match(/^\/_walkr\/compare\/o\/([a-f0-9]+)\/([^/]+)\/([^/]+)$/);
      if (frame) {
        if (!matches(frame[1], page.shell)) fail("NOT_FOUND", "This private Compare URL is unavailable.");
        method("GET");
        const view = await store.read(sessionName(frame[2]));
        const option = view.options.find((item) => item.optionId === frame[3]);
        if (!option || option.format !== "html") fail("NOT_FOUND", "This session has no HTML option of that name.");
        send(res, 200, option.content, "text/html; charset=utf-8", { "content-security-policy": OPTION_CSP });
        return true;
      }
      if (!raw.startsWith(`${PREFIX}api/`)) fail("NOT_FOUND", "Unknown Compare route.");
      const provided = req.headers["x-human-review-token"];
      const agent = matches(provided, token);
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
      if (route === "sessions") {
        if (req.method === "GET") { send(res, 200, { sessions: await store.list() }); return true; }
        agentOnly(); method("POST");
        const answer = await store.create(await readBody(req));
        send(res, 200, { ...answer, path: pagePath(answer.view.sessionId) });
        return true;
      }
      const match = route.match(/^sessions\/([^/]+)(?:\/(seen|submit|rate|outcome))?$/);
      if (!match) fail("NOT_FOUND", "Unknown Compare API route.");
      const sessionId = sessionName(match[1]);
      const operation = match[2] || "view";
      if (operation === "view") {
        method("GET");
        send(res, 200, { view: await store.read(sessionId), ...(agent ? { path: pagePath(sessionId) } : {}) });
        return true;
      }
      if (operation === "outcome") agentOnly();
      else if (!browser) fail("FORBIDDEN", "The pick, the rating and the seen mark come only from the private Compare page of the user.");
      method("POST");
      const body = await readBody(req);
      if (operation === "seen" && (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length)) {
        fail("INVALID_REQUEST", "Seen expects an empty JSON object.");
      }
      const call = { seen: "markSeen", submit: "submit", rate: "rate", outcome: "recordOutcome" }[operation];
      send(res, 200, await store[call](sessionId, body));
    } catch (error) {
      const known = error instanceof DoubleStoreError;
      const code = known ? error.code : "INTERNAL_ERROR";
      const message = known ? error.message : "Compare could not complete this request. Retry the unchanged request after checking the private server.";
      send(res, STATUS[code] || 500, { error: { code, message } });
    }
    return true;
  };
}
