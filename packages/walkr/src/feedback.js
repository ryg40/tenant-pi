// Deterministic renderer for Walkr Feedback sessions (components, decision trees, and grill-me sessions).
// Uses createElement and textContent only (CSP: script-src 'self'; style-src 'self'). Untrusted HTML previews and
// option concept overviews load exclusively in sandboxed iframes served under /_walkr/feedback/o/<capability>/...
import { mountFrameZoom } from "./frame-zoom.js";
import { RATING_MAX, RATING_MIN, isRating, starsLabel, stepRating } from "./compare-stars.js";

const TEXT_MAX = 8000;
const CUSTOM_PICK = "__custom__";

const ACTION_BUTTONS = {
  "accept-revise": [{ decision: "accept", label: "Accept", primary: true }, { decision: "another-round", label: "Another round", primary: false }],
  "submit-revise": [{ decision: "submit", label: "Submit", primary: true }, { decision: "another-round", label: "Another round", primary: false }],
  "accept-only": [{ decision: "accept", label: "Accept", primary: true }],
  "submit-only": [{ decision: "submit", label: "Submit", primary: true }],
};

const DECISION_LABELS = {
  accept: "Accepted",
  submit: "Submitted",
  "another-round": "Another round requested",
};

const KIND_LABELS = {
  component: "Component",
  decision: "Decision",
  grill: "Grill",
};

function localTime(value, fallback = "unknown") {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return fallback;
  const two = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

function itemValidation(item, draft) {
  const comment = (draft.comment ?? "").trim();
  const overlong = (draft.comment ?? "").length > TEXT_MAX;
  if (overlong) {
    return {
      canPrimary: false,
      canRevise: false,
      hint: `Comment must be at most ${TEXT_MAX} characters.`,
    };
  }
  if (item.kind === "component") {
    return {
      canPrimary: true,
      canRevise: Boolean(comment),
      hint: comment ? "" : "Write a comment to request another round.",
    };
  }
  const hasOption = Boolean(draft.pick && draft.pick !== CUSTOM_PICK && item.options?.some((opt) => opt.optionId === draft.pick));
  const isCustom = draft.pick === CUSTOM_PICK;
  const canPrimary = hasOption || (isCustom && Boolean(comment));
  const canRevise = hasOption || Boolean(comment);
  let hint = "";
  if (!canPrimary && !canRevise) hint = "Pick an option, or choose Custom and write a comment.";
  else if (!canPrimary) hint = "Pick an option, or write a comment for your custom answer.";
  return { canPrimary, canRevise, hint };
}

function batchIncluded(item, draft) {
  const v = itemValidation(item, draft);
  if (!v.canPrimary) return false;
  if (item.kind === "component") return Boolean(draft.includeBatch);
  return true;
}

function primaryDecisionOf(actions) {
  return actions.startsWith("accept") ? "accept" : "submit";
}

function makeResponsePayload(item, draft, decision) {
  const comment = (draft.comment ?? "").trim();
  if (item.kind === "component") {
    return { itemId: item.itemId, decision, ...(comment ? { comment } : {}) };
  }
  const pick = draft.pick && draft.pick !== CUSTOM_PICK && item.options?.some((opt) => opt.optionId === draft.pick) ? draft.pick : null;
  return { itemId: item.itemId, decision, pick, ...(comment ? { comment } : {}) };
}

/**
 * Mount and manage the Feedback workspace inside `#feedbackWork`.
 * Calls `actions.expand`, `actions.respond`, and `actions.rate` — never writes directly to HTTP without going through
 * the page controller so pending/retry recovery and busy locking stay unified.
 */
export function createFeedbackView(win, container, actions) {
  const doc = win.document;
  const make = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const storage = () => { try { return win.localStorage; } catch { return null; } };
  const draftKey = (sessionId) => `walkr-feedback:draft:${sessionId}`;

  let currentSession = "";
  let renderKey = "";
  let view = null;
  let drafts = Object.create(null); // itemId -> { pick, comment }
  let batchNote = "";
  let ratingDraft = null;
  let ratingNote = "";
  let lastSavedRatingAt = "";
  let zooms = [];
  let closed = false;

  function loadDrafts(sessionId) {
    drafts = Object.create(null);
    batchNote = "";
    try {
      const raw = storage()?.getItem(draftKey(sessionId));
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        if (parsed.items && typeof parsed.items === "object") {
          for (const [k, v] of Object.entries(parsed.items)) {
            if (v && typeof v === "object") {
              drafts[k] = {
                pick: typeof v.pick === "string" ? v.pick : null,
                comment: typeof v.comment === "string" ? v.comment : "",
                includeBatch: v.includeBatch === true,
              };
            }
          }
        }
        if (typeof parsed.note === "string") batchNote = parsed.note;
      }
    } catch {}
  }

  function saveDrafts() {
    if (!currentSession) return;
    try {
      const hasAny = Boolean(batchNote.trim()) || Object.values(drafts).some((d) => d.pick || d.includeBatch || (d.comment ?? "").trim());
      if (!hasAny) storage()?.removeItem(draftKey(currentSession));
      else storage()?.setItem(draftKey(currentSession), JSON.stringify({ items: drafts, note: batchNote }));
    } catch {}
  }

  function clearSubmittedDrafts(nextView) {
    let changed = false;
    for (const item of nextView.items) {
      if (item.response && drafts[item.itemId]) {
        delete drafts[item.itemId];
        changed = true;
      }
    }
    if (changed) saveDrafts();
  }

  function getDraft(itemId) {
    if (!drafts[itemId]) drafts[itemId] = { pick: null, comment: "", includeBatch: false };
    return drafts[itemId];
  }

  function disposeZooms() {
    for (const zoom of zooms.splice(0)) zoom.close();
  }

  function clear() {
    disposeZooms();
    currentSession = "";
    renderKey = "";
    view = null;
    drafts = Object.create(null);
    batchNote = "";
    ratingDraft = null;
    ratingNote = "";
    lastSavedRatingAt = "";
    container.replaceChildren();
  }

  function structureKey(v, frames) {
    return JSON.stringify([
      v.sessionId,
      v.revision,
      v.status,
      v.receivedAt ?? "",
      v.receivedRevision ?? 0,
      Boolean(v.outcome),
      v.rating?.value ?? null,
      frames,
    ]);
  }

  function buildFrame(src, title, zoomName, hostTools, className = "fb-frame-wrap") {
    const wrap = make("div", className);
    const frame = make("iframe");
    frame.setAttribute("sandbox", "");
    frame.title = title;
    frame.src = src;
    wrap.append(frame);
    if (hostTools) {
      zooms.push(mountFrameZoom({ document: doc, stage: wrap, host: hostTools, name: zoomName, label: title, storage: storage() }));
    }
    return wrap;
  }

  function pendingFor(v, itemId, optionId = null) {
    return (v.pendingExpands ?? []).some((req) => req.itemId === itemId && (optionId === null || req.optionIds.includes(optionId)));
  }

  function buildOverview(v, item, opt, frames) {
    if (!opt.overview) return null;
    const box = make("div", "fb-overview");
    const bar = make("div", "fb-overview-bar");
    bar.append(make("span", "fb-overview-label", "Concept overview"));
    const tools = make("div", "fb-overview-tools");
    bar.append(tools);
    box.append(bar);
    if (opt.overview.format === "html") {
      const src = `${frames}/${v.sessionId}/${encodeURIComponent(item.itemId)}/${encodeURIComponent(opt.optionId)}`;
      box.append(buildFrame(src, `${opt.label} concept overview`, `feedback:${v.workflow}:overview`, tools, "fb-overview-frame"));
    } else {
      const pre = make("pre", "fb-pre fb-overview-text", opt.overview.content);
      box.append(pre);
    }
    return box;
  }

  function buildItemCard(v, item, { locked, frames }) {
    const card = make("article", `fb-card fb-kind-${item.kind} fb-status-${item.status}`);
    card.dataset.item = item.itemId;
    card.dataset.kind = item.kind;
    if (item.response) card.dataset.answered = "true";

    if (item.branchLabel) {
      card.append(make("div", "fb-branch-chip", item.branchLabel));
    }

    // Compact read-only nodes for settled or skipped tree branches
    if (item.status === "settled") {
      const head = make("div", "fb-settled-row");
      head.append(
        make("span", "fb-pill fb-pill-settled", "Settled"),
        make("strong", "fb-card-title", item.title),
        make("span", "fb-settled-answer", item.settledAnswer),
      );
      card.append(head);
      if (item.summary) card.append(make("p", "fb-card-summary", item.summary));
      return card;
    }
    if (item.status === "skipped") {
      const head = make("div", "fb-settled-row");
      head.append(
        make("span", "fb-pill fb-pill-skipped", "Set aside"),
        make("strong", "fb-card-title", item.title),
      );
      card.append(head);
      if (item.summary) card.append(make("p", "fb-card-summary", item.summary));
      return card;
    }

    const head = make("header", "fb-card-head");
    const headLeft = make("div", "fb-card-head-main");
    const metaRow = make("div", "fb-card-badges");
    metaRow.append(make("span", "fb-pill fb-pill-kind", KIND_LABELS[item.kind] || item.kind));
    if (item.response) {
      metaRow.append(make("span", `fb-pill fb-pill-decision fb-dec-${item.response.decision}`, DECISION_LABELS[item.response.decision] || item.response.decision));
    } else if (pendingFor(v, item.itemId)) {
      metaRow.append(make("span", "fb-pill fb-pill-expanding", "Expanding..."));
    } else {
      metaRow.append(make("span", "fb-pill fb-pill-open", "Open"));
    }
    headLeft.append(metaRow, make("h2", "fb-card-title", item.title));
    if (item.summary) headLeft.append(make("p", "fb-card-summary", item.summary));
    head.append(headLeft);
    const headTools = make("div", "fb-card-tools");
    head.append(headTools);
    card.append(head);

    if (item.kind === "component") {
      if (item.explanation) card.append(make("p", "fb-explanation", item.explanation));
      if (item.preview) {
        if (item.preview.format === "html") {
          const src = `${frames}/${v.sessionId}/${encodeURIComponent(item.itemId)}/preview`;
          card.append(buildFrame(src, item.title, `feedback:${v.workflow}:component`, headTools, "fb-component-frame"));
        } else {
          card.append(make("pre", "fb-pre fb-component-text", item.preview.content));
        }
      }
    } else {
      if (item.prompt) card.append(make("p", "fb-prompt", item.prompt));
      if (item.explanation) card.append(make("p", "fb-explanation", item.explanation));

      const draft = getDraft(item.itemId);
      const answered = Boolean(item.response);
      const activePick = answered ? (item.response.pick ?? CUSTOM_PICK) : draft.pick;
      const optionsWrap = make("div", "fb-options");
      optionsWrap.setAttribute("role", "radiogroup");
      optionsWrap.setAttribute("aria-label", `Choices for ${item.title}`);

      const unexpanded = (item.options ?? []).filter((opt) => opt.expandable && !opt.expanded);

      for (const [idx, opt] of (item.options ?? []).entries()) {
        const isRec = opt.optionId === item.recommended;
        const isRich = Boolean(opt.expanded || opt.overview || opt.explanation);
        const isPicked = activePick === opt.optionId;
        const optCard = make("div", `fb-option${isRec ? " is-recommended" : ""}${isRich ? " is-expanded" : " is-compact"}${isPicked ? " is-picked" : ""}`);
        optCard.dataset.option = opt.optionId;

        const labelRow = make("label", "fb-option-select");
        const radio = make("input");
        radio.type = "radio";
        radio.name = `fb-pick-${v.sessionId}-${item.itemId}`;
        radio.value = opt.optionId;
        radio.checked = isPicked;
        radio.disabled = answered || locked;
        radio.addEventListener("change", () => {
          if (answered || locked) return;
          getDraft(item.itemId).pick = opt.optionId;
          saveDrafts();
          refreshControls();
        });

        const titleSpan = make("span", "fb-option-head");
        titleSpan.append(make("span", "fb-option-num", `Option ${idx + 1}`), make("strong", "fb-option-label", opt.label));
        if (isRec) titleSpan.append(make("span", "fb-rec-pill", "Recommended"));
        if (isPicked && answered) titleSpan.append(make("span", "fb-picked-pill", "Picked"));
        labelRow.append(radio, titleSpan);
        optCard.append(labelRow);

        if (opt.summary) optCard.append(make("p", "fb-option-summary", opt.summary));
        if (opt.explanation) optCard.append(make("p", "fb-option-explanation", opt.explanation));
        const overview = buildOverview(v, item, opt, frames);
        if (overview) optCard.append(overview);

        if (!answered && opt.expandable && !opt.expanded) {
          const isPending = pendingFor(v, item.itemId, opt.optionId);
          const optFoot = make("div", "fb-option-expand-row");
          const expBtn = make("button", "btn-ghost fb-expand-one", isPending ? "Expanding..." : "Expand this option");
          expBtn.type = "button";
          expBtn.dataset.expandOption = opt.optionId;
          expBtn.disabled = locked || isPending;
          expBtn.addEventListener("click", () => actions.expand(v.sessionId, item.itemId, [opt.optionId]));
          optFoot.append(expBtn);
          optCard.append(optFoot);
        }

        optionsWrap.append(optCard);
      }

      // Custom / none of these option
      const customPicked = activePick === CUSTOM_PICK && (answered ? item.response.pick === null : true);
      const customCard = make("div", `fb-option fb-option-custom${customPicked ? " is-picked" : ""}`);
      const customRow = make("label", "fb-option-select");
      const customRadio = make("input");
      customRadio.type = "radio";
      customRadio.name = `fb-pick-${v.sessionId}-${item.itemId}`;
      customRadio.value = CUSTOM_PICK;
      customRadio.checked = customPicked;
      customRadio.disabled = answered || locked;
      customRadio.addEventListener("change", () => {
        if (answered || locked) return;
        getDraft(item.itemId).pick = CUSTOM_PICK;
        saveDrafts();
        refreshControls();
      });
      const customHead = make("span", "fb-option-head");
      customHead.append(make("strong", "fb-option-label", "Custom / another direction"));
      customRow.append(customRadio, customHead);
      customCard.append(customRow, make("p", "fb-option-summary", "Describe what you want in the feedback comment box below."));
      optionsWrap.append(customCard);

      card.append(optionsWrap);

      // Prominent Expand button for options 2 & 3 (or all remaining expandable options)
      if (!answered && unexpanded.length > 0) {
        const itemPending = pendingFor(v, item.itemId);
        const expandBar = make("div", "fb-expand-bar");
        const countLabel = unexpanded.length === 1
          ? `Expand ${unexpanded[0].label}`
          : `Expand options ${unexpanded.map((o) => (item.options.indexOf(o) + 1)).join(" & ")}`;
        const expandAll = make("button", "btn-ghost fb-expand-all", itemPending ? "Worker is expanding options..." : countLabel);
        expandAll.type = "button";
        expandAll.dataset.expandItem = item.itemId;
        expandAll.disabled = locked || itemPending;
        expandAll.addEventListener("click", () => actions.expand(v.sessionId, item.itemId, unexpanded.map((o) => o.optionId)));
        const expandHint = make("span", "fb-expand-hint", itemPending
          ? "Generating detailed explanations and HTML concept overviews live. Your draft comments stay intact."
          : "Ask the runner worker for full explanations and small HTML concept overviews on the remaining options.");
        expandBar.append(expandAll, expandHint);
        card.append(expandBar);
      }
    }

    // Footer: feedback comment box + deterministic contextual action buttons (or saved response summary)
    const foot = make("footer", "fb-card-foot");
    if (item.response) {
      const resBox = make("div", "fb-response-summary");
      const pickedLabel = item.response.pick
        ? item.options?.find((opt) => opt.optionId === item.response.pick)?.label ?? item.response.pick
        : null;
      const line = `${DECISION_LABELS[item.response.decision] || item.response.decision}${pickedLabel ? ` · ${pickedLabel}` : item.kind !== "component" ? " · Custom" : ""} · ${localTime(item.response.submittedAt)}`;
      resBox.append(make("p", "fb-response-line", line));
      if (item.response.comment) resBox.append(make("p", "fb-response-comment", item.response.comment));
      foot.append(resBox);
    } else {
      const draft = getDraft(item.itemId);
      const commentLabel = make("label", "fb-comment-label");
      commentLabel.append(make("span", "", "Feedback comment"));
      const textarea = make("textarea");
      textarea.rows = 2;
      textarea.maxLength = TEXT_MAX;
      textarea.dataset.fbComment = item.itemId;
      textarea.placeholder = item.kind === "component"
        ? "Optional for Accept; required for Another round."
        : "Optional comment, or required when choosing Custom / another direction.";
      textarea.value = draft.comment ?? "";
      textarea.readOnly = locked;
      textarea.addEventListener("input", () => {
        getDraft(item.itemId).comment = textarea.value;
        saveDrafts();
        refreshControls();
      });
      commentLabel.append(textarea);
      foot.append(commentLabel);

      const openCount = v.items.filter((entry) => entry.status === "open" && !entry.response).length;
      if (item.kind === "component" && openCount > 1) {
        const includeLabel = make("label", "fb-batch-include");
        const checkbox = make("input");
        checkbox.type = "checkbox";
        checkbox.checked = Boolean(draft.includeBatch);
        checkbox.disabled = locked;
        checkbox.dataset.fbBatchInclude = item.itemId;
        checkbox.addEventListener("change", () => {
          getDraft(item.itemId).includeBatch = checkbox.checked;
          saveDrafts();
          refreshControls();
        });
        includeLabel.append(checkbox, make("span", "", "Include in Submit all ready"));
        foot.append(includeLabel);
      }

      const actionRow = make("div", "fb-action-row");
      const buttons = ACTION_BUTTONS[item.actions] || ACTION_BUTTONS["submit-revise"];
      const hint = make("span", "fb-action-hint");
      hint.dataset.fbHint = item.itemId;
      for (const spec of buttons) {
        const btn = make("button", spec.primary ? "btn-primary fb-act-btn" : "btn-ghost fb-act-btn", spec.label);
        btn.type = "button";
        btn.dataset.fbAction = `${item.itemId}:${spec.decision}`;
        btn.dataset.decision = spec.decision;
        btn.dataset.itemId = item.itemId;
        btn.addEventListener("click", () => {
          const payload = makeResponsePayload(item, getDraft(item.itemId), spec.decision);
          actions.respond(v.sessionId, [payload]);
        });
        actionRow.append(btn);
      }
      actionRow.append(hint);
      foot.append(actionRow);
    }
    card.append(foot);
    return card;
  }

  function buildTree(v, opts) {
    const byId = new Map(v.items.map((item) => [item.itemId, item]));
    const children = new Map();
    const roots = [];
    for (const item of v.items) {
      if (item.parentId && byId.has(item.parentId)) {
        const list = children.get(item.parentId) ?? [];
        list.push(item);
        children.set(item.parentId, list);
      } else {
        roots.push(item);
      }
    }
    const renderNode = (item) => {
      const branch = make("div", "fb-tree-node");
      branch.append(buildItemCard(v, item, opts));
      const kids = children.get(item.itemId);
      if (kids?.length) {
        const sub = make("div", "fb-tree-children");
        for (const child of kids) sub.append(renderNode(child));
        branch.append(sub);
      }
      return branch;
    };
    const tree = make("div", "fb-tree");
    for (const root of roots) tree.append(renderNode(root));
    return tree;
  }

  function buildBatchDock(v, locked) {
    const openItems = v.items.filter((item) => item.status === "open" && !item.response);
    if (openItems.length <= 1) return null;
    const dock = make("section", "fb-batch-dock");
    dock.dataset.fbBatch = "true";
    const noteLabel = make("label", "fb-batch-note");
    noteLabel.append(make("span", "", "Overall session note (optional)"));
    const noteArea = make("textarea");
    noteArea.rows = 2;
    noteArea.maxLength = TEXT_MAX;
    noteArea.placeholder = "Optional summary note sent with your batch submit.";
    noteArea.value = batchNote;
    noteArea.readOnly = locked;
    noteArea.addEventListener("input", () => {
      batchNote = noteArea.value;
      saveDrafts();
    });
    noteLabel.append(noteArea);

    const bar = make("div", "fb-batch-bar");
    const count = make("span", "fb-batch-count");
    count.dataset.fbBatchCount = "true";
    const submitAll = make("button", "btn-primary", "Submit all ready");
    submitAll.type = "button";
    submitAll.dataset.fbBatchSubmit = "true";
    submitAll.addEventListener("click", () => {
      const ready = [];
      for (const item of openItems) {
        const d = getDraft(item.itemId);
        if (batchIncluded(item, d)) ready.push(makeResponsePayload(item, d, primaryDecisionOf(item.actions)));
      }
      if (ready.length) actions.respond(v.sessionId, ready, batchNote.trim() || undefined);
    });
    const clearBtn = make("button", "btn-ghost", "Clear drafts");
    clearBtn.type = "button";
    clearBtn.disabled = locked;
    clearBtn.addEventListener("click", () => {
      drafts = Object.create(null);
      batchNote = "";
      saveDrafts();
      renderKey = "";
      render({ view: v, locked, frames: currentFrames });
    });
    bar.append(count, clearBtn, submitAll);
    dock.append(noteLabel, bar);
    return dock;
  }

  function buildReceipt(v) {
    if (!v.lastResponseRevision) return null;
    const received = v.receivedRevision >= v.lastResponseRevision && Boolean(v.receivedAt);
    const text = (!received && v.outcome)
      ? ""
      : received
        ? `The agent received your response at ${localTime(v.receivedAt)}.`
        : "Waiting for the agent to read your response.";
    if (!text) return null;
    const p = make("p", "cmp-receipt fb-receipt", text);
    p.setAttribute("role", "status");
    p.dataset.receipt = received ? "received" : "waiting";
    return p;
  }

  function buildRating(v, locked) {
    const savedRating = v.rating?.value ?? null;
    const active = ratingDraft ?? savedRating;
    const details = make("details", "cmp-rate fb-rate");
    const summary = make("summary");
    const head = make("span", "cmp-rate-head");
    const title = make("span", "", "Rate this session");
    title.id = `fb-rate-title-${v.sessionId}`;
    const pill = make("span", "cmp-rate-pill", starsLabel(savedRating));
    pill.dataset.rated = String(Boolean(savedRating));
    head.append(title, pill);
    summary.append(head);
    details.append(summary);

    const body = make("div", "cmp-rate-body");
    const row = make("div", "cmp-rate-stars-row");
    const stars = make("span", "cmp-stars");
    stars.setAttribute("role", "radiogroup");
    stars.setAttribute("aria-labelledby", title.id);
    const readout = make("span", "cmp-rate-readout", ratingDraft && ratingDraft !== savedRating ? `${starsLabel(ratingDraft)}, not saved` : starsLabel(savedRating));

    const drawStars = () => {
      const val = ratingDraft ?? savedRating;
      readout.textContent = ratingDraft && ratingDraft !== savedRating ? `${starsLabel(ratingDraft)}, not saved` : starsLabel(savedRating);
      stars.replaceChildren(...Array.from({ length: RATING_MAX }, (_, idx) => {
        const pt = idx + 1;
        const btn = make("button", `cmp-star ${pt % 2 ? "is-left" : "is-right"}${isRating(val) && pt <= val ? " is-on" : ""}`);
        btn.type = "button";
        btn.setAttribute("role", "radio");
        btn.setAttribute("aria-checked", String(pt === val));
        btn.setAttribute("aria-label", starsLabel(pt));
        btn.title = starsLabel(pt);
        btn.tabIndex = pt === (isRating(val) ? val : RATING_MIN) ? 0 : -1;
        btn.disabled = locked;
        btn.addEventListener("click", () => {
          ratingDraft = pt;
          drawStars();
          updateSaveBtn();
          stars.querySelector('[tabindex="0"]')?.focus();
        });
        return btn;
      }));
    };
    stars.addEventListener("keydown", (event) => {
      const by = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[event.key];
      if (!by || locked) return;
      event.preventDefault();
      ratingDraft = stepRating(ratingDraft ?? savedRating ?? null, by);
      drawStars();
      updateSaveBtn();
      stars.querySelector('[tabindex="0"]')?.focus();
    });

    const noteLabel = make("label", "cmp-note");
    noteLabel.append(make("span", "", "Rating note"));
    const note = make("textarea");
    note.rows = 3;
    note.maxLength = 2000;
    note.placeholder = "Optional. What was good or bad in this feedback session?";
    note.value = ratingNote;
    note.readOnly = locked;
    note.addEventListener("input", () => {
      ratingNote = note.value;
      updateSaveBtn();
    });
    noteLabel.append(note);

    const actRow = make("div", "cmp-rate-actions");
    const save = make("button", "btn-ghost fb-rate-save", "Save rating");
    save.type = "button";
    const updateSaveBtn = () => {
      const val = ratingDraft ?? savedRating;
      save.disabled = locked || !isRating(val) || (val === savedRating && !ratingNote.trim());
    };
    save.addEventListener("click", () => {
      const val = ratingDraft ?? savedRating;
      if (!isRating(val) || locked) return;
      actions.rate(v.sessionId, val, ratingNote.trim() || undefined);
    });
    drawStars();
    updateSaveBtn();
    row.append(stars, readout);
    actRow.append(save);
    body.append(row, noteLabel, actRow);
    details.append(body);
    return details;
  }

  let currentLocked = false;
  let currentFrames = "";

  function refreshControls() {
    if (!view) return;
    let readyCount = 0;
    const openItems = view.items.filter((item) => item.status === "open" && !item.response);
    for (const item of openItems) {
      const d = getDraft(item.itemId);
      const v = itemValidation(item, d);
      if (batchIncluded(item, d)) readyCount += 1;
      const card = container.querySelector(`[data-item="${item.itemId}"]`);
      if (!card) continue;
      for (const optCard of card.querySelectorAll(".fb-option")) {
        const val = optCard.dataset.option ?? CUSTOM_PICK;
        optCard.classList.toggle("is-picked", d.pick === val);
      }
      for (const btn of card.querySelectorAll("[data-fb-action]")) {
        const dec = btn.dataset.decision;
        const ok = dec === "another-round" ? v.canRevise : v.canPrimary;
        btn.disabled = currentLocked || !ok;
      }
      const hint = card.querySelector(`[data-fb-hint="${item.itemId}"]`);
      if (hint) hint.textContent = v.hint;
    }
    const countNode = container.querySelector("[data-fb-batch-count]");
    if (countNode) countNode.textContent = `${readyCount} of ${openItems.length} open items ready`;
    const batchBtn = container.querySelector("[data-fb-batch-submit]");
    if (batchBtn) batchBtn.disabled = currentLocked || readyCount === 0;
  }

  function render({ view: nextView, locked = false, frames = "" }) {
    if (closed || !nextView) return;
    currentLocked = locked;
    currentFrames = frames;
    if (nextView.sessionId !== currentSession) {
      currentSession = nextView.sessionId;
      ratingDraft = null;
      ratingNote = "";
      lastSavedRatingAt = nextView.rating?.at ?? "";
      loadDrafts(currentSession);
    } else if ((nextView.rating?.at ?? "") !== lastSavedRatingAt) {
      ratingDraft = null;
      ratingNote = "";
      lastSavedRatingAt = nextView.rating?.at ?? "";
    }
    clearSubmittedDrafts(nextView);
    view = nextView;
    const nextKey = `${structureKey(nextView, frames)}/${locked}`;
    if (nextKey === renderKey) {
      refreshControls();
      return;
    }
    renderKey = nextKey;
    const prevRateOpen = Boolean(container.querySelector(".fb-rate")?.open);
    disposeZooms();

    const parts = [];
    if (nextView.layout === "tree") {
      parts.push(buildTree(nextView, { locked, frames }));
    } else {
      const list = make("div", `fb-list fb-layout-${nextView.layout}`);
      for (const item of nextView.items) list.append(buildItemCard(nextView, item, { locked, frames }));
      parts.push(list);
    }

    const dock = buildBatchDock(nextView, locked);
    if (dock) parts.push(dock);

    if (nextView.outcome) {
      const out = make("section", "fb-outcome");
      out.append(make("h2", "", "Outcome of the agent"), make("p", "cmp-pre", nextView.outcome.summary));
      parts.push(out);
    }

    const receiptNode = buildReceipt(nextView);
    if (receiptNode) parts.push(receiptNode);

    const rateNode = buildRating(nextView, locked);
    if (prevRateOpen) rateNode.open = true;
    parts.push(rateNode);

    container.replaceChildren(...parts);
    refreshControls();
  }

  return {
    render,
    clear,
    noteDelivered(sessionId) {
      if (sessionId && sessionId !== currentSession) {
        try {
          const raw = storage()?.getItem(draftKey(sessionId));
          if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object" && parsed.note) {
              parsed.note = "";
              const hasAny = Object.values(parsed.items ?? {}).some((d) => d?.pick || d?.includeBatch || (d?.comment ?? "").trim());
              if (!hasAny) storage()?.removeItem(draftKey(sessionId));
              else storage()?.setItem(draftKey(sessionId), JSON.stringify(parsed));
            }
          }
        } catch {}
        return;
      }
      if (!batchNote) return;
      batchNote = "";
      saveDrafts();
      const noteEl = container.querySelector(".fb-batch-note textarea");
      if (noteEl) noteEl.value = "";
    },
    close() {
      closed = true;
      disposeZooms();
      container.replaceChildren();
    },
  };
}
