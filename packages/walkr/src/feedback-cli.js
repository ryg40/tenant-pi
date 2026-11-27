import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { createHash } from "node:crypto";
import { allowedHosts, publicOrigin } from "./allowed-hosts.js";
import { ensureServer } from "./local-server.js";
import { feedbackRoot, sessionName } from "./feedback-store.js";
import { isCanonicalAbsolute } from "./canonical-path.js";
import { posixOnlyRefusal } from "./posix-only.js";
import { connect, disconnect } from "./sheprd-link.js";
import { REMOTE_TIMEOUT_S, configPath, remoteHost, runRemote } from "./compare-remote.js";

const HELP = `walkr-feedback [--here] <command> (compatibility: walkr feedback)
  create <absolute-request.json>|-             Submit { actionId, workflow, title, brief, items } (1 to 12 items);
                                               print JSON with the session ID and the private page URL.
                                               With -, the JSON request comes on standard input.
  open [<session-id>]                          Print the private page URL of this server run
  list                                         Print the saved Feedback sessions, oldest first
  view <session-id>                            Print one saved Feedback record as JSON (sends no receipt)
  wait <session-id> [--timeout <seconds>] [--after-revision <n>]
                                               Wait for an Expand request or a submitted item/session response
                                               (default timeout 240 s, max 3600 s). Returns status "expand",
                                               "ready" (with receipt confirmed), or "timeout".
  patch <session-id> <absolute-patch.json>|-   Fulfill a pending Expand request with { actionId, itemId, options }
                                               containing rich explanations and small HTML/text concept overviews
  received <session-id>                        Confirm to the page that you read the latest response (after view)
  outcome <session-id> <absolute-outcome.json>|-
                                               Save { actionId, summary }: what you did with the result
  close                                        Tell Sheprd that the run ended; print { "sheprd": ... }. Starts no server.

Item kinds: component (preview + comment + Accept/Another round), decision or grill (2-3 options where option 1 starts
expanded with explanation + small HTML concept overview, and options 2-3 can set expandable: true for lazy expansion).
Optional parentId and branchLabel arrange items into a deterministic decision tree.
Action presets: accept-revise, submit-revise, accept-only, submit-only.

Sessions are saved under HUMAN_REVIEW_FEEDBACK_ROOT, default ~/.local/.walkr/feedback.
`;

const fail = (message) => { throw new Error(message); };
const unknownSession = (message) => { throw Object.assign(new Error(message), { exitCode: 2 }); };
const stdout = (text) => new Promise((resolve) => process.stdout.write(text, resolve));
const json = (value) => stdout(`${JSON.stringify(value)}\n`);
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
  if ((command === "patch" || command === "outcome") && rest.length === 2) return { command, session: session(rest[0]), input: file(rest[1]) };
  if (command === "wait" && rest.length >= 1) {
    const id = session(rest[0]);
    let seconds = 240;
    let afterRevision = 0;
    for (let i = 1; i < rest.length; i += 2) {
      const flag = rest[i];
      const raw = rest[i + 1];
      if (raw === undefined) fail("Invalid Feedback arguments. Use walkr-feedback --help.");
      if (flag === "--timeout") {
        seconds = Number(raw);
        if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) {
          fail("--timeout requires seconds greater than zero and at most 3600.");
        }
      } else if (flag === "--after-revision") {
        afterRevision = Number(raw);
        if (!Number.isInteger(afterRevision) || afterRevision < 0) {
          fail("--after-revision requires a non-negative integer.");
        }
      } else {
        fail("Invalid Feedback arguments. Use walkr-feedback --help.");
      }
    }
    return { command, session: id, seconds, afterRevision };
  }
  fail("Invalid Feedback arguments. Use walkr-feedback --help.");
}

function request(server, route, { method = "GET", body, timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port: server.port, path: `/_walkr/feedback/api/${route}`, method,
      headers: { "x-human-review-token": server.token, "content-type": "application/json" },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("error", () => reject(new Error("Feedback response ended early. Retry mutations with the exact original request.")));
      res.on("end", () => {
        let value;
        try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { return reject(new Error("The running Walkr server has no Feedback support. Stop the old server, then run the command again.")); }
        if (res.statusCode !== 200) {
          const code = /^[A-Z_]+$/.test(value?.error?.code) ? value.error.code : `HTTP_${res.statusCode}`;
          const message = typeof value?.error?.message === "string" ? ` ${value.error.message.slice(0, 300)}` : "";
          return reject(Object.assign(new Error(`Feedback ${code}.${message}`), { code }));
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

async function readRequest(file) {
  try {
    const bytes = file === "-" ? await readStdin() : await fs.readFile(file);
    JSON.parse(bytes.toString("utf8"));
    return bytes;
  } catch { fail("Cannot read the JSON request. Supply an absolute readable file path, or - for standard input."); }
}

const readJson = async (file) => JSON.parse((await readRequest(file)).toString("utf8"));

export async function runFeedback(argv) {
  const here = argv[0] === "--here";
  const args = here ? argv.slice(1) : argv;
  if (args.length === 0 || args.length === 1 && ["--help", "-h", "help"].includes(args[0])) return stdout(HELP);
  if (args.length === 1 && args[0] === "close") return json({ sheprd: await disconnect() });
  const refusal = posixOnlyRefusal();
  if (refusal) fail(refusal);
  if (process.env.HUMAN_REVIEW_HOSTED === "1") fail("Feedback is not available in hosted mode.");
  const host = here ? null : remoteHost();
  if (host) {
    const options = parse(args);
    if (options.input) {
      const input = await readRequest(options.input);
      const words = options.command === "create" ? ["create", "-"] : [options.command, options.session, "-"];
      return runRemote(host, options.command, words, { input, program: "walkr-feedback" });
    }
    const seconds = options.command === "wait" ? options.seconds + REMOTE_TIMEOUT_S : REMOTE_TIMEOUT_S;
    return runRemote(host, options.command, args, { seconds, program: "walkr-feedback" });
  }
  const root = feedbackRoot();
  if (!isCanonicalAbsolute(root)) fail("HUMAN_REVIEW_FEEDBACK_ROOT must be a canonical absolute directory.");
  const options = parse(args);
  const server = await ensureServer();
  const capability = await request(server, "capabilities");
  if (capability.feedback !== 1 || capability.rootId !== createHash("sha256").update(root).digest("hex")) {
    fail("The running Walkr server uses a different Feedback root. It was not replaced. Set the same HUMAN_REVIEW_FEEDBACK_ROOT, or stop that server.");
  }
  const remote = allowedHosts().find((entry) => entry.endsWith(`:${server.port}`));
  const url = (route) => `http://${remote || `127.0.0.1:${server.port}`}${route}`;
  const session = options.session && `sessions/${options.session}`;
  if (options.command === "create") {
    const answer = await request(server, "sessions", { method: "POST", body: await readJson(options.input) });
    const local = url(answer.path);
    const site = publicOrigin(configPath(), (line) => process.stderr.write(`${line}\n`));
    const made = {
      ...answer.result,
      status: answer.view.status,
      revision: answer.view.revision,
      url: site ? `${site.origin}/walkr#${answer.result.sessionId}` : local,
      ...(site ? { localUrl: local } : {}),
    };
    const sheprd = await connect(local);
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
  if (options.command === "patch") {
    const answer = await request(server, `${session}/patch`, { method: "POST", body: await readJson(options.input) });
    return json({ ...answer.result, sessionId: options.session, revision: answer.view.revision });
  }
  const receive = async () => {
    const answer = await request(server, `${session}/received`, { method: "POST", body: {} });
    if (!validTime(answer?.result?.receivedAt)) fail("The server answer did not confirm the receipt with an ISO time.");
    return answer;
  };
  if (options.command === "received") {
    const got = (await receive()).result;
    return json({ sessionId: options.session, receivedAt: got.receivedAt, receivedRevision: got.receivedRevision });
  }
  if (options.command === "outcome") {
    return json((await request(server, `${session}/outcome`, { method: "POST", body: await readJson(options.input) })).result);
  }
  const deadline = Date.now() + options.seconds * 1000;
  for (;;) {
    const { view } = await request(server, session);
    if (view.pendingExpands?.length) {
      return json({
        status: "expand",
        sessionId: view.sessionId,
        revision: view.revision,
        sessionStatus: view.status,
        expand: view.pendingExpands,
      });
    }
    if (view.lastResponseRevision > options.afterRevision) {
      let receipt;
      let outputView = view;
      try {
        const answer = await receive();
        receipt = { receivedAt: answer.result.receivedAt, receivedRevision: answer.result.receivedRevision };
        // Build output from the receipt transaction's view so every acknowledged response is included.
        if (answer.view?.sessionId === view.sessionId) outputView = answer.view;
      } catch (error) {
        receipt = { received: false };
        process.stderr.write(`The page did not get the receipt: ${error.message} Run walkr-feedback received ${view.sessionId} to retry it.\n`);
      }
      const responses = outputView.items
        .filter((item) => item.response !== null)
        .map((item) => {
          const { actionId, ...rest } = item.response;
          const picked = item.options?.find((opt) => opt.optionId === rest.pick);
          return {
            itemId: item.itemId,
            title: item.title,
            kind: item.kind,
            ...rest,
            ...(picked ? { pickLabel: picked.label } : {}),
          };
        });
      return json({
        status: "ready",
        sessionId: outputView.sessionId,
        revision: outputView.revision,
        lastResponseRevision: outputView.lastResponseRevision,
        sessionStatus: outputView.status,
        answeredCount: outputView.answeredCount,
        actionableCount: outputView.actionableCount,
        ...receipt,
        responses,
        ...(outputView.note ? { note: outputView.note } : {}),
        rating: outputView.rating?.value ?? null,
      });
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return json({ status: "timeout", sessionId: view.sessionId, revision: view.revision });
    await pause(Math.min(500, remaining));
  }
}
