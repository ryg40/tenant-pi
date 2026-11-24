import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { createHash } from "node:crypto";
import { allowedHosts, publicOrigin } from "./allowed-hosts.js";
import { ensureServer } from "./local-server.js";
import { compareRoot, sessionName } from "./compare-store.js";
import { isCanonicalAbsolute } from "./canonical-path.js";
import { posixOnlyRefusal } from "./posix-only.js";
import { connect, disconnect } from "./sheprd-link.js";
import { REMOTE_TIMEOUT_S, configPath, remoteHost, runRemote } from "./compare-remote.js";

const HELP = `walkr-compare [--here] <command> (compatibility: walkr compare)
  create <absolute-request.json>|-             Submit { actionId, workflow, title, brief, options } with 2 or 3 options;
                                               print JSON with the session ID and the private page URL.
                                               With -, the JSON request comes on standard input.
                                               With the key walkrPublicOrigin of the artifacts config file,
                                               url is <public origin>/walkr#<session-id> (no secret) and
                                               localUrl is the private page URL on this computer
  open [<session-id>]                          Print the private page URL of this server run
  list                                         Print the saved sessions, oldest first, with pick and rating
  view <session-id>                            Print one saved record as JSON. It sends no receipt.
  wait <session-id> [--timeout <seconds>]      Wait for the submitted result of the owner (default 240, max 3600).
                                               On a result it confirms the receipt to the page and prints receivedAt;
                                               when the receipt fails, it prints "received": false and the result
  received <session-id>                        Confirm to the page that you read the result (after view);
                                               print { sessionId, receivedAt }
  outcome <session-id> <absolute-request.json>|-
                                               Save { actionId, summary }: what you did with the result
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
A command starts the background Walkr server when none runs for the state directory.
No browser opens automatically.

Remote mode: when the key "remote" of the artifacts config file (~/.config/tenant-artifacts/config.json, or under
XDG_CONFIG_HOME; artifacts setup --remote HOST writes it) names a host, create, open, list, view, wait, received and
outcome run on that host as walkr-compare --here <command>, through one ssh call each. The sessions are then stored
there, and nothing is written on this computer. create and outcome send the request file on standard input.
The page address of create and open is the address that the host prints. A loopback address is valid on that host only.
--here, the first word, runs the command on this computer and reads no key "remote". close, --help and --version
always run here. Exit 3: ssh did not reach the host, the connection ended, the call timed out, or the host has no
walkr-compare. Nothing falls back to this computer. Run wait again after exit 3; retry create and outcome with the
exact same file. Exit 1 with "Invalid Compare arguments." from the host: the host has a walkr-compare without remote
mode. Install this version or a newer one there.
Compare is the one Walkr mode. Core, Double, Coinflip and Trainer are retired (CHANGELOG.md).
`;
const fail = (message) => { throw new Error(message); };
// `open` with an unknown or invalid session ID exits 2, so a caller tells it from a server failure (exit 1).
const unknownSession = (message) => { throw Object.assign(new Error(message), { exitCode: 2 }); };
const stdout = (text) => new Promise((resolve) => process.stdout.write(text, resolve));
const json = (value) => stdout(`${JSON.stringify(value)}\n`);
// An ISO time as the server writes it: a valid date whose `toISOString()` gives the same text. This refuses a date such
// as February 30, and takes the extended years that `toISOString()` writes.
const validTime = (s) => typeof s === "string" && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parse(args) {
  const [command, ...rest] = args;
  const file = (value) => { if (value !== "-" && !path.isAbsolute(value || "")) fail("Supply an absolute JSON request file, or - for standard input."); return value; };
  const session = (value) => { try { return sessionName(value); } catch (error) { fail(error.message); } };
  if (command === "create" && rest.length === 1) return { command, input: file(rest[0]) };
  if (command === "list" && !rest.length) return { command };
  if (command === "open" && rest.length === 1) {
    try { return { command, session: sessionName(rest[0]) }; } catch (error) { unknownSession(error.message); }
  }
  if (command === "open" && !rest.length) return { command };
  if ((command === "view" || command === "received") && rest.length === 1) return { command, session: session(rest[0]) };
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
          return reject(Object.assign(new Error(`Compare ${code}.${message}`), { code }));
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

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// The bytes of the request: the file of the absolute path, or standard input for "-". They must be JSON.
async function readRequest(file) {
  try {
    const bytes = file === "-" ? await readStdin() : await fs.readFile(file);
    JSON.parse(bytes.toString("utf8"));
    return bytes;
  } catch { fail("Cannot read the JSON request. Supply an absolute readable file path, or - for standard input."); }
}

const readJson = async (file) => JSON.parse((await readRequest(file)).toString("utf8"));

/** The words after the program name. A first word --here runs the command on this computer (remote mode is off). */
export async function runCompare(argv) {
  const here = argv[0] === "--here";
  const args = here ? argv.slice(1) : argv;
  if (args.length === 0 || args.length === 1 && ["--help", "-h", "help"].includes(args[0])) return stdout(HELP);
  if (args.length === 1 && args[0] === "close") return json({ sheprd: await disconnect() });
  const refusal = posixOnlyRefusal(); // Before hosted, argument and path checks; help stays available.
  if (refusal) fail(refusal);
  if (process.env.HUMAN_REVIEW_HOSTED === "1") fail("Compare is not available in hosted mode.");
  const host = here ? null : remoteHost();
  if (host) {
    // The words are checked here first, so a refusal of valid words on the host means an older walkr-compare there.
    const options = parse(args);
    if (options.input) {
      const input = await readRequest(options.input);
      const words = options.command === "create" ? ["create", "-"] : ["outcome", options.session, "-"];
      return runRemote(host, options.command, words, { input });
    }
    const seconds = options.command === "wait" ? options.seconds + REMOTE_TIMEOUT_S : REMOTE_TIMEOUT_S;
    return runRemote(host, options.command, args, { seconds });
  }
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
    const local = url(answer.path);
    // With the key walkrPublicOrigin, the owner opens the short address on the public origin: its /walkr redirects to
    // the page, and the browser keeps the fragment. A bad value is a line on standard error and no public address.
    const site = publicOrigin(configPath(), (line) => process.stderr.write(`${line}\n`));
    const made = { ...answer.result, status: answer.view.status, url: site ? `${site.origin}/walkr#${answer.result.sessionId}` : local,
      ...(site ? { localUrl: local } : {}) };
    const sheprd = await connect(local); // Optional link; a failed link never fails the command.
    return json(sheprd === null ? made : { ...made, sheprd });
  }
  if (options.command === "list") return json(await request(server, "sessions"));
  if (options.command === "open") {
    const answer = await request(server, session ?? "page").catch((error) => {
      if (session && error.code === "NOT_FOUND") unknownSession(error.message);
      throw error;
    });
    const page = url(answer.path);
    await connect(page);
    return stdout(`${page}\n`);
  }
  if (options.command === "view") return json((await request(server, session)).view);
  // The receipt: the page shows that the agent has the result. The same time comes back on each call.
  const receive = async () => {
    const answer = await request(server, `${session}/received`, { method: "POST", body: {} });
    // A missing or malformed time is no receipt: `received` then exits 1, and `wait` prints "received": false.
    if (!validTime(answer?.result?.receivedAt)) fail("The server answer did not confirm the receipt with an ISO time.");
    return answer.result.receivedAt;
  };
  if (options.command === "received") return json({ sessionId: options.session, receivedAt: await receive() });
  if (options.command === "outcome") {
    return json((await request(server, `${session}/outcome`, { method: "POST", body: await readJson(options.input) })).result);
  }
  const deadline = Date.now() + options.seconds * 1000;
  for (;;) {
    const { view } = await request(server, session);
    if (view.result) {
      const { actionId, requestSha256, ...result } = view.result;
      const picked = view.options.find((option) => option.optionId === result.pick);
      // A failed receipt (an older server, a network fault) never loses the result: it still prints, with "received": false.
      let receipt;
      try { receipt = { receivedAt: await receive() }; }
      catch (error) {
        receipt = { received: false };
        process.stderr.write(`The page did not get the receipt: ${error.message} Run walkr-compare received ${view.sessionId} to retry it.\n`);
      }
      return json({ status: "ready", sessionId: view.sessionId, ...receipt, result: { ...result, ...(picked ? { pickLabel: picked.label } : {}) }, rating: view.rating?.value ?? null });
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return json({ status: "timeout" });
    await pause(Math.min(500, remaining));
  }
}
