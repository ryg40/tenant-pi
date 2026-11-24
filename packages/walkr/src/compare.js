import { A2UI_BASIC_CATALOG, A2UI_LIMITS, A2UI_MAX_LENGTH, A2UI_OPTION_DETAILS, A2UI_READ_ONLY, A2UI_VERSION, createA2uiHost } from "./a2ui.js";
import { RATING_MAX, RATING_MIN, isRating, starsLabel, starsText, stepRating } from "./compare-stars.js";
import { createSessionPreview } from "./compare-a2ui.js";
import { mountFrameZoom } from "./frame-zoom.js";

// These codes prove that the server did not save the request. Anything else stays unresolved.
const NOT_SAVED = new Set(["INVALID_REQUEST", "INVALID_ID", "ACTION_CONFLICT", "INVALID_TRANSITION", "NOT_FOUND", "FORBIDDEN", "UNAUTHORIZED", "WRITE_FAILED"]);
const VIEWS = { columns: "Side by side", single: "One option" };
const SESSION = /^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$/;
// A row of a readable session opens the Compare stage with pick, comment, submit and rating. A row of a record that
// the server cannot read shows its error code only.
const isCompare = (row) => row?.type === "compare" && !row.error;
/** A record time in the local time of the browser, as YYYY-MM-DD HH:MM. */
function localTime(value, fallback = "unknown") {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return fallback;
  const two = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}
// The order of two texts, such as two ISO times or two session IDs.
const order = (a, b) => String(a ?? "") < String(b ?? "") ? -1 : String(a ?? "") > String(b ?? "") ? 1 : 0;
/** The surface ID of the decision panel. */
export const DECISION = "decision";
/** The picker value of "No option fits". An optionId is never empty, so the two never clash. */
export const NO_FIT = "";
/** The picker value of the Next round card "From my comments and note". A roundId is never empty, so the two never clash. */
export const FROM_FEEDBACK = "";
/** The `nextRound` of a round from the pick, the comments and the note: FEEDBACK_ROUND of src/compare-store.js. */
export const FEEDBACK_ROUND = "@feedback";
// LIMITS.text of src/compare-store.js: the most characters of the note and of each column comment.
const TEXT_MAX = 8000;
const LAST_ROUND = 20; // LIMITS.rounds of src/compare-store.js: a session of this round takes no nextRound.
// The cut of a text or markdown preview in a card of the decision panel: at most this many characters and lines.
// Seven cards hold at most 4200 characters of preview text. An HTML preview goes by the path of its frame.
const PREVIEW_CHARS = 600, PREVIEW_LINES = 8;

// The text of a text-like preview: from the first character that is not blank, at most PREVIEW_CHARS characters, with
// no blank lines (a small box has no room for them), and then the first PREVIEW_LINES lines. The cut starts after the
// leading blank text, so a long indent does not use up the cut. Markdown stays source text, as in the option columns.
// Empty when no text is left.
function previewText(content) {
  const first = content.search(/\S/);
  if (first < 0) return "";
  // A character takes at most two UTF-16 units, so this slice holds the first PREVIEW_CHARS characters.
  const head = Array.from(content.slice(first, first + PREVIEW_CHARS * 2 + 1)).slice(0, PREVIEW_CHARS).join("");
  return head.replace(/\r\n?/g, "\n").replace(/\n\s*\n/g, "\n").split("\n").slice(0, PREVIEW_LINES).join("\n").trimEnd();
}

/** The text of a submitted result: the pick, the next round that the owner asked for, the note and the outcome of the agent. */
export function resultText(view) {
  const label = view.options.find((item) => item.optionId === view.result.pick)?.label;
  const round = view.result.nextRound === undefined ? null : view.result.nextRound === FEEDBACK_ROUND ? "from your comments and note"
    : view.nextRounds?.find((item) => item.roundId === view.result.nextRound)?.label ?? view.result.nextRound;
  return `${view.result.pick === null ? "You picked no option." : `You picked ${label}.`}${round === null ? "" : ` Next round: ${round}.`}${view.result.note ? ` Note: ${view.result.note}` : ""}${view.outcome ? ` Outcome: ${view.outcome.summary}` : ""}`;
}

/**
 * True when the open panel of this draft shows the Next round cards: the session has suggestions, it is not the last
 * round, and the draft has a selection in "Pick one option" (an option or "No option fits"), now or earlier.
 */
export function showsNextCards(view, draft) {
  return Boolean(view.nextRounds) && (view.round ?? 1) < LAST_ROUND && Boolean(draft.pick || draft.none || draft.chose);
}

/**
 * The A2UI v1.0 messages of the decision panel, from the session view and the draft of the page. An open session gets a
 * picker with one entry per option and "No option fits", the note, Submit (done) and Next round; a submitted session
 * gets its result. A session of round 20, the last round of a chain, gets no Next round button.
 * After the first selection in the first picker (`showsNextCards`), a view with `nextRounds` also gets a second
 * picker: "From my comments and note" (the default) and one entry per suggestion of the agent.
 * The data model holds `/pick` (a list of one picker value), `/next` (the same, only with the second picker), `/note`,
 * `/commented` (true while a comment of an option column has text), `/overlong` (true while a comment of an option column
 * has more than TEXT_MAX characters: then both buttons refuse) and `/locked` (true while a request is in flight or not
 * confirmed: then the pickers, the note and the buttons take no change).
 * Both buttons send the action `submit` with the session of the view; the context `button` names the button.
 * Each option card and each Next round card with a `preview` shows a small preview (`walkr_optionDetails`): the cut text
 * of a text or markdown content, or the frame of an HTML content by its path under `frames`, the base of the option
 * frames of the page. Without `frames`, an HTML content gets no preview. A submitted session shows no preview.
 * An open panel that is over the size limit of one A2UI call (`A2UI_LIMITS.bytes`, the size rule of
 * `checkA2uiMessages`) is built again without the previews, and then also without the summaries of the option cards and
 * of the Next round cards. The labels, the pickers, the note and the buttons stay, so a long note or a pending submit
 * still shows. The option columns still show each option summary.
 */
export function decisionMessages(view, draft, { locked = false, frames = null, surfaceId = DECISION, status = false } = {}) {
  if (view.status !== "open") {
    return panel([{ id: "root", component: "Column", children: ["title", "result"] }, panelTitle(), { id: "result", component: "Text", text: resultText(view) }], undefined, surfaceId);
  }
  const levels = [{ previews: true, described: true }, { previews: false, described: true }, { previews: false, described: false }];
  for (const [index, level] of levels.entries()) {
    const messages = openPanel(view, draft, locked, { ...level, frames, surfaceId, status });
    if (index === levels.length - 1 || new TextEncoder().encode(JSON.stringify(messages)).length <= A2UI_LIMITS.bytes) return messages;
  }
}

const panel = (components, dataModel, surfaceId = DECISION) => [{ version: A2UI_VERSION, createSurface: { surfaceId, catalogId: A2UI_BASIC_CATALOG, components, ...(dataModel ? { dataModel } : {}) } }];
const panelTitle = () => ({ id: "title", component: "Text", text: "Your decision", variant: "h2" });

// The messages of an open panel. `described`: the option cards and the Next round cards show the summaries of the agent.
// `previews`: they show the previews of their content too. `status`: adds a Text bound to `/status` for socket errors.
function openPanel(view, draft, locked, { previews, described, frames, surfaceId = DECISION, status = false }) {
  // The preview key of one card, from a content `{ format, content }`: a cut text, or the frame path of an HTML content.
  const frameOf = (...steps) => frames ? [frames, view.sessionId, ...steps.map(encodeURIComponent)].join("/") : null;
  const sketch = (item, frame) => {
    if (!previews || !item) return {};
    if (item.format === "html") return frame ? { preview: { frame } } : {};
    const text = previewText(item.content);
    return text ? { preview: { text } } : {};
  };
  const details = view.options.map((item) => ({
    value: item.optionId, ...(described && item.summary ? { description: item.summary } : {}), ...(item.optionId === view.recommended ? { recommended: true } : {}),
    ...sketch(item, frameOf(item.optionId)),
  }));
  const path = (pointer) => ({ "@path": pointer });
  const call = (name, args) => ({ "@call": name, args });
  const lockPath = path("/locked");
  // Next round asks for one more round. A session of the last round has Submit (done) only.
  const more = (view.round ?? 1) < LAST_ROUND;
  const suggests = more && Boolean(view.nextRounds);
  const cards = showsNextCards(view, draft);
  // The meaning of Next round, after the first selection: a round from the comments and the note (the default), or one
  // suggestion of the agent. A session without suggestions has only the first meaning, so it shows no second picker.
  const next = cards ? [{
    id: "next", component: "ChoicePicker", label: "Next round", variant: "mutuallyExclusive", value: path("/next"),
    options: [{ label: "From my comments and note", value: FROM_FEEDBACK }, ...view.nextRounds.map((item) => ({ label: item.label, value: item.roundId }))],
    "@metadata": { extensions: {
      [A2UI_OPTION_DETAILS]: [{ value: FROM_FEEDBACK, description: "The agent prepares a new round from your pick, your comments and your note." },
        ...view.nextRounds.map((item) => ({ value: item.roundId, ...(described && item.summary ? { description: item.summary } : {}), ...sketch(item.preview, frameOf("next", item.roundId)) }))
          .filter((entry) => Object.keys(entry).length > 1)],
      [A2UI_READ_ONLY]: lockPath,
    } },
  }] : [];
  // A pick, or "No option fits" with one of `ways`: the first picker value is an optionId, or the list holds NO_FIT and
  // one of the conditions holds. Submit (done) needs the note. Next round also takes a column comment (`/commented`) or
  // a chosen suggestion (a first value of /next that is not empty). The texts of the panel say the same.
  const fits = (ways) => call("or", { values: [call("required", { value: path("/pick/0") }),
    call("and", { values: [call("required", { value: path("/pick") }), ways.length > 1 ? call("or", { values: ways }) : ways[0]] })] });
  const noted = call("required", { value: path("/note") });
  const button = (id, label, variant, ways, message, context = {}) => [{
    id, component: "Button", child: `${id}Label`, variant,
    action: { event: { name: "submit", context: { sessionId: view.sessionId, button: id, pick: path("/pick"), note: path("/note"), ...context } } },
    "@checks": [
      { condition: call("not", { value: lockPath }), message: "Wait until the last request is confirmed." },
      { condition: call("not", { value: path("/overlong") }), message: `A column comment has at most ${TEXT_MAX} characters.` },
      { condition: fits(ways), message },
      { condition: call("length", { value: path("/note"), max: TEXT_MAX }), message: `The note has at most ${TEXT_MAX} characters.` },
    ],
  }, { id: `${id}Label`, component: "Text", text: label }];
  const also = suggests ? "a comment or a suggestion" : "a comment";
  return panel([
    { id: "root", component: "Column", children: ["title", "pick", ...(cards ? ["next"] : []), "send", ...(status ? ["status"] : [])] },
    panelTitle(),
    {
      id: "pick", component: "ChoicePicker", label: "Pick one option", variant: "mutuallyExclusive", value: path("/pick"),
      options: [...view.options.map((item) => ({ label: item.label, value: item.optionId })), { label: "No option fits", value: NO_FIT }],
      "@metadata": { extensions: { [A2UI_OPTION_DETAILS]: [...details, { value: NO_FIT,
        description: `Write a note that says what is missing.${more ? ` Next round also takes ${also} instead.` : ""}` }], [A2UI_READ_ONLY]: lockPath } },
    },
    ...next,
    { id: "send", component: "Row", align: "start", children: ["note", "submit", ...(more ? ["more"] : [])] },
    {
      id: "note", component: "TextField", label: "Note", value: path("/note"), variant: "longText",
      placeholder: `Optional. Required when no option fits${more ? `, but Next round also takes ${also}` : ""}.`, weight: 1,
      "@metadata": { extensions: { [A2UI_READ_ONLY]: lockPath, [A2UI_MAX_LENGTH]: TEXT_MAX } },
    },
    // Submit (done) ends the comparison with this result. Next round sends the result and asks for one more round.
    ...button("submit", "Submit (done)", "primary", [noted], "Pick one option, or select No option fits and write a note."),
    ...(more ? button("more", "Next round", "default", [noted, path("/commented"), ...(cards ? [call("required", { value: path("/next/0") })] : [])],
      `Pick one option, or select No option fits and write a note or a comment${suggests ? ", or choose a suggestion" : ""}.`, cards ? { next: path("/next") } : {}) : []),
    ...(status ? [{ id: "status", component: "Text", text: path("/status") }] : []),
  ], { pick: draft.none ? [NO_FIT] : draft.pick ? [draft.pick] : [], ...(cards ? { next: [draft.next ?? FROM_FEEDBACK] } : {}), note: draft.note, commented: hasComments(draft), overlong: overLong(draft), locked, ...(status ? { status: "" } : {}) }, surfaceId);
}

/** True while a comment of an option column has text. The panel check of Next round reads it as `/commented`. */
const hasComments = (draft) => Object.values(draft.comments ?? {}).some((text) => typeof text === "string" && text.trim() !== "");
/** True while a comment of an option column has more than TEXT_MAX characters. The panel checks read it as `/overlong`. */
const overLong = (draft) => Object.values(draft.comments ?? {}).some((text) => typeof text === "string" && text.length > TEXT_MAX);

/**
 * The Walkr page: the list of the Compare sessions, newest first, and the selected session with pick, comment, submit
 * and rating.
 */
export function bootCompare(win, { fetch: fetchImpl = win.fetch.bind(win), refreshMs = 2000 } = {}) {
  const doc = win.document, $ = (id) => doc.getElementById(id), body = doc.body.dataset;
  const api = "/_walkr/compare/api";
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
  // The whole fragment is one session ID, one renderer suffix, or both. Each other fragment selects nothing.
  const fragment = () => { const [id, suffix, ...rest] = win.location.hash.slice(1).split(";");
    const renderer = /^renderer=(current|a2ui)$/.exec(suffix ?? "")?.[1];
    const whole = rest.length === 0 && (suffix === undefined || renderer) && (id === "" || SESSION.test(id));
    return whole ? { id: id || null, renderer } : { id: null, renderer: undefined }; };
  const hashId = () => fragment().id;
  const forced = () => fragment().renderer;
  let renderer = forced() ?? (stored("renderer") === "a2ui" ? "a2ui" : "current");
  const address = (id, explicit) => {
    const fragment = `${id ?? ""}${explicit ? `;renderer=${renderer}` : ""}`;
    win.history.replaceState(null, "", fragment ? `#${fragment}` : win.location.pathname);
  };

  let sessions = [], selected = hashId(), view = null, record = null, loaded = "", stageKey = "", recordKey = "", roundsKey = "", single = 0;
  // A request that is not confirmed yet, also from an earlier load of the page: a retry sends it unchanged.
  let pending = null;
  try { pending = JSON.parse(stored("pending", "null")); } catch {}
  // A new draft of a session. A pending submit of the same session gives its pick, comments, note and suggestion, so the
  // frozen panel and the columns show what a retry sends, also after a reload. A pending rating or a request of another
  // session gives none: the Next round card is then "From my comments and note". `chose`: the owner made a selection in
  // "Pick one option" in this draft, so the Next round cards stay when the pick is cleared.
  const newDraft = (sessionId) => {
    const sent = (pending?.op === "submit" && pending.sessionId === sessionId ? pending.body : null) ?? {};
    const comments = sent.comments && typeof sent.comments === "object" ? Object.fromEntries(Object.entries(sent.comments).filter(([, text]) => typeof text === "string")) : {};
    return { pick: typeof sent.pick === "string" ? sent.pick : null, comments, note: typeof sent.note === "string" ? sent.note : "", none: sent.pick === null,
      next: typeof sent.nextRound === "string" && sent.nextRound !== FEEDBACK_ROUND ? sent.nextRound : FROM_FEEDBACK, chose: false };
  };
  let draft = newDraft(selected), ratingDraft = null, ratingNote = "";
  let busy = false, error = "", closed = false, timer, zooms = [], readGeneration = 0;
  // The decision panel. It is drawn again only for another session or status; a redraw of the page keeps the note.
  // `decisionText` shows a submitted result as plain text when the surface refuses it (the result is over the A2UI limits).
  let decisionKey = "", decisionLocked = false, decisionRefused = false;
  const decision = createA2uiHost(doc, { onAction: decide, onChange: changed });
  const decisionText = make("section", "cmp-result");
  decisionText.hidden = true;
  // The receipt line below the result text. It stands outside the surface: an A2UI Text takes no role, and the line
  // changes with no new draw of the panel.
  const receipt = make("p", "cmp-receipt");
  receipt.setAttribute("role", "status");
  receipt.hidden = true;
  $("decision").replaceChildren(decision.element, decisionText, receipt);
  let listOpen = stored("list") ? stored("list") === "open" : !selected;
  const folds = new Map(); // Layout only, reset when the selected session changes.

  const preview = createSessionPreview(doc, { select, render, pick: pickOption, comment: commentOption, saveRating,
    tab(at) { single = at; render(); }, rating(path, value) {
      if (path === "/rating") ratingDraft = value; else if (path === "/note") ratingNote = value;
      render();
    },
  });
  function switchRenderer(value) {
    if (renderer === value) return;
    renderer = value;
    preview.clear(); stageKey = ""; roundsKey = "";
    for (const zoom of zooms.splice(0)) zoom.close();
    $("stage").replaceChildren(); $("rounds").replaceChildren(); $("rounds").hidden = true;
    render();
  }

  const newId = () => win.crypto?.randomUUID ? win.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const shown = () => {
    const workflow = $("typeFilter").value.split(":")[1];
    return sessions.filter((item) => !workflow || item.workflow === workflow);
  };
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
      const answer = await call(`/sessions/${item.sessionId}/${item.op}`, { method: "POST", body: JSON.stringify(item.body) });
      // Only an answer for this session with a result proves the save. Any other answer keeps the request for a retry.
      if (answer?.view?.sessionId !== item.sessionId || !answer.result) throw Object.assign(new Error("The server answer did not confirm the save."), { code: "MALFORMED" });
      setPending(null);
      if (item.sessionId === selected) { view = answer.view; loaded = `${view.sessionId}/${view.revision}`; }
      if (item.op === "rate" && item.sessionId === selected) { ratingDraft = null; ratingNote = ""; }
      if (answer.result.outcome === "already-submitted") error = "This session was already submitted. The first result is kept.";
    } catch (failure) {
      if (NOT_SAVED.has(failure.code)) setPending(null);
      error = NOT_SAVED.has(failure.code) ? failure.message : `Not confirmed: ${failure.message} Retry the same request; do not start a new one.`;
    } finally { busy = false; await load(); }
  }

  function select(sessionId) {
    if (sessionId === selected) return;
    readGeneration += 1;
    selected = sessionId; view = null; record = null; loaded = ""; single = 0; ratingDraft = null;
    folds.clear();
    draft = newDraft(sessionId);
    ratingNote = "";
    // A newly selected session starts with the rating fold closed and the side column at its top. A poll and a new draw of
    // the panel keep both.
    $("rating").open = false;
    $("decide").scrollTop = 0;
    if (hashId() !== sessionId) address(sessionId, forced() || renderer === "a2ui");
    render();
    void load();
  }

  async function load() {
    if (closed || busy) return;
    const generation = ++readGeneration;
    const stale = () => closed || busy || generation !== readGeneration;
    try {
      const answer = await call("/history");
      if (stale()) return;
      sessions = answer.rows; // Newest first.
      const row = sessions.find((item) => item.ref === selected);
      if (selected && !row) { error = "This session is not in the saved sessions."; selected = null; view = null; record = null; }
      // A record that the server cannot read: the page shows its error code and changes nothing.
      record = row?.error ? row : null;
      // Read the record again only after it changed, so a frame and a draft stay while you read.
      if (isCompare(row) && !busy && loaded !== `${row.sessionId}/${row.updatedAt}/${row.isNew}`) {
        // A selection, mutation or newer read can invalidate this answer while it is in flight.
        const wanted = row.sessionId;
        const fresh = (await call(`/sessions/${wanted}`)).view;
        if (stale() || wanted !== selected || fresh.sessionId !== wanted) return;
        if (view?.sessionId === wanted && fresh.revision < view.revision) return;
        view = fresh;
        loaded = `${row.sessionId}/${row.updatedAt}/${row.isNew}`;
        if (view.isNew) call(`/sessions/${wanted}/seen`, { method: "POST", body: "{}" }).catch(() => {});
      }
      if (!pending && error.startsWith("Could not read")) error = "";
    } catch (failure) {
      if (stale()) return;
      error = `Could not read saved state: ${failure.message}`;
    }
    render();
  }

  function chipText(item) {
    return item.workflow ? `Compare · ${item.workflow}` : "Compare";
  }

  function rowState(item) {
    if (!isCompare(item)) return item.state;
    return item.status === "open" ? "Waiting for your pick" : item.pick === null ? "No option fitted" : `Picked: ${item.pickLabel}`;
  }

  function pickOption(id) {
    if (!view || view.status !== "open" || pending || busy) return;
    draft.pick = draft.pick === id ? null : id;
    draft.none = false;
    if (!decisionRefused) decision.apply([{ version: A2UI_VERSION, updateDataModel: { surfaceId: DECISION, path: "/pick", value: draft.pick ? [draft.pick] : [] } }]);
    render();
  }

  function commentOption(id, value) {
    if (!view || view.status !== "open" || pending || busy) return;
    const before = { commented: hasComments(draft), overlong: overLong(draft) };
    draft.comments[id] = value;
    const after = { commented: hasComments(draft), overlong: overLong(draft) };
    for (const name of Object.keys(after)) if (!decisionRefused && before[name] !== after[name]) {
      decision.apply([{ version: A2UI_VERSION, updateDataModel: { surfaceId: DECISION, path: `/${name}`, value: after[name] } }]);
    }
  }

  function option(item, mode, readOnly) {
    const card = make("section", "cmp-option");
    card.dataset.option = item.optionId;
    const head = make("header", "cmp-option-head");
    const titleBox = make("div", "cmp-option-title");
    const nameRow = make("div", "cmp-option-name-row");
    const name = make("strong", "", item.label);
    name.title = item.label;
    nameRow.append(name);
    const pickedBadge = make("span", "cmp-option-picked", "Picked");
    pickedBadge.setAttribute("aria-hidden", "true");
    pickedBadge.hidden = true;
    nameRow.append(pickedBadge);
    titleBox.append(nameRow);
    const isRec = item.optionId === view.recommended;
    const anySub = view.options.some((other) => other.summary || other.optionId === view.recommended);
    if (item.summary || isRec || anySub) {
      const subRow = make("div", "cmp-option-sub");
      if (isRec) subRow.append(make("span", "cmp-option-rec", "Recommended"));
      if (item.summary) {
        const summary = make("span", "cmp-summary", item.summary);
        summary.title = item.summary;
        subRow.append(summary);
      }
      titleBox.append(subRow);
    }
    head.append(titleBox);
    const tools = make("div", "cmp-option-tools");
    const stage = make("div", "cmp-body");
    if (item.format === "html") {
      // An HTML option is untrusted: its own sandboxed document, with no scripts and no network.
      const frame = make("iframe");
      frame.setAttribute("sandbox", "");
      frame.title = item.label;
      frame.src = `${body.frames}/${view.sessionId}/${encodeURIComponent(item.optionId)}`;
      stage.append(frame);
      zooms.push(mountFrameZoom({ document: doc, stage, host: tools, name: `compare:${view.workflow}`, label: item.label, storage: storage() }));
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
    pick.addEventListener("click", () => pickOption(item.optionId));
    const comment = make("textarea");
    comment.rows = 2;
    comment.setAttribute("aria-label", `Comment on ${item.label}`);
    comment.placeholder = readOnly ? "No comment" : `Comment on ${item.label} (optional)`;
    comment.dataset.comment = item.optionId;
    comment.value = readOnly ? view.result?.comments[item.optionId] ?? "" : draft.comments[item.optionId] ?? "";
    // The store limit. A restored or a set value can be longer: then `/overlong` makes both buttons refuse.
    // render() makes the field read-only for a submitted session and while the panel is locked.
    comment.maxLength = TEXT_MAX;
    comment.addEventListener("input", () => commentOption(item.optionId, comment.value));
    foot.append(pick, comment);
    card.append(head, stage, foot);
    if (mode === "columns") {
      const controls = make("span", "cmp-fold-controls");
      const rail = make("button", "cmp-rail");
      const mark = make("span", "cmp-rail-pick", " ✓");
      mark.setAttribute("aria-hidden", "true");
      mark.hidden = true;
      rail.append(make("span", "cmp-rail-label", item.label), mark);
      rail.type = "button";
      rail.hidden = true;
      rail.setAttribute("aria-label", `Show ${item.label}`);
      rail.title = `Show ${item.label}`;
      stage.id = `cmp-body-${item.optionId}`;
      rail.setAttribute("aria-controls", stage.id);
      rail.setAttribute("aria-expanded", "false");
      for (const direction of ["left", "right"]) {
        const fold = make("button", "btn-ghost", `Fold ${direction}`);
        fold.type = "button";
        fold.dataset.fold = direction;
        fold.setAttribute("aria-label", `Fold ${item.label} to the ${direction}`);
        fold.setAttribute("aria-controls", stage.id);
        fold.addEventListener("click", () => {
          folds.set(item.optionId, direction);
          layoutColumns();
          rail.focus();
        });
        controls.append(fold);
      }
      const solo = make("button", "btn-ghost", "Solo");
      solo.type = "button";
      solo.setAttribute("aria-label", `Show ${item.label} alone`);
      solo.addEventListener("click", () => {
        const index = view.options.findIndex((other) => other.optionId === item.optionId);
        folds.clear();
        view.options.forEach((other, at) => {
          if (other.optionId !== item.optionId) folds.set(other.optionId, at < index ? "left" : "right");
        });
        layoutColumns();
      });
      controls.append(solo);
      tools.prepend(controls);
      rail.addEventListener("click", () => {
        const direction = folds.get(item.optionId);
        folds.delete(item.optionId);
        layoutColumns();
        controls.querySelector(`[data-fold="${direction}"]`)?.focus();
      });
      card.append(rail);
    }
    if (tools.childElementCount) head.append(tools);
    return card;
  }

  function layoutColumns() {
    const columns = view && viewMode() === "columns";
    $("showAll").hidden = !columns || !folds.size;
    $("stage").classList.toggle("has-folds", Boolean(columns && folds.size));
    const tracks = [];
    for (const card of $("stage").children) {
      const direction = columns && folds.get(card.dataset.option);
      const folded = Boolean(direction);
      tracks.push(folded ? "var(--cmp-rail-width)" : "minmax(0, 1fr)");
      card.classList.toggle("is-folded", folded);
      card.dataset.fold = direction || "";
      for (const child of card.children) child.hidden = child.classList.contains("cmp-rail") ? !folded : folded;
      for (const button of card.querySelectorAll("[data-fold], .cmp-rail")) button.setAttribute("aria-expanded", String(!folded));
    }
    $("stage").style.setProperty("--cmp-columns", tracks.join(" "));
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

  // A change in the panel: the pick moves the column marks, the note and the Next round card stay in the draft for a
  // redraw. The render after the first selection draws the panel again with the Next round cards (drawDecision).
  function changed({ surfaceId, path, value }) {
    if (surfaceId !== DECISION || !view || view.status !== "open") return;
    if (path === "/note") { draft.note = typeof value === "string" ? value : ""; return; }
    if (path === "/next") {
      const [round] = Array.isArray(value) ? value : [];
      draft.next = view.nextRounds?.some((item) => item.roundId === round) ? round : FROM_FEEDBACK;
      return;
    }
    if (path !== "/pick") return;
    const [chosen] = Array.isArray(value) ? value : [];
    draft.none = chosen === NO_FIT;
    draft.pick = view.options.some((item) => item.optionId === chosen) ? chosen : null;
    render();
  }

  // Submit (done) and Next round of the panel. Nothing goes to the server before one of these clicks. An action of a
  // panel that was built for another session than the selected one sends nothing.
  function decide({ action }) {
    if (action.name !== "submit" || action.surfaceId !== DECISION || !view || view.status !== "open" || busy || pending) return;
    if (action.context.sessionId !== view.sessionId) return;
    const [chosen] = Array.isArray(action.context.pick) ? action.context.pick : [];
    const note = typeof action.context.note === "string" ? action.context.note.trim() : "";
    const known = view.options.some((item) => item.optionId === chosen);
    const comments = Object.fromEntries(Object.entries(draft.comments).filter(([, text]) => text.trim()));
    // Submit (done) sends no nextRound, also when a suggestion card is selected. Next round sends the roundId of the
    // selected suggestion, or FEEDBACK_ROUND for the card "From my comments and note" and in a session without suggestions.
    const [round] = action.context.button === "more" && Array.isArray(action.context.next) ? action.context.next : [];
    const nextRound = action.context.button !== "more" ? null : view.nextRounds?.some((item) => item.roundId === round) ? round : FEEDBACK_ROUND;
    // The rule of the store: a pick, or "No option fits" with a note; with Next round, a comment or a suggestion also does.
    // Each comment has at most TEXT_MAX characters.
    if (overLong(draft)) return;
    if (!known && !(chosen === NO_FIT && (note || (nextRound && (nextRound !== FEEDBACK_ROUND || Object.keys(comments).length))))) return;
    void send({ op: "submit", sessionId: view.sessionId, body: { actionId: newId(), pick: known ? chosen : null, comments, ...(note ? { note } : {}), ...(nextRound ? { nextRound } : {}) } });
  }

  // The control of the panel that has the focus: the ID of its component, the value of a radio, and the caret of a text
  // field. A new draw of the same panel gives the focus back to the same control, so the first show of the Next round
  // cards keeps the focus on the card that the owner just selected, and the note keeps its caret.
  function focusOf() {
    const active = doc.activeElement;
    const part = active && decision.element.contains(active) ? active.closest("[data-a2ui-id]") : null;
    if (!part) return null;
    const text = active.tagName === "TEXTAREA" || active.tagName === "INPUT" && active.type === "text";
    return { id: part.dataset.a2uiId, tag: active.tagName, value: active.type === "radio" ? active.value : null,
      caret: text ? [active.selectionStart, active.selectionEnd, active.selectionDirection, active.scrollTop] : null };
  }
  function refocus(spot) {
    const part = spot && [...decision.element.querySelectorAll("[data-a2ui-id]")].find((node) => node.dataset.a2uiId === spot.id);
    if (!part) return;
    const target = [part, ...part.querySelectorAll("input, textarea, button")]
      .find((node) => node.tagName === spot.tag && (spot.value === null || node.value === spot.value));
    if (!target || target.disabled) return;
    target.focus({ preventScroll: true });
    if (spot.caret) {
      const [start, end, direction, top] = spot.caret;
      target.setSelectionRange(start, end, direction);
      target.scrollTop = top;
    }
  }

  // The selection and the scroll of the note, apart from the focus: a new draw of the same panel puts them back, also
  // when another control has the focus.
  const noteField = () => decision.element.querySelector('[data-a2ui-id="note"] textarea');
  function noteSpot() {
    const field = noteField();
    return field ? [field.selectionStart, field.selectionEnd, field.selectionDirection, field.scrollTop] : null;
  }
  function renote(spot) {
    const field = noteField();
    if (!field || !spot) return;
    const [start, end, direction, top] = spot;
    field.setSelectionRange(start, end, direction);
    field.scrollTop = top;
  }

  // The first show of the Next round cards makes the panel taller. Bring the first Next round card into view with the
  // smallest scroll of the side column (of the main area in the stacked layout). The note and the buttons stay in view
  // in the sticky foot of the panel, so the scroll keeps the card above the foot: --cmp-foot (src/compare.css) gives the
  // height of the foot to the scroll padding of each scroll area. Only that draw calls it: a poll draws no new panel, so
  // it never scrolls.
  function reveal() {
    const foot = decision.element.querySelector('[data-a2ui-id="send"]');
    if (foot) doc.documentElement.style.setProperty("--cmp-foot", `${Math.ceil(foot.getBoundingClientRect().height)}px`);
    decision.element.querySelector('[data-a2ui-id="next"] .a2-option')?.scrollIntoView?.({ block: "nearest" });
  }

  // Take the panel away: no control of it stays live.
  function clearDecision() {
    decision.apply([{ version: A2UI_VERSION, deleteSurface: { surfaceId: DECISION } }]);
    decisionText.hidden = true;
    decisionText.replaceChildren();
  }

  // Draw the panel for a new session or status, and once more when the Next round cards show after the first selection.
  // Otherwise only `/locked` changes, so the note keeps its focus and text. A new draw of the same session gives the focus
  // back to the control that had it. A refusal keeps the key, so an unchanged poll never retries it. The note keeps its selection through the new draw.
  function drawDecision() {
    if (!view) {
      if (decisionKey !== "") clearDecision();
      decisionKey = "";
      return;
    }
    const locked = busy || Boolean(pending);
    if (view.status === "open" && (draft.pick || draft.none)) draft.chose = true;
    const key = `${view.sessionId}/${view.status}/${view.status === "open" ? showsNextCards(view, draft) : Boolean(view.outcome)}`;
    if (key !== decisionKey) {
      const same = decisionKey.startsWith(`${view.sessionId}/`);
      const spot = same ? focusOf() : null, noted = same ? noteSpot() : null;
      const cardsShow = decisionKey === `${view.sessionId}/open/false` && key === `${view.sessionId}/open/true`;
      const drawn = decision.apply(decisionMessages(view, draft, { locked, frames: body.frames })).ok;
      if (drawn) { renote(noted); refocus(spot); }
      if (drawn && cardsShow) reveal();
      if (drawn) { decisionText.hidden = true; decisionText.replaceChildren(); }
      else if (view.status !== "open") {
        // The result always shows: as plain text when the surface refuses it, and with no control of an older draw.
        clearDecision();
        decisionText.replaceChildren(make("h2", "", "Your decision"), make("p", "cmp-pre", resultText(view)));
        decisionText.hidden = false;
      }
      else {
        clearDecision();
        decisionText.textContent = "The decision panel cannot show this session.";
        decisionText.hidden = false;
      }
      decisionRefused = !drawn; decisionKey = key; decisionLocked = locked;
    } else if (!decisionRefused && view.status === "open" && locked !== decisionLocked) {
      decisionLocked = locked;
      decision.apply([{ version: A2UI_VERSION, updateDataModel: { surfaceId: DECISION, path: "/locked", value: locked } }]);
    }
  }

  // A submitted result waits for the receipt of the agent (`receivedAt`). A saved outcome also proves that the agent has
  // the result, so a session with an outcome and no receipt shows no line. The text only changes on a new value, so a
  // screen reader announces each change once. `loaded` reads the view again after the write, because it moves `updatedAt`.
  function drawReceipt() {
    const text = !view || view.status === "open" || (!view.receivedAt && view.outcome) ? ""
      : view.receivedAt ? `The agent received your result at ${localTime(view.receivedAt)}.` : "Waiting for the agent to read your result.";
    if (receipt.textContent !== text) receipt.textContent = text;
    receipt.dataset.receipt = !text ? "" : view.receivedAt ? "received" : "waiting";
    receipt.hidden = !text;
  }

  // The links between the rounds of one comparison, outside the panel. They come from the current rows at each draw: the
  // earlier round is the row of `previous.sessionId`, and the later rounds are the rows whose `previousSessionId` names
  // this session, in creation order. So a later round shows as soon as a poll lists it. An earlier session that is not in
  // the list shows its session ID as text. Drawn again only on a change.
  function drawRounds() {
    const rows = sessions.filter(isCompare);
    const earlier = view?.previous ? view.previous.sessionId : null;
    const earlierRow = earlier ? rows.find((item) => item.ref === earlier) ?? null : null;
    const later = view ? rows.filter((item) => item.previousSessionId === view.sessionId).sort((a, b) => order(a.time, b.time) || order(a.ref, b.ref)) : [];
    const key = view ? JSON.stringify([view.sessionId, view.round ?? 1, earlier, earlierRow?.title ?? null, later.map((item) => [item.ref, item.title])]) : "";
    if (key === roundsKey) return;
    roundsKey = key;
    if (renderer === "a2ui") {
      const lines = [...(earlier ? [{ prefix: `Round ${view.round ?? 2}. Earlier round:`, title: earlierRow?.title ?? earlier, target: earlierRow?.ref }] : []),
        ...later.map((item) => ({ prefix: "Next round:", title: item.title, target: item.ref }))];
      preview.rounds(lines); $("rounds").hidden = !lines.length;
      return;
    }
    const link = (sessionId, text) => {
      const button = make("button", "cmp-round-link", text);
      button.type = "button";
      button.dataset.round = sessionId;
      button.addEventListener("click", () => select(sessionId));
      return button;
    };
    const lines = [];
    if (earlier) {
      const line = make("p", "cmp-round-line", `Round ${view.round ?? 2}. Earlier round: `);
      line.append(earlierRow ? link(earlier, earlierRow.title) : make("span", "cmp-round-name", earlier));
      lines.push(line);
    }
    for (const item of later) {
      const line = make("p", "cmp-round-line", "Next round: ");
      line.append(link(item.ref, item.title));
      lines.push(line);
    }
    $("rounds").replaceChildren(...lines);
    $("rounds").hidden = !lines.length;
  }

  function render() {
    if (closed) return;
    const isPreview = renderer === "a2ui";
    $("renderer").value = renderer;
    $("showAll").setAttribute("aria-controls", isPreview ? "aStage" : "stage");
    drawDecision();
    drawReceipt();
    drawRounds();
    const list = shown();
    const fresh = sessions.filter((item) => item.isNew).length;
    $("app").classList.toggle("is-list-closed", !listOpen);
    $("toggleList").setAttribute("aria-expanded", String(listOpen));
    $("newCount").hidden = !fresh;
    $("newCount").textContent = fresh ? `${fresh} new` : "";
    // The filter lists the workflows of the saved sessions.
    const workflows = [...new Set(sessions.filter((item) => item.workflow).map((item) => item.workflow))].sort();
    const filter = $("typeFilter");
    if (filter.dataset.workflows !== workflows.join()) {
      const keep = filter.value;
      filter.replaceChildren(new win.Option("All workflows", ""), ...workflows.map((name) => new win.Option(name, `compare:${name}`)));
      filter.value = [...filter.options].some((item) => item.value === keep) ? keep : "";
      filter.dataset.workflows = workflows.join();
    }
    $("empty").hidden = list.length > 0;
    $("sessions").replaceChildren(...list.map((item) => {
      const li = make("li"), button = make("button");
      button.type = "button";
      button.dataset.session = item.ref;
      button.dataset.type = item.type;
      if (item.ref === selected) button.setAttribute("aria-current", "true");
      const top = make("span", "cmp-row-top");
      if (item.isNew) top.append(make("span", "cmp-badge", "New"));
      const chip = chipText(item);
      const typeChip = make("span", "cmp-type", chip);
      typeChip.dataset.type = item.type;
      if (item.workflow) typeChip.dataset.workflow = item.workflow;
      top.append(typeChip);
      // A later round of a comparison.
      const round = isCompare(item) && item.round > 1 ? `Round ${item.round}` : "";
      if (round) top.append(make("span", "cmp-round", round));
      if (isCompare(item)) top.append(make("span", "cmp-row-stars", starsText(item.rating)));
      const state = rowState(item);
      const when = localTime(item.time, "time unknown");
      button.append(top, make("span", "cmp-row-title", item.title), make("span", "cmp-row-meta", `${when} · ${state}`));
      button.setAttribute("aria-label", `${item.isNew ? "New. " : ""}${chip}: ${item.title}. ${round ? `${round}. ` : ""}${state}.${isCompare(item) ? ` ${starsLabel(item.rating)}.` : ""}`);
      button.addEventListener("click", () => select(item.ref));
      li.append(button);
      return li;
    }));
    const index = list.findIndex((item) => item.ref === selected);
    $("newer").disabled = !list.length || index === 0;
    $("older").disabled = !list.length || index === list.length - 1;

    $("alert").hidden = !error && !pending;
    $("alertText").textContent = error || (pending ? "A request is not confirmed. Retry the same request." : "");
    $("resolve").hidden = !pending;
    $("resolve").disabled = busy;

    for (const id of ["context", "work", "stage", "decide"]) $(id).hidden = !view;
    $("aStage").hidden = !isPreview || !view; $("aInfo").hidden = !isPreview;
    $("aRating").hidden = !isPreview; $("rating").hidden = isPreview;
    if (!view || !isPreview) $("aTabs").hidden = true;
    if (isPreview) $("tabs").hidden = $("stage").hidden = $("context").hidden = true;
    $("original").hidden = isPreview || !view?.source;
    $("record").hidden = !record;
    // With no session, the page shows how to start one: the guidance of src/compare-server.js.
    const guide = !view && !record && !list.length;
    $("guide").hidden = !guide;
    if (guide && !$("guide").childElementCount) {
      const part = make("section", "cmp-record-part");
      part.append(make("h2", "", "Start Compare"), ...[...doc.querySelectorAll("template[data-guide]")].map((item) => item.content.cloneNode(true)));
      $("guide").replaceChildren(part);
    }
    $("hint").hidden = Boolean(view || record || guide);
    $("type").hidden = !view && !record;
    $("viewMode").disabled = !view;
    if (!view) {
      $("title").textContent = record ? record.title : "Walkr sessions";
      $("state").textContent = record ? record.state : "";
      $("state").dataset.status = "";
      $("type").textContent = record ? "Compare" : "";
      $("type").dataset.type = record ? "compare" : "";
      delete $("type").dataset.workflow;
      const key = record ? `${record.ref}/${record.error}` : "";
      if (key !== recordKey) {
        recordKey = key;
        $("record").replaceChildren(...(record ? [make("p", "cmp-record-error", `This record is not readable (${record.error}). The page does not change it. Preserve it before a recovery.`)] : []));
      }
      $("tabs").hidden = true;
      $("showAll").hidden = true;
      folds.clear();
      if (isPreview) {
        const lines = record ? [[$("record").textContent]] : guide ? [["Start Compare", "h2"],
          ...[...$("guide").querySelectorAll("p")].map((line) => [line.textContent])] : [[$("hint").textContent]];
        preview.empty(record ? `record/${key}` : guide ? "guide" : "hint", lines);
        $("guide").hidden = $("record").hidden = $("hint").hidden = true;
      }
      for (const zoom of zooms.splice(0)) zoom.close();
      $("stage").replaceChildren();
      stageKey = "";
      return;
    }
    const readOnly = view.status !== "open";
    const mode = viewMode();
    $("type").textContent = `Compare · ${view.workflow}`;
    Object.assign($("type").dataset, { type: "compare", workflow: view.workflow });
    $("title").textContent = view.title;
    $("state").textContent = `${readOnly ? "Submitted" : "Waiting for your pick"}${view.rating ? ` · ${starsLabel(view.rating.value)}` : ""}`;
    $("state").dataset.status = readOnly ? "submitted" : "open";
    const modeSelect = $("viewMode");
    const modes = Object.keys(VIEWS);
    if ([...modeSelect.options].map((item) => item.value).join() !== modes.join()) modeSelect.replaceChildren(...modes.map((name) => new win.Option(VIEWS[name], name)));
    modeSelect.value = mode;

    if (isPreview) preview.render({ view, mode, single, folds, locked: readOnly || busy || Boolean(pending),
      comments: readOnly ? view.result.comments ?? {} : draft.comments, frames: body.frames, storage: storage(), picked: readOnly ? view.result.pick : draft.pick });
    else drawCurrentStage(mode, readOnly);
    drawRating();
  }

  function drawCurrentStage(mode, readOnly) {
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
    layoutColumns();
    for (const card of $("stage").children) {
      const on = card.dataset.option === picked;
      card.dataset.picked = String(on);
      const pickedBadge = card.querySelector(".cmp-option-picked");
      if (pickedBadge) pickedBadge.hidden = !on;
      const rail = card.querySelector(".cmp-rail");
      if (rail) {
        const label = view.options.find((item) => item.optionId === card.dataset.option).label;
        rail.querySelector(".cmp-rail-pick").hidden = !on;
        rail.setAttribute("aria-label", `Show ${label}${on ? ", picked" : ""}`);
      }
    }
    for (const tab of $("tabs").children) tab.dataset.picked = String(tab.dataset.tab === picked);
    for (const button of $("stage").querySelectorAll("[data-pick]")) {
      const on = button.dataset.pick === picked;
      button.setAttribute("aria-pressed", String(on));
      button.textContent = on ? (readOnly ? "Picked" : "Picked. Select again to clear.") : "Pick this option";
      button.disabled = busy || Boolean(pending) || readOnly;
      button.hidden = readOnly && !on;
    }
    // The comments lock with the panel, so a confirmed result and a retry hold the text that the fields show.
    for (const field of $("stage").querySelectorAll("[data-comment]")) field.readOnly = busy || Boolean(pending) || readOnly;

  }

  function drawRating() {
    const savedRating = view.rating?.value ?? null;
    const rating = ratingDraft ?? savedRating;
    const label = ratingDraft && ratingDraft !== savedRating ? `${starsLabel(ratingDraft)}, not saved` : starsLabel(savedRating);
    const disabled = busy || Boolean(pending) || !rating || rating === savedRating && !ratingNote.trim();
    if (renderer === "a2ui") {
      preview.rating({ rating, note: ratingNote, locked: busy,
        summary: `Rate this session · ${starsLabel(savedRating)}`, label }, disabled);
      return;
    }
    if ($("rateNote").value !== ratingNote) $("rateNote").value = ratingNote;
    if ($("stars").dataset.shown !== `${rating}/${busy}`) {
      const focused = doc.activeElement?.dataset?.rating;
      $("stars").dataset.shown = `${rating}/${busy}`;
      $("stars").replaceChildren(...stars(rating, busy));
      if (focused) $("stars").querySelector('[tabindex="0"]')?.focus();
    }
    // The summary line of the rating fold shows the saved rating, also while the fold is closed.
    $("rateSaved").textContent = starsLabel(savedRating);
    $("rateSaved").dataset.rated = String(Boolean(savedRating));
    $("rateText").textContent = label;
    $("rate").disabled = disabled;
  }

  function saveRating() {
    const rating = ratingDraft ?? view?.rating?.value, note = ratingNote.trim();
    if (!view || !isRating(rating) || busy || pending || rating === view.rating?.value && !note) return;
    void send({ op: "rate", sessionId: view.sessionId, body: { actionId: newId(), rating, ...(note ? { note } : {}) } });
  }

  const step = (by) => { const list = shown(); const at = list.findIndex((item) => item.ref === selected); const next = at < 0 ? null : list[at + by]; if (next) select(next.ref); };
  const handlers = [
    [$("toggleList"), "click", () => { listOpen = !listOpen; store("list", listOpen ? "open" : "closed"); render(); }],
    [$("newer"), "click", () => step(-1)],
    [$("older"), "click", () => step(1)],
    [$("typeFilter"), "change", () => render()],
    [$("renderer"), "change", () => {
      switchRenderer($("renderer").value); store("renderer", renderer); address(selected, true);
    }],
    [$("viewMode"), "change", () => { if (view) store(`view:${view.workflow}`, $("viewMode").value); render(); }],
    [$("showAll"), "click", () => {
      if (renderer === "a2ui") { preview.showAll(folds); return; }
      const first = $("stage").querySelector(".is-folded [data-fold]");
      folds.clear(); layoutColumns(); first?.focus();
    }],
    [$("rateNote"), "input", () => { ratingNote = $("rateNote").value; render(); }],
    [$("stars"), "keydown", (event) => {
      const by = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[event.key];
      if (!by || !view) return;
      event.preventDefault();
      ratingDraft = stepRating(ratingDraft ?? view.rating?.value ?? null, by);
      render();
      $("stars").querySelector('[tabindex="0"]')?.focus();
    }],
    [$("rate"), "click", saveRating],
    [$("resolve"), "click", () => { if (pending) void send(pending); }],
    [win, "hashchange", () => { switchRenderer(forced() ?? (stored("renderer") === "a2ui" ? "a2ui" : "current")); select(hashId()); }],
  ];
  for (const [node, type, fn] of handlers) node.addEventListener(type, fn);
  const tick = async () => { await load(); if (!closed) timer = win.setTimeout(tick, refreshMs); };
  const ready = tick();
  return { ready, load, close() {
    closed = true; win.clearTimeout(timer);
    for (const [node, type, fn] of handlers) node.removeEventListener(type, fn);
    for (const zoom of zooms.splice(0)) zoom.close();
    preview.close(); decision.close();
  } };
}

if (typeof window !== "undefined" && window.document?.body?.dataset.compare !== undefined) bootCompare(window);
