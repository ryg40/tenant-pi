import { RATING_MAX, RATING_MIN, isRating, starsLabel, starsText, stepRating } from "./compare-stars.js";
import { mountFrameZoom } from "./frame-zoom.js";

// These codes prove that the server did not save the request. Anything else stays unresolved.
const NOT_SAVED = new Set(["INVALID_REQUEST", "INVALID_ID", "ACTION_CONFLICT", "INVALID_TRANSITION", "NOT_FOUND", "FORBIDDEN", "UNAUTHORIZED", "WRITE_FAILED"]);
const VIEWS = { columns: "Side by side", single: "One option" };
const SESSION = /^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$/;

/** The one Compare page: the session list, and the selected session in the display format of its type. */
export function bootCompare(win, { fetch: fetchImpl = win.fetch.bind(win), refreshMs = 2000 } = {}) {
  const doc = win.document, $ = (id) => doc.getElementById(id), body = doc.body.dataset;
  const api = "/_walkr/compare/api/sessions";
  const stored = (key, fallback = null) => { try { return win.localStorage.getItem(`walkr-compare:${key}`) ?? fallback; } catch { return fallback; } };
  const store = (key, value) => { try { value === null ? win.localStorage.removeItem(`walkr-compare:${key}`) : win.localStorage.setItem(`walkr-compare:${key}`, value); } catch {} };
  // A browser policy can make the localStorage getter throw. The zoom then keeps no preference.
  const storage = () => { try { return win.localStorage; } catch { return null; } };
  const make = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const hashId = () => { const value = win.location.hash.slice(1); return SESSION.test(value) ? value : null; };

  let sessions = [], selected = hashId(), view = null, loaded = "", stageKey = "", single = 0;
  let draft = { pick: null, comments: {}, note: "", none: false }, ratingDraft = null;
  let busy = false, error = "", closed = false, timer, zooms = [], readGeneration = 0;
  let listOpen = stored("list") ? stored("list") === "open" : !selected;
  let pending = null;
  try { pending = JSON.parse(stored("pending", "null")); } catch {}

  const newId = () => win.crypto?.randomUUID ? win.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const shown = () => { const type = $("typeFilter").value; return sessions.filter((item) => !type || item.workflow === type); };
  const viewMode = () => {
    const saved = view && stored(`view:${view.workflow}`);
    return VIEWS[saved] ? saved : "columns";
  };

  async function call(route, options = {}) {
    let response;
    try {
      response = await fetchImpl(`${api}${route}`, { ...options, headers: { "x-human-review-token": body.token, "content-type": "application/json" } });
    } catch { throw Object.assign(new Error("The private server did not answer."), { code: "NETWORK" }); }
    let value;
    try { value = await response.json(); } catch { throw Object.assign(new Error("The server answer was not readable."), { code: "MALFORMED" }); }
    if (!response.ok) throw Object.assign(new Error(value?.error?.message || `HTTP ${response.status}`), { code: value?.error?.code || `HTTP_${response.status}` });
    return value;
  }

  function setPending(value) {
    pending = value;
    store("pending", value ? JSON.stringify(value) : null);
  }

  // Submit and Save rating. An answer that does not prove the result stays as one saved request for an exact retry.
  async function send(item) {
    readGeneration += 1;
    setPending(item);
    busy = true; error = ""; render();
    try {
      const answer = await call(`/${item.sessionId}/${item.op}`, { method: "POST", body: JSON.stringify(item.body) });
      // Only an answer for this session with a result proves the save. Any other answer keeps the request for a retry.
      if (answer?.view?.sessionId !== item.sessionId || !answer.result) throw Object.assign(new Error("The server answer did not confirm the save."), { code: "MALFORMED" });
      setPending(null);
      if (item.sessionId === selected) { view = answer.view; loaded = `${view.sessionId}/${view.revision}`; }
      if (item.op === "rate") { ratingDraft = null; $("rateNote").value = ""; }
      if (answer.result.outcome === "already-submitted") error = "This session was already submitted. The first result is kept.";
    } catch (failure) {
      if (NOT_SAVED.has(failure.code)) setPending(null);
      error = NOT_SAVED.has(failure.code) ? failure.message : `Not confirmed: ${failure.message} Retry the same request; do not start a new one.`;
    } finally { busy = false; await load(); }
  }

  function select(sessionId) {
    if (sessionId === selected) return;
    readGeneration += 1;
    selected = sessionId; view = null; loaded = ""; single = 0; ratingDraft = null;
    draft = { pick: null, comments: {}, note: "", none: false };
    for (const id of ["note", "rateNote"]) $(id).value = "";
    $("none").checked = false;
    if (win.location.hash.slice(1) !== (sessionId ?? "")) win.history.replaceState(null, "", sessionId ? `#${sessionId}` : win.location.pathname);
    render();
    void load();
  }

  async function load() {
    if (closed || busy) return;
    const generation = ++readGeneration;
    const stale = () => closed || busy || generation !== readGeneration;
    try {
      const answer = await call("");
      if (stale()) return;
      sessions = answer.sessions.reverse(); // Newest first.
      const row = sessions.find((item) => item.sessionId === selected);
      if (selected && !row) { error = "This session is not in the saved sessions."; selected = null; view = null; }
      // Read the record again only after it changed, so a frame and a draft stay while you read.
      if (row && !busy && loaded !== `${row.sessionId}/${row.updatedAt}/${row.isNew}`) {
        // A selection, mutation or newer read can invalidate this answer while it is in flight.
        const wanted = row.sessionId;
        const fresh = (await call(`/${wanted}`)).view;
        if (stale() || wanted !== selected || fresh.sessionId !== wanted) return;
        if (view?.sessionId === wanted && fresh.revision < view.revision) return;
        view = fresh;
        loaded = `${row.sessionId}/${row.updatedAt}/${row.isNew}`;
        if (view.isNew) call(`/${wanted}/seen`, { method: "POST", body: "{}" }).catch(() => {});
      }
      if (!pending && error.startsWith("Could not read")) error = "";
    } catch (failure) {
      if (stale()) return;
      error = `Could not read saved state: ${failure.message}`;
    }
    render();
  }

  function option(item, mode, readOnly) {
    const card = make("section", "cmp-option");
    card.dataset.option = item.optionId;
    const head = make("header", "cmp-option-head");
    head.append(make("strong", "", item.label));
    if (item.summary) head.append(make("span", "cmp-summary", item.summary));
    const stage = make("div", "cmp-body");
    if (item.format === "html") {
      // An HTML option is untrusted: its own sandboxed document, with no scripts and no network.
      const frame = make("iframe");
      frame.setAttribute("sandbox", "");
      frame.title = item.label;
      frame.src = `${body.frames}/${view.sessionId}/${encodeURIComponent(item.optionId)}`;
      stage.append(frame);
      zooms.push(mountFrameZoom({ document: doc, stage, host: head, name: `compare:${view.workflow}`, label: item.label, storage: storage() }));
    } else {
      // Text and Markdown both show as plain text, never as live HTML.
      const pre = make("pre", `cmp-text format-${item.format}`);
      pre.textContent = item.content;
      stage.append(pre);
    }
    const foot = make("footer", "cmp-option-foot");
    const pick = make("button", "cmp-pick-button", "Pick this option");
    pick.type = "button";
    pick.dataset.pick = item.optionId;
    pick.addEventListener("click", () => { draft.pick = draft.pick === item.optionId ? null : item.optionId; draft.none = false; $("none").checked = false; render(); });
    const comment = make("textarea");
    comment.rows = 2;
    comment.setAttribute("aria-label", `Comment on ${item.label}`);
    comment.placeholder = readOnly ? "No comment" : `Comment on ${item.label} (optional)`;
    comment.dataset.comment = item.optionId;
    comment.value = readOnly ? view.result?.comments[item.optionId] ?? "" : draft.comments[item.optionId] ?? "";
    comment.readOnly = readOnly;
    comment.addEventListener("input", () => { draft.comments[item.optionId] = comment.value; });
    foot.append(pick, comment);
    card.append(head, stage, foot);
    return card;
  }

  function context() {
    const parts = [make("h2", "", "Brief"), make("p", "cmp-pre", view.brief)];
    if (view.clarifications.length) {
      const list = make("dl");
      for (const item of view.clarifications) list.append(make("dt", "", item.question), make("dd", "", item.answer));
      parts.push(make("h2", "", "Answers before the start"), list);
    }
    if (view.outcome) parts.push(make("h2", "", "Outcome of the agent"), make("p", "cmp-pre", view.outcome.summary));
    if (view.repo) parts.push(make("p", "cmp-meta", `Repository: ${view.repo.name}${view.repo.revision ? ` at ${view.repo.revision}` : ""}`));
    parts.push(make("p", "cmp-meta", `Session ${view.sessionId}`));
    return parts;
  }

  function stars(value, readOnly) {
    return Array.from({ length: RATING_MAX }, (_, index) => {
      const point = index + 1;
      const half = make("button", `cmp-star ${point % 2 ? "is-left" : "is-right"}${isRating(value) && point <= value ? " is-on" : ""}`);
      half.type = "button";
      half.setAttribute("role", "radio");
      half.setAttribute("aria-checked", String(point === value));
      half.setAttribute("aria-label", starsLabel(point));
      half.title = starsLabel(point);
      half.dataset.rating = String(point);
      half.tabIndex = point === (isRating(value) ? value : RATING_MIN) ? 0 : -1;
      half.disabled = readOnly;
      half.addEventListener("click", () => { ratingDraft = point; render(); $("stars").querySelector('[tabindex="0"]')?.focus(); });
      return half;
    });
  }

  function render() {
    if (closed) return;
    const list = shown();
    const fresh = sessions.filter((item) => item.isNew).length;
    $("app").classList.toggle("is-list-closed", !listOpen);
    $("toggleList").setAttribute("aria-expanded", String(listOpen));
    $("newCount").hidden = !fresh;
    $("newCount").textContent = fresh ? `${fresh} new` : "";
    const types = [...new Set(sessions.map((item) => item.workflow))].sort();
    const filter = $("typeFilter");
    if ([...filter.options].slice(1).map((item) => item.value).join() !== types.join()) {
      const keep = filter.value;
      filter.replaceChildren(new win.Option("All types", ""), ...types.map((type) => new win.Option(type, type)));
      filter.value = types.includes(keep) ? keep : "";
    }
    $("empty").hidden = list.length > 0;
    $("sessions").replaceChildren(...list.map((item) => {
      const li = make("li"), button = make("button");
      button.type = "button";
      button.dataset.session = item.sessionId;
      if (item.sessionId === selected) button.setAttribute("aria-current", "true");
      const top = make("span", "cmp-row-top");
      if (item.isNew) top.append(make("span", "cmp-badge", "New"));
      top.append(make("span", "cmp-type", item.workflow), make("span", "cmp-row-stars", starsText(item.rating)));
      const state = item.status === "open" ? "Waiting for your pick" : item.pick === null ? "No option fitted" : `Picked: ${item.pickLabel}`;
      button.append(top, make("span", "cmp-row-title", item.title), make("span", "cmp-row-meta", `${item.createdAt.slice(0, 16).replace("T", " ")} · ${state}`));
      button.setAttribute("aria-label", `${item.isNew ? "New. " : ""}${item.workflow}: ${item.title}. ${state}. ${starsLabel(item.rating)}.`);
      button.addEventListener("click", () => select(item.sessionId));
      li.append(button);
      return li;
    }));
    const index = list.findIndex((item) => item.sessionId === selected);
    $("newer").disabled = !list.length || index === 0;
    $("older").disabled = !list.length || index === list.length - 1;

    $("alert").hidden = !error && !pending;
    $("alertText").textContent = error || (pending ? "A request is not confirmed. Retry the same request." : "");
    $("resolve").hidden = !pending;
    $("resolve").disabled = busy;

    for (const id of ["context", "stage", "decide"]) $(id).hidden = !view;
    $("original").hidden = !view?.source;
    $("hint").hidden = Boolean(view);
    $("type").hidden = !view;
    $("viewMode").disabled = !view;
    if (!view) {
      $("title").textContent = "Walkr sessions";
      $("state").textContent = "";
      $("tabs").hidden = true;
      for (const zoom of zooms.splice(0)) zoom.close();
      $("stage").replaceChildren();
      stageKey = "";
      return;
    }
    const readOnly = view.status !== "open";
    const mode = viewMode();
    $("type").textContent = view.workflow;
    $("title").textContent = view.title;
    $("state").textContent = `${readOnly ? "Submitted" : "Waiting for your pick"}${view.rating ? ` · ${starsLabel(view.rating.value)}` : ""}`;
    const modeSelect = $("viewMode");
    const modes = Object.keys(VIEWS);
    if ([...modeSelect.options].map((item) => item.value).join() !== modes.join()) modeSelect.replaceChildren(...modes.map((name) => new win.Option(VIEWS[name], name)));
    modeSelect.value = mode;

    // Build the stage only when the session, its saved state or the view changes: frames and drafts stay while you read.
    single = Math.min(single, view.options.length - 1);
    const key = `${view.sessionId}/${view.status}/${mode}/${mode === "single" ? single : ""}/${Boolean(view.outcome)}`;
    if (key !== stageKey) {
      stageKey = key;
      for (const zoom of zooms.splice(0)) zoom.close();
      $("contextBody").replaceChildren(...context());
      // The original text is folded above the options: open it to compare, close it to give the options the space.
      if (view.source) {
        $("originalLabel").textContent = view.source.label;
        $("originalText").textContent = view.source.content;
      }
      const visible = mode === "single" ? [view.options[single]] : view.options;
      $("stage").dataset.view = mode;
      $("stage").dataset.count = String(visible.length);
      $("stage").replaceChildren(...visible.map((item) => option(item, mode, readOnly)));
      $("tabs").hidden = mode !== "single";
      $("tabs").replaceChildren(...(mode === "single" ? view.options.map((item, at) => {
        const tab = make("button", "", item.label);
        tab.type = "button";
        tab.setAttribute("role", "tab");
        tab.setAttribute("aria-selected", String(at === single));
        tab.dataset.tab = item.optionId;
        tab.addEventListener("click", () => { single = at; render(); });
        return tab;
      }) : []));
    }
    const picked = readOnly ? view.result.pick : draft.pick;
    for (const card of $("stage").children) card.dataset.picked = String(card.dataset.option === picked);
    for (const tab of $("tabs").children) tab.dataset.picked = String(tab.dataset.tab === picked);
    for (const button of $("stage").querySelectorAll("[data-pick]")) {
      const on = button.dataset.pick === picked;
      button.setAttribute("aria-pressed", String(on));
      button.textContent = on ? (readOnly ? "Picked" : "Picked. Select again to clear.") : "Pick this option";
      button.disabled = busy || Boolean(pending) || readOnly;
      button.hidden = readOnly && !on;
    }
    const label = view.options.find((item) => item.optionId === picked)?.label;
    $("result").textContent = readOnly
      ? `${view.result.pick === null ? "You picked no option." : `You picked ${label}.`}${view.result.note ? ` Note: ${view.result.note}` : ""}${view.outcome ? ` Outcome: ${view.outcome.summary}` : ""}`
      : draft.none ? "No option fits. Write a note that says what is missing." : label ? `Your pick: ${label}.` : "Pick one option, or select No option fits.";
    for (const id of ["noneLabel", "noteLabel", "submit"]) $(id).hidden = readOnly;
    $("submit").disabled = busy || Boolean(pending) || !(draft.pick || draft.none && $("note").value.trim());

    const savedRating = view.rating?.value ?? null;
    const rating = ratingDraft ?? savedRating;
    if ($("stars").dataset.shown !== `${rating}/${busy}`) {
      const focused = doc.activeElement?.dataset?.rating;
      $("stars").dataset.shown = `${rating}/${busy}`;
      $("stars").replaceChildren(...stars(rating, busy));
      if (focused) $("stars").querySelector('[tabindex="0"]')?.focus();
    }
    $("rateText").textContent = ratingDraft && ratingDraft !== savedRating ? `${starsLabel(ratingDraft)}, not saved` : starsLabel(savedRating);
    $("rate").disabled = busy || Boolean(pending) || !rating || rating === savedRating && !$("rateNote").value.trim();
  }

  const step = (by) => { const list = shown(); const next = list[list.findIndex((item) => item.sessionId === selected) + by]; if (next) select(next.sessionId); };
  const handlers = [
    [$("toggleList"), "click", () => { listOpen = !listOpen; store("list", listOpen ? "open" : "closed"); render(); }],
    [$("newer"), "click", () => step(-1)],
    [$("older"), "click", () => step(1)],
    [$("typeFilter"), "change", () => render()],
    [$("viewMode"), "change", () => { if (view) store(`view:${view.workflow}`, $("viewMode").value); render(); }],
    [$("none"), "change", () => { draft.none = $("none").checked; if (draft.none) draft.pick = null; render(); }],
    [$("note"), "input", () => { draft.note = $("note").value; render(); }],
    [$("rateNote"), "input", () => render()],
    [$("stars"), "keydown", (event) => {
      const by = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[event.key];
      if (!by || !view) return;
      event.preventDefault();
      ratingDraft = stepRating(ratingDraft ?? view.rating?.value ?? null, by);
      render();
      $("stars").querySelector('[tabindex="0"]')?.focus();
    }],
    [$("submit"), "click", () => {
      const comments = Object.fromEntries(Object.entries(draft.comments).filter(([, text]) => text.trim()));
      const note = $("note").value.trim();
      void send({ op: "submit", sessionId: view.sessionId, body: { actionId: newId(), pick: draft.none ? null : draft.pick, comments, ...(note ? { note } : {}) } });
    }],
    [$("rate"), "click", () => {
      const note = $("rateNote").value.trim();
      void send({ op: "rate", sessionId: view.sessionId, body: { actionId: newId(), rating: ratingDraft ?? view.rating.value, ...(note ? { note } : {}) } });
    }],
    [$("resolve"), "click", () => { if (pending) void send(pending); }],
    [win, "hashchange", () => select(hashId())],
  ];
  for (const [node, type, fn] of handlers) node.addEventListener(type, fn);
  const tick = async () => { await load(); if (!closed) timer = win.setTimeout(tick, refreshMs); };
  const ready = tick();
  return { ready, load, close() {
    closed = true; win.clearTimeout(timer);
    for (const [node, type, fn] of handlers) node.removeEventListener(type, fn);
    for (const zoom of zooms.splice(0)) zoom.close();
  } };
}

if (typeof window !== "undefined" && window.document?.body?.dataset.compare !== undefined) bootCompare(window);
