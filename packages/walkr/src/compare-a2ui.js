// The session preview. Each region has its own surface and call budget. The host supplies the
// layout and navigation; messages describe the content and controls. No action here sends HTTP.
import { A2UI_BASIC_CATALOG, A2UI_HIDE_LABEL, A2UI_VERSION, createA2uiHost } from "./a2ui.js";
import { normalizeZoom, ZOOM_KEY, ZOOM_LEVELS } from "./frame-zoom.js";

const path = (name) => ({ "@path": `/${name}` });
const extensions = (values) => ({ "@metadata": { extensions: values } });
const text = (id, value, variant) => ({ id, component: "Text", text: value, ...(variant ? { variant } : {}) });
const box = (id, children, row = false) => ({ id, component: row ? "Row" : "Column", children });
const fold = (summary, children) => ({ ...box("root", children), ...extensions({ walkr_fold: summary }) });
const surface = (surfaceId, components, dataModel = {}) => [{ version: A2UI_VERSION, createSurface: { surfaceId, catalogId: A2UI_BASIC_CATALOG, components, dataModel } }];
const button = (id, label, name = id, context = {}) => [
  { id, component: "Button", child: `${id}Label`, action: { event: { name, context } } }, text(`${id}Label`, label),
];

// Match words in order (longest common subsequence). Bound both allocation and work before building
// the table. Omitted marks never mean omitted option text.
function changes(source, content) {
  if (!source || source === content) return [];
  if (source.length + content.length > 64000) return null;
  const words = (value) => [...value.matchAll(/\S+/gu)];
  const a = words(source), b = words(content), width = b.length + 1;
  if ((a.length + 1) * width > 1000000) return null;
  const table = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    const k = i * width + j;
    table[k] = a[i][0] === b[j][0] ? 1 + table[k + width + 1] : Math.max(table[k + width], table[k + 1]);
  }
  const marks = [];
  for (let i = 0, j = 0; j < b.length;) {
    if (i < a.length && a[i][0] === b[j][0]) { i++; j++; continue; }
    const k = i * width + j;
    if (i < a.length && table[k + width] >= table[k + 1]) { i++; continue; }
    const word = b[j++];
    marks.push([word.index, word.index + word[0].length]);
    if (marks.length > 200) return null;
  }
  return marks;
}

/** Complete, contiguous chunks. Even JSON control characters take at most six bytes per code unit. */
export function readingMessages(content, source) {
  const ranges = changes(source, content), calls = [];
  for (let start = 0; start < content.length;) {
    let end = Math.min(start + 8000, content.length);
    if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1])) end--;
    const marks = (ranges ?? []).filter(([a, b]) => a < end && b > start).map(([a, b]) => [Math.max(0, a - start), Math.min(end, b) - start]);
    calls.push(surface(`run${calls.length}`, [{ ...text("root", content.slice(start, end)), ...(marks.length ? extensions({ walkr_marks: marks }) : {}) }]));
    start = end;
  }
  return { calls, plain: ranges === null };
}

export function paneMessages(view, item, columns, frames) {
  const html = item.format === "html", controls = columns ? ["left", "right", "solo"] : [];
  const zoom = html ? ["out", "reset", "in", "full"] : [];
  const isRec = item.optionId === view.recommended;
  const anySub = view.options?.some((other) => other.summary || other.optionId === view.recommended) ?? false;
  const hasSub = Boolean(item.summary || isRec || anySub);
  const tools = [...(columns ? ["folds"] : []), ...(zoom.length ? ["zoom"] : [])];
  return surface("pane", [box("root", ["head", "body", "foot", ...(columns ? ["rail"] : [])]),
    box("head", ["titleBox", ...(tools.length ? ["tools"] : [])]),
    box("titleBox", ["nameRow", ...(hasSub ? ["subRow"] : [])]),
    box("nameRow", ["title", "pickedBadge"], true),
    text("title", item.label, "h2"), text("pickedBadge", "Picked", "caption"),
    ...(hasSub ? [box("subRow", [...(isRec ? ["rec"] : []), ...(item.summary ? ["summary"] : [])], true)] : []),
    ...(isRec ? [text("rec", "Recommended", "caption")] : []),
    ...(item.summary ? [text("summary", item.summary, "caption")] : []),
    ...(tools.length ? [box("tools", tools, true)] : []),
    ...(columns ? [box("folds", controls, true), ...button("left", "Fold left"), ...button("right", "Fold right"), ...button("solo", "Solo"),
      { id: "rail", component: "Button", child: "railContent", action: { event: { name: "rail", context: {} } } },
      box("railContent", ["railLabel", "railPick"], true), text("railLabel", item.label), text("railPick", "✓")] : []),
    ...(html ? [box("zoom", zoom, true), ...button("out", "−"), ...button("reset", path("percent")), ...button("in", "+"), ...button("full", "Full page")] : []),
    box("body", html ? ["frame"] : []), ...(html ? [{ id: "frame", component: "WalkrFrame", label: item.label, frame: `${frames}/${view.sessionId}/${encodeURIComponent(item.optionId)}` }] : []),
    box("foot", []),
  ], { percent: "100%" });
}

const field = (id, label, limit, placeholder, extra = {}) => ({ id, component: "TextField", label, variant: "longText", value: path(id),
  ...(placeholder !== undefined ? { placeholder } : {}),
  ...extensions({ walkr_maxLength: limit, ...extra }) });

export function footerMessages(label, locked = false, readOnly = false) {
  return surface("footer", [box("root", ["pick", "comment"], true), ...button("pick", path("pickLabel")),
    field("comment", `Comment on ${label}`, 8000, path("hint"), { walkr_readOnly: path("locked"), [A2UI_HIDE_LABEL]: true })],
    { pickLabel: "Pick this option", comment: "", hint: readOnly ? "No comment" : `Comment on ${label} (optional)`, locked });
}

function ratingMessages(model) {
  return surface("rating", [fold(path("summary"), ["score", "noteRow"]),
    { ...box("score", ["stars", "shown"], true), justify: "spaceBetween" },
    { id: "stars", component: "Slider", label: "Rate this session", min: 1, max: 10, steps: 9, value: path("rating"),
      ...extensions({ walkr_stars: true, walkr_readOnly: path("locked") }) }, text("shown", path("label"), "caption"),
    box("noteRow", ["note", "save"]),
    field("note", "Rating note", 2000, "Optional. What was good or bad in this session?"), ...button("save", "Save rating")], model);
}

const part = (node, id) => node.querySelector(`[data-a2ui-id="${id}"]`);
// The mounted host and its last projected data. Refresh only fields whose value changed.
function mount(doc, parent, messages, events) {
  const { surfaceId, dataModel } = messages[0].createSurface, last = { ...dataModel };
  const host = createA2uiHost(doc, { ...events, onChange(change) {
    last[change.path.slice(1)] = change.value;
    events?.onChange?.(change);
  } });
  parent.append(host.element);
  if (!host.apply(messages).ok) {
    host.element.replaceChildren();
    const error = doc.createElement("p");
    error.setAttribute("role", "alert"); error.textContent = "This part cannot be shown. Select Current to read it.";
    host.element.append(error);
  }
  return { node: host.element, close: host.close, set(values) {
    const updates = Object.entries(values).filter(([key, value]) => last[key] !== value);
    if (!updates.length) return;
    host.apply(updates.map(([key, value]) => ({ version: A2UI_VERSION, updateDataModel: { surfaceId, path: `/${key}`, value } })));
    Object.assign(last, values);
  } };
}

/** The layout slots belong to the page. All content inside them comes from checked messages. */
export function createSessionPreview(doc, actions) {
  const $ = (id) => doc.getElementById(id);
  let session = "", infoSession = "", stageKey = "", tabHost, ratingHost, panes = [], roundHosts = [], infoHosts = [];
  const release = (hosts) => { for (const host of hosts.splice(0)) host.close(); };
  function reading(parent, value, source, hosts) {
    const { calls, plain } = readingMessages(value, source);
    if (plain) hosts.push(mount(doc, parent, surface("notice", [text("root", "Full text. Word marks are off for this comparison.", "caption")])));
    const runs = doc.createElement("div");
    runs.className = "a2-reading";
    parent.append(runs);
    for (const messages of calls) hosts.push(mount(doc, runs, messages));
  }
  function info(view, keepOpen = false) {
    const slot = $("aInfo");
    const open = keepOpen ? {
      brief: Boolean(slot.querySelector('[data-a2ui-surface="brief"] details')?.open),
      original: Boolean(slot.querySelector('[data-a2ui-surface="original"] details')?.open),
    } : { brief: false, original: false };
    release(infoHosts);
    slot.replaceChildren();
    const brief = mount(doc, slot, surface("brief", [fold("Brief and answers", ["parts"]), box("parts", [])]));
    infoHosts.push(brief);
    if (open.brief) brief.node.querySelector("details").open = true;
    const parts = part(brief.node, "parts");
    const heading = (title) => infoHosts.push(mount(doc, parts, surface("heading", [text("root", title, "h2")])));
    heading("Brief");
    reading(parts, view.brief, null, infoHosts);
    if (view.clarifications.length) {
      heading("Answers before the start");
      for (const item of view.clarifications) {
        infoHosts.push(mount(doc, parts, surface("question", [text("root", item.question)])));
        reading(parts, item.answer, null, infoHosts);
      }
    }
    if (view.outcome) { heading("Outcome of the agent"); reading(parts, view.outcome.summary, null, infoHosts); }
    if (view.repo) infoHosts.push(mount(doc, parts, surface("repo", [text("root", `Repository: ${view.repo.name}${view.repo.revision ? ` at ${view.repo.revision}` : ""}`, "caption")])));
    infoHosts.push(mount(doc, parts, surface("session", [text("root", `Session ${view.sessionId}`, "caption")])));
    if (view.source) {
      const original = mount(doc, slot, surface("original", [fold(view.source.label, ["original"]), box("original", [])]));
      infoHosts.push(original);
      if (open.original) original.node.querySelector("details").open = true;
      reading(part(original.node, "original"), view.source.content, null, infoHosts);
    }
  }
  function rounds(lines) {
    release(roundHosts); $("rounds").replaceChildren();
    for (const { prefix, title, target } of lines) roundHosts.push(mount(doc, $("rounds"), surface("round", [box("root", ["prefix", "round"], true), text("prefix", prefix),
      ...(target ? button("round", title, "select", { target }) : [text("round", title)])]), { onAction: ({ action }) => actions.select(action.context.target) }));
  }
  function releaseStage() {
    for (const pane of panes.splice(0)) { release(pane.hosts); pane.host.close(); }
    tabHost?.close(); tabHost = null; stageKey = "";
  }
  function clearStage() {
    releaseStage(); $("aTabs").replaceChildren(); $("aStage").replaceChildren();
  }
  // Disposal uses only the hosts we own. The window can already be closed.
  function close() {
    releaseStage(); release(infoHosts); release(roundHosts); ratingHost?.close(); ratingHost = null; session = ""; infoSession = "";
  }
  function clear() {
    close();
    for (const id of ["aTabs", "aStage", "aInfo", "aRating"]) $(id).replaceChildren();
  }
  function empty(key, lines) {
    if (session === key) return;
    clear(); session = key;
    infoHosts.push(mount(doc, $("aInfo"), surface("message", [box("root", lines.map((_, i) => `p${i}`)),
      ...lines.map(([value, variant], i) => text(`p${i}`, value, variant))])));
  }
  function rating(model, disabled) {
    if (!ratingHost) ratingHost = mount(doc, $("aRating"), ratingMessages(model), {
      onAction: actions.saveRating, onChange: ({ path, value }) => actions.rating(path, value),
    });
    else ratingHost.set(model);
    part(ratingHost.node, "save").disabled = disabled;
  }
  function render({ view, mode, single, folds, picked, comments, locked, frames, storage }) {
    const infoKey = `${view.sessionId}/${Boolean(view.outcome)}`;
    if (infoKey !== session) { info(view, view.sessionId === infoSession); session = infoKey; infoSession = view.sessionId; }
    const columns = mode === "columns", stage = $("aStage");
    const key = `${view.sessionId}/${mode}`;
    if (key !== stageKey) {
      clearStage(); stageKey = key;
      if (!columns) {
        tabHost = mount(doc, $("aTabs"), surface("tabs", [{ id: "root", component: "Tabs", tabs: view.options.map((_, i) => ({ title: path(`t${i}`), child: "content" })), ...extensions({ walkr_activeTab: path("tab") }) }, box("content", [])], { tab: single }),
          { onChange: ({ value }) => actions.tab(value) });
        tabHost.node.querySelector('[role="tablist"]').setAttribute("aria-label", "Options");
        tabHost.node.querySelector('[role="tabpanel"]').removeAttribute("role");
        stage.setAttribute("role", "tabpanel");
        for (const tab of tabHost.node.querySelectorAll('[role="tab"]')) tab.setAttribute("aria-controls", stage.id);
      } else { stage.removeAttribute("role"); stage.removeAttribute("aria-label"); }
    }
    $("aTabs").hidden = columns;
    if (!columns) {
      tabHost.set({ tab: single, ...Object.fromEntries(view.options.map((item, i) => [`t${i}`, item.label])) });
      for (const [i, tab] of [...tabHost.node.querySelectorAll('[role="tab"]')].entries()) {
        tab.dataset.picked = String(view.options[i]?.optionId === picked);
      }
      stage.setAttribute("aria-label", view.options[single].label);
    }
    // Keep every column mounted during folds. In One option, load a pane only when first selected.
    const visible = columns ? view.options : [view.options[single]];
    for (const item of visible) {
      if (panes.some((pane) => pane.item === item.optionId)) continue;
      const hosts = [], zoomKey = ZOOM_KEY + `compare:${view.workflow}`;
      let zoom = 1;
      try { zoom = normalizeZoom(storage?.getItem(zoomKey)); } catch {}
      const drawZoom = () => {
        const percent = `${Math.round(100 * zoom)}%`;
        host.set({ percent }); part(host.node, "body").dataset.zoom = percent;
        for (const id of ["out", "full", "in"]) part(host.node, id).disabled = id === "in" ? zoom === 1 : zoom === ZOOM_LEVELS[0];
        part(host.node, "reset").setAttribute("aria-pressed", String(zoom === 1));
      };
      const act = ({ action: { name } }) => {
        if (["left", "right", "solo", "rail"].includes(name)) {
          const direction = folds.get(item.optionId);
          if (name === "solo") { folds.clear(); view.options.forEach((o, i) => { if (o !== item) folds.set(o.optionId, i < view.options.indexOf(item) ? "left" : "right"); }); }
          else if (name === "rail") folds.delete(item.optionId); else folds.set(item.optionId, name);
          actions.render();
          if (name !== "solo") part(host.node, name === "rail" ? direction : "rail")?.focus();
        } else if (["out", "in", "reset", "full"].includes(name)) {
          const i = ZOOM_LEVELS.indexOf(zoom);
          zoom = name === "reset" ? 1 : name === "full" ? ZOOM_LEVELS[0] : ZOOM_LEVELS[Math.max(0, Math.min(i + (name === "in" ? 1 : -1), ZOOM_LEVELS.length - 1))];
          drawZoom(); try { storage?.setItem(zoomKey, String(zoom)); } catch {}
        }
      };
      const host = mount(doc, stage, paneMessages(view, item, columns, frames), { onAction: act });
      const pane = { host, hosts, item: item.optionId };
      panes.push(pane);
      host.node.classList.add("a-pane");
      if (!part(host.node, "body")) continue;
      pane.footer = mount(doc, part(host.node, "foot"), footerMessages(item.label, locked, view.status !== "open"), {
        onAction: () => actions.pick(item.optionId), onChange: ({ value }) => actions.comment(item.optionId, value),
      });
      hosts.push(pane.footer);
      const bodyId = `a-body-${item.optionId}`;
      part(host.node, "body").id = bodyId;
      part(host.node, "title").title = item.label;
      const pickedBadge = part(host.node, "pickedBadge");
      if (pickedBadge) { pickedBadge.setAttribute("aria-hidden", "true"); pickedBadge.hidden = true; }
      const summaryNode = part(host.node, "summary");
      if (summaryNode) summaryNode.title = item.summary;
      if (columns) {
        for (const [id, label] of [["left", `Fold ${item.label} to the left`], ["right", `Fold ${item.label} to the right`], ["solo", `Show ${item.label} alone`], ["rail", `Show ${item.label}`]]) {
          part(host.node, id).setAttribute("aria-label", label);
          part(host.node, id).setAttribute("aria-controls", bodyId);
        }
        part(host.node, "rail").title = `Show ${item.label}`;
        part(host.node, "railPick").setAttribute("aria-hidden", "true");
      }
      if (item.format === "html") {
        const zoomGroup = part(host.node, "zoom");
        zoomGroup.setAttribute("role", "group");
        zoomGroup.setAttribute("aria-label", `Zoom of the ${item.label}`);
        for (const [id, title] of [["out", `Zoom out the ${item.label}`], ["reset", `Show the ${item.label} at 100%`], ["in", `Zoom in the ${item.label}`], ["full", `Show the ${item.label} at the smallest zoom`]]) {
          const control = part(host.node, id);
          control.title = title;
          control.setAttribute("aria-label", title);
        }
        drawZoom();
      } else reading(part(host.node, "body"), item.content, view.source?.content, hosts);
    }
    stage.classList.toggle("has-folds", columns && folds.size > 0);
    for (const pane of panes) {
      const { host, item } = pane, direction = columns && folds.get(item), on = picked === item;
      const option = view.options.find((o) => o.optionId === item);
      host.node.hidden = !columns && item !== view.options[single].optionId;
      host.node.dataset.fold = direction || ""; host.node.dataset.picked = String(on);
      const pickedBadge = part(host.node, "pickedBadge");
      if (pickedBadge) pickedBadge.hidden = !on;
      if (pane.footer) {
        pane.footer.set({ locked, comment: Object.hasOwn(comments, item) ? comments[item] : "",
          hint: view.status !== "open" ? "No comment" : `Comment on ${option.label} (optional)`,
          pickLabel: on ? (view.status === "open" ? "Picked. Select again to clear." : "Picked") : "Pick this option" });
        const pick = part(pane.footer.node, "pick");
        pick.setAttribute("aria-pressed", String(on)); pick.disabled = locked; pick.hidden = view.status !== "open" && !on;
      }
      const rail = part(host.node, "rail");
      if (!rail) continue;
      part(host.node, "railPick").hidden = !on;
      rail.setAttribute("aria-label", `Show ${option.label}${on ? ", picked" : ""}`);
      rail.hidden = !direction;
      for (const id of ["head", "body", "foot"]) part(host.node, id).hidden = Boolean(direction);
      for (const id of ["left", "right", "rail"]) part(host.node, id).setAttribute("aria-expanded", String(!direction));
    }
    $("showAll").hidden = !columns || !folds.size;
  }
  return { render, empty, rating, rounds, clear, close, showAll(folds) {
    const pane = panes.find(({ item }) => folds.has(item));
    const focus = pane && part(pane.host.node, folds.get(pane.item));
    folds.clear(); actions.render(); focus?.focus();
  } };
}
