import { createDoubleRequest, outcomeUnknown } from "./double.js";
import { createSessionController, createSessionTransport, mountSessionShell } from "./double-session-shell.js";
import { encodeDoubleComparisonId } from "./double-route.js";
import { MODE_SHELLS } from "./shared-gui-mode-shells.js";
import { steerProblem } from "./steer-limits.js";

// Start replays the complete saved action before validation and connection/active checks.
// WRITE_FAILED is NOT definitive here: creating the session can fail after its
// start reservation commits. Do not reuse the single-record mutation allowlist.
const START_NOT_SAVED = new Set(["INVALID_REQUEST", "INVALID_ID", "ACTION_CONFLICT", "DISCONNECTED", "ACTIVE_SESSION"]);
function sharedOutcomeUnknown(item, error) {
  if (item.op === "start") return !START_NOT_SAVED.has(error?.code);
  // These session checks also follow receipt lookup, including on exact retries.
  if (item.op === "retry" && error?.code === "DISCONNECTED" ||
      ["retry", "recover"].includes(item.op) && error?.code === "STALE_ATTEMPT") return false;
  // Stop, retry and recover look the session up before any write: a missing session record proves that nothing was saved.
  if (error?.code === "NOT_FOUND") return false;
  return outcomeUnknown(error, true);
}

export function bootSharedGui(win, { fetch: fetchImpl = win.fetch.bind(win), base = "", refreshMs = 1000 } = {}) {
  const doc = win.document, $ = (id) => doc.getElementById(id), storage = win.localStorage;
  const key = `shared-gui:${doc.body.dataset.archive}`;
  const request = createDoubleRequest({ token: doc.body.dataset.token, fetch: fetchImpl, allowEmptyView: true });
  let saved = null, pair = null, busy = false, closed = false, timer, reading = false, error = "", selected = null, epoch = 0;
  // New review: the page leaves the saved session on screen and shows the start card. Nothing is saved or sent.
  // The page opens on the start card. A saved session that needs the owner (recovery, a failed delivery, an unconfirmed request) opens first.
  let fresh = true, boot = true;
  let pending = JSON.parse(storage.getItem(key + ":pending") ?? "null");
  let draftTimer, draftSaving = false, draftVersion = 0, draftLoaded = false;
  let draftRequest = JSON.parse(storage.getItem(key + ":draft-request") ?? "null");
  $("brief").value = storage.getItem(key + ":draft") ?? "";
  const generationAllowed = () => Boolean(saved?.connection.connected && !saved?.recoveryRequired);
  // Mode panels persist unresolved actions as `${key}:<mode>-pending`.
  const unresolvedSession = () => Object.keys(storage).some((name) => (name.startsWith("double-session-pending:") ||
    name.startsWith(key + ":") && name.endsWith("-pending") && name !== key + ":pending") && storage.getItem(name));
  const radios = () => [...doc.querySelectorAll('input[name="guiMode"]')];
  const selectedMode = () => radios().find((input) => input.checked)?.value ?? "double";
  const modeLabel = (mode) => mode === "double" ? "Double" : MODE_SHELLS[mode]?.label ?? mode;
  const startable = (mode) => mode === "double" || Object.hasOwn(MODE_SHELLS, mode);
  for (const input of radios()) if (input.value === storage.getItem(key + ":mode") && !input.disabled) input.checked = true;
  const mounted = {};
  const modeShell = (mode) => mounted[mode] ??= MODE_SHELLS[mode].mount({ window: win, token: doc.body.dataset.token, fetch: fetchImpl,
    base, storage, key, canGenerate: generationAllowed, onChange: () => void load() });
  const isActive = (view) => {
    const item = saved?.history.find((entry) => entry.sessionId === view?.sessionId);
    return Boolean(view && (item ? item.active : !["ended", "stopped"].includes(view.status)));
  };
  // Prompt-box steering covers Double and Coinflip only. Training has no steering.
  const STEERABLE = new Set(["double", "coinflip"]);
  const steerMode = (view) => isActive(view) && STEERABLE.has(view.mode ?? "double") ? view.mode ?? "double" : null;
  // The freshest saved view of a steerable session: the mode's own view when it shows that session.
  function reviewView(mode, sessionId) {
    if (mode === "coinflip") return mounted.coinflip?.view?.sessionId === sessionId ? mounted.coinflip.view : null;
    return pair?.sessionId === sessionId ? pair.controller.getState().view : null;
  }
  const instructions = (mode, view) => mode === "coinflip" ? (view?.steers ?? []).map((x) => x.text)
    : (view?.rounds ?? []).filter((r) => r.outcome?.kind === "steer").map((r) => r.outcome.instruction);
  // An in-flight or unconfirmed request of the mode: it may still save the instruction.
  function requestOpen(mode) {
    if (mode === "coinflip") return Boolean(mounted.coinflip?.pending);
    const s = pair?.controller.getState();
    return Boolean(s?.pending || s?.unresolved);
  }
  // Why the box text cannot be sent: the start brief, the last saved instruction, or the size limit.
  function textProblem(mode, view) {
    const text = $("brief").value, texts = instructions(mode, view);
    if (!text.trim()) return "empty";
    if (text.trim() === (view?.brief ?? "").trim() || text.trim() === (texts.at(-1) ?? "").trim()) {
      return "Type a new instruction. The box holds the start brief or the last saved instruction.";
    }
    return steerProblem(texts, text);
  }
  // The box owns the instruction: a sent text leaves it once the session shows it saved, on any path
  // (direct answer, Resolve, Retry, or a reload). A proven refusal keeps the text.
  let sent = JSON.parse(storage.getItem(key + ":steer-sent") ?? "null");
  function settleSent() {
    if (!sent) return;
    // The page moved to another session: the box no longer belongs to that instruction.
    if (saved?.view && saved.view.sessionId !== sent.sessionId) { sent = null; storage.removeItem(key + ":steer-sent"); return; }
    if (requestOpen(sent.mode)) return;
    const view = reviewView(sent.mode, sent.sessionId);
    if (!view) return;
    const texts = instructions(sent.mode, view);
    if (texts.length > sent.count && texts.at(-1) === sent.text && $("brief").value === sent.text) setDraft("");
    sent = null; storage.removeItem(key + ":steer-sent");
  }
  // Send needs the mode's own idle review state: a displayed pair, nothing running, nothing unresolved, a new text.
  function canSteer() {
    const view = saved?.view, mode = steerMode(view);
    if (!mode || busy || pending || sent || !generationAllowed()) return false;
    const own = reviewView(mode, view.sessionId);
    if (!own || textProblem(mode, own)) return false;
    return mode === "coinflip" ? mounted.coinflip.canSteer() : pair.controller.getState().canNext;
  }
  function renderSteer() {
    if (closed) return;
    settleSent();
    $("steerSend").hidden = !steerMode(saved?.view);
    $("briefLabel").textContent = steerMode(saved?.view) ? "Instruction for the next pair" : "Design brief";
    $("brief").setAttribute("placeholder", $("briefLabel").textContent);
    $("steerSend").disabled = !canSteer();
  }
  // The hint of a new brief. It says why Send is off when the chat is disconnected.
  const draftHint = () => !saved || generationAllowed() ? "The brief stays a draft until Send."
    : "Disconnected. The brief stays a draft. Explicitly reconnect the same chat before Send.";
  function steerHint(view, viewMode, active) {
    if (viewMode === "trainer") return active ? "Prompt steering is not available for Training. The text stays a draft." : draftHint();
    if (active && steerMode(view)) {
      if (!generationAllowed()) return "Disconnected. Drafts and saved work stay. Explicitly reconnect the same chat before Send instruction.";
      if (["generating", "failed"].includes(view.status)) return "The prompt stays editable. Send instruction is available again when a pair is shown and nothing is generating.";
      const problem = textProblem(viewMode, reviewView(viewMode, view.sessionId) ?? view);
      if (problem && problem !== "empty") return problem;
      if (viewMode === "coinflip") return view.winner ? "Send instruction keeps the winner unchanged and requests one new challenger."
        : "Send instruction replaces both candidates. The old pair stays in history; no winner or rejection is recorded.";
      if (pair?.controller.getState().unsavedDrafts.length) return "Save or clear unsaved feedback text before Send instruction.";
      return "Send instruction saves it and requests a new pair under the current keepers, deletions, and saved feedback.";
    }
    if (viewMode === "coinflip") return draftHint();
    if (view?.status === "stopped") return "Stopped without a result. The brief and history remain saved.";
    if (view?.status === "ended") return `Final page saved. Chat delivery: ${view.delivery}.`;
    return draftHint();
  }
  // One state chip in the top bar: the saved state of the session on screen.
  function stateChip(view, viewMode) {
    if (!view) return ["", ""];
    if (viewMode === "coinflip") {
      if (view.status === "stopped") return [view.submitted ? "Submitted" : view.result ? "Stopped · not submitted" : "Stopped without a result", "ended"];
      return [{ generating: "Generating", failed: "Generation failed", choosing: "Choosing" }[view.status] ?? view.status, view.status];
    }
    if (viewMode === "trainer") {
      if (view.status === "linked") return [{ "plan-review": "Plan review", "changes-requested": "Changes requested", ranking: "Ranking", complete: "All groups saved" }[view.dataset?.status] ?? "Linked", "editing"];
      return [{ preparing: "Preparing", failed: "Preparation failed", ended: "Ended" }[view.status] ?? view.status, view.status === "preparing" ? "generating" : view.status];
    }
    return [{ generating: "Generating", failed: "Generation failed", stopped: "Stopped", ended: "Ended" }[view.status] ?? view.status, view.status === "stopped" ? "ended" : view.status];
  }
  function render() {
    if (closed) return;
    const view = saved?.view, viewMode = view ? view.mode ?? "double" : null;
    // The top bar shows the connection as one dot and one word. The chat id and its file open on demand.
    $("connectionState").textContent = saved ? `${saved.connection.connected ? "Connected" : "Disconnected"}: ${saved.origin.piSessionId} (${saved.origin.piSessionFile})` : "Connection not loaded. Explicitly connect Pi.";
    $("connectionLabel").textContent = !saved ? "Not loaded" : saved.connection.connected ? "Connected" : "Disconnected";
    $("connection").dataset.state = !saved ? "loading" : saved.connection.connected ? "on" : "off";
    const active = isActive(view);
    const initial = active && viewMode === "double" && !view.comparison;
    $("startDouble").hidden = Boolean(active || pending?.op === "start");
    $("startDouble").textContent = `Send to ${modeLabel(selectedMode())}`;
    renderSteer();
    $("startDouble").disabled = busy || Boolean(pending) || unresolvedSession() || !generationAllowed() || !$("brief").value.trim() ||
      !startable(selectedMode()) || Boolean(saved?.history.some((s) => s.active));
    $("initialStop").hidden = !initial;
    $("initialStop").disabled = busy || Boolean(pending);
    $("initialRetry").hidden = !initial || view.status !== "failed";
    $("initialRetry").disabled = busy || Boolean(pending) || !generationAllowed();
    // The mode panels own their recovery controls. This control sends the Double route only.
    $("recoverGeneration").hidden = !active || viewMode !== "double" || view.status !== "generating";
    $("recoverGeneration").disabled = busy || Boolean(pending);
    $("newReview").hidden = !view || Boolean(pending) || Boolean(saved?.history.some((item) => item.active));
    $("startRetry").hidden = !pending;
    $("startRetry").disabled = busy;
    // The page shows the mode of the session on screen. While a review is active, the mode choice of the next start is hidden.
    const shownMode = pending?.op === "start" ? pending.body.mode : view ? viewMode : selectedMode();
    for (const link of doc.querySelectorAll(".mode-nav a")) {
      if (link.getAttribute("href") === `/_walkr/modes/${shownMode}`) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
    }
    $("guiMode").hidden = Boolean(active || pending?.op === "start");
    $("guiEntry").classList.toggle("is-active", Boolean(active));
    $("guiHeading").textContent = active ? `${modeLabel(viewMode)} review` : "Start a review";
    // The stage holds candidates only when a mode has something to show. Without them the composer takes the stage.
    const staged = Boolean(view && (viewMode !== "double" || view.comparison));
    doc.body.dataset.guiStage = staged ? "review" : "start";
    // The mode chip says which mode the page shows. The mode choice of the composer says what the next brief starts.
    $("viewMode").textContent = pending?.op === "start" || view ? modeLabel(shownMode) : "";
    // A displayed Double pair owns the title and the state chip. Every other view shows its brief and its saved state.
    if (!view?.comparison) {
      $("title").textContent = pending?.op === "start" ? pending.body.brief : view ? view.brief ?? saved.history.find((item) => item.sessionId === view.sessionId)?.brief ?? modeLabel(viewMode) : "New review";
      const [chip, chipState] = stateChip(view, viewMode);
      $("sessionState").textContent = chip; $("sessionState").dataset.state = chipState;
    }
    $("title").title = $("title").textContent;
    // A held request is not a failure: the mode panel offers its explicit send.
    const deliveryFailure = saved?.deliveryFailures?.find((item) => item.sessionId === view?.sessionId && item.status !== "held");
    // A disconnected chat turns Send off: the reason shows at rest, not only while the prompt has focus.
    $("guiStatus").dataset.kind = error || deliveryFailure || pending || initial && view.status === "failed" || saved && !generationAllowed() ? "alert" : "hint";
    $("guiStatus").textContent = error || (deliveryFailure ? `Chat delivery failed: ${deliveryFailure.status}. Complete output remains saved; no truncation or automatic redelivery.` : "") || (pending ? "Request not confirmed. Resolve the identical saved request; do not send a new one." :
      initial ? (view.status === "failed" ? view.generation.attempt.failure : "Generating the initial pair. Stop remains available. Interrupted work requires explicit recovery.") :
      steerHint(view, viewMode, active));
    $("guiHistory").replaceChildren(...(saved?.history ?? []).map((item) => {
      const li = doc.createElement("li"), button = doc.createElement("button");
      // The text of the button stays "<Mode> <status>: <brief>"; the parts carry their own style.
      const part = (className, text) => { const span = doc.createElement("span"); span.className = className; span.textContent = text; return span; };
      button.append(part("history-mode", modeLabel(item.mode ?? "double")), " ", part("history-status", item.status), ": ", part("history-brief", item.brief));
      if (item.sessionId === view?.sessionId) button.setAttribute("aria-current", "true");
      button.addEventListener("click", () => { selected = item.sessionId; fresh = false; button.closest("details").open = false; void load(); });
      li.append(button); return li;
    }));
    doc.querySelector(".double-panes").hidden = viewMode !== "double" || !view?.comparison;
    doc.querySelector(".double-rail").hidden = viewMode !== "double" || !view?.comparison;
    for (const mode of Object.keys(MODE_SHELLS)) if (viewMode === mode || mounted[mode]) modeShell(mode).update(viewMode === mode ? view : null);
    if (!view?.comparison && pair) { pair.close(); pair = null; }
    // The save line belongs to a mounted Double pair. Without one, it shows the state of this page.
    if (!pair && !view?.comparison) {
      // The connection and the state chip have their own places in the bar, so this line stays empty when no request is in progress.
      const [label, kind] = !saved ? ["Loading…", "saving"] : busy ? ["Saving…", "saving"] : pending ? ["Not confirmed", "failed"] : ["", ""];
      $("statusText").textContent = label;
      $("status").className = `save-line ${kind}`.trim();
      doc.body.setAttribute("aria-busy", !saved || busy ? "true" : "false");
    }
    if (view?.comparison && pair?.sessionId !== view.sessionId) {
      pair?.close();
      const controller = createSessionController({ sessionId: view.sessionId,
        transport: createSessionTransport({ sessionId: view.sessionId, token: doc.body.dataset.token, fetch: fetchImpl, base }),
        canGenerate: generationAllowed, canMutate: () => !pending && !busy, storage, timers: win });
      pair = { ...mountSessionShell({ window: win, controller }), sessionId: view.sessionId };
      // Controller state decides Send; a change re-renders only the steering control.
      controller.subscribe(renderSteer);
      void controller.load();
    } else pair?.controller.refreshControls();
  }
  async function load() {
    if (closed || reading || busy) return;
    reading = true;
    const ticket = epoch;
    try {
      const state = await request(base + "/api/double/gui", "GET");
      if (closed || busy || ticket !== epoch) return;
      if (selected && selected !== state.currentSessionId) {
        const mode = state.history.find((item) => item.sessionId === selected)?.mode ?? "double";
        state.view = (await request(base + (mode === "double" ? `/api/double/sessions/${encodeDoubleComparisonId(selected)}` : MODE_SHELLS[mode].route(selected)), "GET")).view;
      }
      if (closed || busy || ticket !== epoch) return;
      // The start card shows only while no session is active.
      if (boot && (pending || state.recoveryRequired || state.deliveryFailures?.length)) fresh = false;
      boot = false;
      if (fresh && !selected && !state.history.some((item) => item.active)) state.view = null; else fresh = false;
      saved = state;
      if (!draftLoaded) {
        draftLoaded = true;
        if (storage.getItem(key + ":draft") === null) $("brief").value = state.draft;
      }
      render();
      if (saved.view?.comparison && pair?.controller.getState().view?.sessionId === saved.view.sessionId &&
          pair.controller.getState().view.revision !== saved.view.revision) await pair.controller.load({ background: true });
    } catch (e) { error = `Refresh failed: ${e.message}`; if (saved) saved.connection.connected = false; }
    finally { reading = false; render(); }
  }
  async function send(item) {
    if (busy || closed) return;
    // Persist the complete action before dispatch. Reload never auto-submits it.
    epoch++;
    pending = item;
    storage.setItem(key + ":pending", JSON.stringify(item));
    busy = true; error = ""; render();
    try {
      const answer = await request(base + item.route, "POST", item.body);
      if (answer.result?.actionId !== item.body.actionId || answer.result.kind !== item.kind) throw new Error("The exact action receipt is missing.");
      if (item.op === "start" && (typeof answer.result.sessionId !== "string" ||
          !answer.history.some((entry) => entry.sessionId === answer.result.sessionId && entry.brief === item.body.brief))) throw new Error("The start receipt has no matching saved request.");
      if (item.op !== "start" && (!Number.isSafeInteger(answer.result.revision) ||
          answer.view?.sessionId !== item.sessionId || answer.view.revision < answer.result.revision ||
          item.body.expectedRevision !== undefined && answer.result.revision !== item.body.expectedRevision + 1)) throw new Error("The receipt revision or session does not match.");
      storage.removeItem(key + ":pending"); pending = null;
      selected = null; fresh = false;
      if (item.op === "start") saved = answer;
    } catch (e) {
      error = e.message;
      if (!sharedOutcomeUnknown(item, e)) { pending = null; storage.removeItem(key + ":pending"); }
    } finally { busy = false; await load(); render(); }
  }
  const actionId = () => win.crypto.randomUUID();
  function setDraft(text) {
    if ($("brief").value !== text) $("brief").value = text;
    storage.setItem(key + ":draft", text); draftVersion++;
    win.clearTimeout(draftTimer); draftTimer = win.setTimeout(saveDraft, 400);
  }
  // The mode saves the instruction and requests generation in one action. Its own storage keeps an
  // unconfirmed request for explicit Resolve or Retry; the confirmed instruction lives in the session history.
  async function steer() {
    const view = saved?.view, mode = steerMode(view);
    if (!canSteer()) return;
    const text = $("brief").value;
    // Saved before dispatch, so a reload can still settle the box after a lost answer.
    sent = { mode, sessionId: view.sessionId, text, count: instructions(mode, reviewView(mode, view.sessionId)).length };
    storage.setItem(key + ":steer-sent", JSON.stringify(sent));
    const outcome = await (mode === "coinflip" ? mounted.coinflip.steer(text) : pair.controller.steer(text));
    if (closed) return;
    if (outcome?.refused) { sent = null; storage.removeItem(key + ":steer-sent"); }
    renderSteer();
    await load();
  }
  async function saveDraft() {
    if (closed || draftSaving) return;
    draftSaving = true;
    const version = draftVersion;
    try {
      draftRequest ??= { actionId: actionId(), text: $("brief").value };
      storage.setItem(key + ":draft-request", JSON.stringify(draftRequest));
      const answer = await request(base + "/api/double/gui/draft", "POST", draftRequest);
      if (answer.result?.actionId !== draftRequest.actionId || answer.result.kind !== "draft") throw new Error("Draft receipt missing.");
      const changed = $("brief").value !== draftRequest.text;
      draftRequest = null; storage.removeItem(key + ":draft-request");
      if (changed) draftTimer = win.setTimeout(saveDraft, 400);
    } catch (e) { error = `Draft stays in this browser; server save failed: ${e.message}`; }
    finally { draftSaving = false; if (version !== draftVersion) draftTimer = win.setTimeout(saveDraft, 400); render(); }
  }
  const handlers = [
    ["brief", "input", () => { setDraft($("brief").value); render(); }],
    ["steerSend", "click", () => void steer()],
    ["startDouble", "click", () => {
      const mode = selectedMode();
      if (busy || pending || unresolvedSession() || !generationAllowed() || !startable(mode) || saved?.history.some((s) => s.active)) return;
      void send({ op: "start", kind: "start", route: "/api/double/gui/start", body: { actionId: actionId(), mode, brief: $("brief").value } });
    }],
    ...radios().map((input) => [input, "change", () => { storage.setItem(key + ":mode", selectedMode()); render(); }]),
    ["startRetry", "click", () => { if (pending) void send(pending); }],
    ["newReview", "click", () => {
      if (busy || pending || saved?.history.some((item) => item.active)) return;
      fresh = true; selected = null;
      if (saved) saved.view = null;
      render(); $("brief").focus();
    }],
    ["guiReload", "click", () => { error = ""; void load(); if (draftRequest) void saveDraft(); }],
    ...[["initialStop", "stop"], ["initialRetry", "retry"], ["recoverGeneration", "recover"]].map(([button, op]) => [button, "click", () => {
      const view = saved?.view;
      if (!view || busy || pending || op === "retry" && !generationAllowed()) return;
      const body = { actionId: actionId(), ...(op === "recover" ? {} : { expectedRevision: view.revision }),
        ...(op === "stop" ? {} : { requestId: view.generation.requestId, attemptId: view.generation.attempt.id }) };
      void send({ op, sessionId: view.sessionId, kind: op === "recover" ? "fail" : op, route: `/api/double/sessions/${encodeDoubleComparisonId(view.sessionId)}/${op}`, body });
    }]),
  ];
  const target = (id) => typeof id === "string" ? $(id) : id;
  for (const [id, event, fn] of handlers) target(id).addEventListener(event, fn);
  // A mode guide is another page: it opens in a new tab, so the review page and its private address stay.
  for (const link of doc.querySelectorAll(".mode-nav a")) { link.setAttribute("target", "_blank"); link.setAttribute("rel", "noopener noreferrer"); }
  // The popovers of the page (connection, saved sessions, guides, saved choices) close on a click outside and on Escape.
  const popovers = () => [...doc.querySelectorAll("details.gui-pop[open]")];
  const closeOutside = (event) => { for (const item of popovers()) if (!item.contains(event.target)) item.open = false; };
  const closeOnEscape = (event) => {
    if (event.key !== "Escape") return;
    for (const item of popovers()) { const inside = item.contains(doc.activeElement); item.open = false; if (inside) item.querySelector("summary").focus(); }
  };
  // A click inside a candidate frame does not reach this document; the window loses focus to the frame.
  const closeAll = () => { for (const item of popovers()) item.open = false; };
  doc.addEventListener("click", closeOutside);
  doc.addEventListener("keydown", closeOnEscape);
  win.addEventListener("blur", closeAll);
  async function tick() { await load(); if (!closed) timer = win.setTimeout(tick, refreshMs); }
  render(); void tick();
  return { load, get pair() { return pair; }, get state() { return saved; }, mode: (name) => mounted[name], close() {
    if (closed) return;
    closed = true; win.clearTimeout(timer); win.clearTimeout(draftTimer); pair?.close();
    for (const shell of Object.values(mounted)) shell.close();
    for (const [id, event, fn] of handlers) target(id).removeEventListener(event, fn);
    doc.removeEventListener("click", closeOutside); doc.removeEventListener("keydown", closeOnEscape); win.removeEventListener("blur", closeAll);
  } };
}
if (typeof window !== "undefined" && window.document?.body?.dataset.sharedGui !== undefined) bootSharedGui(window);
