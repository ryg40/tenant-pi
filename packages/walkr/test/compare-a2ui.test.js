import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { bootCompare } from "../src/compare.js";
import { footerMessages, paneMessages, readingMessages } from "../src/compare-a2ui.js";
import { checkA2uiMessages, createA2uiHost } from "../src/a2ui.js";

const view = { sessionId: "20260101T000000Z-0123456789ab" };
const item = { optionId: "a", label: "First option", format: "html" };

test("pane and reading messages pass the check; the largest option keeps its full text", () => {
  const frames = `/_walkr/compare/o/${"b".repeat(64)}`;
  for (const columns of [false, true]) assert.equal(checkA2uiMessages(paneMessages(view, item, columns, frames)).ok, true);
  const value = "\u0001".repeat(1024 * 1024 - 4) + "tail";
  const { calls, plain } = readingMessages(value, "original");
  assert.equal(plain, true);
  assert.ok(calls.every((call) => checkA2uiMessages(call).ok));
  assert.equal(calls.map(([{ createSurface }]) => createSurface.components[0].text).join(""), value);
  const [{ createSurface }] = readingMessages("a red ball", "a blue ball").calls[0];
  assert.deepEqual(createSurface.components[0]["@metadata"].extensions.walkr_marks, [[2, 5]]);
});

test("a locked pane refuses comment edits", (t) => {
  const dom = new JSDOM(); t.after(() => dom.window.close());
  const host = createA2uiHost(dom.window.document, { onChange: () => assert.fail("locked") });
  assert.equal(host.apply(footerMessages("First", true)).ok, true);
  const input = host.element.querySelector("textarea");
  assert.equal(input.readOnly, true);
  input.value = "changed"; input.dispatchEvent(new dom.window.Event("input"));
  assert.equal(input.value, "");
  dom.window.document.body.append(host.element); input.focus();
  host.apply([{ version: "1.0", updateDataModel: { surfaceId: "footer", path: "/comment", value: "Saved in the other page" } }]);
  assert.equal(input.value, "Saved in the other page"); host.close();
});

test("switching preserves the draft; a poll keeps the pane and both renderers submit the same body", async (t) => {
  const shell = readFileSync(new URL("../src/compare.html", import.meta.url), "utf8");
  const session = { ...view, workflow: "text-revision", status: "open", brief: "Compare these", clarifications: [], revision: 1,
    options: ["a", "b"].map((id) => ({ optionId: id, label: id, format: "text", content: id })) };
  const bodies = [];
  for (const renderer of ["current", "a2ui"]) {
    const dom = new JSDOM(shell, { url: `http://localhost/#${view.sessionId};renderer=${renderer}` });
    const win = dom.window, doc = win.document, get = (selector) => doc.querySelector(selector);
    win.crypto.randomUUID = () => "same-action";
    const row = { ...session, ref: view.sessionId, type: "compare", updatedAt: "first" };
    const app = bootCompare(win, { fetch: async (route, options) => {
      if (options.method === "POST") { bodies.push(JSON.parse(options.body)); throw Error("offline"); }
      return { ok: true, json: async () => route.endsWith("history") ? { rows: [row] } : { view: session } };
    } });
    t.after(() => { app.close(); win.close(); }); await app.ready;
    const stage = renderer === "a2ui" ? "#aStage" : "#stage";
    const input = get(`${stage} textarea`); input.focus(); input.value = "Keep this";
    input.dispatchEvent(new win.Event("input")); input.setSelectionRange(1, 3);
    await app.load();
    assert.equal(get(`${stage} textarea`), input); assert.equal(doc.activeElement, input);
    assert.deepEqual([input.selectionStart, input.selectionEnd], [1, 3]);
    get(`${stage} ${renderer === "a2ui" ? '[data-a2ui-id="pick"]' : '[data-pick]'}`).click();
    const change = (value) => { get("#renderer").value = value; get("#renderer").dispatchEvent(new win.Event("change")); };
    change(renderer === "current" ? "a2ui" : "current");
    const other = renderer === "current" ? "#aStage" : "#stage";
    assert.equal(get(`${other} textarea`).value, "Keep this"); assert.ok(get(`${other} [aria-pressed=true]`));
    change(renderer);
    get('#decision [data-a2ui-id="submit"]').click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(get(`${stage} textarea`).readOnly, true);
    assert.equal(get("#resolve").hidden, false);
  }
  assert.deepEqual(bodies[0], { pick: "a", actionId: "same-action", comments: { a: "Keep this" } });
  assert.deepEqual(bodies, [bodies[0], bodies[0]]);
});

test("a fragment with an unknown suffix selects no session and forces no renderer", async (t) => {
  const shell = readFileSync(new URL("../src/compare.html", import.meta.url), "utf8");
  for (const [suffix, id] of [[";typo", null], [";renderer=a2ui;more", null], ["", view.sessionId], [";renderer=a2ui", view.sessionId]]) {
    const dom = new JSDOM(shell, { url: "http://localhost/" });
    const win = dom.window;
    win.location.hash = view.sessionId + suffix;
    const asked = [];
    const session = { ...view, workflow: "text-revision", status: "open", brief: "Compare these", clarifications: [], revision: 1,
      options: ["a", "b"].map((id) => ({ optionId: id, label: id, format: "text", content: id })) };
    const row = { ...session, ref: view.sessionId, type: "compare", updatedAt: "first" };
    const app = bootCompare(win, { fetch: async (route) => { asked.push(route);
      return { ok: true, json: async () => route.endsWith("history") ? { rows: [row] } : { view: session } }; } });
    t.after(() => { app.close(); win.close(); }); await app.ready;
    assert.equal(asked.some((route) => route.split("/").includes(view.sessionId)), id !== null, suffix);
  }
});

test("A2UI preview matches Current for comment fields, rails, badges, open folds across a live outcome, and picked tabs", async (t) => {
  const shell = readFileSync(new URL("../src/compare.html", import.meta.url), "utf8");
  const probeCurrent = (doc) => {
    const panes = [...doc.querySelectorAll("#stage .cmp-option")].map((pane) => {
      const comment = pane.querySelector("textarea");
      const rail = pane.querySelector(".cmp-rail");
      const railMark = rail.querySelector(".cmp-rail-pick");
      const badge = pane.querySelector(".cmp-option-picked");
      const foot = pane.querySelector(".cmp-option-foot");
      return {
        commentName: comment.getAttribute("aria-label"),
        commentHint: comment.placeholder,
        commentReadOnly: comment.readOnly,
        railName: rail.getAttribute("aria-label"),
        railPicked: !railMark.hidden,
        pickedBadge: !badge.hidden,
        labelsRepeated: Boolean(foot.querySelector("label, .cmp-label")),
      };
    });
    const folds = [doc.getElementById("context"), doc.getElementById("original")];
    return {
      panes,
      briefHeadings: [...folds[0].querySelectorAll("h2, h3")].map((node) => node.textContent),
      foldsOpen: folds.map((fold) => fold.open),
    };
  };
  const probeA2ui = (doc) => {
    const panes = [...doc.querySelectorAll("#aStage .a-pane")].map((pane) => {
      const comment = pane.querySelector("textarea");
      const railMark = pane.querySelector('button [aria-hidden="true"]');
      const rail = railMark.closest("button");
      const badge = [...pane.querySelectorAll('[aria-hidden="true"]')].find((node) => !node.closest("button"));
      const foot = comment.closest("section");
      return {
        commentName: comment.getAttribute("aria-label"),
        commentHint: comment.placeholder,
        commentReadOnly: comment.readOnly,
        railName: rail.getAttribute("aria-label"),
        railPicked: !railMark.hidden,
        pickedBadge: Boolean(badge && !badge.hidden),
        labelsRepeated: Boolean(foot.querySelector("label, .a2-label")),
      };
    });
    const folds = [...doc.querySelectorAll("#aInfo details")];
    return {
      panes,
      briefHeadings: [...folds[0].querySelectorAll("h2, h3")].map((node) => node.textContent),
      foldsOpen: folds.map((fold) => fold.open),
    };
  };
  const probeTabs = (doc, renderer) => [...doc.querySelectorAll(renderer === "a2ui" ? '#aTabs [role="tab"]' : '#tabs [role="tab"]')]
    .map((tab) => ({ label: tab.textContent, picked: tab.dataset.picked === "true" }));

  const run = async (renderer) => {
    const dom = new JSDOM(shell, { url: `http://localhost/#${view.sessionId};renderer=${renderer}` });
    const win = dom.window, doc = win.document;
    let current = {
      ...view, workflow: "text-revision", status: "open", title: "Compare check", brief: "First line.\nSecond line.",
      clarifications: [{ question: "Who reads this?", answer: "Reviewers." }],
      source: { label: "Original text", format: "text", content: "Original alpha" },
      revision: 1,
      options: [
        { optionId: "a", label: "Long option title", summary: "Summary text", format: "text", content: "Alpha" },
        { optionId: "b", label: "Short option", format: "text", content: "Beta" },
      ],
    };
    let updatedAt = "v1";
    const app = bootCompare(win, { fetch: async (route) => ({ ok: true, json: async () => route.endsWith("history")
      ? { rows: [{ ...current, ref: view.sessionId, type: "compare", updatedAt }] } : { view: current } }) });
    t.after(() => { app.close(); win.close(); });
    await app.ready;
    const probe = renderer === "a2ui" ? probeA2ui : probeCurrent;
    const open = probe(doc);
    for (const fold of renderer === "a2ui" ? doc.querySelectorAll("#aInfo details") : [doc.getElementById("context"), doc.getElementById("original")]) {
      fold.open = true;
    }
    current = {
      ...current, status: "submitted", revision: 2, result: { pick: "a", comments: {} },
      outcome: { summary: "Applied.", at: "2026-01-01T00:01:00Z" },
    };
    updatedAt = "v2";
    await app.load();
    const submitted = probe(doc);
    const mode = doc.getElementById("viewMode");
    mode.value = "single";
    mode.dispatchEvent(new win.Event("change"));
    return { open, submitted: { ...submitted, tabs: probeTabs(doc, renderer) } };
  };

  const current = await run("current");
  const a2ui = await run("a2ui");
  assert.deepEqual(a2ui.open, current.open);
  assert.deepEqual(a2ui.submitted, current.submitted);
});

test("A2UI rating locks stars only while a send runs and keeps the rating note editable", async (t) => {
  const shell = readFileSync(new URL("../src/compare.html", import.meta.url), "utf8");
  const dom = new JSDOM(shell, { url: `http://localhost/#${view.sessionId};renderer=a2ui` });
  const win = dom.window, doc = win.document;
  const session = {
    ...view, workflow: "text-revision", status: "open", title: "Rating lock check", brief: "Check rating lock.",
    clarifications: [], revision: 1,
    options: [
      { optionId: "a", label: "First", format: "text", content: "Alpha" },
      { optionId: "b", label: "Second", format: "text", content: "Beta" },
    ],
  };
  const row = { ...session, ref: view.sessionId, type: "compare", updatedAt: "v1" };
  let releasePost;
  const app = bootCompare(win, { fetch: async (route, options) => {
    if (options?.method === "POST") return new Promise((_, reject) => { releasePost = () => reject(new Error("offline")); });
    return { ok: true, json: async () => route.endsWith("history") ? { rows: [row] } : { view: session } };
  } });
  t.after(() => { app.close(); win.close(); });
  await app.ready;
  const stars = () => [...doc.querySelectorAll('#aRating [role="radio"]')];
  const note = doc.querySelector('#aRating [data-a2ui-id="note"] textarea');
  const save = doc.querySelector('#aRating [data-a2ui-id="save"]');
  const resolve = doc.getElementById("resolve");
  assert.equal(stars().every((node) => !node.disabled), true);
  assert.equal(note.readOnly, false);
  doc.querySelector('#aStage [data-a2ui-id="pick"]').click();
  doc.querySelector('#decision [data-a2ui-id="submit"]').click();
  assert.equal(stars().every((node) => node.disabled), true, "stars lock while the submit is in flight");
  assert.equal(note.readOnly, false, "rating note stays editable while the submit is in flight");
  assert.equal(save.disabled, true);
  assert.equal(resolve.disabled, true);
  releasePost();
  await app.load();
  const deadline = Date.now() + 2000;
  while ((resolve.hidden || resolve.disabled) && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 5));
  }
  assert.equal(resolve.hidden, false);
  assert.equal(resolve.disabled, false);
  assert.equal(stars().every((node) => !node.disabled), true, "stars unlock while the result is uncertain");
  assert.equal(note.readOnly, false, "rating note stays editable while the result is uncertain");
  stars()[6].click();
  note.value = "Draft while uncertain";
  note.dispatchEvent(new win.Event("input"));
  assert.equal(stars()[6].getAttribute("aria-checked"), "true");
  assert.equal(note.value, "Draft while uncertain");
  assert.equal(save.disabled, true, "Save rating stays disabled while a request is pending");
});

async function waitUntil(ready, expected, limit = 2000) {
  const deadline = Date.now() + limit;
  while (!ready()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting until ${expected}`);
    await new Promise((done) => setTimeout(done, 5));
  }
}

const a2uiPane = (doc, optionId) => doc.querySelector(`#aStage #a-body-${optionId}`)?.closest(".a-pane");
const a2uiComment = (doc, optionId) => a2uiPane(doc, optionId)?.querySelector("textarea");
const a2uiPick = (doc, optionId) => a2uiPane(doc, optionId)?.querySelector('[data-a2ui-id="pick"]');

test("in A2UI, an already-submitted response keeps the first saved pick and comments and locks the panes", async (t) => {
  const shell = readFileSync(new URL("../src/compare.html", import.meta.url), "utf8");
  const open = { ...view, workflow: "text-revision", title: "Session one", status: "open", brief: "Compare", clarifications: [], revision: 1,
    options: [{ optionId: "a", label: "First", format: "text", content: "A" }, { optionId: "b", label: "Second", format: "text", content: "B" }] };
  const saved = { ...open, status: "submitted", revision: 2, updatedAt: "second",
    result: { actionId: "first-action", pick: "a", comments: { a: "First saved comment" }, note: "First note", submittedAt: "2026-01-01T00:01:00.000Z" } };
  let currentView = open;
  const dom = new JSDOM(shell, { url: `http://localhost/#${view.sessionId};renderer=a2ui` });
  const win = dom.window, doc = win.document, get = (selector) => doc.querySelector(selector);
  const app = bootCompare(win, { fetch: async (route, options) => {
    const tail = route.split("/").at(-1);
    if (options.method === "POST" && tail === "submit") {
      currentView = saved;
      return { ok: true, json: async () => ({ view: saved, result: { outcome: "already-submitted", replay: true, result: saved.result } }) };
    }
    const row = { ...currentView, ref: view.sessionId, type: "compare", updatedAt: currentView.updatedAt || "first" };
    return { ok: true, json: async () => tail === "history" ? { rows: [row] } : { view: currentView } };
  } });
  t.after(() => { app.close(); win.close(); }); await app.ready;
  const draftB = a2uiComment(doc, "b");
  draftB.value = "Losing draft on B";
  draftB.dispatchEvent(new win.Event("input"));
  a2uiPick(doc, "b").click();
  get('#decision [data-a2ui-id="submit"]').click();
  await waitUntil(() => get("#resolve").hidden, "the Retry button is hidden");
  assert.equal(win.localStorage.getItem("walkr-compare:pending"), null);
  assert.deepEqual(
    {
      a: [a2uiComment(doc, "a").value, a2uiComment(doc, "a").readOnly],
      b: [a2uiComment(doc, "b").value, a2uiComment(doc, "b").readOnly],
    },
    { a: ["First saved comment", true], b: ["", true] },
  );
  assert.deepEqual(
    {
      a: {
        picked: a2uiPane(doc, "a").dataset.picked,
        pressed: a2uiPick(doc, "a").getAttribute("aria-pressed"),
        disabled: a2uiPick(doc, "a").disabled,
      },
      b: {
        picked: a2uiPane(doc, "b").dataset.picked,
        pressed: a2uiPick(doc, "b").getAttribute("aria-pressed"),
        disabled: a2uiPick(doc, "b").disabled,
      },
    },
    {
      a: { picked: "true", pressed: "true", disabled: true },
      b: { picked: "false", pressed: "false", disabled: true },
    },
  );
});

test("in A2UI, a stale panel cannot submit for another session and a restored over-limit comment refuses submit", async (t) => {
  const shell = readFileSync(new URL("../src/compare.html", import.meta.url), "utf8");
  const secondId = "20260101T000001Z-abcdef012345";
  const makeSession = (sessionId, title) => ({ sessionId, workflow: "text-revision", title, status: "open", brief: "Compare", clarifications: [], revision: 1,
    options: [{ optionId: "a", label: "First", format: "text", content: "A" }, { optionId: "b", label: "Second", format: "text", content: "B" }] });
  const sessions = { [view.sessionId]: makeSession(view.sessionId, "First"), [secondId]: makeSession(secondId, "Second") };
  const posts = [];
  let rejectRetry = true;
  const dom = new JSDOM(shell, { url: `http://localhost/#${view.sessionId};renderer=a2ui` });
  const win = dom.window, doc = win.document, get = (selector) => doc.querySelector(selector);
  win.localStorage.setItem("walkr-compare:pending", JSON.stringify({
    op: "submit", sessionId: view.sessionId, body: { actionId: "over-1", pick: "a", comments: { a: "x".repeat(8001) } },
  }));
  const app = bootCompare(win, { fetch: async (route, options) => {
    const parts = route.split("/");
    const tail = parts.at(-1);
    if (options.method === "POST" && tail === "submit") {
      posts.push({ sessionId: parts.at(-2), body: JSON.parse(options.body) });
      if (rejectRetry) {
        rejectRetry = false;
        return { ok: false, status: 400, json: async () => ({ error: { code: "INVALID_REQUEST", message: "Too long" } }) };
      }
      return { ok: false, status: 400, json: async () => ({ error: { code: "INVALID_REQUEST", message: "Unexpected" } }) };
    }
    if (tail === "history") return { ok: true, json: async () => ({ rows: Object.values(sessions).map((item) => ({ ...item, ref: item.sessionId, type: "compare", updatedAt: "first" })) }) };
    return { ok: true, json: async () => ({ view: sessions[tail] }) };
  } });
  t.after(() => { app.close(); win.close(); }); await app.ready;
  assert.equal(a2uiComment(doc, "a").value.length, 8001);
  assert.equal(a2uiComment(doc, "a").readOnly, true);
  get("#resolve").click();
  await waitUntil(
    () => get("#resolve").hidden && a2uiComment(doc, "a")?.readOnly === false,
    "the Retry button is hidden and option a's comment is editable",
  );
  assert.equal(posts.length, 1);
  const comment = a2uiComment(doc, "a");
  assert.equal(comment.value.length, 8001);
  const submit = get('#decision [data-a2ui-id="submit"]');
  const more = get('#decision [data-a2ui-id="more"]');
  assert.equal(submit.disabled, true);
  assert.equal(more.disabled, true);
  submit.disabled = false;
  submit.click();
  assert.equal(posts.length, 1, "over-limit comment refuses submit even if button is clicked");
  comment.value = "x".repeat(8000);
  comment.dispatchEvent(new win.Event("input"));
  assert.equal(submit.disabled, false);
  assert.equal(more.disabled, false);
  // Hold the panel's Submit button for session 1, switch to session 2, and try clicking the stale button.
  const staleSubmit = get('#decision [data-a2ui-id="submit"]');
  get(`#sessions button[data-session="${secondId}"]`).click();
  await waitUntil(() => get("#title").textContent === "Second", "the second session loads");
  staleSubmit.disabled = false;
  staleSubmit.click();
  await app.load();
  await waitUntil(
    () => get("#title").textContent === "Second" && get("#resolve").hidden,
    "the second session stays open with the Retry button hidden",
  );
  assert.equal(posts.length, 1, "a stale panel button sends no request for another session");
});

test("in A2UI, an uncertain malformed submit restores pending comments on reload without replaying and retries identically", async (t) => {
  const shell = readFileSync(new URL("../src/compare.html", import.meta.url), "utf8");
  const session = { ...view, workflow: "text-revision", title: "Retry session", status: "open", brief: "Compare", clarifications: [], revision: 1,
    options: [{ optionId: "a", label: "First", format: "text", content: "A" }, { optionId: "b", label: "Second", format: "text", content: "B" }] };
  const row = { ...session, ref: view.sessionId, type: "compare", updatedAt: "first" };
  const sent = [];
  const dom1 = new JSDOM(shell, { url: `http://localhost/#${view.sessionId};renderer=a2ui` });
  const win1 = dom1.window, doc1 = win1.document;
  win1.crypto.randomUUID = () => "retry-action-1";
  const app1 = bootCompare(win1, { fetch: async (route, options) => {
    const tail = route.split("/").at(-1);
    if (options.method === "POST" && tail === "submit") {
      sent.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({}) };
    }
    return { ok: true, json: async () => tail === "history" ? { rows: [row] } : { view: session } };
  } });
  t.after(() => { app1.close(); win1.close(); }); await app1.ready;
  const comment1A = a2uiComment(doc1, "a");
  const comment1B = a2uiComment(doc1, "b");
  comment1A.value = "Keep A comment";
  comment1A.dispatchEvent(new win1.Event("input"));
  comment1B.value = "   ";
  comment1B.dispatchEvent(new win1.Event("input"));
  a2uiPick(doc1, "a").click();
  doc1.querySelector('#decision [data-a2ui-id="submit"]').click();
  const resolve1 = doc1.getElementById("resolve");
  await waitUntil(() => !resolve1.hidden && !resolve1.disabled, "the Retry button is visible and enabled");
  assert.equal(sent.length, 1);
  const storedPending = win1.localStorage.getItem("walkr-compare:pending");
  assert.ok(storedPending);

  // Reload into a new window with the persisted pending request: no automatic replay, comments restored and locked.
  const dom2 = new JSDOM(shell, { url: `http://localhost/#${view.sessionId};renderer=a2ui` });
  const win2 = dom2.window, doc2 = win2.document;
  win2.localStorage.setItem("walkr-compare:pending", storedPending);
  const app2 = bootCompare(win2, { fetch: async (route, options) => {
    const tail = route.split("/").at(-1);
    if (options.method === "POST" && tail === "submit") {
      sent.push(JSON.parse(options.body));
      return { ok: false, status: 400, json: async () => ({ error: { code: "INVALID_REQUEST", message: "Stopped" } }) };
    }
    return { ok: true, json: async () => tail === "history" ? { rows: [row] } : { view: session } };
  } });
  t.after(() => { app2.close(); win2.close(); }); await app2.ready;
  const resolve2 = doc2.getElementById("resolve");
  await waitUntil(
    () => a2uiComment(doc2, "a")?.value === "Keep A comment"
      && a2uiComment(doc2, "a")?.readOnly === true
      && a2uiComment(doc2, "b")?.readOnly === true
      && !resolve2.hidden
      && !resolve2.disabled,
    "the restored comments are locked and the Retry button is enabled",
  );
  assert.equal(sent.length, 1, "reload does not replay the pending request automatically");
  assert.deepEqual(
    {
      a: [a2uiComment(doc2, "a").value, a2uiComment(doc2, "a").readOnly],
      b: [a2uiComment(doc2, "b").value, a2uiComment(doc2, "b").readOnly],
    },
    { a: ["Keep A comment", true], b: ["", true] },
  );
  resolve2.click();
  await waitUntil(() => resolve2.hidden, "the Retry button is hidden");
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], sent[0]);
  assert.deepEqual(sent[0], { actionId: "retry-action-1", pick: "a", comments: { a: "Keep A comment" } });
});
