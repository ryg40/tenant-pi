import "./no-outer-config.js"; // First: no test reads the artifacts config of the outer user.
import test from "./posix-only-mode.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { listen, request } from "./server-fixtures.js";
import { starsLabel, starsText, stepRating } from "../src/compare-stars.js";
import { FROM_FEEDBACK, NO_FIT } from "../src/compare.js";
import { CompareStore } from "../src/compare-store.js";
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
  return { dir, stateDir, root: path.join(dir, "walkr", "compare") };
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
    "a recommended ID that is not an option": { ...base, recommended: "z" },
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

test("an HTML option and the HTML preview of a next round are served as sandboxed documents without scripts and network, only under the page capability", async (t) => {
  const f = await setup(t);
  const s = await serve(t, f);
  const sketch = '<p style="color: #444">A sketch of the next round</p>';
  const { result, path: pagePath } = await created(s, { ...htmlRequest(), nextRounds: [{ roundId: "sketch", label: "Sketch", preview: { format: "html", content: sketch } }] });
  const browser = await owner(s, pagePath);
  const frame = await request(s.port, `${browser.frames}/${result.sessionId}/a`);
  assert.equal(frame.status, 200);
  assert.equal(frame.text, HOSTILE, "the option bytes are exact");
  const policy = frame.headers["content-security-policy"];
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /(^|; )sandbox($|;)/, "the sandbox directive has no allow-scripts");
  assert.doesNotMatch(policy, /script-src|allow-/);
  // Servo compares 'self' with the opaque origin of the sandboxed option, so the policy also names the page origin.
  assert.equal(policy.split("; ").find((part) => part.startsWith("frame-ancestors")), `frame-ancestors 'self' http://127.0.0.1:${s.port}`);
  assert.equal(frame.headers["x-content-type-options"], "nosniff");
  const preview = await request(s.port, `${browser.frames}/${result.sessionId}/next/sketch`);
  assert.equal(preview.status, 200);
  assert.equal(preview.text, sketch, "the preview bytes are exact");
  assert.equal(preview.headers["content-security-policy"], policy, "a preview has the policy of an option");
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

async function bootPage(t, s, pagePath, { intercept = null, wait = true, pending = null } = {}) {
  const browser = await owner(s, pagePath);
  const dom = new JSDOM(browser.page.text, { url: `http://127.0.0.1:${s.port}${pagePath}` });
  t.after(() => dom.window.close());
  // A request that an earlier load of the page saved and that is not confirmed: the page starts as after a reload.
  if (pending) dom.window.localStorage.setItem("walkr-compare:pending", JSON.stringify(pending));
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
  const click = async (node) => {
    node.click();
    // load() does not wait for a busy send. The retry control unlocks after its receipt is handled.
    await new Promise((resolve, reject) => {
      const finish = (failure) => {
        clearTimeout(timer);
        observer.disconnect();
        failure ? reject(failure) : resolve();
      };
      const check = () => { if (!doc.getElementById("resolve").disabled) finish(); };
      const observer = new dom.window.MutationObserver(check);
      const timer = setTimeout(() => finish(new Error("Compare receipt did not settle")), 5000);
      observer.observe(doc.getElementById("resolve"), { attributes: true, attributeFilter: ["disabled"] });
      check();
    });
    await app.load();
  };
  // The decision panel is an A2UI surface: a part has the ID of its component, a picker entry the value of its option.
  const part = (id) => doc.querySelector(`#decision [data-a2ui-id="${id}"]`);
  const radio = (value) => [...doc.querySelectorAll('#decision input[type="radio"]')].find((input) => input.value === value);
  const note = (text) => {
    const field = part("note").querySelector("textarea");
    field.value = text;
    field.dispatchEvent(new dom.window.Event("input"));
  };
  // The controls of the panel that take a click or text now. A submitted session has none: no Submit can be used.
  const usable = () => [...doc.querySelectorAll("#decision button, #decision input, #decision textarea")].filter((node) => !node.disabled && !node.readOnly);
  return { app, doc, $: (id) => doc.getElementById(id), click, part, radio, note, usable, browser, window: dom.window };
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
  assert.equal(page.$("type").dataset.type, "compare");
  assert.equal(page.$("type").dataset.workflow, "cfn-options");
  assert.equal(page.$("title").textContent, "Add a dead-letter queue");
  const frames = [...page.$("stage").querySelectorAll("iframe")];
  assert.equal(frames.length, 3);
  assert.equal(frames.every((frame) => frame.getAttribute("sandbox") === ""), true, "each HTML option is in a sandboxed frame");
  assert.deepEqual([...page.$("viewMode").options].map((item) => item.value), ["columns", "single"], "two views");
  assert.equal(page.part("submit").disabled, true);
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
  assert.equal(page.radio("b").checked, true, "the panel follows the pick of the column");
  assert.equal(page.part("submit").disabled, false);
  await page.click(page.part("submit"));
  const saved = (await s.agent(`sessions/${html.result.sessionId}`)).json.view;
  assert.equal(saved.result.pick, "b");
  assert.deepEqual(saved.result.comments, { a: "Too many resources" });
  assert.match(page.$("decision").textContent, /Option B/, "the result shows the pick");
  assert.deepEqual(page.usable(), [], "no Submit can be used");

  page.$("stars").querySelector('[data-rating="7"]').click();
  assert.match(page.$("rateText").textContent, /3\.5 of 5 stars, not saved/);
  await page.click(page.$("rate"));
  assert.equal((await s.agent(`sessions/${html.result.sessionId}`)).json.view.rating.value, 7);
  assert.equal(page.$("stars").querySelectorAll(".is-on").length, 7);
  assert.equal(page.$("rateText").textContent, "3.5 of 5 stars");

  // The older and newer buttons step through the list; a text session shows each version as clean text, with the original folded above.
  await page.click(page.$("newer"));
  assert.equal(page.$("type").dataset.type, "compare");
  assert.equal(page.$("type").dataset.workflow, "text-revision");
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

  page.radio(NO_FIT).click();
  assert.equal(page.part("submit").disabled, true, "no option needs a note");
  page.note("All three are too long");
  await page.click(page.part("submit"));
  const none = (await s.agent(`sessions/${text.result.sessionId}`)).json.view.result;
  assert.equal(none.pick, null);
  assert.equal(none.note, "All three are too long");

  page.$("typeFilter").value = "compare:cfn-options";
  page.$("typeFilter").dispatchEvent(new page.window.Event("change"));
  assert.deepEqual([...page.$("sessions").querySelectorAll("button")].map((row) => row.dataset.session), [html.result.sessionId]);
});

test("the decision panel sends one submit with its pick, only on Submit (done), and nothing for No option fits without a note", async (t) => {
  const s = await serve(t, await setup(t));
  const made = await created(s, { ...textRequest("create-panel"), recommended: "shorter" });
  assert.equal(made.view.recommended, "shorter");
  const route = `${API}/sessions/${made.result.sessionId}/submit`;
  const submits = [];
  const page = await bootPage(t, s, made.path, { intercept: async (path, options) => {
    if (options.method === "POST" && path === route) submits.push(JSON.parse(options.body));
  } });
  page.radio(NO_FIT).click();
  await page.click(page.part("submit"));
  await page.click(page.part("more"));
  assert.equal(submits.length, 0, "No option fits without a note or a comment sends nothing");
  page.radio("short").click();
  assert.equal(page.$("stage").querySelector('[data-pick="short"]').getAttribute("aria-pressed"), "true", "the column follows the pick of the panel");
  assert.equal(submits.length, 0, "a pick sends nothing before Submit");
  await page.click(page.part("submit"));
  assert.deepEqual(submits.map((body) => body.pick), ["short"]);
  assert.equal((await s.agent(`sessions/${made.result.sessionId}`)).json.view.result.pick, "short");
});

test("a Submit of the panel of another session sends no request", async (t) => {
  const s = await serve(t, await setup(t));
  const first = await created(s, textRequest("create-stale-a"));
  const second = await created(s, { ...textRequest("create-stale-b"), title: "Another session" });
  const routes = new Set([first, second].map((made) => `${API}/sessions/${made.result.sessionId}/submit`));
  const submits = [];
  const page = await bootPage(t, s, first.path, { intercept: async (route, options) => {
    if (options.method === "POST" && routes.has(route)) submits.push(route);
  } });
  page.radio("short").click();
  const stale = page.part("submit");
  assert.equal(stale.disabled, false);
  page.$("sessions").querySelector(`[data-session="${second.result.sessionId}"]`).click();
  await page.app.load();
  assert.equal(page.$("title").textContent, "Another session");
  page.radio("short").click();
  // The click resolves after a request that it started has its answer.
  await page.click(stale);
  assert.deepEqual(submits, [], "the Submit of the first panel sends nothing for the selected session");
  await page.click(page.part("submit"));
  assert.deepEqual(submits, [`${API}/sessions/${second.result.sessionId}/submit`], "the Submit of the selected session still sends");
});

test("a submitted session with a long note and a long outcome still shows its result", async (t) => {
  const s = await serve(t, await setup(t));
  const made = await created(s, textRequest("create-long-result"));
  const page = await bootPage(t, s, made.path);
  assert.notDeepEqual(page.usable(), [], "the open panel takes a pick");
  // Each control character takes 6 bytes of JSON: the result text is larger than one A2UI call may be.
  const note = `Note start${"\u0001".repeat(7990)}`, summary = `Outcome start${"\u0001".repeat(7987)}`;
  const session = `sessions/${made.result.sessionId}`;
  const submit = await page.browser.call(`${session}/submit`, { method: "POST", body: { actionId: "submit-long", pick: "short", note } });
  assert.equal(submit.status, 200, submit.text);
  const outcome = await s.agent(`${session}/outcome`, { method: "POST", body: { actionId: "outcome-long", summary } });
  assert.equal(outcome.status, 200, outcome.text);
  await page.app.load();
  const shown = page.$("decision").textContent;
  assert.ok(shown.includes(note) && shown.includes(summary), "the result shows the whole note and the whole outcome");
  assert.deepEqual(page.usable(), [], "no Submit can be used");
});

test("folding and Solo keep frames, zoom, drafts and picks in place, including saved results and ratings", async (t) => {
  const s = await serve(t, await setup(t));
  const made = await created(s);
  const page = await bootPage(t, s, made.path);
  const stage = page.$("stage");
  const cards = [...stage.children];
  const frames = cards.map((card) => card.querySelector("iframe"));
  const documents = frames.map((frame) => frame.contentDocument);
  const control = (card, label) => card.querySelector(`[aria-label="${label}"]`);
  const fold = (card, direction) => card.querySelector(`[data-fold="${direction}"]`);
  const comment = cards[0].querySelector("textarea");
  comment.value = "Keep this draft";
  comment.dispatchEvent(new page.window.Event("input"));
  cards[0].querySelector(".zoom-out").click();
  const zoom = cards[0].querySelector(".cmp-body").dataset.zoom;
  cards[0].querySelector("[data-pick]").click();
  page.$("stars").querySelector('[data-rating="7"]').click();
  page.$("rateNote").value = "Useful options";
  page.$("rateNote").dispatchEvent(new page.window.Event("input"));

  fold(cards[0], "left").click();
  const rail = cards[0].querySelector(".cmp-rail");
  assert.equal(fold(cards[0], "left").getAttribute("aria-label"), "Fold Option A to the left");
  assert.equal(rail.getAttribute("aria-expanded"), "false");
  assert.equal(page.$(rail.getAttribute("aria-controls")).hidden, true);
  assert.equal(rail.hidden, false);
  assert.equal(rail.querySelector(".cmp-rail-label").textContent, "Option A");
  assert.equal(rail.querySelector(".cmp-rail-pick").hidden, false);
  assert.equal(page.doc.activeElement, rail, "focus moves out of the folded content");
  assert.equal(page.$("showAll").hidden, false);
  fold(cards[2], "right").click();
  assert.deepEqual(cards.map((card) => card.dataset.fold), ["left", "", "right"]);
  control(cards[1], "Show Option B alone").click();
  rail.click();
  assert.equal(rail.hidden, true);
  assert.equal(fold(cards[0], "left").getAttribute("aria-expanded"), "true");
  assert.equal(page.doc.activeElement, fold(cards[0], "left"));
  control(cards[2], "Show Option C alone").click();
  assert.deepEqual(cards.map((card) => card.dataset.fold), ["left", "left", ""]);
  page.$("showAll").click();
  assert.equal(page.$("showAll").hidden, true);
  assert.ok(cards.every((card) => !card.classList.contains("is-folded")));

  fold(cards[0], "right").click();
  await page.app.load();
  assert.deepEqual([...stage.children].map((card) => card.dataset.fold), ["right", "", ""], "polling keeps the folds");
  assert.deepEqual([...stage.querySelectorAll("iframe")], frames, "folding and polling keep the frames in order");
  assert.deepEqual(frames.map((frame) => frame.contentDocument), documents, "frame documents are not reloaded");
  assert.equal(cards[0].querySelector(".cmp-body").dataset.zoom, zoom);
  assert.equal(cards[0].querySelector("textarea").value, "Keep this draft");
  assert.equal(cards[0].querySelector("[data-pick]").getAttribute("aria-pressed"), "true");
  assert.equal(page.$("stars").querySelector('[aria-checked="true"]').dataset.rating, "7");
  assert.equal(page.$("rateNote").value, "Useful options");
  await page.click(page.$("rate"));
  await page.click(page.part("submit"));
  const saved = (await s.agent(`sessions/${made.result.sessionId}`)).json.view;
  assert.equal(saved.result.pick, "a");
  assert.deepEqual(saved.result.comments, { a: "Keep this draft" });
  assert.equal(saved.rating.value, 7);
  assert.equal(saved.rating.note, "Useful options");
  assert.equal(stage.querySelector('[data-option="a"]').dataset.fold, "right");
  assert.equal(stage.querySelector('[data-option="a"] .cmp-rail-pick').hidden, false);
});

test("the rating is a fold that is closed at the start, shows the saved rating in its summary, stays open through a new draw of the panel and a poll, and starts closed for a newly selected session", async (t) => {
  const s = await serve(t, await setup(t));
  const first = await created(s, htmlRequest("create-fold-1"));
  const second = await created(s, textRequest("create-fold-2"));
  const page = await bootPage(t, s, first.path);
  const fold = page.$("rating");
  const summary = () => fold.querySelector("summary").textContent;
  assert.equal(fold.tagName, "DETAILS");
  assert.ok(fold.contains(page.$("stars")) && fold.contains(page.$("rate")), "the stars and Save rating are in the fold");
  assert.equal(fold.open, false, "the fold is closed at the start");
  assert.match(summary(), /Rate this session.*Not rated/, "the summary names the action and the rating");

  fold.open = true;
  page.radio("b").click();
  await page.click(page.part("submit"));
  assert.deepEqual(page.usable(), [], "the panel is drawn again with the result: no Submit can be used");
  assert.equal(fold.open, true, "a new draw of the panel keeps the fold open");
  page.$("stars").querySelector('[data-rating="7"]').click();
  await page.click(page.$("rate"));
  assert.match(summary(), /Rate this session.*3\.5 of 5 stars/, "the summary shows the saved rating");
  await page.app.load();
  assert.equal(fold.open, true, "a poll keeps the fold open");

  page.$("sessions").querySelector(`[data-session="${second.result.sessionId}"]`).click();
  await page.app.load();
  assert.equal(page.$("sessions").querySelector('[aria-current="true"]').dataset.session, second.result.sessionId);
  assert.equal(fold.open, false, "a newly selected session starts with the fold closed");
  assert.match(summary(), /Rate this session.*Not rated/);
});

test("two-option folds support no pick, reset on session changes, and leave One option unchanged", async (t) => {
  const s = await serve(t, await setup(t));
  const first = await created(s, textRequest());
  const second = await created(s, { ...textRequest("another-text"), title: "Another session" });
  const page = await bootPage(t, s, first.path);
  const stage = page.$("stage");
  const cards = [...stage.children];
  cards[0].querySelector('[aria-label="Show Short alone"]').click();
  assert.equal(cards[1].classList.contains("is-folded"), true);
  cards[0].querySelector('[data-fold="right"]').click();
  assert.ok(cards.every((card) => card.classList.contains("is-folded")), "even all-folded can recover with Show all");
  page.$("showAll").click();
  assert.ok(cards.every((card) => !card.classList.contains("is-folded")));
  cards[0].querySelector('[data-pick]').click();
  cards[0].querySelector('[data-fold="left"]').click();
  page.radio(NO_FIT).click();
  assert.equal(cards[0].querySelector('.cmp-rail-pick').hidden, true);
  assert.equal(page.part("submit").disabled, true, "no pick still requires a note");
  page.note("Need another version");
  await page.click(page.part("submit"));
  assert.equal((await s.agent(`sessions/${first.result.sessionId}`)).json.view.result.pick, null);
  await page.click(page.$("sessions").querySelector(`[data-session="${second.result.sessionId}"]`));
  assert.ok([...stage.children].every((card) => !card.classList.contains("is-folded")));
  assert.equal(page.$("showAll").hidden, true);
  stage.querySelector('[data-fold="right"]').click();
  page.$("viewMode").value = "single";
  page.$("viewMode").dispatchEvent(new page.window.Event("change"));
  assert.equal(page.$("showAll").hidden, true);
  assert.equal(stage.querySelector(".cmp-fold-controls"), null);
  assert.equal(page.$("tabs").hidden, false);
  page.$("tabs").querySelector('[data-tab="shorter"]').click();
  assert.equal(stage.firstElementChild.dataset.option, "shorter");
  page.$("viewMode").value = "columns";
  page.$("viewMode").dispatchEvent(new page.window.Event("change"));
  await page.click(page.$("sessions").querySelector(`[data-session="${first.result.sessionId}"]`));
  assert.ok([...stage.children].every((card) => !card.classList.contains("is-folded")), "returning to a session also resets folds");
});

test("the Compare wordmark precedes Sessions", async (t) => {
  const dom = new JSDOM(await fs.readFile(new URL("../src/compare.html", import.meta.url), "utf8"));
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  const mark = doc.querySelector(".cmp-mark");
  assert.equal(mark.textContent, "walkr");
  assert.equal(mark.querySelector(".cmp-mark-r").textContent, "r");
  assert.equal(mark, doc.querySelector(".cmp-bar").firstElementChild);
  assert.equal(mark.nextElementSibling, doc.getElementById("toggleList"));
});

test("the command starts the background server, creates a session, waits for the result and saves the outcome", async (t) => {
  const f = await setup(t);
  const env = { ...process.env, HUMAN_REVIEW_STATE_DIR: f.stateDir, HUMAN_REVIEW_COMPARE_ROOT: f.root, HUMAN_REVIEW_IDLE_MS: "0" };
  delete env.HUMAN_REVIEW_HOSTED;
  const cli = async (...args) => (await run(process.execPath, [CLI, ...args], { env })).stdout;
  // The record is read when the server starts: the setup hook may remove the state directory first.
  let serverPid = 0;
  t.after(async () => {
    if (serverPid) try { process.kill(serverPid); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  assert.match(await cli("--help"), /walkr-compare/);
  await assert.rejects(cli("create", "relative.json"), /absolute JSON request file/);
  const file = path.join(f.dir, "request.json");
  await fs.writeFile(file, JSON.stringify(textRequest()));
  const made = JSON.parse(await cli("create", file));
  serverPid = JSON.parse(await fs.readFile(path.join(f.stateDir, "server.json"), "utf8")).pid;
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

  // An unknown session exits 2, with an empty standard input and no terminal.
  const unknown = spawn(process.execPath, [CLI, "open", "20260101T000000Z-000000000000"], { env, stdio: ["ignore", "ignore", "pipe"] });
  unknown.stderr.resume();
  assert.equal(await new Promise((resolve) => unknown.once("close", resolve)), 2);
});

test("a local front with a loopback Host and Origin of another port loads the page and writes; a foreign Origin is refused", async (t) => {
  const f = await setup(t);
  const s = await serve(t, f);
  const made = await created(s, textRequest());
  const front = `127.0.0.1:${s.port === 6790 ? 6791 : 6790}`;
  const headers = { host: front, origin: `http://${front}` };
  const page = await request(s.port, made.path.split("#")[0], { headers });
  assert.equal(page.status, 200);
  const token = page.text.match(/data-token="([^"]+)"/)[1];
  const seen = `${API}/sessions/${made.view.sessionId}/seen`;
  const accepted = await request(s.port, seen, { token, method: "POST", body: {}, headers });
  assert.equal(accepted.status, 200, accepted.text);
  assert.equal((await request(s.port, seen, { token, method: "POST", body: {}, headers: { ...headers, origin: "http://foreign.test" } })).status, 403);
  // The own port keeps the rule of before: a page behind an HTTPS proxy still writes.
  const own = `127.0.0.1:${s.port}`;
  const proxied = await request(s.port, seen, { token, method: "POST", body: {}, headers: { host: own, origin: `https://${own}` } });
  assert.equal(proxied.status, 200, proxied.text);
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
  assert.equal(page.$("type").dataset.type, "compare");
  assert.equal(page.$("type").dataset.workflow, "text-revision");
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
    page.part("submit").click();
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
  // The click resolves after the submit answer and one more read.
  await page.click(page.part("submit"));
  release();
  await poll;
  assert.match(page.$("decision").textContent, /You picked Short\./, "the saved pick still shows after the late poll");
  assert.deepEqual(page.usable(), [], "no Submit can be used");
  assert.equal(page.$("stage").querySelector('[data-pick="short"]').disabled, true);
  assert.equal((await s.agent(session)).json.view.result.pick, "short");
});

test("an answer that does not prove the save keeps the request for an exact retry", { timeout: 10000 }, async (t) => {
  const f = await setup(t);
  const s = await serve(t, f);
  const made = await created(s, htmlRequest("create-unproven"));
  let firstBody, retryBody, release, captured;
  const held = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { captured = resolve; });
  t.after(() => release());
  const intercept = async (route, options) => {
    if (options.method !== "POST" || route !== `${API}/sessions/${made.result.sessionId}/submit`) return;
    if (!firstBody) {
      firstBody = options.body;
      return { ok: true, status: 200, json: async () => ({}) };
    }
    retryBody = options.body;
    captured();
    await held;
  };
  const page = await bootPage(t, s, made.path, { intercept });
  await page.click(page.$("stage").querySelector('[data-pick="b"]'));
  await page.click(page.part("submit"));
  const saved = JSON.parse(page.window.localStorage.getItem("walkr-compare:pending"));
  assert.equal(saved.sessionId, made.result.sessionId);
  assert.equal(page.$("resolve").hidden, false);
  assert.deepEqual(saved.body, JSON.parse(firstBody));
  // The server saved the first request, but the retry receipt must arrive before click completes.
  const retry = page.click(page.$("resolve"));
  retry.catch(() => {}); // Cleanup still awaits a rejected click if an earlier assertion fails.
  let timer;
  try {
    await started;
    assert.equal(retryBody, firstBody, "the retry sends the exact original request");
    const result = await Promise.race([
      retry.then(() => "completed"),
      new Promise((resolve) => { timer = setTimeout(() => resolve("held"), 600); }),
    ]);
    assert.equal(result, "held", "click must stay pending while the receipt is held");
    assert.deepEqual(JSON.parse(page.window.localStorage.getItem("walkr-compare:pending")), saved);
  } finally {
    clearTimeout(timer);
    release();
    await retry;
  }
  assert.equal(page.window.localStorage.getItem("walkr-compare:pending"), null);
  assert.equal((await s.agent(`sessions/${made.result.sessionId}`)).json.view.result.pick, "b");
});

test("after a reload, the panel shows the pick and the note of a pending submit, and the retry sends the same body", { timeout: 10000 }, async (t) => {
  const s = await serve(t, await setup(t));
  const made = await created(s, htmlRequest("create-reload"));
  const route = `${API}/sessions/${made.result.sessionId}/submit`;
  const pending = { op: "submit", sessionId: made.result.sessionId, body: { actionId: "submit-before-reload", pick: "b", comments: {}, note: "First note", nextRound: "@feedback" } };
  const sent = [];
  const page = await bootPage(t, s, made.path, { pending, intercept: async (path, options) => {
    if (options.method === "POST" && path === route) sent.push(JSON.parse(options.body));
  } });
  assert.equal(page.radio("b").checked, true, "the panel shows the pick of the pending request");
  assert.equal(page.part("note").querySelector("textarea").value, "First note", "the panel shows the note of the pending request");
  assert.equal(page.$("stage").querySelector('[data-pick="b"]').getAttribute("aria-pressed"), "true", "the column marks the same pick");
  assert.deepEqual(page.usable(), [], "the panel takes no change before the retry");
  await page.click(page.$("resolve"));
  assert.deepEqual(sent, [pending.body], "the retry sends the same body");
  assert.equal((await s.agent(`sessions/${made.result.sessionId}`)).json.view.result.nextRound, "@feedback", "the retry keeps the meaning of Next round");
});

const NEXT_ROUNDS = [{ roundId: "shorter-b", label: "Shorter versions of B", summary: "Two shorter cuts of B" }, { roundId: "mix-a-c", label: "Mix A and C" }];

test("next rounds: a repeated roundId and an open earlier session are refused; a linked session is round 2, its row names the earlier one, and round 20 takes no nextRounds and no nextRound", async (t) => {
  const store = new CompareStore({ root: (await setup(t)).root });
  await assert.rejects(store.create({ ...textRequest("round-1"), nextRounds: [NEXT_ROUNDS[0], { ...NEXT_ROUNDS[1], roundId: "shorter-b" }] }), { code: "INVALID_REQUEST" });
  const first = (await store.create({ ...textRequest("round-1"), nextRounds: NEXT_ROUNDS })).result.sessionId;
  await assert.rejects(store.create({ ...textRequest("round-2"), previous: { sessionId: first } }), { code: "INVALID_REQUEST" });
  await store.submit(first, { actionId: "submit-1", pick: "short", nextRound: "mix-a-c" });
  const second = (await store.create({ ...textRequest("round-2"), title: "Round two", previous: { sessionId: first, roundId: "mix-a-c" } })).result.sessionId;
  assert.equal((await store.read(second)).round, 2);
  assert.equal((await store.list()).find((row) => row.sessionId === second).previousSessionId, first);
  // A chain ends at round 20, so a session of round 20 takes no suggestions for one more round.
  let last = second;
  for (let round = 3; round <= 20; round += 1) {
    await store.submit(last, { actionId: "submit", pick: "short" });
    const request = { ...textRequest(`round-${round}`), previous: { sessionId: last } };
    if (round === 20) await assert.rejects(store.create({ ...request, nextRounds: NEXT_ROUNDS }), { code: "INVALID_REQUEST", message: /last round/ });
    last = (await store.create(request)).result.sessionId;
  }
  assert.equal((await store.read(last)).round, 20);
  await assert.rejects(store.submit(last, { actionId: "submit-last", pick: "short", nextRound: "@feedback" }), { code: "INVALID_REQUEST", message: /last round/ });
});

test("a next round preview over its limit is refused, and a valid preview comes back in the session view", async (t) => {
  const store = new CompareStore({ root: (await setup(t)).root });
  const large = { ...NEXT_ROUNDS[0], preview: { format: "text", content: "x".repeat(16 * 1024 + 1) } };
  await assert.rejects(store.create({ ...textRequest("preview-large"), nextRounds: [large] }), { code: "INVALID_REQUEST" });
  const rounds = [{ ...NEXT_ROUNDS[0], preview: { format: "html", content: "<p>Two shorter cuts of B</p>" } }, NEXT_ROUNDS[1]];
  const made = (await store.create({ ...textRequest("preview-ok"), nextRounds: rounds })).result.sessionId;
  assert.deepEqual((await store.read(made)).nextRounds, rounds);
});

test("submit refuses an unknown next round and takes No option fits with a next round and no note", async (t) => {
  const store = new CompareStore({ root: (await setup(t)).root });
  const made = (await store.create({ ...textRequest("round-submit"), nextRounds: NEXT_ROUNDS })).result.sessionId;
  await assert.rejects(store.submit(made, { actionId: "submit-1", pick: "short", nextRound: "other" }), { code: "INVALID_REQUEST" });
  const saved = await store.submit(made, { actionId: "submit-1", pick: null, nextRound: "mix-a-c" });
  assert.equal(saved.view.result.pick, null);
  assert.equal(saved.view.result.nextRound, "mix-a-c");
});

test("submit takes nextRound @feedback without nextRounds, but not for No option fits without a note or a comment; no roundId and no previous.roundId is @feedback", async (t) => {
  const store = new CompareStore({ root: (await setup(t)).root });
  await assert.rejects(store.create({ ...textRequest("feedback-id"), nextRounds: [{ roundId: "@feedback", label: "Feedback" }] }), { code: "INVALID_ID" });
  const made = (await store.create(textRequest("feedback-1"))).result.sessionId;
  await assert.rejects(store.submit(made, { actionId: "submit-empty", pick: null, nextRound: "@feedback" }), { code: "INVALID_REQUEST" });
  const saved = await store.submit(made, { actionId: "submit-1", pick: null, comments: { short: "Too formal" }, nextRound: "@feedback" });
  assert.equal(saved.view.result.nextRound, "@feedback");
  await assert.rejects(store.create({ ...textRequest("feedback-2"), previous: { sessionId: made, roundId: "@feedback" } }), { code: "INVALID_REQUEST" });
  assert.equal((await store.create({ ...textRequest("feedback-2"), previous: { sessionId: made } })).view.round, 2);
});

test("the Next round cards show only after the first selection, and the new draw keeps the focus, the pick and the note", async (t) => {
  const s = await serve(t, await setup(t));
  const made = await created(s, { ...textRequest("create-reveal"), nextRounds: NEXT_ROUNDS });
  const page = await bootPage(t, s, made.path);
  assert.equal(page.part("next"), null, "a new session shows no Next round card");
  assert.ok(page.part("submit") && page.part("more"), "both buttons show");
  page.note("Typed before the pick");
  page.radio("shorter").focus();
  page.radio("shorter").click();
  assert.ok(page.part("next"), "the Next round cards show after the first selection");
  assert.equal(page.radio("shorter").checked, true, "the clicked card is still selected");
  assert.equal(page.doc.activeElement, page.radio("shorter"), "the focus stays on the clicked card");
  assert.equal(page.part("note").querySelector("textarea").value, "Typed before the pick", "the typed note stays");
  page.radio(NO_FIT).click();
  assert.ok(page.part("next"), "the cards stay when the pick changes");
});

test("Submit (done) sends no nextRound, also with a selected suggestion; Next round sends @feedback or the roundId of the selected suggestion", async (t) => {
  const s = await serve(t, await setup(t));
  const sessions = [];
  for (const [actionId, extra] of [["create-done", { nextRounds: NEXT_ROUNDS }], ["create-feedback", { nextRounds: NEXT_ROUNDS }], ["create-chosen", { nextRounds: NEXT_ROUNDS }], ["create-bare", {}]]) {
    sessions.push(await created(s, { ...textRequest(actionId), title: actionId, ...extra }));
  }
  const [done, feedback, chosen, bare] = sessions;
  const routes = sessions.map((made) => `${API}/sessions/${made.result.sessionId}/submit`);
  const submits = [];
  const page = await bootPage(t, s, done.path, { intercept: async (route, options) => {
    if (options.method === "POST" && routes.includes(route)) submits.push({ route, body: JSON.parse(options.body) });
  } });
  const round = (value) => [...page.part("next").querySelectorAll('input[type="radio"]')].find((input) => input.value === value);
  const open = (made) => page.click(page.$("sessions").querySelector(`[data-session="${made.result.sessionId}"]`));
  page.radio("short").click();
  assert.equal(round(FROM_FEEDBACK).checked, true, "From my comments and note is the default");
  round("mix-a-c").click();
  await page.click(page.part("submit"));
  await open(feedback);
  page.radio("short").click();
  assert.equal(round(FROM_FEEDBACK).checked, true, "a new selected session starts with the first card");
  await page.click(page.part("more"));
  assert.match(page.$("decision").textContent, /Next round: from your comments and note\./);
  await open(chosen);
  page.radio("short").click();
  round("mix-a-c").click();
  await page.click(page.part("more"));
  await open(bare);
  page.radio("short").click();
  assert.ok(page.part("submit") && page.part("more"), "a session without suggestions shows both buttons");
  assert.equal(page.part("next"), null, "and no Next round picker");
  await page.click(page.part("more"));
  assert.deepEqual(submits.map((item) => item.route), routes, "each press sends exactly one submit");
  assert.equal(Object.hasOwn(submits[0].body, "nextRound"), false, "Submit (done) sends no nextRound");
  assert.deepEqual(submits.slice(1).map((item) => item.body.nextRound), ["@feedback", "mix-a-c", "@feedback"]);
});

test("a later round shows its round line, and the earlier title selects the earlier session", async (t) => {
  const s = await serve(t, await setup(t));
  const first = await created(s, { ...textRequest("create-chain-1"), nextRounds: NEXT_ROUNDS });
  const browser = await owner(s, first.path);
  const submitted = await browser.call(`sessions/${first.result.sessionId}/submit`, { method: "POST", body: { actionId: "submit-chain", pick: null, nextRound: "mix-a-c" } });
  assert.equal(submitted.status, 200, submitted.text);
  const second = await created(s, { ...textRequest("create-chain-2"), title: "Round two", previous: { sessionId: first.result.sessionId, roundId: "mix-a-c" } });
  const page = await bootPage(t, s, second.path);
  const line = page.$("rounds").querySelector(".cmp-round-line");
  assert.match(line.textContent, /\bRound 2\b/);
  const link = line.querySelector("button");
  assert.equal(link.textContent, first.view.title);
  await page.click(link);
  assert.equal(page.$("title").textContent, first.view.title);
});

test("the open earlier session shows the link to a later round that the next poll lists, without a new selection", async (t) => {
  const s = await serve(t, await setup(t));
  const first = await created(s, { ...textRequest("create-parent"), nextRounds: NEXT_ROUNDS });
  const browser = await owner(s, first.path);
  for (const [route, body] of [["submit", { actionId: "submit-parent", pick: "short", nextRound: "mix-a-c" }], ["seen", {}]]) {
    const answer = await browser.call(`sessions/${first.result.sessionId}/${route}`, { method: "POST", body });
    assert.equal(answer.status, 200, answer.text);
  }
  const page = await bootPage(t, s, first.path);
  assert.equal(page.$("rounds").querySelector("[data-round]"), null);
  const second = await created(s, { ...textRequest("create-child"), title: "Round two", previous: { sessionId: first.result.sessionId, roundId: "mix-a-c" } });
  await page.app.load();
  assert.equal(page.$("rounds").querySelector(`[data-round="${second.result.sessionId}"]`)?.textContent, "Round two");
  assert.equal(page.$("title").textContent, first.view.title, "the earlier session stays selected");
});

test("after a reload, an open panel over the A2UI size limit still shows the pick, the round and the note of a pending submit", { timeout: 10000 }, async (t) => {
  const s = await serve(t, await setup(t));
  // Three summaries, four suggestion summaries and the note at their limits, in a character of three UTF-8 bytes.
  const long = (length) => "\u6587".repeat(length);
  const request = textRequest("create-large");
  request.options = [...request.options, { optionId: "third", label: "Third", format: "text", content: "A third text." }].map((item) => ({ ...item, summary: long(2000) }));
  request.nextRounds = ["one", "two", "three", "four"].map((roundId) => ({ roundId, label: `Round ${roundId}`, summary: long(2000) }));
  const made = await created(s, request);
  const pending = { op: "submit", sessionId: made.result.sessionId, body: { actionId: "submit-large", pick: "short", comments: {}, note: long(8000), nextRound: "two" } };
  const page = await bootPage(t, s, made.path, { pending });
  assert.equal(page.radio("short").checked, true, "the panel shows the pick of the pending request");
  assert.equal(page.part("next").querySelector('input[value="two"]').checked, true, "the panel shows the round of the pending request");
  assert.equal(page.part("note").querySelector("textarea").value, pending.body.note, "the panel shows the note of the pending request");
  assert.ok(page.part("submit"), "the panel has its Submit control");
  assert.equal(page.$("resolve").hidden, false, "the retry control shows");
  assert.equal(page.$("decision").querySelector(".a2-over"), null, "no line says that the surface is too large");
  assert.deepEqual([...page.$("decision").querySelectorAll(".a2-error")].filter((node) => !node.hidden), [], "no line says that the surface was refused");
});

test("the decision panel shows a preview in each option card and in a suggestion card with a preview, and a poll keeps them", async (t) => {
  const s = await serve(t, await setup(t));
  const request = textRequest("create-previews");
  // A long indent before the text does not use up the cut of the preview.
  request.options = [...request.options, { optionId: "third", label: "Third", format: "text", content: `${" ".repeat(600)}A third text.` }];
  request.nextRounds = [{ ...NEXT_ROUNDS[0], preview: { format: "text", content: "B in one line.\nB in two lines." } }, NEXT_ROUNDS[1]];
  const made = await created(s, request);
  const page = await bootPage(t, s, made.path);
  page.radio("short").click();
  const previews = () => [...page.$("decision").querySelectorAll(".a2-option-preview")];
  const shown = previews();
  assert.deepEqual(shown.map((node) => node.closest("[data-value]").dataset.value), ["short", "shorter", "third", "shorter-b"]);
  assert.equal(shown[0].textContent, request.options[0].content);
  assert.equal(shown[2].textContent, "A third text.");
  await page.app.load();
  await page.app.load();
  assert.ok(previews().length === shown.length && previews().every((node, index) => node === shown[index]), "a poll keeps the preview nodes");
});

test("an open panel over the A2UI size limit shows no preview first, and keeps the labels, the summaries and Submit", { timeout: 10000 }, async (t) => {
  const s = await serve(t, await setup(t));
  // In a character of three UTF-8 bytes: the summaries at their limit, previews at their cut, and a note that the
  // panel holds without the previews but not with them.
  const long = (length) => "\u6587".repeat(length);
  const request = textRequest("create-large-previews");
  request.options = [...request.options, { optionId: "third", label: "Third", format: "text", content: "A third text." }]
    .map((item, index) => ({ ...item, summary: long(2000), content: `${index} ${long(700)}` }));
  request.nextRounds = ["one", "two", "three", "four"].map((roundId) => ({ roundId, label: `Round ${roundId}`, summary: long(2000), preview: { format: "text", content: long(700) } }));
  const made = await created(s, request);
  const pending = { op: "submit", sessionId: made.result.sessionId, body: { actionId: "submit-large", pick: "short", comments: {}, note: long(5000) } };
  const page = await bootPage(t, s, made.path, { pending });
  const panel = page.$("decision");
  assert.equal(panel.querySelector(".a2-option-preview"), null, "the panel shows no preview");
  assert.deepEqual([...panel.querySelectorAll(".a2-option-label")].map((node) => node.textContent),
    ["Short", "Shorter", "Third", "No option fits", "From my comments and note", "Round one", "Round two", "Round three", "Round four"]);
  assert.equal(panel.querySelector('[data-value="short"] .a2-option-description').textContent, long(2000), "the summaries stay");
  assert.ok(page.part("submit"), "the panel has its Submit control");
  assert.deepEqual([...panel.querySelectorAll(".a2-error")].filter((node) => !node.hidden), [], "no line says that the surface was refused");
});

test("the receipt of the agent is refused for an open session and for the page credential, and only the first time is saved", async (t) => {
  const s = await serve(t, await setup(t));
  const made = await created(s, textRequest("create-receipt"));
  const session = `sessions/${made.result.sessionId}`;
  const browser = await owner(s, made.path);
  const early = await s.agent(`${session}/received`, { method: "POST", body: {} });
  assert.equal(early.status, 409, early.text);
  assert.equal(early.json.error.code, "INVALID_TRANSITION");
  const submitted = await browser.call(`${session}/submit`, { method: "POST", body: { actionId: "submit-receipt", pick: "short" } });
  assert.equal(submitted.status, 200, submitted.text);
  assert.equal((await browser.call(`${session}/received`, { method: "POST", body: {} })).status, 403, "the page credential must not send the receipt");
  const first = await s.agent(`${session}/received`, { method: "POST", body: {} });
  assert.equal(first.status, 200, first.text);
  assert.equal(Number.isNaN(Date.parse(first.json.result.receivedAt)), false);
  const again = await s.agent(`${session}/received`, { method: "POST", body: {} });
  assert.equal(again.json.result.receivedAt, first.json.result.receivedAt, "a second receipt keeps the first time");
  assert.equal(again.json.view.receivedAt, first.json.result.receivedAt);
});

test("wait on a submitted session sends the receipt and prints receivedAt, and the view holds the same time", async (t) => {
  const f = await setup(t);
  const env = { ...process.env, HUMAN_REVIEW_STATE_DIR: f.stateDir, HUMAN_REVIEW_COMPARE_ROOT: f.root, HUMAN_REVIEW_IDLE_MS: "0" };
  delete env.HUMAN_REVIEW_HOSTED;
  const cli = async (...args) => (await run(process.execPath, [CLI, ...args], { env })).stdout;
  let serverPid = 0;
  t.after(async () => {
    if (serverPid) try { process.kill(serverPid); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  const file = path.join(f.dir, "request.json");
  await fs.writeFile(file, JSON.stringify(textRequest("create-wait-receipt")));
  const made = JSON.parse(await cli("create", file));
  serverPid = JSON.parse(await fs.readFile(path.join(f.stateDir, "server.json"), "utf8")).pid;
  const port = Number(new URL(made.url).port);
  const token = (await request(port, new URL(made.url).pathname)).text.match(/data-token="([a-f0-9]{64})"/)[1];
  const submitted = await request(port, `${API}/sessions/${made.sessionId}/submit`, { token, method: "POST", body: { actionId: "submit-wait", pick: "short" } });
  assert.equal(submitted.status, 200, submitted.text);
  const ready = JSON.parse(await cli("wait", made.sessionId, "--timeout", "5"));
  assert.equal(ready.status, "ready");
  assert.equal(typeof ready.receivedAt, "string");
  assert.equal(JSON.parse(await cli("view", made.sessionId)).receivedAt, ready.receivedAt);
});

test("a submitted session shows the waiting line, and the next poll shows the receipt with the same option frames", async (t) => {
  const s = await serve(t, await setup(t));
  const made = await created(s, htmlRequest("create-receipt-page"));
  const session = `sessions/${made.result.sessionId}`;
  const browser = await owner(s, made.path);
  const submitted = await browser.call(`${session}/submit`, { method: "POST", body: { actionId: "submit-receipt-page", pick: "b" } });
  assert.equal(submitted.status, 200, submitted.text);
  const page = await bootPage(t, s, made.path);
  const line = page.$("decision").querySelector('[role="status"]');
  assert.equal(line.hidden, false);
  assert.match(line.textContent, /^Waiting for the agent/);
  const frames = [...page.$("stage").querySelectorAll("iframe")];
  assert.ok(frames.length >= 1, "the session shows its option frames");
  const received = await s.agent(`${session}/received`, { method: "POST", body: {} });
  assert.equal(received.status, 200, received.text);
  await page.app.load();
  assert.match(line.textContent, /^The agent received your result at /);
  const after = [...page.$("stage").querySelectorAll("iframe")];
  assert.equal(after.length === frames.length && after.every((frame, at) => frame === frames[at]), true, "the option frames are the same nodes");
});

test("a result of the button Next round shows the result text with the round, and then the received line after the receipt", async (t) => {
  const s = await serve(t, await setup(t));
  const made = await created(s, { ...textRequest("create-receipt-more"), nextRounds: NEXT_ROUNDS });
  const page = await bootPage(t, s, made.path);
  page.radio("short").click();
  [...page.part("next").querySelectorAll('input[type="radio"]')].find((input) => input.value === "mix-a-c").click();
  await page.click(page.part("more"));
  const line = page.$("decision").querySelector('[role="status"]');
  assert.match(line.textContent, /^Waiting for the agent/);
  const received = await s.agent(`sessions/${made.result.sessionId}/received`, { method: "POST", body: {} });
  assert.equal(received.status, 200, received.text);
  await page.app.load();
  const result = page.part("result");
  assert.match(result.textContent, /^You picked Short\. Next round: Mix A and C\./);
  assert.match(line.textContent, /^The agent received your result at /);
  assert.equal(line.hidden, false);
  assert.equal(result.compareDocumentPosition(line) & page.window.Node.DOCUMENT_POSITION_FOLLOWING, page.window.Node.DOCUMENT_POSITION_FOLLOWING, "the received line follows the result text");
});

test("a column comment over the limit makes both buttons refuse with a message, also with No option fits", async (t) => {
  const s = await serve(t, await setup(t));
  const made = await created(s, textRequest("create-long-comment"));
  const route = `${API}/sessions/${made.result.sessionId}/submit`;
  const submits = [];
  const page = await bootPage(t, s, made.path, { intercept: async (path, options) => {
    if (options.method === "POST" && path === route) submits.push(JSON.parse(options.body));
  } });
  const comment = page.$("stage").querySelector('[data-comment="short"]');
  const type = (text) => { comment.value = text; comment.dispatchEvent(new page.window.Event("input")); };
  const message = (id) => page.doc.getElementById(page.part(id).getAttribute("aria-describedby")).textContent;
  assert.equal(comment.maxLength, 8000, "the field has the limit of the store");
  page.radio(NO_FIT).click();
  page.note("Neither version fits");
  // A pasted or restored value can be longer than maxLength allows by typing.
  type("x".repeat(8001));
  for (const id of ["submit", "more"]) {
    assert.equal(page.part(id).disabled, true, `${id} refuses a comment over the limit`);
    assert.match(message(id), /comment/i, `the message of ${id} names a comment`);
    assert.match(message(id), /\b8000 characters\b/, `the message of ${id} names the limit`);
    await page.click(page.part(id));
  }
  assert.deepEqual(submits, [], "no button sends a comment over the limit");
  type("x".repeat(8000));
  assert.equal(page.part("more").disabled, false, "a comment at the limit is valid");
  await page.click(page.part("more"));
  assert.equal(submits.length, 1);
  assert.equal((await s.agent(`sessions/${made.result.sessionId}`)).json.view.result.comments.short.length, 8000, "the store takes the comment");
});

test("the comment fields are read-only while a submit is held; after a reload they hold the comments of the pending body, and the retry sends the same body", { timeout: 10000 }, async (t) => {
  const s = await serve(t, await setup(t));
  const held = await created(s, htmlRequest("create-held-comments"));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const page = await bootPage(t, s, held.path, { intercept: async (path, options) => {
    if (options.method === "POST" && path === `${API}/sessions/${held.result.sessionId}/submit`) await gate;
  } });
  const fields = (at) => [...at.$("stage").querySelectorAll("[data-comment]")];
  const comment = fields(page)[0];
  comment.value = "Before the submit";
  comment.dispatchEvent(new page.window.Event("input"));
  page.radio("b").click();
  const done = page.click(page.part("submit"));
  assert.deepEqual(fields(page).map((field) => field.readOnly), [true, true, true], "no comment takes an edit while the submit is held");
  assert.equal([...page.$("stage").querySelectorAll("[data-pick]")].every((button) => button.disabled), true, "no column pick button takes a click");
  release();
  await done;

  const made = await created(s, htmlRequest("create-reload-comments"));
  const route = `${API}/sessions/${made.result.sessionId}/submit`;
  const pending = { op: "submit", sessionId: made.result.sessionId, body: { actionId: "submit-comments", pick: "b", comments: { a: "Too many resources", c: "Keep the alarm" } } };
  const sent = [];
  const reloaded = await bootPage(t, s, made.path, { pending, intercept: async (path, options) => {
    if (options.method === "POST" && path === route) sent.push(JSON.parse(options.body));
  } });
  assert.deepEqual(fields(reloaded).map((field) => [field.value, field.readOnly]), [["Too many resources", true], ["", true], ["Keep the alarm", true]], "the fields show the comments of the pending body");
  await reloaded.click(reloaded.$("resolve"));
  assert.deepEqual(sent, [pending.body], "the retry sends the same body");
});
