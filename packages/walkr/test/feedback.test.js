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
import { FeedbackStore } from "../src/feedback-store.js";
import { tmpRoot } from "./tmp-root.js";

const run = promisify(execFile);
const API = "/_walkr/feedback/api";
const COMPARE_API = "/_walkr/compare/api";
const CLI = fileURLToPath(new URL("../src/walkr-feedback.js", import.meta.url));
const MAIN_CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const HOSTILE = '<!doctype html><h1>Sketch</h1><script>window.injected=1</script>';

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(tmpRoot, "walkr-feedback-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const stateDir = path.join(dir, "state");
  await fs.mkdir(stateDir, { mode: 0o700 });
  return {
    dir,
    stateDir,
    compareRoot: path.join(dir, "walkr", "compare"),
    feedbackRoot: path.join(dir, "walkr", "feedback"),
  };
}

async function serve(t, f, extra = {}) {
  const s = await listen(t, f, {
    HUMAN_REVIEW_COMPARE_ROOT: f.compareRoot,
    HUMAN_REVIEW_FEEDBACK_ROOT: f.feedbackRoot,
    ...extra,
  });
  return {
    ...s,
    agent: (route, options) => s.api(`${API}/${route}`, options),
    compareAgent: (route, options) => s.api(`${COMPARE_API}/${route}`, options),
  };
}

function grillTreeRequest(actionId = "fb-tree-1") {
  return {
    actionId,
    workflow: "grill-me",
    title: "Session refresh and caching",
    brief: "Confirm refresh trigger and retry budget before coding.",
    layout: "tree",
    clarifications: [{ question: "Target runtime?", answer: "Local CLI worker" }],
    repo: { name: "demo-app", revision: "abc1234" },
    items: [
      {
        itemId: "root-store",
        kind: "decision",
        title: "Token storage backend",
        status: "settled",
        settledAnswer: "OS keychain + in-memory cache",
      },
      {
        itemId: "q-refresh",
        kind: "grill",
        parentId: "root-store",
        branchLabel: "Given OS keychain + memory cache",
        title: "How should token refresh trigger?",
        prompt: "Option 1 proactively refreshes inside a 5 minute skew window.",
        actions: "submit-revise",
        recommended: "opt-1",
        options: [
          {
            optionId: "opt-1",
            label: "Proactive skew window",
            summary: "Refresh when within 5m of expiry.",
            explanation: "Prevents concurrent 401 storms while staying idle-friendly with single-flight deduplication.",
            overview: { format: "html", content: HOSTILE },
          },
          {
            optionId: "opt-2",
            label: "Reactive on 401",
            summary: "Wait for an upstream 401 then replay.",
            expandable: true,
          },
          {
            optionId: "opt-3",
            label: "Background timer",
            summary: "Fixed refresh timer while process runs.",
            expandable: true,
          },
        ],
      },
      {
        itemId: "q-retry",
        kind: "decision",
        parentId: "q-refresh",
        branchLabel: "Follow-up after refresh choice",
        title: "Retry budget on transient errors",
        actions: "accept-revise",
        recommended: "r-2",
        options: [
          {
            optionId: "r-2",
            label: "2 retries with jitter",
            summary: "Fast recovery without long hangs.",
            explanation: "Caps total stall time below 3 seconds.",
            overview: { format: "text", content: "Attempt 1 -> wait 250ms -> Attempt 2" },
          },
          {
            optionId: "r-none",
            label: "Fail fast (no retry)",
            summary: "Surface errors immediately to caller.",
            expandable: true,
          },
        ],
      },
    ],
  };
}

function componentRequest(actionId = "fb-comp-1") {
  return {
    actionId,
    workflow: "component-review",
    title: "Status banner chunk",
    brief: "Review the compact warning banner spacing and wording.",
    layout: "single",
    items: [
      {
        itemId: "banner",
        kind: "component",
        title: "Compact warning banner",
        summary: "Single row warning banner with inline retry.",
        explanation: "Uses subtle warm accent and keeps height under 48px.",
        actions: "accept-revise",
        preview: { format: "html", content: "<!doctype html><div>Banner Preview</div>" },
      },
    ],
  };
}

async function created(s, body = grillTreeRequest()) {
  const answer = await s.agent("sessions", { method: "POST", body });
  assert.equal(answer.status, 200, answer.text);
  return answer.json;
}

async function owner(s, pagePath) {
  const page = await request(s.port, pagePath.split("#")[0]);
  assert.equal(page.status, 200);
  const token = page.text.match(/data-token="([a-f0-9]{64})"/)[1];
  const frames = page.text.match(/data-feedback-frames="([^"]+)"/)[1];
  return {
    page,
    token,
    frames,
    call: (route, options = {}) => request(s.port, `${API}/${route}`, { token, ...options }),
  };
}

async function bootPage(t, s, pagePath, { seedStorage = null, intercept = null } = {}) {
  const browser = await owner(s, pagePath);
  const dom = new JSDOM(browser.page.text, { url: `http://127.0.0.1:${s.port}${pagePath}` });
  if (seedStorage) {
    for (const [k, v] of Object.entries(seedStorage)) dom.window.localStorage.setItem(k, v);
  }
  const inflight = new Set();
  const fetchImpl = async (route, options = {}) => {
    const p = request(s.port, route, { method: options.method, headers: options.headers, rawBody: options.body });
    inflight.add(p);
    try {
      const answer = await p;
      const reply = { ok: answer.status === 200, status: answer.status, json: async () => JSON.parse(answer.text) };
      return intercept ? (await intercept(route, options, reply)) ?? reply : reply;
    } finally {
      inflight.delete(p);
    }
  };
  const { bootCompare } = await import("../src/compare.js");
  const app = bootCompare(dom.window, { fetch: fetchImpl, refreshMs: 60000 });
  t.after(async () => {
    app.close();
    await Promise.allSettled([...inflight]);
    dom.window.close();
  });
  await app.ready;
  await Promise.allSettled([...inflight]);
  const doc = dom.window.document;
  const clickAndSettle = async (node) => {
    node.click();
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("Feedback action did not settle")), 5000);
      const tick = () => {
        if (!inflight.size && !doc.getElementById("resolve").disabled) {
          clearTimeout(deadline);
          resolve();
          return;
        }
        setTimeout(tick, 15);
      };
      setTimeout(tick, 15);
    });
    await app.load();
    await Promise.allSettled([...inflight]);
  };
  return { dom, doc, app, browser, clickAndSettle };
}

test("FeedbackStore validates tree cycles, item shapes, presets, and idempotency", async (t) => {
  const f = await setup(t);
  const store = new FeedbackStore({ root: f.feedbackRoot });

  // Cycle in decision tree is rejected.
  const cyclic = grillTreeRequest("bad-cycle");
  cyclic.items[0].parentId = "q-retry";
  await assert.rejects(() => store.create(cyclic), (err) => err.code === "INVALID_REQUEST");

  // Unknown parentId is rejected.
  const orphan = grillTreeRequest("bad-orphan");
  orphan.items[1].parentId = "does-not-exist";
  await assert.rejects(() => store.create(orphan), (err) => err.code === "INVALID_REQUEST");

  // All-settled items is rejected.
  const allSettled = {
    actionId: "bad-settled",
    workflow: "decision-tree",
    title: "Nothing open",
    brief: "Invalid",
    items: [{ itemId: "s1", kind: "decision", title: "Done", status: "settled", settledAnswer: "Yes" }],
  };
  await assert.rejects(() => store.create(allSettled), (err) => err.code === "INVALID_REQUEST");

  // Component with options is rejected; component without preview is rejected.
  const badComp = componentRequest("bad-comp");
  badComp.items[0].options = [{ optionId: "a", label: "A" }, { optionId: "b", label: "B" }];
  await assert.rejects(() => store.create(badComp), (err) => err.code === "INVALID_REQUEST");

  // Duplicate option content is rejected.
  const dupOpt = grillTreeRequest("bad-dup");
  dupOpt.items[2].options = [
    { optionId: "o1", label: "Same", summary: "Identical" },
    { optionId: "o2", label: "Same", summary: "Identical" },
  ];
  await assert.rejects(() => store.create(dupOpt), (err) => err.code === "INVALID_REQUEST");

  // Valid create is idempotent on identical replay, and rejects conflicting payload on same actionId.
  const first = await store.create(componentRequest("comp-idemp"));
  const replay = await store.create(componentRequest("comp-idemp"));
  assert.equal(replay.result.sessionId, first.result.sessionId);
  assert.equal(replay.result.replay, true);
  const mutated = componentRequest("comp-idemp");
  mutated.title = "Different title";
  await assert.rejects(() => store.create(mutated), (err) => err.code === "ACTION_CONFLICT");

  // Component another-round requires a comment; accept works without comment; disallowed decision fails.
  const sid = first.result.sessionId;
  await assert.rejects(
    () => store.respond(sid, { actionId: "r-bad-1", responses: [{ itemId: "banner", decision: "another-round" }] }),
    (err) => err.code === "INVALID_REQUEST",
  );
  await assert.rejects(
    () => store.respond(sid, { actionId: "r-bad-2", responses: [{ itemId: "banner", decision: "submit" }] }),
    (err) => err.code === "INVALID_REQUEST",
  );
  const accepted = await store.respond(sid, { actionId: "r-ok", responses: [{ itemId: "banner", decision: "accept" }] });
  assert.equal(accepted.view.status, "submitted");
  assert.equal(accepted.result.outcome, "submitted");
  const repeat = await store.respond(sid, { actionId: "r-second", responses: [{ itemId: "banner", decision: "accept" }] });
  assert.equal(repeat.result.outcome, "already-submitted");
});

test("Feedback server enforces sandboxed HTML frames, token boundaries, and hosted refusal", async (t) => {
  const f = await setup(t);
  const s = await serve(t, f);
  const made = await created(s, grillTreeRequest("sec-tree"));
  const sid = made.result.sessionId;
  const browser = await owner(s, made.path);

  // Sandboxed HTML concept overview has strict CSP; wrong secret gets 404.
  const frame = await request(s.port, `${browser.frames}/${sid}/q-refresh/opt-1`);
  assert.equal(frame.status, 200);
  assert.equal(frame.text, HOSTILE);
  assert.match(frame.headers["content-security-policy"], /default-src 'none'/);
  assert.match(frame.headers["content-security-policy"], /\bsandbox\b/);
  assert.match(frame.headers["content-security-policy"], /frame-ancestors 'self'/);

  const badCap = await request(s.port, `/_walkr/feedback/o/${"0".repeat(64)}/${sid}/q-refresh/opt-1`);
  assert.equal(badCap.status, 404);

  // Agent token cannot call owner writes (seen, expand, respond, rate).
  for (const [op, body] of [
    ["seen", {}],
    ["expand", { actionId: "a1", itemId: "q-refresh" }],
    ["respond", { actionId: "a2", responses: [{ itemId: "q-refresh", decision: "submit", pick: "opt-1" }] }],
    ["rate", { actionId: "a3", rating: 8 }],
  ]) {
    const res = await s.agent(`sessions/${sid}/${op}`, { method: "POST", body });
    assert.equal(res.status, 403, op);
  }

  // Browser page token cannot call agent writes (create, patch, received, outcome) or agent metadata routes.
  assert.equal((await browser.call("capabilities")).status, 403);
  assert.equal((await browser.call("page")).status, 403);
  assert.equal((await browser.call("sessions", { method: "POST", body: componentRequest("nope") })).status, 403);
  assert.equal((await browser.call(`sessions/${sid}/patch`, { method: "POST", body: { actionId: "p1", itemId: "q-refresh", options: [] } })).status, 403);
  assert.equal((await browser.call(`sessions/${sid}/received`, { method: "POST", body: {} })).status, 403);
  assert.equal((await browser.call(`sessions/${sid}/outcome`, { method: "POST", body: { actionId: "o1", summary: "Done" } })).status, 403);

  // Hosted mode refuses Feedback routes.
  const hf = await setup(t);
  const hs = await listen(t, hf, { HUMAN_REVIEW_FEEDBACK_ROOT: hf.feedbackRoot, HUMAN_REVIEW_HOSTED: "1" });
  const hostedRefusal = await hs.api(`${API}/sessions`, { method: "POST", body: componentRequest("hosted") });
  assert.equal(hostedRefusal.status, 403);
  assert.equal(hostedRefusal.json.error.code, "HOSTED_UNSUPPORTED");
});

test("Decision tree UI renders settled branch, lazy-expands options 2 & 3 while preserving drafts, and supports batch submit + receipt + rating", async (t) => {
  const f = await setup(t);
  const s = await serve(t, f);
  const made = await created(s, grillTreeRequest("ui-tree-1"));
  const sid = made.result.sessionId;
  const page = await bootPage(t, s, made.path);
  const { doc } = page;

  // Feedback workspace is visible, Compare stage is hidden.
  assert.equal(doc.getElementById("feedbackWork").hidden, false);
  assert.equal(doc.getElementById("stage").hidden, true);
  assert.equal(doc.getElementById("decide").hidden, true);

  // Settled parent chip renders compactly; child grill card shows branchLabel & Option 1 overview iframe.
  const settled = doc.querySelector('[data-item="root-store"]');
  assert.ok(settled.textContent.includes("Settled"));
  assert.ok(settled.textContent.includes("OS keychain + in-memory cache"));

  const grill = doc.querySelector('[data-item="q-refresh"]');
  assert.ok(grill.querySelector(".fb-branch-chip").textContent.includes("Given OS keychain"));
  assert.equal(grill.querySelectorAll(".fb-overview-frame iframe").length, 1);

  // Owner selects Option 1 and types a draft comment before clicking Expand options 2 & 3.
  const opt1Radio = grill.querySelector('input[type="radio"][value="opt-1"]');
  opt1Radio.checked = true;
  opt1Radio.dispatchEvent(new page.dom.window.Event("change", { bubbles: true }));
  const commentBox = grill.querySelector('[data-fb-comment="q-refresh"]');
  commentBox.value = "Keep single-flight dedupe even if we compare option 2.";
  commentBox.dispatchEvent(new page.dom.window.Event("input", { bubbles: true }));

  const expandBtn = grill.querySelector('[data-expand-item="q-refresh"]');
  assert.ok(expandBtn);
  assert.match(expandBtn.textContent, /Expand options 2 & 3/);

  await page.clickAndSettle(expandBtn);

  // Pending expand recorded on server; draft stays intact.
  let view = (await s.agent(`sessions/${sid}`)).json.view;
  assert.equal(view.pendingExpands.length, 1);
  assert.deepEqual(view.pendingExpands[0].optionIds, ["opt-2", "opt-3"]);

  // Runner worker patches Options 2 & 3 with rich explanations and HTML overviews.
  const patched = await s.agent(`sessions/${sid}/patch`, {
    method: "POST",
    body: {
      actionId: "patch-ui-1",
      itemId: "q-refresh",
      options: [
        {
          optionId: "opt-2",
          explanation: "Reactive 401 refresh avoids clock skew but adds replay buffering.",
          overview: { format: "html", content: "<!doctype html><div>Reactive 401 diagram</div>" },
        },
        {
          optionId: "opt-3",
          explanation: "Background timer keeps tokens warm during idle windows.",
          overview: { format: "html", content: "<!doctype html><div>Timer diagram</div>" },
        },
      ],
    },
  });
  assert.equal(patched.status, 200, patched.text);

  await page.app.load();

  // After live refresh: all 3 options now show overview frames, Expand button is gone, and owner draft survived!
  const grillAfter = doc.querySelector('[data-item="q-refresh"]');
  assert.equal(grillAfter.querySelectorAll(".fb-overview-frame iframe").length, 3);
  assert.equal(grillAfter.querySelector('[data-expand-item="q-refresh"]'), null);
  assert.equal(grillAfter.querySelector('input[type="radio"][value="opt-1"]').checked, true);
  assert.equal(grillAfter.querySelector('[data-fb-comment="q-refresh"]').value, "Keep single-flight dedupe even if we compare option 2.");

  // Owner also picks an option on q-retry and submits both items at once via the sticky batch dock.
  const retryRadio = doc.querySelector('[data-item="q-retry"] input[type="radio"][value="r-2"]');
  retryRadio.checked = true;
  retryRadio.dispatchEvent(new page.dom.window.Event("change", { bubbles: true }));
  assert.match(doc.querySelector("[data-fb-batch-count]").textContent, /2 of 2 open items ready/);

  await page.clickAndSettle(doc.querySelector("[data-fb-batch-submit]"));

  view = (await s.agent(`sessions/${sid}`)).json.view;
  assert.equal(view.status, "submitted");
  assert.equal(view.answeredCount, 2);
  assert.equal(doc.querySelector('[data-receipt="waiting"]').textContent, "Waiting for the agent to read your response.");

  // Agent sends receipt -> page receipt updates; agent records outcome -> outcome renders.
  assert.equal((await s.agent(`sessions/${sid}/received`, { method: "POST", body: {} })).status, 200);
  await page.app.load();
  assert.match(doc.querySelector('[data-receipt="received"]').textContent, /The agent received your response at/);

  assert.equal((await s.agent(`sessions/${sid}/outcome`, { method: "POST", body: { actionId: "out-1", summary: "Implemented proactive skew refresh with 2 retries." } })).status, 200);
  await page.app.load();
  assert.ok(doc.querySelector(".fb-outcome").textContent.includes("Implemented proactive skew refresh"));

  // Rating saves and clears local draft state so Save rating disables until changed again.
  const star9 = doc.querySelector('.fb-rate button[aria-label="4.5 of 5 stars"]');
  star9.click();
  const rateSave = doc.querySelector(".fb-rate-save");
  assert.equal(rateSave.disabled, false);
  await page.clickAndSettle(rateSave);
  assert.equal((await s.agent(`sessions/${sid}`)).json.view.rating.value, 9);
  assert.equal(doc.querySelector(".fb-rate-save").disabled, true);
});

test("Unified session list merges Compare and Feedback rows and switches views cleanly", async (t) => {
  const f = await setup(t);
  const s = await serve(t, f);
  const cmp = await s.compareAgent("sessions", {
    method: "POST",
    body: {
      actionId: "cmp-uni-1",
      workflow: "cfn-options",
      title: "Compare SQS DLQ",
      brief: "Pick one stack change.",
      options: [
        { optionId: "a", label: "A", format: "text", content: "Queue only" },
        { optionId: "b", label: "B", format: "text", content: "Queue + alarm" },
      ],
    },
  });
  assert.equal(cmp.status, 200, cmp.text);
  const fb = await created(s, componentRequest("fb-uni-1"));

  const page = await bootPage(t, s, fb.path);
  const { doc } = page;
  const rows = [...doc.querySelectorAll("#sessions button[data-session]")];
  assert.equal(rows.length, 2);
  assert.equal(doc.getElementById("feedbackWork").hidden, false);
  assert.equal(doc.getElementById("stage").hidden, true);

  // Switch to Compare row -> Compare stage shows and Feedback hides.
  const cmpRow = rows.find((el) => el.textContent.includes("Compare SQS DLQ"));
  assert.ok(cmpRow);
  cmpRow.click();
  await new Promise((resolve) => setTimeout(resolve, 60));
  await page.app.load();
  assert.equal(doc.getElementById("feedbackWork").hidden, true);
  assert.equal(doc.getElementById("stage").hidden, false);
});

test("CLI walkr-feedback and walkr feedback alias run create, expand-wake wait, patch, respond-wake wait, and outcome", async (t) => {
  const f = await setup(t);
  const env = {
    ...process.env,
    HUMAN_REVIEW_STATE_DIR: f.stateDir,
    HUMAN_REVIEW_COMPARE_ROOT: f.compareRoot,
    HUMAN_REVIEW_FEEDBACK_ROOT: f.feedbackRoot,
    HUMAN_REVIEW_IDLE_MS: "0",
  };
  delete env.HUMAN_REVIEW_HOSTED;
  delete env.WALKR_SHEPRD_CONNECT;

  const stop = async () => {
    try {
      const saved = JSON.parse(await fs.readFile(path.join(f.stateDir, "server.json"), "utf8"));
      process.kill(saved.pid);
    } catch {}
  };
  t.after(stop);

  const cli = async (args, { bin = CLI, stdin = null } = {}) => {
    if (stdin === null) return (await run(process.execPath, [bin, ...args], { env, timeout: 15000 })).stdout.trim();
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [bin, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
      let out = "", err = "";
      child.stdout.on("data", (c) => { out += c; });
      child.stderr.on("data", (c) => { err += c; });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve(out.trim()) : reject(new Error(err || `exit ${code}`)));
      child.stdin.end(stdin);
    });
  };

  assert.match(await cli(["--help"]), /walkr-feedback/);
  assert.match(await cli(["feedback", "--help"], { bin: MAIN_CLI }), /walkr-feedback/);

  // Create via stdin using `walkr feedback create -`.
  const made = JSON.parse(await cli(["feedback", "create", "-"], { bin: MAIN_CLI, stdin: JSON.stringify(grillTreeRequest("cli-fb-1")) }));
  const sid = made.sessionId;
  assert.ok(sid);
  assert.equal(made.status, "open");

  const opened = await cli(["open", sid]);
  assert.ok(opened.endsWith(`#${sid}`));

  const saved = JSON.parse(await fs.readFile(path.join(f.stateDir, "server.json"), "utf8"));
  const pageUrl = new URL(made.url);
  const page = await request(saved.port, pageUrl.pathname);
  const pageToken = page.text.match(/data-token="([a-f0-9]{64})"/)[1];

  // Start `wait` in background, trigger owner Expand, verify wait wakes with status: "expand".
  const waitExpand = cli(["wait", sid, "--timeout", "10", "--after-revision", "0"]);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const expRes = await request(saved.port, `${API}/sessions/${sid}/expand`, {
    method: "POST",
    token: pageToken,
    body: { actionId: "cli-exp-1", itemId: "q-refresh", optionIds: ["opt-2", "opt-3"] },
  });
  assert.equal(expRes.status, 200, expRes.text);
  const wokeExpand = JSON.parse(await waitExpand);
  assert.equal(wokeExpand.status, "expand");
  assert.deepEqual(wokeExpand.expand[0].optionIds, ["opt-2", "opt-3"]);

  // Fulfill expand via `patch -`.
  const patched = JSON.parse(await cli(["patch", sid, "-"], {
    stdin: JSON.stringify({
      actionId: "cli-patch-1",
      itemId: "q-refresh",
      options: [
        { optionId: "opt-2", explanation: "Reactive 401 explanation", overview: { format: "html", content: "<!doctype html><p>opt2</p>" } },
        { optionId: "opt-3", explanation: "Timer explanation", overview: { format: "html", content: "<!doctype html><p>opt3</p>" } },
      ],
    }),
  }));
  assert.deepEqual(patched.patched, ["opt-2", "opt-3"]);

  // Owner submits response on q-refresh; `wait` wakes with status: "ready" and auto-receipt.
  const waitResp = cli(["wait", sid, "--timeout", "10", "--after-revision", "0"]);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const respRes = await request(saved.port, `${API}/sessions/${sid}/respond`, {
    method: "POST",
    token: pageToken,
    body: {
      actionId: "cli-resp-1",
      responses: [{ itemId: "q-refresh", decision: "submit", pick: "opt-1", comment: "Looks crisp" }],
    },
  });
  assert.equal(respRes.status, 200, respRes.text);
  const wokeReady = JSON.parse(await waitResp);
  assert.equal(wokeReady.status, "ready");
  assert.equal(wokeReady.sessionStatus, "partial");
  assert.ok(wokeReady.receivedAt);
  assert.equal(wokeReady.responses[0].pick, "opt-1");
  assert.equal(wokeReady.responses[0].pickLabel, "Proactive skew window");

  // Record outcome via stdin and verify list/view.
  const outRes = JSON.parse(await cli(["outcome", sid, "-"], {
    stdin: JSON.stringify({ actionId: "cli-out-1", summary: "Applied proactive skew refresh." }),
  }));
  assert.equal(outRes.outcome.summary, "Applied proactive skew refresh.");
  const listed = JSON.parse(await cli(["list"]));
  assert.equal(listed.sessions.length, 1);
  const viewed = JSON.parse(await cli(["view", sid]));
  assert.equal(viewed.outcome.summary, "Applied proactive skew refresh.");
});

test("Late patches are refused after cancellation/answer, coalesced expands keep both action receipts, and optionId preview resolves by item kind", async (t) => {
  const f = await setup(t);
  const s = await serve(t, f);

  // Mixed session with a component item and a decision item whose optionId is literally "preview".
  const made = await created(s, {
    actionId: "fb-edge-1",
    workflow: "decision-tree",
    title: "Kind dispatch and patch guards",
    brief: "Verify preview optionId and patch lifecycle guards.",
    items: [
      {
        itemId: "comp-1",
        kind: "component",
        title: "Header chunk",
        preview: { format: "html", content: "<!doctype html><div>Component preview body</div>" },
      },
      {
        itemId: "dec-1",
        kind: "decision",
        title: "Choose preview mode",
        recommended: "preview",
        options: [
          {
            optionId: "preview",
            label: "Inline preview",
            summary: "Show preview inline.",
            explanation: "Zero clicks to inspect.",
            overview: { format: "html", content: "<!doctype html><div>Decision option named preview</div>" },
          },
          {
            optionId: "modal",
            label: "Modal dialog",
            summary: "Open in modal.",
            expandable: true,
          },
          {
            optionId: "drawer",
            label: "Side drawer",
            summary: "Open in side drawer.",
            expandable: true,
          },
        ],
      },
    ],
  });
  const sid = made.result.sessionId;
  const browser = await owner(s, made.path);

  // Both component preview and decision option literally named "preview" return 200 with sandbox CSP.
  const compFrame = await request(s.port, `${browser.frames}/${sid}/comp-1/preview`);
  assert.equal(compFrame.status, 200);
  assert.equal(compFrame.text, "<!doctype html><div>Component preview body</div>");
  assert.match(compFrame.headers["content-security-policy"], /\bsandbox\b/);

  const optFrame = await request(s.port, `${browser.frames}/${sid}/dec-1/preview`);
  assert.equal(optFrame.status, 200);
  assert.equal(optFrame.text, "<!doctype html><div>Decision option named preview</div>");
  assert.match(optFrame.headers["content-security-policy"], /\bsandbox\b/);

  // Patching an option with no pending expand request is rejected.
  const prematurePatch = await s.agent(`sessions/${sid}/patch`, {
    method: "POST",
    body: {
      actionId: "patch-premature",
      itemId: "dec-1",
      options: [{ optionId: "modal", explanation: "Unrequested patch" }],
    },
  });
  assert.equal(prematurePatch.status, 409);
  assert.equal(prematurePatch.json.error.code, "INVALID_TRANSITION");

  // Two distinct expand actionIds targeting overlapping pending options coalesce onto one pending request
  // while persisting receipts for BOTH actionIds.
  const exp1 = await browser.call(`sessions/${sid}/expand`, {
    method: "POST",
    body: { actionId: "exp-a", itemId: "dec-1", optionIds: ["modal", "drawer"] },
  });
  assert.equal(exp1.status, 200, exp1.text);
  const exp2 = await browser.call(`sessions/${sid}/expand`, {
    method: "POST",
    body: { actionId: "exp-b", itemId: "dec-1", optionIds: ["modal"] },
  });
  assert.equal(exp2.status, 200, exp2.text);
  assert.equal(exp2.json.result.coalesced, true);
  assert.equal((await s.agent(`sessions/${sid}`)).json.view.pendingExpands.length, 1);

  // Patch only "modal" (leaving "drawer" pending): pendingExpands must advertise ONLY unfinished option "drawer",
  // and exact replay of the committed patch must still work.
  const patchModalBody = {
    actionId: "patch-modal-1",
    itemId: "dec-1",
    options: [{ optionId: "modal", explanation: "Modal details" }],
  };
  const patchedModal = await s.agent(`sessions/${sid}/patch`, { method: "POST", body: patchModalBody });
  assert.equal(patchedModal.status, 200, patchedModal.text);
  const afterPartial = (await s.agent(`sessions/${sid}`)).json.view;
  assert.equal(afterPartial.pendingExpands.length, 1);
  assert.deepEqual(afterPartial.pendingExpands[0].optionIds, ["drawer"]);

  // Owner answers dec-1 (cancelling remaining pending expand for "drawer").
  const answered = await browser.call(`sessions/${sid}/respond`, {
    method: "POST",
    body: { actionId: "resp-dec-1", responses: [{ itemId: "dec-1", decision: "submit", pick: "preview" }] },
  });
  assert.equal(answered.status, 200, answered.text);

  // Exact replay of BOTH expand actionIds still succeeds after cancellation, while a mutated body under exp-b returns 409 ACTION_CONFLICT.
  const replayExp2 = await browser.call(`sessions/${sid}/expand`, {
    method: "POST",
    body: { actionId: "exp-b", itemId: "dec-1", optionIds: ["modal"] },
  });
  assert.equal(replayExp2.status, 200, replayExp2.text);
  assert.equal(replayExp2.json.result.replay, true);

  const conflictExp2 = await browser.call(`sessions/${sid}/expand`, {
    method: "POST",
    body: { actionId: "exp-b", itemId: "dec-1", optionIds: ["drawer"] },
  });
  assert.equal(conflictExp2.status, 409);
  assert.equal(conflictExp2.json.error.code, "ACTION_CONFLICT");

  // Exact replay of already-committed patch succeeds, whereas a late new patch against the answered item or picked option is rejected.
  const replayPatch = await s.agent(`sessions/${sid}/patch`, { method: "POST", body: patchModalBody });
  assert.equal(replayPatch.status, 200);
  assert.equal(replayPatch.json.result.replay, true);

  const latePatch = await s.agent(`sessions/${sid}/patch`, {
    method: "POST",
    body: {
      actionId: "patch-late-1",
      itemId: "dec-1",
      options: [{ optionId: "drawer", explanation: "Too late" }],
    },
  });
  assert.equal(latePatch.status, 409);
  assert.equal(latePatch.json.error.code, "INVALID_TRANSITION");

  const tamperPicked = await s.agent(`sessions/${sid}/patch`, {
    method: "POST",
    body: {
      actionId: "patch-tamper-1",
      itemId: "dec-1",
      options: [{ optionId: "preview", explanation: "Rewritten after pick" }],
    },
  });
  assert.equal(tamperPicked.status, 409);
  assert.equal(tamperPicked.json.error.code, "INVALID_TRANSITION");
});

test("Mixed session excludes untouched components from Submit all ready, isolates batch note, restores drafts on reload, and retries lost submits", async (t) => {
  const f = await setup(t);
  const s = await serve(t, f);
  const made = await created(s, {
    actionId: "fb-mixed-1",
    workflow: "mixed-chunk",
    title: "Mixed component and decisions",
    brief: "Confirm untouched component safety and batch note isolation.",
    items: [
      {
        itemId: "comp-banner",
        kind: "component",
        title: "Banner preview",
        actions: "accept-revise",
        preview: { format: "text", content: "Banner text" },
      },
      {
        itemId: "dec-color",
        kind: "decision",
        title: "Accent color",
        actions: "submit-revise",
        options: [
          { optionId: "amber", label: "Amber", summary: "Warm highlight" },
          { optionId: "violet", label: "Violet", summary: "Lavender highlight" },
        ],
      },
      {
        itemId: "dec-size",
        kind: "decision",
        title: "Control density",
        actions: "submit-revise",
        options: [
          { optionId: "compact", label: "Compact", summary: "Tighter rows" },
          { optionId: "cozy", label: "Cozy", summary: "More padding" },
        ],
      },
    ],
  });
  const sid = made.result.sessionId;
  const page1 = await bootPage(t, s, made.path);
  const { doc: doc1 } = page1;

  // Initially 0 of 3 open items are ready for batch submit (untouched component is NOT silently included).
  assert.match(doc1.querySelector("[data-fb-batch-count]").textContent, /0 of 3 open items ready/);
  assert.equal(doc1.querySelector("[data-fb-batch-submit]").disabled, true);

  // Explicit opt-in checkbox includes the component in batch submit; Clear drafts removes it again.
  const incCheck = doc1.querySelector('[data-fb-batch-include="comp-banner"]');
  assert.ok(incCheck);
  incCheck.checked = true;
  incCheck.dispatchEvent(new page1.dom.window.Event("change", { bubbles: true }));
  assert.match(doc1.querySelector("[data-fb-batch-count]").textContent, /1 of 3 open items ready/);
  assert.equal(doc1.querySelector("[data-fb-batch-submit]").disabled, false);
  const clearBtn = [...doc1.querySelectorAll("[data-fb-batch] button")].find((b) => b.textContent === "Clear drafts");
  clearBtn.click();
  assert.match(doc1.querySelector("[data-fb-batch-count]").textContent, /0 of 3 open items ready/);
  assert.equal(doc1.querySelector('[data-fb-batch-include="comp-banner"]').checked, false);

  // Fill a draft decision and batch note, then simulate a full page reload into a brand-new JSDOM sharing localStorage.
  const amberRadio = doc1.querySelector('[data-item="dec-color"] input[type="radio"][value="amber"]');
  amberRadio.checked = true;
  amberRadio.dispatchEvent(new page1.dom.window.Event("change", { bubbles: true }));
  const colorComment = doc1.querySelector('[data-fb-comment="dec-color"]');
  colorComment.value = "Matches existing nav";
  colorComment.dispatchEvent(new page1.dom.window.Event("input", { bubbles: true }));
  const batchArea1 = doc1.querySelector(".fb-batch-note textarea");
  batchArea1.value = "Batch summary note";
  batchArea1.dispatchEvent(new page1.dom.window.Event("input", { bubbles: true }));

  const savedStorage = {};
  for (let i = 0; i < page1.dom.window.localStorage.length; i += 1) {
    const key = page1.dom.window.localStorage.key(i);
    savedStorage[key] = page1.dom.window.localStorage.getItem(key);
  }
  const page2 = await bootPage(t, s, made.path, { seedStorage: savedStorage });
  const { doc: doc2 } = page2;

  // Drafts survive a real page reload; untouched component is STILL excluded from batch count (1 of 3 ready).
  assert.equal(doc2.querySelector('[data-item="dec-color"] input[type="radio"][value="amber"]').checked, true);
  assert.equal(doc2.querySelector('[data-fb-comment="dec-color"]').value, "Matches existing nav");
  assert.equal(doc2.querySelector(".fb-batch-note textarea").value, "Batch summary note");
  assert.match(doc2.querySelector("[data-fb-batch-count]").textContent, /1 of 3 open items ready/);

  // Submitting dec-color individually must NOT send or append the batch note.
  await page2.clickAndSettle(doc2.querySelector('[data-fb-action="dec-color:submit"]'));
  let view = (await s.agent(`sessions/${sid}`)).json.view;
  assert.equal(view.note, null);
  assert.equal(view.items.find((i) => i.itemId === "comp-banner").response, null);

  // Batch submit with only dec-size picked sends batch note ONCE, clears batch note draft, and still leaves comp-banner untouched.
  const cozyRadio = doc2.querySelector('[data-item="dec-size"] input[type="radio"][value="cozy"]');
  cozyRadio.checked = true;
  cozyRadio.dispatchEvent(new page2.dom.window.Event("change", { bubbles: true }));
  assert.match(doc2.querySelector("[data-fb-batch-count]").textContent, /1 of 2 open items ready/);
  await page2.clickAndSettle(doc2.querySelector("[data-fb-batch-submit]"));

  view = (await s.agent(`sessions/${sid}`)).json.view;
  assert.equal(view.note, "Batch summary note");
  assert.equal(view.items.find((i) => i.itemId === "comp-banner").response, null);
  assert.equal(doc2.querySelector("[data-fb-batch]"), null); // Only 1 open item remains; dock is gone.

  // Now finish comp-banner individually with a simulated lost-response network error on first try, then retry exact actionId.
  let dropOnce = true;
  const retryPage = await bootPage(t, s, made.path, {
    intercept: async (route, _options, reply) => {
      if (dropOnce && route === `${API}/sessions/${sid}/respond`) {
        dropOnce = false;
        return { ok: true, status: 200, json: async () => ({ malformed: true }) };
      }
      return reply;
    },
  });
  retryPage.doc.querySelector('[data-fb-action="comp-banner:accept"]').click();
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(retryPage.doc.getElementById("resolve").hidden, false);
  const pendingRaw = JSON.parse(retryPage.dom.window.localStorage.getItem("walkr-compare:pending"));
  assert.equal(pendingRaw.mode, "feedback");
  assert.equal(pendingRaw.op, "respond");
  await retryPage.clickAndSettle(retryPage.doc.getElementById("resolve"));
  assert.equal(retryPage.dom.window.localStorage.getItem("walkr-compare:pending"), null);

  // Batch note was NOT appended a second time when finishing comp-banner individually!
  view = (await s.agent(`sessions/${sid}`)).json.view;
  assert.equal(view.status, "submitted");
  assert.equal(view.note, "Batch summary note");
});

test("CLI wait handles nonzero cursors across sequential responses, no duplicate wake, bounded timeout, and receipt-view consistency", async (t) => {
  const f = await setup(t);
  const env = {
    ...process.env,
    HUMAN_REVIEW_STATE_DIR: f.stateDir,
    HUMAN_REVIEW_COMPARE_ROOT: f.compareRoot,
    HUMAN_REVIEW_FEEDBACK_ROOT: f.feedbackRoot,
    HUMAN_REVIEW_IDLE_MS: "0",
  };
  delete env.HUMAN_REVIEW_HOSTED;
  delete env.WALKR_SHEPRD_CONNECT;

  const stop = async () => {
    try {
      const saved = JSON.parse(await fs.readFile(path.join(f.stateDir, "server.json"), "utf8"));
      process.kill(saved.pid);
    } catch {}
  };
  t.after(stop);

  const cli = async (args, { stdin = null } = {}) => {
    if (stdin === null) return (await run(process.execPath, [CLI, ...args], { env, timeout: 15000 })).stdout.trim();
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
      let out = "", err = "";
      child.stdout.on("data", (c) => { out += c; });
      child.stderr.on("data", (c) => { err += c; });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve(out.trim()) : reject(new Error(err || `exit ${code}`)));
      child.stdin.end(stdin);
    });
  };

  const made = JSON.parse(await cli(["create", "-"], { stdin: JSON.stringify(grillTreeRequest("cli-cursor-1")) }));
  const sid = made.sessionId;
  const saved = JSON.parse(await fs.readFile(path.join(f.stateDir, "server.json"), "utf8"));
  const pageUrl = new URL(made.url);
  const page = await request(saved.port, pageUrl.pathname);
  const pageToken = page.text.match(/data-token="([a-f0-9]{64})"/)[1];

  // Response 1 on q-refresh.
  assert.equal((await request(saved.port, `${API}/sessions/${sid}/respond`, {
    method: "POST",
    token: pageToken,
    body: { actionId: "cur-r1", responses: [{ itemId: "q-refresh", decision: "submit", pick: "opt-1" }] },
  })).status, 200);

  const w1 = JSON.parse(await cli(["wait", sid, "--timeout", "5", "--after-revision", "0"]));
  assert.equal(w1.status, "ready");
  assert.equal(w1.responses.length, 1);
  assert.equal(w1.receivedRevision, w1.lastResponseRevision);
  assert.ok(w1.revision >= w1.lastResponseRevision);

  // Calling wait again with --after-revision <w1.revision> must NOT duplicate-wake and must return bounded timeout.
  const wTimeout = JSON.parse(await cli(["wait", sid, "--timeout", "1", "--after-revision", String(w1.revision)]));
  assert.equal(wTimeout.status, "timeout");

  // Response 2 on q-retry wakes wait with --after-revision <w1.revision> and returns BOTH responses matching receivedRevision.
  const w2Promise = cli(["wait", sid, "--timeout", "5", "--after-revision", String(w1.revision)]);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal((await request(saved.port, `${API}/sessions/${sid}/respond`, {
    method: "POST",
    token: pageToken,
    body: { actionId: "cur-r2", responses: [{ itemId: "q-retry", decision: "accept", pick: "r-2" }] },
  })).status, 200);

  const w2 = JSON.parse(await w2Promise);
  assert.equal(w2.status, "ready");
  assert.equal(w2.sessionStatus, "submitted");
  assert.equal(w2.responses.length, 2);
  assert.equal(w2.receivedRevision, w2.lastResponseRevision);
});

test("Partial expand restart advertises only remaining options, and competing submission preserves unsaved batch note", async (t) => {
  const f = await setup(t);
  const s = await serve(t, f);

  // Part 1: Partial expand completion followed by fresh wait/patch completes cleanly without looping.
  const madeExpand = await created(s, grillTreeRequest("fb-partial-exp-1"));
  const expSid = madeExpand.result.sessionId;
  const expBrowser = await owner(s, madeExpand.path);
  assert.equal((await expBrowser.call(`sessions/${expSid}/expand`, {
    method: "POST",
    body: { actionId: "pexp-1", itemId: "q-refresh", optionIds: ["opt-2", "opt-3"] },
  })).status, 200);
  assert.equal((await s.agent(`sessions/${expSid}/patch`, {
    method: "POST",
    body: { actionId: "ppatch-1", itemId: "q-refresh", options: [{ optionId: "opt-2", explanation: "Done first" }] },
  })).status, 200);
  const viewAfterFirst = (await s.agent(`sessions/${expSid}`)).json.view;
  assert.deepEqual(viewAfterFirst.pendingExpands.map((r) => r.optionIds), [["opt-3"]]);
  // Worker restarts and patches exactly the advertised remaining optionIds -> succeeds and clears pendingExpands.
  const advertised = viewAfterFirst.pendingExpands[0];
  assert.equal((await s.agent(`sessions/${expSid}/patch`, {
    method: "POST",
    body: {
      actionId: "ppatch-2",
      itemId: advertised.itemId,
      options: advertised.optionIds.map((optionId) => ({ optionId, explanation: "Done on restart" })),
    },
  })).status, 200);
  assert.deepEqual((await s.agent(`sessions/${expSid}`)).json.view.pendingExpands, []);

  // Part 2: Competing submission in another tab leaves unsaved batch note intact in this tab while another item remains open.
  const madeRace = await created(s, {
    actionId: "fb-race-note-1",
    workflow: "mixed-chunk",
    title: "Competing tab submission",
    brief: "Verify batch note stays when another tab already submitted the same item.",
    items: [
      {
        itemId: "d1",
        kind: "decision",
        title: "First decision",
        options: [{ optionId: "a", label: "A" }, { optionId: "b", label: "B" }],
      },
      {
        itemId: "d2",
        kind: "decision",
        title: "Second decision",
        options: [{ optionId: "c", label: "C" }, { optionId: "d", label: "D" }],
      },
      {
        itemId: "d3",
        kind: "decision",
        title: "Third decision",
        options: [{ optionId: "e", label: "E" }, { optionId: "f", label: "F" }],
      },
    ],
  });
  const raceSid = madeRace.result.sessionId;
  const tab1 = await bootPage(t, s, madeRace.path);
  const { doc } = tab1;

  // Tab 1 picks d1 and writes a batch note.
  const radioA = doc.querySelector('[data-item="d1"] input[type="radio"][value="a"]');
  radioA.checked = true;
  radioA.dispatchEvent(new tab1.dom.window.Event("change", { bubbles: true }));
  const noteEl = doc.querySelector(".fb-batch-note textarea");
  noteEl.value = "Do not lose this unsaved batch note";
  noteEl.dispatchEvent(new tab1.dom.window.Event("input", { bubbles: true }));

  // Meanwhile Tab 2 submits d1 first without any note (leaving d2 and d3 still open).
  assert.equal((await tab1.browser.call(`sessions/${raceSid}/respond`, {
    method: "POST",
    body: { actionId: "tab2-d1", responses: [{ itemId: "d1", decision: "submit", pick: "b" }] },
  })).status, 200);

  // Tab 1 now clicks Submit all ready -> server answers already-submitted with view.note === null.
  await tab1.clickAndSettle(doc.querySelector("[data-fb-batch-submit]"));
  const afterRace = (await s.agent(`sessions/${raceSid}`)).json.view;
  assert.equal(afterRace.status, "partial");
  assert.equal(afterRace.note, null);

  // Tab 1 MUST still retain the unsaved batch note in the UI and localStorage so the owner can attach it to d2/d3.
  assert.equal(doc.querySelector(".fb-batch-note textarea").value, "Do not lose this unsaved batch note");
  const persisted = JSON.parse(tab1.dom.window.localStorage.getItem(`walkr-feedback:draft:${raceSid}`));
  assert.equal(persisted.note, "Do not lose this unsaved batch note");
});
