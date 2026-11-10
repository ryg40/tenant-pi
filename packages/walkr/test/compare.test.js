import test from "./posix-only-mode.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { listen, request } from "./double-fixtures.js";
import { starsLabel, starsText, stepRating } from "../src/compare-stars.js";
import { tmpRoot } from "./tmp-root.js";

const run = promisify(execFile);
const API = "/_walkr/compare/api";
const CLI = fileURLToPath(new URL("../src/walkr-compare.js", import.meta.url));
const HOSTILE = '<h1>Option A</h1><img src="http://example.invalid/x.png"><script>window.injected=1</script>';

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(tmpRoot, "walkr-compare-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const stateDir = path.join(dir, "state");
  await fs.mkdir(stateDir, { mode: 0o700 });
  return { dir, stateDir, archiveDir: path.join(dir, "archive"), root: path.join(dir, "walkr", "compare") };
}

async function serve(t, f) {
  const s = await listen(t, f, { HUMAN_REVIEW_COMPARE_ROOT: f.root });
  return { ...s, agent: (route, options) => s.api(`${API}/${route}`, options) };
}

function htmlRequest(actionId = "create-1") {
  return {
    actionId, workflow: "cfn-options", title: "Add a dead-letter queue", brief: "Compare three ways to add a dead-letter queue.",
    clarifications: [{ question: "Which stack?", answer: "The order stack" }], repo: { name: "example-app", revision: "3bc9b6c" },
    options: [
      { optionId: "a", label: "Option A", summary: "One new resource", format: "html", content: HOSTILE },
      { optionId: "b", label: "Option B", format: "html", content: "<h1>Option B</h1>" },
      { optionId: "c", label: "Option C", format: "html", content: "<h1>Option C</h1>" },
    ],
  };
}

function textRequest(actionId = "create-text") {
  return {
    actionId, workflow: "text-revision", title: "Simplify the ticket update", brief: "Make the update shorter.",
    source: { label: "Current text", format: "text", content: "The deployment has been completed and all checks passed." },
    options: [
      { optionId: "short", label: "Short", format: "text", content: "The deployment is complete and all checks passed." },
      { optionId: "shorter", label: "Shorter", format: "markdown", content: "Deployed. All checks passed. <b onclick=\"window.injected=1\">x</b>" },
    ],
  };
}

async function created(s, body = htmlRequest()) {
  const answer = await s.agent("sessions", { method: "POST", body });
  assert.equal(answer.status, 200, answer.text);
  return answer.json;
}

async function owner(s, pagePath) {
  const page = await request(s.port, pagePath.split("#")[0]);
  assert.equal(page.status, 200);
  const token = page.text.match(/data-token="([a-f0-9]{64})"/)[1];
  const frames = page.text.match(/data-frames="([^"]+)"/)[1];
  return { page, token, frames, call: (route, options = {}) => request(s.port, `${API}/${route}`, { token, ...options }) };
}

test("a session keeps its exact options, takes one final result from the page, and survives a restart", async (t) => {
  const f = await setup(t);
  let s = await serve(t, f);
  const body = htmlRequest();
  const first = await created(s, body);
  assert.match(first.result.sessionId, /^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$/);
  assert.equal(first.path.endsWith(`#${first.result.sessionId}`), true);
  assert.deepEqual(first.view.options.map((option) => option.content), body.options.map((option) => option.content));
  assert.equal(first.view.status, "open");
  assert.equal(first.view.isNew, true);

  const replay = await created(s, body);
  assert.deepEqual(replay.result, { sessionId: first.result.sessionId, replay: true });
  const conflict = await s.agent("sessions", { method: "POST", body: { ...body, title: "Another title" } });
  assert.equal(conflict.json.error.code, "ACTION_CONFLICT");

  const session = `sessions/${first.result.sessionId}`;
  const browser = await owner(s, first.path);
  for (const [route, payload] of [["submit", { actionId: "x", pick: "a" }], ["rate", { actionId: "x", rating: 8 }], ["seen", {}]]) {
    const refused = await s.agent(`${session}/${route}`, { method: "POST", body: payload });
    assert.equal(refused.status, 403, `the agent credential must not ${route}`);
  }
  assert.equal((await request(s.port, `${API}/${session}`)).status, 401);

  const unknown = await browser.call(`${session}/submit`, { method: "POST", body: { actionId: "submit-0", pick: "z" } });
  assert.equal(unknown.json.error.code, "INVALID_REQUEST");
  const noNote = await browser.call(`${session}/submit`, { method: "POST", body: { actionId: "submit-0", pick: null } });
  assert.equal(noNote.json.error.code, "INVALID_REQUEST");
  const early = await s.agent(`${session}/outcome`, { method: "POST", body: { actionId: "outcome-1", summary: "Applied." } });
  assert.equal(early.json.error.code, "INVALID_TRANSITION");

  const submit = { actionId: "submit-1", pick: "b", comments: { a: "Too many resources", c: "  " }, note: "Keep the alarm" };
  const saved = await browser.call(`${session}/submit`, { method: "POST", body: submit });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.json.view.status, "submitted");
  assert.deepEqual(saved.json.result.result.comments, { a: "Too many resources" });
  assert.equal((await browser.call(`${session}/submit`, { method: "POST", body: submit })).json.result.replay, true);
  const second = await browser.call(`${session}/submit`, { method: "POST", body: { actionId: "submit-2", pick: "c" } });
  assert.equal(second.json.result.outcome, "already-submitted");
  assert.equal(second.json.view.result.pick, "b", "the first result stays");

  const outcome = await s.agent(`${session}/outcome`, { method: "POST", body: { actionId: "outcome-1", summary: "Applied option B to template.yaml." } });
  assert.equal(outcome.status, 200, outcome.text);
  assert.equal((await s.agent(`${session}/outcome`, { method: "POST", body: { actionId: "outcome-2", summary: "Again." } })).json.error.code, "OUTCOME_EXISTS");

  await s.close();
  s = await serve(t, f);
  const after = await s.agent(session);
  assert.equal(after.json.view.result.pick, "b");
  assert.equal(after.json.view.outcome.summary, "Applied option B to template.yaml.");
  assert.equal((await request(s.port, first.path.split("#")[0])).status, 404, "a page URL belongs to one server run");
  const record = path.join(f.root, "sessions", first.result.sessionId, "session.json");
  assert.equal((await fs.stat(record)).mode & 0o777, 0o600);
  await fs.writeFile(record, (await fs.readFile(record, "utf8")).replace("Keep the alarm", "Drop the alarm"));
  assert.equal((await s.agent(session)).json.error.code, "RECOVERY_REQUIRED", "a changed record fails its checksum");
});

test("a rating is a whole number from 1 to 10, comes only from the page, and a later rating replaces the shown one", async (t) => {
  const f = await setup(t);
  const s = await serve(t, f);
  const { result, path: pagePath } = await created(s);
  const session = `sessions/${result.sessionId}`;
  const browser = await owner(s, pagePath);
  for (const rating of [0, 11, 7.5, "7", null]) {
    const refused = await browser.call(`${session}/rate`, { method: "POST", body: { actionId: `bad-${rating}`, rating } });
    assert.equal(refused.json.error.code, "INVALID_REQUEST", `rating ${rating} must be refused`);
  }
  const first = await browser.call(`${session}/rate`, { method: "POST", body: { actionId: "rate-1", rating: 7, note: "Good options" } });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.json.view.rating.value, 7);
  assert.equal((await browser.call(`${session}/rate`, { method: "POST", body: { actionId: "rate-1", rating: 7, note: "Good options" } })).json.result.replay, true);
  assert.equal((await browser.call(`${session}/rate`, { method: "POST", body: { actionId: "rate-1", rating: 2 } })).json.error.code, "ACTION_CONFLICT");
  const later = await browser.call(`${session}/rate`, { method: "POST", body: { actionId: "rate-2", rating: 10 } });
  assert.equal(later.json.view.rating.value, 10);
  assert.deepEqual(later.json.view.ratings.map((rating) => rating.value), [7, 10], "each rating stays in the record");
  assert.equal((await s.agent("sessions")).json.sessions[0].rating, 10);

  assert.equal(starsLabel(7), "3.5 of 5 stars");
  assert.equal(starsLabel(null), "Not rated");
  assert.equal(starsText(7), "★★★½");
  assert.equal(starsText(10), "★★★★★");
  assert.deepEqual([stepRating(null, 1), stepRating(1, -1), stepRating(10, 1), stepRating(4, 1)], [1, 1, 10, 5]);
});

test("the session list is in time order and marks a session as new until the page opens it", async (t) => {
  const f = await setup(t);
  const s = await serve(t, f);
  const one = await created(s, htmlRequest("create-1"));
  await new Promise((resolve) => setTimeout(resolve, 1100)); // A session ID starts with its creation second.
  const two = await created(s, textRequest());
  const browser = await owner(s, one.path);
  const list = (await browser.call("sessions")).json.sessions;
  assert.deepEqual(list.map((item) => item.sessionId), [one.result.sessionId, two.result.sessionId]);
  assert.deepEqual(list.map((item) => item.isNew), [true, true]);
  assert.deepEqual(list.map((item) => item.workflow), ["cfn-options", "text-revision"]);
  const seen = await browser.call(`sessions/${one.result.sessionId}/seen`, { method: "POST", body: {} });
  assert.equal(seen.status, 200, seen.text);
  const again = await browser.call(`sessions/${one.result.sessionId}/seen`, { method: "POST", body: {} });
  assert.equal(again.json.result.seenAt, seen.json.result.seenAt, "only the first time is saved");
  assert.deepEqual((await browser.call("sessions")).json.sessions.map((item) => item.isNew), [false, true]);
});

test("create refuses unsafe or incomplete requests and writes nothing", async (t) => {
  const f = await setup(t);
  const s = await serve(t, f);
  const base = htmlRequest();
  const cases = {
    "one option": { ...base, options: base.options.slice(0, 1) },
    "four options": { ...base, options: [...base.options, { optionId: "d", label: "D", format: "html", content: "<p>D</p>" }] },
    "a repeated option ID": { ...base, options: [base.options[0], { ...base.options[1], optionId: "a" }] },
    "the same content twice": { ...base, options: [base.options[0], { ...base.options[1], content: base.options[0].content }] },
    "an unknown format": { ...base, options: [base.options[0], { ...base.options[1], format: "svg" }] },
    "an option ID with a slash": { ...base, options: [base.options[0], { ...base.options[1], optionId: "../b" }] },
    "an unknown field": { ...base, extra: true },
    "an unsafe workflow name": { ...base, workflow: "CFN Options" },
    "an HTML source": { ...base, source: { format: "html", content: "<p>x</p>" } },
    "content over the limit": { ...base, options: [base.options[0], { ...base.options[1], content: "x".repeat(1024 * 1024 + 1) }] },
  };
  for (const [name, body] of Object.entries(cases)) {
    const refused = await s.agent("sessions", { method: "POST", body });
    assert.equal(refused.status, 400, `${name} must be refused: ${refused.text}`);
  }
  assert.deepEqual((await s.agent("sessions")).json.sessions, []);
  await assert.rejects(fs.stat(f.root), { code: "ENOENT" });
  assert.equal((await s.agent("sessions/not-a-session")).json.error.code, "INVALID_ID");
  assert.equal((await s.agent("sessions?x=1")).json.error.code, "INVALID_REQUEST");
});

test("an HTML option is served as a sandboxed document without scripts and network, only under the page capability", async (t) => {
  const f = await setup(t);
  const s = await serve(t, f);
  const { result, path: pagePath } = await created(s);
  const browser = await owner(s, pagePath);
  const frame = await request(s.port, `${browser.frames}/${result.sessionId}/a`);
  assert.equal(frame.status, 200);
  assert.equal(frame.text, HOSTILE, "the option bytes are exact");
  const policy = frame.headers["content-security-policy"];
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /(^|; )sandbox($|;)/, "the sandbox directive has no allow-scripts");
  assert.doesNotMatch(policy, /script-src|allow-/);
  assert.equal(frame.headers["x-content-type-options"], "nosniff");
  assert.equal((await request(s.port, `/_walkr/compare/o/${"0".repeat(64)}/${result.sessionId}/a`)).status, 404);
  assert.equal((await request(s.port, `${browser.frames}/${result.sessionId}/missing`)).status, 404);
  const shellPolicy = browser.page.headers["content-security-policy"];
  assert.match(shellPolicy, /script-src 'self'/);
  assert.match(shellPolicy, /frame-ancestors 'none'/);
  assert.doesNotMatch(browser.page.text, /mode-nav/, "the page has no mode menu");

  const text = await created(s, textRequest());
  assert.equal((await request(s.port, `${browser.frames}/${text.result.sessionId}/short`)).status, 404, "a text option has no frame document");
});

test("hosted mode refuses every Compare route", async (t) => {
  const f = await setup(t);
  const s = await listen(t, f, { HUMAN_REVIEW_COMPARE_ROOT: f.root, HUMAN_REVIEW_HOSTED: "1" });
  const refused = await s.api(`${API}/sessions`, { method: "POST", body: htmlRequest() });
  assert.equal(refused.status, 403);
  assert.equal(refused.json.error.code, "HOSTED_UNSUPPORTED");
});

test("an option ID that is a property name of every object takes a result without a comment", async (t) => {
  const s = await serve(t, await setup(t));
  const body = htmlRequest("create-proto");
  body.options = [{ ...body.options[0], optionId: "constructor" }, { ...body.options[1], optionId: "normal" }];
  const made = await created(s, body);
  const browser = await owner(s, made.path);
  const sent = await browser.call(`sessions/${made.result.sessionId}/submit`, { method: "POST", body: { actionId: "pick-proto", pick: "normal", comments: {} } });
  assert.equal(sent.status, 200, sent.text);
  assert.deepEqual(sent.json.view.result.comments, {});
});

async function bootPage(t, s, pagePath, { intercept = null, wait = true } = {}) {
  const browser = await owner(s, pagePath);
  const dom = new JSDOM(browser.page.text, { url: `http://127.0.0.1:${s.port}${pagePath}` });
  t.after(() => dom.window.close());
  const fetchImpl = async (route, options = {}) => {
    const answer = await request(s.port, route, { method: options.method, headers: options.headers, rawBody: options.body });
    const reply = { ok: answer.status === 200, status: answer.status, json: async () => JSON.parse(answer.text) };
    // A test can hold or replace one answer after the server handled the request.
    return intercept ? await intercept(route, options, reply) ?? reply : reply;
  };
  const { bootCompare } = await import("../src/compare.js");
  const app = bootCompare(dom.window, { fetch: fetchImpl, refreshMs: 60000 });
  t.after(() => app.close());
  if (wait) await app.ready;
  const doc = dom.window.document;
  const click = async (node) => { node.click(); await new Promise((resolve) => setTimeout(resolve, 150)); await app.load(); };
  return { app, doc, $: (id) => doc.getElementById(id), click, browser, window: dom.window };
}

test("the page lists the sessions newest first, shows the type and the format of the selected session, and submits a pick", async (t) => {
  const f = await setup(t);
  const s = await serve(t, f);
  const html = await created(s, htmlRequest());
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const text = await created(s, textRequest());
  const page = await bootPage(t, s, html.path);

  const rows = [...page.$("sessions").querySelectorAll("button")];
  assert.deepEqual(rows.map((row) => row.dataset.session), [text.result.sessionId, html.result.sessionId], "newest first");
  assert.equal(rows[0].querySelector(".cmp-badge")?.textContent, "New");
  assert.equal(page.$("type").textContent, "cfn-options");
  assert.equal(page.$("title").textContent, "Add a dead-letter queue");
  const frames = [...page.$("stage").querySelectorAll("iframe")];
  assert.equal(frames.length, 3);
  assert.equal(frames.every((frame) => frame.getAttribute("sandbox") === ""), true, "each HTML option is in a sandboxed frame");
  assert.deepEqual([...page.$("viewMode").options].map((item) => item.value), ["columns", "single"], "two views");
  assert.equal(page.$("submit").disabled, true);
  assert.equal(page.doc.querySelector(".mode-nav"), null);

  await page.app.load();
  const opened = [...page.$("sessions").querySelectorAll("button")].find((row) => row.dataset.session === html.result.sessionId);
  assert.equal(opened.querySelector(".cmp-badge"), null, "an opened session is no longer new");
  assert.equal(page.$("newCount").textContent, "1 new");

  page.$("viewMode").value = "single";
  page.$("viewMode").dispatchEvent(new page.window.Event("change"));
  assert.equal(page.$("stage").querySelectorAll("iframe").length, 1);
  assert.equal(page.$("tabs").querySelectorAll("button").length, 3);
  page.$("viewMode").value = "columns";
  page.$("viewMode").dispatchEvent(new page.window.Event("change"));

  page.$("stage").querySelector('[data-pick="b"]').click();
  const comment = page.$("stage").querySelector('[data-comment="a"]');
  comment.value = "Too many resources";
  comment.dispatchEvent(new page.window.Event("input"));
  assert.equal(page.$("submit").disabled, false);
  await page.click(page.$("submit"));
  const saved = (await s.agent(`sessions/${html.result.sessionId}`)).json.view;
  assert.equal(saved.result.pick, "b");
  assert.deepEqual(saved.result.comments, { a: "Too many resources" });
  assert.match(page.$("result").textContent, /You picked Option B\./);
  assert.equal(page.$("submit").hidden, true);

  page.$("stars").querySelector('[data-rating="7"]').click();
  assert.match(page.$("rateText").textContent, /3\.5 of 5 stars, not saved/);
  await page.click(page.$("rate"));
  assert.equal((await s.agent(`sessions/${html.result.sessionId}`)).json.view.rating.value, 7);
  assert.equal(page.$("stars").querySelectorAll(".is-on").length, 7);
  assert.equal(page.$("rateText").textContent, "3.5 of 5 stars");

  // The older and newer buttons step through the list; a text session shows each version as clean text, with the original folded above.
  await page.click(page.$("newer"));
  assert.equal(page.$("type").textContent, "text-revision");
  assert.equal(page.$("viewMode").value, "columns");
  assert.deepEqual([...page.$("viewMode").options].map((item) => item.value), ["columns", "single"]);
  assert.equal(page.$("original").hidden, false);
  assert.equal(page.$("original").open, false, "the original text is folded until the owner opens it");
  assert.equal(page.$("originalText").textContent.length > 0, true);
  assert.equal(page.$("stage").querySelectorAll("iframe").length, 0);
  const shorter = page.$("stage").querySelector('[data-option="shorter"] pre');
  assert.equal(shorter.querySelector("b"), null, "Markdown and text never become live HTML");
  assert.equal(shorter.querySelectorAll("ins, del").length, 0, "each version shows as clean text");
  assert.equal(page.window.injected, undefined);
  assert.equal(page.$("newer").disabled, true);

  page.$("none").click();
  assert.equal(page.$("submit").disabled, true, "no option needs a note");
  page.$("note").value = "All three are too long";
  page.$("note").dispatchEvent(new page.window.Event("input"));
  await page.click(page.$("submit"));
  const none = (await s.agent(`sessions/${text.result.sessionId}`)).json.view.result;
  assert.equal(none.pick, null);
  assert.equal(none.note, "All three are too long");

  page.$("typeFilter").value = "cfn-options";
  page.$("typeFilter").dispatchEvent(new page.window.Event("change"));
  assert.deepEqual([...page.$("sessions").querySelectorAll("button")].map((row) => row.dataset.session), [html.result.sessionId]);
});

test("the command starts the background server, creates a session, waits for the result and saves the outcome", async (t) => {
  const f = await setup(t);
  const env = { ...process.env, HUMAN_REVIEW_STATE_DIR: f.stateDir, HUMAN_REVIEW_COMPARE_ROOT: f.root, HUMAN_REVIEW_IDLE_MS: "0" };
  delete env.HUMAN_REVIEW_HOSTED;
  const cli = async (...args) => (await run(process.execPath, [CLI, ...args], { env })).stdout;
  t.after(async () => {
    try { process.kill(JSON.parse(await fs.readFile(path.join(f.stateDir, "server.json"), "utf8")).pid); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  assert.match(await cli("--help"), /walkr-compare/);
  await assert.rejects(cli("create", "relative.json"), /absolute JSON request file/);
  const file = path.join(f.dir, "request.json");
  await fs.writeFile(file, JSON.stringify(textRequest()));
  const made = JSON.parse(await cli("create", file));
  assert.equal(made.status, "open");
  assert.match(made.url, /^http:\/\/127\.0\.0\.1:[0-9]+\/_walkr\/compare\/g\/[a-f0-9]{64}#/);
  assert.equal(JSON.parse(await cli("create", file)).replay, true);
  assert.equal(JSON.parse(await cli("list")).sessions.length, 1);
  assert.equal((await cli("open")).trim(), made.url.split("#")[0]);
  assert.deepEqual(JSON.parse(await cli("wait", made.sessionId, "--timeout", "1")), { status: "timeout" });

  const port = Number(new URL(made.url).port);
  const page = await request(port, new URL(made.url).pathname);
  const token = page.text.match(/data-token="([a-f0-9]{64})"/)[1];
  const waiting = spawn(process.execPath, [CLI, "wait", made.sessionId, "--timeout", "30"], { env, stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  waiting.stdout.on("data", (chunk) => { out += chunk; });
  const submitted = await request(port, `${API}/sessions/${made.sessionId}/submit`, { token, method: "POST", body: { actionId: "submit-1", pick: "short", note: "Good" } });
  assert.equal(submitted.status, 200, submitted.text);
  await new Promise((resolve) => waiting.once("close", resolve));
  const ready = JSON.parse(out);
  assert.equal(ready.status, "ready");
  assert.deepEqual({ pick: ready.result.pick, pickLabel: ready.result.pickLabel, note: ready.result.note }, { pick: "short", pickLabel: "Short", note: "Good" });

  const outcome = path.join(f.dir, "outcome.json");
  await fs.writeFile(outcome, JSON.stringify({ actionId: "outcome-1", summary: "Posted the short text to the ticket." }));
  assert.equal(JSON.parse(await cli("outcome", made.sessionId, outcome)).outcome.summary, "Posted the short text to the ticket.");
  assert.equal(JSON.parse(await cli("view", made.sessionId)).outcome.summary, "Posted the short text to the ticket.");
});

test("a late answer for an earlier session never replaces the selected session", async (t) => {
  const f = await setup(t);
  const s = await serve(t, f);
  const first = await created(s, htmlRequest("create-late-a"));
  const second = await created(s, textRequest("create-late-b"));
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const intercept = async (route, options) => {
    if (!options.method && route.endsWith(`/sessions/${first.result.sessionId}`)) await held;
  };
  const page = await bootPage(t, s, first.path, { intercept, wait: false });
  await new Promise((resolve) => setTimeout(resolve, 200));
  page.window.location.hash = `#${second.result.sessionId}`;
  page.window.dispatchEvent(new page.window.Event("hashchange"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(page.$("title").textContent, "Simplify the ticket update");
  release();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(page.$("title").textContent, "Simplify the ticket update", "the held answer of the first session is dropped");
  assert.equal(page.$("type").textContent, "text-revision");
  assert.equal(page.$("stage").querySelectorAll("iframe").length, 0);
});

test("selecting another session during a held mutation clears the old stage immediately", { timeout: 10000 }, async (t) => {
  const s = await serve(t, await setup(t));
  const first = await created(s, textRequest("create-held-mutation-a"));
  const second = await created(s, { ...textRequest("create-held-mutation-b"), title: "Another session" });
  let release, captured;
  const held = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { captured = resolve; });
  t.after(() => release());
  const page = await bootPage(t, s, first.path, { intercept: async (route, options) => {
    if (options.method === "POST" && route === `${API}/sessions/${first.result.sessionId}/submit`) {
      captured();
      await held;
    }
  } });
  try {
    assert.equal(page.$("stage").hidden, false);
    assert.equal(page.$("title").textContent, first.view.title);
    page.$("stage").querySelector('[data-pick="short"]').click();
    page.$("submit").click();
    await started;
    page.$("sessions").querySelector(`[data-session="${second.result.sessionId}"]`).click();
    assert.equal(page.window.location.hash, `#${second.result.sessionId}`);
    assert.equal(page.$("sessions").querySelector('[aria-current="true"]').dataset.session, second.result.sessionId);
    assert.notEqual(page.$("title").textContent, first.view.title);
    assert.equal(page.$("stage").hidden, true);
  } finally {
    page.app.close();
    release();
  }
});

test("a held poll does not overwrite a submitted view", { timeout: 10000 }, async (t) => {
  const s = await serve(t, await setup(t));
  const made = await created(s, textRequest("create-held-poll"));
  const browser = await owner(s, made.path);
  const session = `sessions/${made.result.sessionId}`;
  await browser.call(`${session}/seen`, { method: "POST", body: {} });
  let hold = false, release, captured;
  const held = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { captured = resolve; });
  t.after(() => release());
  const page = await bootPage(t, s, made.path, { intercept: async (route, options) => {
    if (hold && !options.method && route === `${API}/${session}`) {
      hold = false;
      captured();
      await held;
    }
  } });
  // Change the list row so the next poll reads the still-open session again.
  await browser.call(`${session}/rate`, { method: "POST", body: { actionId: "rate-before-poll", rating: 7 } });
  hold = true;
  const poll = page.app.load();
  await started;
  page.$("stage").querySelector('[data-pick="short"]').click();
  const submitted = new Promise((resolve) => {
    const observer = new page.window.MutationObserver(() => {
      if (page.$("submit").hidden) { observer.disconnect(); resolve(); }
    });
    observer.observe(page.$("submit"), { attributes: true });
    t.after(() => observer.disconnect());
  });
  page.$("submit").click();
  await submitted;
  release();
  await poll;
  assert.equal(page.$("submit").hidden, true);
  assert.equal(page.$("stage").querySelector('[data-pick="short"]').disabled, true);
  assert.equal((await s.agent(session)).json.view.result.pick, "short");
});

test("an answer that does not prove the save keeps the request for an exact retry", async (t) => {
  const f = await setup(t);
  const s = await serve(t, f);
  const made = await created(s, htmlRequest("create-unproven"));
  let broken = true;
  const intercept = async (route, options) => {
    if (broken && options.method === "POST" && route.endsWith("/submit")) { broken = false; return { ok: true, status: 200, json: async () => ({}) }; }
  };
  const page = await bootPage(t, s, made.path, { intercept });
  await page.click(page.$("stage").querySelector('[data-pick="b"]'));
  await page.click(page.$("submit"));
  const saved = JSON.parse(page.window.localStorage.getItem("walkr-compare:pending"));
  assert.equal(saved.sessionId, made.result.sessionId);
  assert.equal(page.$("resolve").hidden, false);
  // The server saved the first request. The exact retry confirms it and clears the saved request.
  await page.click(page.$("resolve"));
  assert.equal(page.window.localStorage.getItem("walkr-compare:pending"), null);
  assert.equal((await s.agent(`sessions/${made.result.sessionId}`)).json.view.result.pick, "b");
});
