// The read-only stage of one history row that is not a Compare session: Core, Double, Coinflip or Trainer.
// Every value goes in as text. No record content becomes live HTML, and this view loads no candidate page.

export const TYPE_LABELS = { core: "Core", double: "Double", coinflip: "Coinflip", trainer: "Trainer", compare: "Compare" };
/** A record time in the local time of the browser, as YYYY-MM-DD HH:MM. */
export function localTime(value, fallback = "unknown") {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return fallback;
  const two = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}
const time = (value) => localTime(value);

/** The nodes of the stage for `doc`, the answer of GET /_walkr/compare/api/history/<ref>. */
export function recordNodes(doc, make) {
  const nodes = [];
  const section = (title) => { const part = make("section", "cmp-record-part"); part.append(make("h2", "", title)); nodes.push(part); return part; };
  const facts = (part, rows) => {
    const list = make("dl", "cmp-facts");
    for (const [name, value] of rows) if (value !== undefined && value !== null && value !== "") list.append(make("dt", "", name), make("dd", "", String(value)));
    part.append(list);
    return list;
  };
  const items = (part, values, line) => {
    if (!values.length) { part.append(make("p", "cmp-meta", "None.")); return; }
    const list = make("ol", "cmp-items");
    for (const value of values) { const li = make("li"); for (const node of [line(value)].flat()) li.append(node); list.append(li); }
    part.append(list);
  };
  const pre = (text) => make("pre", "cmp-pre cmp-quote", text);

  const head = section("Session");
  facts(head, [["Type", TYPE_LABELS[doc.type]], ["Computer", doc.host], ["Updated", time(doc.time)], ["State", doc.state]]);
  const live = make("p", "cmp-live");
  const where = doc.host ? ` on ${doc.host}` : "";
  if (doc.live) live.append(`Open it live${where}: `, make("code", "", doc.live));
  else if (doc.type === "coinflip") live.append(`Coinflip opens only in the shared GUI of its Pi chat${where}. An agent reads it with `, make("code", "", `walkr-coinflip session view ${doc.coinflip?.sessionId ?? "<session-id>"}`), ".");
  else live.textContent = "No command opens this record live.";
  head.append(live);
  if (doc.error) {
    head.append(make("p", "cmp-record-error", `This record is not readable (${doc.error}). The page does not change it. Preserve it before a recovery.`));
    return nodes;
  }

  if (doc.type === "core") {
    const core = doc.core;
    facts(head, [[core.kind === "url" ? "Localhost URL" : "File", core.target], ["Last update", time(core.updatedAt)],
      ["Batch", core.batch ? `${core.batch.delivered ? "Delivered to the agent" : "Waits for the agent"}, ${time(core.batch.at)}` : "None"]]);
    items(section(`Comments (${core.comments.length})`), core.comments, (c) => [
      ...(c.anchor ? [make("span", "cmp-meta", c.kind === "element" ? "Element" : "Selected text"), pre(c.anchor)] : [make("span", "cmp-meta", "No anchor text")]),
      make("p", "cmp-pre", c.feedback), make("span", "cmp-meta", time(c.at))]);
    items(section(`Edits (${core.edits.length})`), core.edits, (e) => [
      make("strong", "", e.label || e.kind), make("span", "cmp-meta", ` ${e.kind}`), make("span", "cmp-meta", "Before"), pre(e.before), make("span", "cmp-meta", "After"), pre(e.after)]);
  } else if (doc.type === "double" && doc.kind === "comparison") {
    const d = doc.double;
    facts(head, [["Comparison", d.comparisonId], ["Label", d.label], ["Mode", "Comparison of two prepared pages"], ["Revision", d.revision],
      ["Batch", d.delivery.batchId ? `${d.delivery.batchId}${d.delivery.acknowledged ? ", received by the agent" : ", waits for the agent"}` : "Not sent"]]);
    for (const pane of ["left", "right"]) {
      items(section(`${pane === "left" ? "Left" : "Right"}: ${d.panes[pane].label}`), d.panes[pane].components, (c) =>
        make("span", "", `${c.label}${c.keeper ? " · keeper" : ""}${c.deleted ? " · deleted" : ""}`));
    }
    items(section("Instruction history"), [...d.history, ...(d.comments ?? [])], (h) => make("span", "cmp-pre",
      h.comment !== undefined ? `Comment${h.label ? ` on ${h.label}` : ""}: ${h.comment}` : `${h.kind === "feedback-delete" ? "Delete with feedback" : "Delete"}: ${h.pane} ${h.label}${h.feedback ? `, ${h.feedback}` : ""}${h.undone ? " (undone)" : ""}`));
  } else if (doc.type === "double") {
    const d = doc.double;
    facts(head, [["Session", d.sessionId], ["Mode", "Shared GUI session"], ["Revision", d.revision], ["Generation", d.generation ? d.generation.attempt.status : "None"],
      ["Final page", d.final ? `${d.final.pane} pane of ${d.final.comparisonId}` : "Not yet"], ["Delivery", d.delivery]]);
    section("Brief").append(make("p", "cmp-pre", d.brief));
    items(section(`Pairs (${d.rounds.length})`), d.rounds, (r) => make("span", "cmp-pre",
      `${r.index + 1}. ${r.comparisonId}${r.outcome ? `: ${r.outcome.kind}${r.outcome.instruction ? `, "${r.outcome.instruction}"` : ""}` : ""}`));
  } else if (doc.type === "coinflip") {
    const c = doc.coinflip;
    const side = (s) => s ? `${s.description}${s.intendedDifference ? ` (${s.intendedDifference})` : ""}` : "";
    facts(head, [["Session", c.sessionId], ["Mode", "Coinflip: one winner, one challenger each round"], ["Pairs", c.pairs], ["Revision", c.revision],
      ["Winner", c.winner ? `${c.winner.side} of pair ${c.winner.pairIndex + 1}` : "None yet"],
      ["Final page", c.result ? `${c.result.side} candidate${c.submitted ? ", submitted" : ""}` : "Not yet"], ["Delivery", c.delivery]]);
    section("Brief").append(make("p", "cmp-pre", c.brief));
    if (c.pair) {
      const pair = section(`Current pair ${c.pair.index + 1}`);
      facts(pair, [["Left", side(c.pair.left)], ["Right", side(c.pair.right)]]);
      pair.append(make("p", "cmp-meta", "Candidate pages show in the shared GUI only. This page loads no candidate HTML."));
    }
    items(section(`Choices (${c.choices.length})`), c.choices, (x) => make("span", "cmp-pre",
      `${x.index + 1}. Pair ${x.pairIndex + 1}: ${x.winnerSide} won${x.note ? `, "${x.note}"` : ""}`));
    items(section(`Instructions from the prompt box (${c.steers.length})`), c.steers, (s) => make("span", "cmp-pre", `${s.index + 1}. ${s.text}`));
  } else if (doc.type === "trainer") {
    const t = doc.trainer;
    facts(head, [["Repository", `${t.repo.name}${t.repo.revision ? ` at ${t.repo.revision}` : ""}`], ["Dataset", t.dataset], ["Items", t.items],
      ["Ranking", `${t.progress.saved} of ${t.progress.groups} groups ranked, ${t.progress.leftovers} leftovers`], ["Created", time(t.createdAt)]]);
    section("Task").append(make("p", "cmp-pre", t.task));
    if (t.plan) {
      const plan = section(`Group plan, revision ${t.plan.revision}${t.plan.review ? ` (${t.plan.review})` : " (waits for review)"}`);
      plan.append(make("p", "cmp-pre", t.plan.explanation));
      items(plan, t.plan.groups, (g) => make("span", "cmp-pre", `${g.groupId}: ${g.items.map((i) => i.title).join(", ")}${g.explanation ? ` · ${g.explanation}` : ""}`));
      if (t.plan.leftovers.length) plan.append(make("p", "cmp-meta", `Leftovers: ${t.plan.leftovers.map((i) => i.title).join(", ")}`));
    }
    items(section("Ranking progress"), t.groups, (g) => make("span", "cmp-pre", `${g.groupId}: ${g.ranking ? g.ranking.map((i, n) => `${n + 1}. ${i.title}`).join("  ") : "not ranked yet"}`));
  }
  return nodes;
}
