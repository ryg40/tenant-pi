import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { createHash } from "node:crypto";
import { allowedHosts } from "./allowed-hosts.js";
import { ensureServer } from "./local-server.js";
import { compareRoot, sessionName } from "./compare-store.js";
import { isCanonicalAbsolute } from "./canonical-path.js";
import { posixOnlyRefusal } from "./posix-only.js";
import { connect, disconnect } from "./sheprd-link.js";

const HELP = `walkr-compare (compatibility: walkr compare)
  create <absolute-request.json>               Submit { actionId, workflow, title, brief, options } with 2 or 3 options;
                                               print JSON with the session ID and the private page URL
  open [<session-id>]                          Print the private page URL of this server run
  list                                         Print the saved sessions, oldest first, with pick and rating
  view <session-id>                            Print one saved record as JSON
  wait <session-id> [--timeout <seconds>]      Wait for the submitted result of the owner (default 240, max 3600)
  outcome <session-id> <absolute-request.json> Save { actionId, summary }: what you did with the result
  close                                        Tell Sheprd that the run ended; print { "sheprd": ... }. Starts no server.
                                               It does not close the page in Sheprd: Sheprd keeps it open for a rating.

An option has { optionId, label, format, content } and an optional summary. format is html, text or markdown.
Optional request fields: clarifications [{ question, answer }], repo { name, revision }, source { label, format, content }.
An HTML option shows in a sandboxed frame without scripts and without network. Inline styles, inline SVG
and data: images work. Text and Markdown show as plain text. With a source, the page can mark the changed words.

Sessions are saved under HUMAN_REVIEW_COMPARE_ROOT, default ~/.local/.walkr/compare, as
<root>/sessions/<timestamped-session-id>/session.json. Records are never deleted.
The page lists every session, the newest first, and marks a session as new until the owner opens it.
Only the private page of the owner records the pick, the comments and the rating (1 to 10, one point for each
half star). Relay the page URL to the owner; never open it, pick or rate.
Retry an uncertain request with the exact same file and action ID.
A command starts the background Walkr server when none runs for the state directory, as walkr-core does.
Compare is local-only; hosted Compare is not available. No browser opens automatically.
Modes: walkr-core, walkr-double, walkr-coinflip, walkr-trainer, walkr-compare.
`;
const fail = (message) => { throw new Error(message); };
const stdout = (text) => new Promise((resolve) => process.stdout.write(text, resolve));
const json = (value) => stdout(`${JSON.stringify(value)}\n`);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parse(args) {
  const [command, ...rest] = args;
  const file = (value) => { if (!path.isAbsolute(value || "")) fail("Supply an absolute JSON request file."); return value; };
  const session = (value) => { try { return sessionName(value); } catch (error) { fail(error.message); } };
  if (command === "create" && rest.length === 1) return { command, input: file(rest[0]) };
  if (command === "list" && !rest.length) return { command };
  if (command === "open" && rest.length <= 1) return { command, ...(rest.length ? { session: session(rest[0]) } : {}) };
  if (command === "view" && rest.length === 1) return { command, session: session(rest[0]) };
  if (command === "outcome" && rest.length === 2) return { command, session: session(rest[0]), input: file(rest[1]) };
  if (command === "wait" && (rest.length === 1 || rest.length === 3 && rest[1] === "--timeout")) {
    const seconds = rest.length === 1 ? 240 : Number(rest[2]);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) fail("--timeout requires seconds greater than zero and at most 3600.");
    return { command, session: session(rest[0]), seconds };
  }
  fail("Invalid Compare arguments. Use walkr-compare --help.");
}

function request(server, route, { method = "GET", body, timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.port, path: `/_walkr/compare/api/${route}`, method,
      headers: { "x-human-review-token": server.token, "content-type": "application/json" } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("error", () => reject(new Error("Compare response ended early. Retry mutations with the exact original request.")));
      res.on("end", () => {
        let value;
        try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { return reject(new Error("The running Walkr server has no Compare support. It was not replaced. Stop the old server, then run the command again.")); }
        if (res.statusCode !== 200) {
          const code = /^[A-Z_]+$/.test(value?.error?.code) ? value.error.code : `HTTP_${res.statusCode}`;
          const message = typeof value?.error?.message === "string" ? ` ${value.error.message.slice(0, 300)}` : "";
          return reject(new Error(`Compare ${code}.${message}`));
        }
        resolve(value);
      });
    });
    const timer = setTimeout(() => req.destroy(), timeout);
    req.once("close", () => clearTimeout(timer));
    req.on("error", () => reject(new Error("The Walkr server is unavailable. Retry mutations with the exact original request.")));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch { fail("Cannot read the JSON request. Supply an absolute readable file path."); }
}

export async function runCompare(args) {
  if (args.length === 0 || args.length === 1 && ["--help", "-h", "help"].includes(args[0])) return stdout(HELP);
  if (args.length === 1 && args[0] === "close") return json({ sheprd: await disconnect() });
  const refusal = posixOnlyRefusal(); // Before hosted, argument and path checks; help stays available.
  if (refusal) fail(refusal.replace("Double, Coinflip, the shared GUI and Trainer need", "Compare needs"));
  if (process.env.HUMAN_REVIEW_HOSTED === "1") fail("Compare is not available in hosted mode.");
  const root = compareRoot();
  if (!isCanonicalAbsolute(root)) fail("HUMAN_REVIEW_COMPARE_ROOT must be a canonical absolute directory.");
  const options = parse(args);
  const server = await ensureServer();
  const capability = await request(server, "capabilities");
  if (capability.compare !== 1 || capability.rootId !== createHash("sha256").update(root).digest("hex")) {
    fail("The running Walkr server uses a different Compare root. It was not replaced. Set the same HUMAN_REVIEW_COMPARE_ROOT, or stop that server.");
  }
  // The first allowed host with the port of this server is the address that the owner uses from another computer.
  const remote = allowedHosts().find((host) => host.endsWith(`:${server.port}`));
  const url = (route) => `http://${remote || `127.0.0.1:${server.port}`}${route}`;
  const session = options.session && `sessions/${options.session}`;
  if (options.command === "create") {
    const answer = await request(server, "sessions", { method: "POST", body: await readJson(options.input) });
    const made = { ...answer.result, status: answer.view.status, url: url(answer.path) };
    const sheprd = await connect(made.url); // Optional link; a failed link never fails the command.
    return json(sheprd === null ? made : { ...made, sheprd });
  }
  if (options.command === "list") return json(await request(server, "sessions"));
  if (options.command === "open") {
    const page = url((await request(server, session ?? "page")).path);
    await connect(page);
    return stdout(`${page}\n`);
  }
  if (options.command === "view") return json((await request(server, session)).view);
  if (options.command === "outcome") {
    return json((await request(server, `${session}/outcome`, { method: "POST", body: await readJson(options.input) })).result);
  }
  const deadline = Date.now() + options.seconds * 1000;
  for (;;) {
    const { view } = await request(server, session);
    if (view.result) {
      const { actionId, requestSha256, ...result } = view.result;
      const picked = view.options.find((option) => option.optionId === result.pick);
      return json({ status: "ready", sessionId: view.sessionId, result: { ...result, ...(picked ? { pickLabel: picked.label } : {}) }, rating: view.rating?.value ?? null });
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return json({ status: "timeout" });
    await pause(Math.min(500, remaining));
  }
}
