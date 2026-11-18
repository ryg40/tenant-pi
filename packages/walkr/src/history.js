import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { isCanonicalAbsolute } from "./canonical-path.js";
import { CoinflipStore } from "./coinflip-store.js";
import { doubleArchiveRoot } from "./double-archive.js";
import { DoubleSessionStore } from "./double-session.js";
import { DoubleStore } from "./double-store.js";
import { statePath } from "./paths.js";
import { readState } from "./state.js";
import { TrainerStore, trainerRoot } from "./trainer-store.js";

/*
 * The session history of every Walkr type for one page: Core, Double, Coinflip, Trainer and Compare.
 * A source is the set of record places of one computer: the Core state file, the Double archive and the Trainer root.
 * Compare has one root for all computers. The reader uses the read functions of each store and writes nothing:
 * no record, no lock, no mode change. A record that it cannot read gives one row with an error, never a failure.
 */

export const TYPES = ["core", "double", "coinflip", "trainer", "compare"];
const HOST = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const SESSION_TIME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/;
const short = (text, max = 160) => { const line = String(text ?? "").trim().split("\n")[0]; return line.length > max ? `${line.slice(0, max - 1)}…` : line; };
const iso = (value) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? null : date.toISOString(); };
const sessionTime = (id) => { const m = SESSION_TIME.exec(id ?? ""); return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z` : null; };
const reference = (parts) => `h-${createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24)}`;
const usable = (dir) => typeof dir === "string" && isCanonicalAbsolute(dir);

/** The record places of this computer. An unset or unusable place gives no rows. */
export function localSources(env = process.env) {
  return [{ host: null, core: statePath(), archive: doubleArchiveRoot(env), trainer: trainerRoot(env) }];
}

/**
 * The record places in a mirror root: one folder for each computer, <root>/hosts/<host>/{core/state.json,double,trainer}.
 * Compare stays in <root>/sessions, so a mirror root of an older copy script keeps working.
 */
export function mirrorSources(root) {
  let names = [];
  try { names = fs.readdirSync(path.join(root, "hosts"), { withFileTypes: true }).filter((e) => e.isDirectory() && HOST.test(e.name)).map((e) => e.name).sort(); }
  catch {}
  return names.map((host) => {
    const base = path.join(root, "hosts", host);
    return { host, core: path.join(base, "core", "state.json"), archive: path.join(base, "double"), trainer: path.join(base, "trainer") };
  });
}

/** Feedback of one Core page: a comment, an edit or a batch. Core pages without feedback are not listed. */
const hasFeedback = (page, batch) => Boolean(page?.comments?.length || page?.edits?.length || batch);
const coreTitle = (page) => page.kind === "url" ? String(page.url ?? "") : path.basename(String(page.file ?? ""));

function coreState(page, batch) {
  const count = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const parts = [count(page.comments?.length ?? 0, "comment"), count(page.edits?.length ?? 0, "edit")];
  if (batch) parts.push(batch.delivered ? "batch delivered" : "batch waiting");
  return parts.join(" · ");
}

function doubleState(view) {
  return view.final ? "Final page saved" : view.status === "sent" ? "Batch sent" : view.status;
}

function coinflipState(view) {
  if (view.submitted) return "Submitted";
  if (view.status === "stopped") return "Stopped";
  return view.winner ? `${view.choices.length} ${view.choices.length === 1 ? "choice" : "choices"} · ${view.status}` : view.status;
}

/** One shell word in POSIX single quotes: a record value never becomes a second command when the owner pastes the line. */
export const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

/** The live command of a row, or null when the type has none. Each value from a record is quoted. */
export function liveCommand(row, locator) {
  const q = shellQuote;
  if (row.type === "core") return `walkr-core ${q(locator.target)}`;
  if (row.type === "double") return locator.kind === "session" ? `walkr-double session reopen ${q(locator.id)}` : `walkr-double reopen ${q(locator.id)}`;
  if (row.type === "trainer") return `walkr-trainer open ${q(locator.repo)} ${q(locator.id)}`;
  return null;
}

/**
 * A writer can replace a record while the reader has it open; one more read then sees the new version. A damaged
 * record fails the second read too. `read` goes through the archive load, which reports each failure as
 * RECOVERY_REQUIRED, so that is the only code to retry.
 */
async function readOnce(store, id) {
  try { return await store.read(id); }
  catch (error) { if (error.code !== "RECOVERY_REQUIRED") throw error; return store.read(id); }
}

/** The same race for a whole place: when a list has an entry with an error, the second list is the answer. */
async function listOnce(list) {
  const found = await list();
  return found.some((entry) => entry.error) ? list() : found;
}

/** `sources` is a function, so a mirror sees a new host folder; the default fixes the places of this computer at the start. */
export function createHistory({ compare, sources, platform = process.platform }) {
  if (!sources) { const fixed = localSources(); sources = () => fixed; }
  const locators = new Map();
  // Records that did not change since the last poll are not read again. The key of a Double or Coinflip record is
  // its place, kind and file name with the stamp (inode, mtime, size) from identities(); Trainer keeps its own map.
  const records = new Map(), trainers = new Map();

  function add(rows, row, locator) {
    row.ref = reference([row.type, locator.kind ?? "", row.host ?? "", locator.repo ?? "", locator.id ?? "", locator.file ?? ""]);
    locators.set(row.ref, { ...locator, row });
    rows.push(row);
  }
  const failed = (rows, type, host, title, error, locator) => add(rows, { type, host, title, time: null, state: `Not readable: ${error}`, error }, { ...locator, error });

  async function core(rows, source) {
    if (!usable(source.core)) return;
    const state = readState(source.core);
    if (!state) return;
    for (const [key, page] of Object.entries(state.pages)) {
      const batch = state.batches[key] ?? null;
      if (!page || typeof page !== "object" || !hasFeedback(page, batch)) continue;
      add(rows, { type: "core", host: source.host, title: coreTitle(page), time: iso(page.updatedAt), state: coreState(page, batch) },
        { source, id: key, target: page.kind === "url" ? page.url : page.file });
    }
  }

  async function archive(rows, source) {
    if (!usable(source.archive)) return;
    const kinds = [
      ["double", "comparison", new DoubleStore({ archiveDir: source.archive }), (v) => ({ title: short(v.label), state: doubleState(v) })],
      ["double", "session", new DoubleSessionStore({ archiveDir: source.archive, platform }), (v) => ({ title: short(v.brief), state: doubleState(v) })],
      ["coinflip", "session", new CoinflipStore({ archiveDir: source.archive, platform }), (v) => ({ title: short(v.brief), state: coinflipState(v) })],
    ];
    for (const [type, kind, store, describe] of kinds) {
      const place = `${source.archive}\0${type}\0${kind}`;
      const known = records.get(place) ?? new Map();
      const next = new Map();
      records.set(place, next);
      let found;
      try { found = await listOnce(() => store.identities(known)); }
      catch (error) { failed(rows, type, source.host, "The Double archive is not readable", error.code || "UNREADABLE", { source, kind }); continue; }
      for (const entry of found) {
        if (entry.error) { failed(rows, type, source.host, `Record ${entry.file.slice(0, 32)}…`, entry.error, { source, kind, file: entry.file }); continue; }
        try {
          const earlier = known.get(entry.file);
          const shown = earlier?.stamp === entry.stamp && earlier.id === entry.id ? earlier.shown : describe(await readOnce(store, entry.id));
          next.set(entry.file, { stamp: entry.stamp, id: entry.id, shown });
          add(rows, { type, host: source.host, time: entry.updatedAt, ...shown }, { source, kind, id: entry.id, store });
        } catch (error) {
          failed(rows, type, source.host, short(entry.id), error.code || "UNREADABLE", { source, kind, id: entry.id });
        }
      }
    }
  }

  async function trainer(rows, source) {
    if (!usable(source.trainer)) return;
    let found;
    const store = new TrainerStore({ root: source.trainer, platform });
    if (!trainers.has(source.trainer)) trainers.set(source.trainer, new Map());
    try { found = await listOnce(() => store.history(trainers.get(source.trainer))); }
    catch (error) { failed(rows, "trainer", source.host, "The Trainer root is not readable", error.code || "UNREADABLE", { source }); return; }
    for (const entry of found) {
      if (entry.error) { failed(rows, "trainer", source.host, `${entry.repo} ${entry.sessionId ?? ""}`.trim(), entry.error, { source, repo: entry.repo, id: entry.sessionId }); continue; }
      add(rows, { type: "trainer", host: source.host, title: short(entry.task), time: iso(entry.createdAt), repo: entry.repo,
        state: `${entry.status} · ${entry.progress.saved} of ${entry.progress.groups} groups ranked` }, { source, repo: entry.repo, id: entry.sessionId, store });
    }
  }

  async function compareRows(rows) {
    let found;
    try { found = await compare().history(); }
    catch (error) { failed(rows, "compare", null, "The Compare root is not readable", error.code || "UNREADABLE", {}); return; }
    for (const entry of found) {
      if (entry.error) { failed(rows, "compare", null, entry.sessionId, entry.error, { id: entry.sessionId }); continue; }
      // A Compare row keeps the Compare summary: the page reads, picks and rates it through the Compare API.
      rows.push({ ...entry, ref: entry.sessionId, type: "compare", host: null, time: entry.createdAt });
    }
  }

  /** Every row, newest first. A row has a ref, a type, a host (null on this computer), a title, a time and a state. */
  async function list() {
    const rows = [];
    locators.clear();
    for (const source of sources()) {
      for (const read of [core, archive, trainer]) {
        try { await read(rows, source); }
        catch (error) { failed(rows, "core", source.host, "A record place is not readable", error.code || "UNREADABLE", { source }); }
      }
    }
    await compareRows(rows);
    rows.sort((a, b) => String(b.time ?? sessionTime(b.sessionId) ?? "").localeCompare(String(a.time ?? sessionTime(a.sessionId) ?? "")));
    return { rows, hosts: [...new Set(rows.map((row) => row.host).filter(Boolean))].sort() };
  }

  /** The read-only view of one row that is not a Compare session, in the format of its type. */
  async function read(ref) {
    if (!locators.has(ref)) await list();
    const locator = locators.get(ref);
    if (!locator) return null;
    const { row } = locator;
    const base = { ref, type: row.type, host: row.host, title: row.title, time: row.time, state: row.state, live: null };
    if (locator.error) return { ...base, error: locator.error };
    base.live = liveCommand(row, locator);
    try {
      if (row.type === "core") {
        const state = readState(locator.source.core);
        const page = state?.pages[locator.id];
        if (!page) return { ...base, error: "NOT_FOUND" };
        const batch = state.batches[locator.id];
        return { ...base, core: {
          target: locator.target, kind: page.kind === "url" ? "url" : "file", updatedAt: iso(page.updatedAt),
          comments: (page.comments ?? []).map((c) => ({ kind: c.kind, anchor: String(c.quote || c.anchor?.quote || ""), feedback: String(c.feedback ?? ""), at: iso(c.createdAt) })),
          edits: (page.edits ?? []).map((e) => ({ kind: e.kind, label: String(e.label ?? ""), before: String(e.before ?? ""), after: String(e.after ?? "") })),
          batch: batch ? { delivered: Boolean(batch.delivered), at: iso(batch.updatedAt) } : null,
        } };
      }
      if (row.type === "trainer") {
        const view = await locator.store.read(locator.repo, locator.id);
        const titles = Object.fromEntries(view.items.map((item) => [item.sourceId, item.title]));
        const plan = view.plans.at(-1);
        const named = (sourceId) => ({ sourceId, title: titles[sourceId] ?? sourceId });
        return { ...base, trainer: {
          repo: view.repo, dataset: view.sessionId, task: view.task, status: view.status, createdAt: view.createdAt, updatedAt: view.updatedAt,
          items: view.items.length, progress: view.progress,
          plan: plan ? { revision: plan.revision, explanation: plan.explanation, review: plan.review?.decision ?? null,
            groups: plan.groups.map((g) => ({ groupId: g.groupId, explanation: g.explanation, items: g.sourceIds.map(named) })), leftovers: plan.leftovers.map(named) } : null,
          groups: view.groups.map((g) => {
            const source = Object.fromEntries(g.candidates.map((c) => [c.candidateId, c.sourceId]));
            return { groupId: g.groupId, ranking: g.vote ? g.vote.ranking.map((id) => named(source[id])) : null };
          }),
        } };
      }
      const view = await readOnce(locator.store, locator.id);
      const { gui, ...shown } = view; // The chat binding of the shared GUI is not part of the history.
      return { ...base, kind: locator.kind, [row.type]: shown };
    } catch (error) {
      return { ...base, error: error.code || "UNREADABLE" };
    }
  }

  return { list, read };
}
