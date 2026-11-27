import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { canonical, capture, fail, hash, id, inspect, readBytes } from "./store-files.js";
import { isCanonicalAbsolute } from "./canonical-path.js";
import { POSIX_ONLY_CODE, posixOnlyRefusal } from "./posix-only.js";
import { RATING_MAX, RATING_MIN } from "./compare-stars.js";

export const SCHEMA = "walkr-feedback-session";
export const VERSION = 1;
const RECORD = "session.json";
const SESSION = /^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$/;
const WORKFLOW = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const FORMATS = new Set(["html", "text", "markdown"]);

export const KINDS = Object.freeze(["component", "decision", "grill"]);
export const LAYOUTS = Object.freeze(["single", "list", "tree"]);
export const ITEM_STATUS = Object.freeze(["open", "settled", "skipped"]);
export const ACTIONS = Object.freeze({
  "accept-revise": Object.freeze(["accept", "another-round"]),
  "submit-revise": Object.freeze(["submit", "another-round"]),
  "accept-only": Object.freeze(["accept"]),
  "submit-only": Object.freeze(["submit"]),
});
export const LIMITS = Object.freeze({
  items: [1, 12],
  options: [2, 3],
  content: 1024 * 1024,
  overview: 256 * 1024,
  text: 8000,
  prompt: 4000,
  summary: 2000,
  settledAnswer: 500,
  short: 200,
  branch: 120,
  clarifications: 12,
  rounds: 20,
});

const queues = new Map();

/** The configured Feedback root, by default ~/.local/.walkr/feedback. Tests and trials set HUMAN_REVIEW_FEEDBACK_ROOT. */
export function feedbackRoot(env = process.env, home = os.homedir()) {
  return env.HUMAN_REVIEW_FEEDBACK_ROOT || path.join(home, ".local", ".walkr", "feedback");
}

export function sessionName(value) {
  if (typeof value !== "string" || !SESSION.test(value)) fail("INVALID_ID", "Unknown Feedback session ID format.");
  return value;
}

function shape(value, required, optional = []) {
  const ok = value !== null && typeof value === "object" && !Array.isArray(value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
  if (!ok) fail("INVALID_REQUEST", `Expected fields ${required.join(", ")}${optional.length ? ` and optional ${optional.join(", ")}` : ""}.`);
  return value;
}

function text(value, name, { max = LIMITS.text, optional = false, empty = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > max) {
    fail("INVALID_REQUEST", `${name} must be ${empty ? "a" : "a nonempty"} string of at most ${max} characters.`);
  }
  return value;
}

function shortId(value, name) {
  id(value);
  if (value.length > LIMITS.short) fail("INVALID_ID", `${name} must be at most ${LIMITS.short} characters.`);
  return value;
}

function tokenId(value, name) {
  shortId(value, name);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
    fail("INVALID_ID", `${name} uses 1-64 letters, digits, dots, underscores or hyphens.`);
  }
  return value;
}

function contentBlock(value, name, max = LIMITS.content) {
  shape(value, ["format", "content"]);
  if (!FORMATS.has(value.format)) fail("INVALID_REQUEST", `${name} format must be html, text or markdown.`);
  if (typeof value.content !== "string" || !value.content.trim() || Buffer.byteLength(value.content) > max) {
    fail("INVALID_REQUEST", `${name} content must be a nonempty string of at most ${max} bytes.`);
  }
  return { format: value.format, content: value.content, contentSha256: hash(value.content) };
}

function stamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.[0-9]{3}Z$/, "Z");
}

const now = () => new Date().toISOString();

function receipt(prior, requestSha256) {
  if (prior.requestSha256 !== requestSha256) fail("ACTION_CONFLICT", "A different request already owns this action ID.");
}

function normalizeOption(option) {
  shape(option, ["optionId", "label"], ["summary", "explanation", "overview", "expandable"]);
  tokenId(option.optionId, "optionId");
  const saved = { optionId: option.optionId, label: text(option.label, "Option label", { max: LIMITS.short }) };
  if (option.summary !== undefined) saved.summary = text(option.summary, "Option summary", { max: LIMITS.summary });
  if (option.explanation !== undefined) saved.explanation = text(option.explanation, "Option explanation", { max: LIMITS.text });
  if (option.overview !== undefined) saved.overview = contentBlock(option.overview, "Option overview", LIMITS.overview);
  if (option.expandable !== undefined && typeof option.expandable !== "boolean") {
    fail("INVALID_REQUEST", "Option expandable must be true or false.");
  }
  const hasDetail = Boolean(saved.overview || saved.explanation);
  saved.expanded = Boolean(saved.overview || (saved.explanation && !option.expandable));
  saved.expandable = option.expandable === true && !saved.expanded;
  if (option.expandable === true && saved.overview) {
    fail("INVALID_REQUEST", `Option ${option.optionId} cannot be expandable when it already has an overview.`);
  }
  if (!hasDetail && saved.summary === undefined && !saved.expandable) {
    saved.summary = saved.label;
  }
  return saved;
}

function normalizeItem(item) {
  shape(
    item,
    ["itemId", "kind", "title"],
    ["summary", "parentId", "branchLabel", "status", "settledAnswer", "actions", "prompt", "explanation", "preview", "options", "recommended"],
  );
  tokenId(item.itemId, "itemId");
  if (!KINDS.includes(item.kind)) fail("INVALID_REQUEST", `Item kind must be one of ${KINDS.join(", ")}.`);
  const status = item.status ?? "open";
  if (!ITEM_STATUS.includes(status)) fail("INVALID_REQUEST", `Item status must be one of ${ITEM_STATUS.join(", ")}.`);
  const actions = item.actions ?? (item.kind === "component" ? "accept-revise" : "submit-revise");
  if (!Object.hasOwn(ACTIONS, actions)) fail("INVALID_REQUEST", `Item actions must be one of ${Object.keys(ACTIONS).join(", ")}.`);

  const saved = {
    itemId: item.itemId,
    kind: item.kind,
    title: text(item.title, "Item title", { max: LIMITS.short }),
    status,
    actions,
  };
  if (item.summary !== undefined) saved.summary = text(item.summary, "Item summary", { max: LIMITS.summary });
  if (item.parentId !== undefined) saved.parentId = tokenId(item.parentId, "parentId");
  if (item.branchLabel !== undefined) saved.branchLabel = text(item.branchLabel, "Branch label", { max: LIMITS.branch });
  if (status === "settled") {
    saved.settledAnswer = text(item.settledAnswer, "Settled answer", { max: LIMITS.settledAnswer });
  } else if (item.settledAnswer !== undefined) {
    fail("INVALID_REQUEST", "settledAnswer is only valid when status is settled.");
  }

  if (item.kind === "component") {
    if (item.options !== undefined || item.recommended !== undefined || item.prompt !== undefined) {
      fail("INVALID_REQUEST", "A component item takes preview and optional explanation, not options, recommended or prompt.");
    }
    if (item.explanation !== undefined) saved.explanation = text(item.explanation, "Component explanation", { max: LIMITS.text });
    if (item.preview !== undefined) saved.preview = contentBlock(item.preview, "Component preview", LIMITS.content);
    else if (status === "open") fail("INVALID_REQUEST", "An open component item requires preview.");
  } else {
    if (item.preview !== undefined) fail("INVALID_REQUEST", "A decision or grill item puts visual sketches in option.overview, not item.preview.");
    if (item.prompt !== undefined) saved.prompt = text(item.prompt, "Item prompt", { max: LIMITS.prompt });
    if (item.explanation !== undefined) saved.explanation = text(item.explanation, "Item explanation", { max: LIMITS.text });
    if (item.options !== undefined) {
      const [min, max] = LIMITS.options;
      if (!Array.isArray(item.options) || item.options.length < min || item.options.length > max) {
        fail("INVALID_REQUEST", `Supply ${min} or ${max} options for item ${item.itemId}.`);
      }
      const ids = new Set();
      const fingerprints = new Set();
      saved.options = item.options.map((raw) => {
        const opt = normalizeOption(raw);
        if (ids.has(opt.optionId)) fail("INVALID_REQUEST", `Duplicate optionId ${opt.optionId} in item ${item.itemId}.`);
        ids.add(opt.optionId);
        const fp = hash(canonical({ label: opt.label, summary: opt.summary ?? "", explanation: opt.explanation ?? "", overview: opt.overview?.contentSha256 ?? "" }));
        if (fingerprints.has(fp)) fail("INVALID_REQUEST", `Two options of item ${item.itemId} have identical content.`);
        fingerprints.add(fp);
        return opt;
      });
      if (item.recommended !== undefined) {
        if (typeof item.recommended !== "string" || !ids.has(item.recommended)) {
          fail("INVALID_REQUEST", `recommended for item ${item.itemId} must name one optionId of that item.`);
        }
        saved.recommended = item.recommended;
      }
    } else if (status === "open") {
      fail("INVALID_REQUEST", `Open ${item.kind} item ${item.itemId} requires 2 or 3 options.`);
    } else if (item.recommended !== undefined) {
      fail("INVALID_REQUEST", `recommended for item ${item.itemId} requires options.`);
    }
  }
  saved.response = null;
  return saved;
}

function checkTree(items) {
  const byId = new Map();
  for (const item of items) {
    if (byId.has(item.itemId)) fail("INVALID_REQUEST", `Each item needs a unique itemId (${item.itemId}).`);
    byId.set(item.itemId, item);
  }
  for (const item of items) {
    if (item.parentId === undefined) continue;
    if (item.parentId === item.itemId || !byId.has(item.parentId)) {
      fail("INVALID_REQUEST", `parentId ${item.parentId} of item ${item.itemId} must name another item of this session.`);
    }
  }
  const state = new Map();
  const visit = (itemId) => {
    const mark = state.get(itemId);
    if (mark === "done") return;
    if (mark === "open") fail("INVALID_REQUEST", `Decision tree contains a cycle through item ${itemId}.`);
    state.set(itemId, "open");
    const parent = byId.get(itemId).parentId;
    if (parent !== undefined) visit(parent);
    state.set(itemId, "done");
  };
  for (const item of items) visit(item.itemId);
}

function normalizeCreate(body) {
  shape(body, ["actionId", "workflow", "title", "brief", "items"], ["layout", "clarifications", "repo", "previous"]);
  shortId(body.actionId, "actionId");
  if (typeof body.workflow !== "string" || !WORKFLOW.test(body.workflow)) {
    fail("INVALID_REQUEST", "workflow uses 1-64 lowercase letters, digits or hyphens, and starts with a letter or digit.");
  }
  const out = {
    workflow: body.workflow,
    title: text(body.title, "Title", { max: LIMITS.short }),
    brief: text(body.brief, "Brief"),
  };
  if (body.repo !== undefined) {
    shape(body.repo, ["name"], ["revision"]);
    if (typeof body.repo.name !== "string" || !REPO.test(body.repo.name)) {
      fail("INVALID_REQUEST", "repo.name uses 1-100 letters, digits, dots, underscores or hyphens.");
    }
    out.repo = { name: body.repo.name };
    if (body.repo.revision !== undefined) out.repo.revision = text(body.repo.revision, "Repository revision", { max: LIMITS.short });
  }
  out.clarifications = [];
  if (body.clarifications !== undefined) {
    if (!Array.isArray(body.clarifications) || body.clarifications.length > LIMITS.clarifications) {
      fail("INVALID_REQUEST", `Supply at most ${LIMITS.clarifications} clarifications.`);
    }
    out.clarifications = body.clarifications.map((item) => {
      shape(item, ["question", "answer"]);
      return {
        question: text(item.question, "Clarification question", { max: LIMITS.summary }),
        answer: text(item.answer, "Clarification answer", { max: LIMITS.summary }),
      };
    });
  }
  const [minItems, maxItems] = LIMITS.items;
  if (!Array.isArray(body.items) || body.items.length < minItems || body.items.length > maxItems) {
    fail("INVALID_REQUEST", `Supply between ${minItems} and ${maxItems} items.`);
  }
  out.items = body.items.map(normalizeItem);
  checkTree(out.items);
  if (!out.items.some((item) => item.status === "open")) {
    fail("INVALID_REQUEST", "At least one feedback item must have status open.");
  }
  const hasTree = out.items.some((item) => item.parentId !== undefined);
  out.layout = body.layout ?? (hasTree ? "tree" : out.items.length === 1 ? "single" : "list");
  if (!LAYOUTS.includes(out.layout)) fail("INVALID_REQUEST", `layout must be one of ${LAYOUTS.join(", ")}.`);

  if (body.previous !== undefined) {
    shape(body.previous, ["sessionId"]);
    if (typeof body.previous.sessionId !== "string" || !SESSION.test(body.previous.sessionId)) {
      fail("INVALID_REQUEST", "previous.sessionId must be a Feedback session ID.");
    }
    out.previous = { sessionId: body.previous.sessionId };
  }
  return out;
}

function nextRoundOf(previous, docs) {
  const earlier = docs.find((doc) => doc.sessionId === previous.sessionId);
  if (!earlier) fail("INVALID_REQUEST", "previous.sessionId names no Feedback session of this root.");
  if (!earlier.items.some((item) => item.response !== null)) {
    fail("INVALID_REQUEST", "previous.sessionId names a session without any submitted response. Wait for a response first.");
  }
  const round = (earlier.round ?? 1) + 1;
  if (round > LIMITS.rounds) fail("INVALID_REQUEST", `A chain of linked Feedback sessions has at most ${LIMITS.rounds} rounds.`);
  return round;
}

/**
 * Durable Feedback sessions: one record per session under <root>/sessions/<session-id>/session.json.
 * One server process owns a root. Records are replaced atomically and never deleted by this store.
 */
export class FeedbackStore {
  #root;

  constructor({ root, platform = process.platform }) {
    const refusal = posixOnlyRefusal(platform);
    if (refusal) fail(POSIX_ONLY_CODE, refusal);
    if (!isCanonicalAbsolute(root)) fail("UNSAFE_PATH", "The Feedback root must be a canonical absolute directory without traversal or a trailing slash.");
    this.#root = root;
  }

  get root() { return this.#root; }

  run(work) {
    const prior = queues.get(this.#root) || Promise.resolve();
    const next = prior.catch(() => {}).then(work);
    queues.set(this.#root, next);
    const release = () => { if (queues.get(this.#root) === next) queues.delete(this.#root); };
    next.then(release, release);
    return next;
  }

  #sessionsDir() { return path.join(this.#root, "sessions"); }
  #sessionDir(sessionId) { return path.join(this.#sessionsDir(), sessionName(sessionId)); }

  async #ensureRoot(create) {
    const missing = [];
    let current = this.#root;
    for (;;) {
      try { await fs.lstat(current); break; }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        if (!create) fail("NOT_FOUND", "The Feedback root does not exist yet.");
        missing.unshift(current);
        current = path.dirname(current);
      }
    }
    await inspect(current, true);
    for (const dir of missing) await fs.mkdir(dir, { mode: 0o700 });
    const stat = await inspect(this.#root, true);
    if (stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o022n)) {
      fail("UNSAFE_PATH", "The Feedback root must belong to the current user and must not be group or world writable.");
    }
  }

  async #privateDir(dir) {
    try { await inspect(dir, true, true); return; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await fs.mkdir(dir, { mode: 0o700 });
    await inspect(dir, true, true);
  }

  async #syncDir(dir) {
    const handle = await fs.open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
  }

  async #confirm(...dirs) {
    try { for (const dir of dirs) await this.#syncDir(dir); }
    catch (error) { fail("COMMIT_UNCERTAIN", "The save is not confirmed on disk. Retry the exact original request and action ID.", { reason: error.code || "UNKNOWN" }); }
  }

  async #load(sessionId) {
    const dir = this.#sessionDir(sessionId);
    let bytes;
    try {
      await this.#ensureRoot(false);
      for (const part of [this.#sessionsDir(), dir]) await inspect(part, true, true);
      bytes = await readBytes(path.join(dir, RECORD), true);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "NOT_FOUND") fail("NOT_FOUND", "The Feedback session does not exist.");
      throw error;
    }
    let doc;
    try {
      const { checksum, ...rest } = JSON.parse(bytes.toString("utf8"));
      if (checksum !== hash(JSON.stringify(rest))) throw new Error();
      doc = rest;
    } catch { fail("RECOVERY_REQUIRED", "The Feedback record failed its checksum. Preserve it before recovery."); }
    if (doc.schema !== SCHEMA || doc.version !== VERSION || doc.sessionId !== sessionId) {
      fail("RECOVERY_REQUIRED", "The Feedback record has an unknown schema or identity. Preserve it before recovery.");
    }
    return { doc, bytes, dir };
  }

  async #commit(dir, doc, previous) {
    const file = path.join(dir, RECORD);
    const temporary = path.join(dir, `.session-${randomUUID()}.tmp`);
    let owned = false, replacing = false, handle;
    try {
      handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      owned = true;
      await handle.writeFile(`${JSON.stringify({ ...doc, checksum: hash(JSON.stringify(doc)) })}\n`);
      await handle.sync();
      await handle.close();
      handle = null;
      await inspect(dir, true, true);
      let current = null;
      try { current = await readBytes(file, true); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (previous === null ? current !== null : current === null || !current.equals(previous)) {
        fail("RECOVERY_REQUIRED", "The Feedback record changed outside this writer. Preserve it before recovery.");
      }
      replacing = true;
      await fs.rename(temporary, file);
      owned = false;
      await this.#syncDir(dir);
    } catch (error) {
      if (replacing) fail("COMMIT_UNCERTAIN", "The save may have committed. Retry the exact original request and action ID.", { reason: error.code || "UNKNOWN" });
      if (error.name === "StoreError") throw error;
      fail("WRITE_FAILED", "The Feedback record was not replaced. Retry the exact original request.", { fsCode: error.code || "UNKNOWN" });
    } finally {
      if (handle) await handle.close().catch(() => {});
      if (owned) await fs.unlink(temporary).catch(() => {});
    }
  }

  #mutate(sessionId, change) {
    return this.run(async () => {
      const { doc, bytes, dir } = await this.#load(sessionId);
      const next = structuredClone(doc);
      const result = change(next);
      if (result.replay) { await this.#confirm(dir); return { result: result.value, view: view(doc) }; }
      next.revision += 1;
      next.updatedAt = now();
      if (result.onCommit) result.onCommit(next);
      await this.#commit(dir, next, bytes);
      return { result: result.value, view: view(next) };
    });
  }

  async #sessions() {
    let names;
    try {
      await this.#ensureRoot(false);
      await inspect(this.#sessionsDir(), true, true);
      names = await fs.readdir(this.#sessionsDir());
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "NOT_FOUND") return [];
      throw error;
    }
    const docs = [];
    for (const name of names.filter((entry) => SESSION.test(entry)).sort()) {
      try { docs.push((await this.#load(name)).doc); }
      catch (error) { if (error.code !== "NOT_FOUND") throw error; }
    }
    return docs;
  }

  async list() {
    return (await this.run(() => this.#sessions())).map(summary);
  }

  async history() {
    return this.run(async () => {
      let names;
      try {
        await this.#ensureRoot(false);
        await inspect(this.#sessionsDir(), true, true);
        names = await fs.readdir(this.#sessionsDir());
      } catch (error) {
        if (error.code === "ENOENT" || error.code === "NOT_FOUND") return [];
        throw error;
      }
      const rows = [];
      for (const name of names.filter((entry) => SESSION.test(entry)).sort()) {
        try { rows.push(summary((await this.#load(name)).doc)); }
        catch (error) { if (error.code !== "NOT_FOUND") rows.push({ sessionId: name, error: error.code || "UNREADABLE" }); }
      }
      return rows;
    });
  }

  /** Agent: create a Feedback session with 1 to 12 deterministic feedback items. */
  async create(input) {
    const body = capture(input);
    const fields = normalizeCreate(body);
    const requestSha256 = hash(canonical(body));
    return this.run(async () => {
      const docs = await this.#sessions();
      for (const doc of docs) {
        if (doc.createAction.actionId === body.actionId) {
          receipt(doc.createAction, requestSha256);
          await this.#confirm(this.#sessionDir(doc.sessionId), this.#sessionsDir());
          return { result: { sessionId: doc.sessionId, replay: true }, view: view(doc) };
        }
      }
      if (fields.previous) fields.round = nextRoundOf(fields.previous, docs);
      await this.#ensureRoot(true);
      await this.#privateDir(this.#sessionsDir());
      let sessionId, dir;
      for (let attempt = 0; !dir; attempt += 1) {
        sessionId = `${stamp()}-${randomBytes(6).toString("hex")}`;
        try {
          await fs.mkdir(this.#sessionDir(sessionId), { mode: 0o700 });
          dir = this.#sessionDir(sessionId);
        } catch (error) {
          if (error.code !== "EEXIST" || attempt >= 8) fail("WRITE_FAILED", "Could not reserve a unique Feedback session directory.", { fsCode: error.code });
        }
      }
      await inspect(dir, true, true);
      await this.#syncDir(this.#sessionsDir());
      const createdAt = now();
      const doc = {
        schema: SCHEMA, version: VERSION, sessionId, createdAt, updatedAt: createdAt, revision: 1, status: "open",
        createAction: { actionId: body.actionId, requestSha256, at: createdAt },
        ...fields,
        expandRequests: [],
        expandActions: [],
        patchActions: [],
        responseActions: [],
        lastResponseAt: null,
        lastResponseRevision: 0,
        note: null,
        receivedAt: null,
        receivedRevision: 0,
        outcome: null,
        ratings: [],
      };
      await this.#commit(dir, doc, null);
      return { result: { sessionId, replay: false }, view: view(doc) };
    });
  }

  async read(sessionId) {
    sessionName(sessionId);
    return view((await this.run(() => this.#load(sessionId))).doc);
  }

  markSeen(sessionId) {
    return this.#mutate(sessionId, (doc) => {
      if (doc.seenAt) return { replay: true, value: { seenAt: doc.seenAt, replay: true } };
      doc.seenAt = now();
      return { value: { seenAt: doc.seenAt, replay: false } };
    });
  }

  /** Owner: request lazy on-demand expansion of options (such as options 2 and 3) from the waiting runner worker. */
  requestExpand(sessionId, input) {
    const body = capture(input);
    shape(body, ["actionId", "itemId"], ["optionIds"]);
    shortId(body.actionId, "actionId");
    tokenId(body.itemId, "itemId");
    const requestSha256 = hash(canonical(body));
    return this.#mutate(sessionId, (doc) => {
      const actions = (doc.expandActions ??= []);
      const priorAction = actions.find((entry) => entry.actionId === body.actionId);
      if (priorAction) {
        receipt(priorAction, requestSha256);
        const linked = doc.expandRequests.find((entry) => entry.actionId === priorAction.expandId) ?? priorAction;
        return { replay: true, value: { expand: linked, replay: true } };
      }
      const priorReq = doc.expandRequests.find((entry) => entry.actionId === body.actionId);
      if (priorReq) {
        receipt(priorReq, requestSha256);
        return { replay: true, value: { expand: priorReq, replay: true } };
      }
      const item = doc.items.find((entry) => entry.itemId === body.itemId);
      if (!item) fail("NOT_FOUND", `Item ${body.itemId} does not exist in this session.`);
      if (item.status !== "open" || item.response) fail("INVALID_TRANSITION", `Item ${body.itemId} is already closed.`);
      if (item.kind === "component" || !item.options?.length) fail("INVALID_REQUEST", `Item ${body.itemId} has no expandable options.`);
      let targets;
      if (body.optionIds !== undefined) {
        if (!Array.isArray(body.optionIds) || !body.optionIds.length) {
          fail("INVALID_REQUEST", "optionIds must be a nonempty array of option IDs.");
        }
        const unique = [...new Set(body.optionIds)];
        for (const optId of unique) {
          const opt = item.options.find((entry) => entry.optionId === optId);
          if (!opt) fail("INVALID_REQUEST", `Unknown optionId ${optId} on item ${body.itemId}.`);
          if (!opt.expandable || opt.expanded) fail("INVALID_TRANSITION", `Option ${optId} on item ${body.itemId} is not awaiting expansion.`);
        }
        targets = unique;
      } else {
        targets = item.options.filter((opt) => opt.expandable && !opt.expanded).map((opt) => opt.optionId);
        if (!targets.length) fail("INVALID_TRANSITION", `Item ${body.itemId} has no unexpanded options.`);
      }
      const at = now();
      // If a pending request already covers every requested option, share that work item while persisting this action receipt.
      const existing = doc.expandRequests.find((entry) => entry.itemId === body.itemId && entry.status === "pending" &&
        targets.every((optId) => entry.optionIds.includes(optId)));
      if (existing) {
        actions.push({ actionId: body.actionId, requestSha256, itemId: body.itemId, optionIds: targets, expandId: existing.actionId, at });
        return { value: { expand: existing, replay: false, coalesced: true } };
      }
      const created = {
        actionId: body.actionId,
        requestSha256,
        itemId: body.itemId,
        optionIds: targets,
        status: "pending",
        requestedAt: at,
      };
      doc.expandRequests.push(created);
      actions.push({ actionId: body.actionId, requestSha256, itemId: body.itemId, optionIds: targets, expandId: created.actionId, at });
      return { value: { expand: created, replay: false } };
    });
  }

  /** Agent (runner worker): fulfill a pending Expand request with rich explanations and small HTML/text concept overviews. */
  patchExpand(sessionId, input) {
    const body = capture(input);
    shape(body, ["actionId", "itemId", "options"]);
    shortId(body.actionId, "actionId");
    tokenId(body.itemId, "itemId");
    const requestSha256 = hash(canonical(body));
    return this.#mutate(sessionId, (doc) => {
      const prior = doc.patchActions.find((entry) => entry.actionId === body.actionId);
      if (prior) {
        receipt(prior, requestSha256);
        return { replay: true, value: { patched: prior.optionIds, replay: true } };
      }
      const item = doc.items.find((entry) => entry.itemId === body.itemId);
      if (!item) fail("NOT_FOUND", `Item ${body.itemId} does not exist in this session.`);
      if (item.kind === "component" || !item.options?.length) fail("INVALID_REQUEST", `Item ${body.itemId} has no options to patch.`);
      if (item.status !== "open" || item.response !== null) {
        fail("INVALID_TRANSITION", `Item ${body.itemId} is already answered or closed and cannot be patched.`);
      }
      if (!Array.isArray(body.options) || !body.options.length) {
        fail("INVALID_REQUEST", "Supply a nonempty options list to patch.");
      }
      const pendingOptionIds = new Set(
        doc.expandRequests
          .filter((req) => req.itemId === body.itemId && req.status === "pending")
          .flatMap((req) => req.optionIds),
      );
      const seen = new Set();
      const normalized = body.options.map((raw) => {
        shape(raw, ["optionId"], ["explanation", "overview"]);
        tokenId(raw.optionId, "optionId");
        if (seen.has(raw.optionId)) fail("INVALID_REQUEST", `Duplicate optionId ${raw.optionId} in patch.`);
        seen.add(raw.optionId);
        if (raw.explanation === undefined && raw.overview === undefined) {
          fail("INVALID_REQUEST", `Patch for option ${raw.optionId} must supply explanation, overview, or both.`);
        }
        const target = item.options.find((opt) => opt.optionId === raw.optionId);
        if (!target) fail("INVALID_REQUEST", `Unknown optionId ${raw.optionId} on item ${body.itemId}.`);
        if (!pendingOptionIds.has(raw.optionId) || !target.expandable || target.expanded) {
          fail("INVALID_TRANSITION", `Option ${raw.optionId} on item ${body.itemId} has no pending expand request.`);
        }
        return {
          optionId: raw.optionId,
          ...(raw.explanation !== undefined ? { explanation: text(raw.explanation, "Option explanation", { max: LIMITS.text }) } : {}),
          ...(raw.overview !== undefined ? { overview: contentBlock(raw.overview, "Option overview", LIMITS.overview) } : {}),
        };
      });
      const at = now();
      for (const patch of normalized) {
        const target = item.options.find((opt) => opt.optionId === patch.optionId);
        if (patch.explanation !== undefined) target.explanation = patch.explanation;
        if (patch.overview !== undefined) target.overview = patch.overview;
        target.expanded = true;
        target.expandable = false;
        target.expandedAt = at;
      }
      for (const req of doc.expandRequests) {
        if (req.itemId !== body.itemId || req.status !== "pending") continue;
        const allDone = req.optionIds.every((optId) => item.options.find((opt) => opt.optionId === optId)?.expanded);
        if (allDone) {
          req.status = "fulfilled";
          req.fulfilledAt = at;
        }
      }
      const patchedIds = normalized.map((entry) => entry.optionId);
      doc.patchActions.push({ actionId: body.actionId, requestSha256, itemId: body.itemId, optionIds: patchedIds, at });
      return { value: { patched: patchedIds, replay: false } };
    });
  }

  /** Owner: submit one item response or a batch of item responses. The first saved response for each item is final. */
  respond(sessionId, input) {
    const body = capture(input);
    shape(body, ["actionId", "responses"], ["note"]);
    shortId(body.actionId, "actionId");
    const requestSha256 = hash(canonical(body));
    return this.#mutate(sessionId, (doc) => {
      const prior = doc.responseActions.find((entry) => entry.actionId === body.actionId);
      if (prior) {
        receipt(prior, requestSha256);
        return { replay: true, value: { outcome: "submitted", replay: true, itemIds: prior.itemIds, status: doc.status } };
      }
      if (!Array.isArray(body.responses) || !body.responses.length) {
        fail("INVALID_REQUEST", "Supply at least one item response.");
      }
      const note = text(body.note, "Note", { optional: true, empty: true });
      const seen = new Set();
      const validated = [];
      let alreadyAnswered = 0;
      for (const raw of body.responses) {
        shape(raw, ["itemId", "decision"], ["pick", "comment"]);
        tokenId(raw.itemId, "itemId");
        if (seen.has(raw.itemId)) fail("INVALID_REQUEST", `Duplicate response for item ${raw.itemId}.`);
        seen.add(raw.itemId);
        const item = doc.items.find((entry) => entry.itemId === raw.itemId);
        if (!item) fail("NOT_FOUND", `Item ${raw.itemId} does not exist in this session.`);
        if (item.status !== "open") fail("INVALID_TRANSITION", `Item ${raw.itemId} is ${item.status} and cannot accept a response.`);
        if (item.response) { alreadyAnswered += 1; continue; }
        const allowed = ACTIONS[item.actions];
        if (!allowed.includes(raw.decision)) {
          fail("INVALID_REQUEST", `Decision ${raw.decision} is not allowed for item ${raw.itemId} (allowed: ${allowed.join(", ")}).`);
        }
        const comment = text(raw.comment, "Comment", { optional: true, empty: true });
        const hasComment = Boolean(comment?.trim());
        let pick = null;
        if (item.kind === "component") {
          if (raw.pick !== undefined && raw.pick !== null) {
            fail("INVALID_REQUEST", `Component item ${raw.itemId} takes no option pick.`);
          }
          if (raw.decision === "another-round" && !hasComment) {
            fail("INVALID_REQUEST", `Write a comment explaining what to change before requesting another round on ${raw.itemId}.`);
          }
        } else {
          const validPick = typeof raw.pick === "string" && item.options.some((opt) => opt.optionId === raw.pick);
          if (raw.pick !== undefined && raw.pick !== null && !validPick) {
            fail("INVALID_REQUEST", `pick for item ${raw.itemId} must name one option of that item, or null.`);
          }
          pick = validPick ? raw.pick : null;
          if (raw.decision === "another-round") {
            if (!pick && !hasComment) {
              fail("INVALID_REQUEST", `Select an option or write a comment before requesting another round on ${raw.itemId}.`);
            }
          } else if (!pick && !hasComment) {
            fail("INVALID_REQUEST", `Pick an option or write a custom comment for item ${raw.itemId}.`);
          }
        }
        validated.push({ item, decision: raw.decision, pick, comment: hasComment ? comment : undefined });
      }
      if (!validated.length && alreadyAnswered === body.responses.length) {
        return { replay: true, value: { outcome: "already-submitted", replay: true, itemIds: [], status: doc.status } };
      }
      if (alreadyAnswered > 0) {
        fail("INVALID_TRANSITION", "One or more selected items already have a submitted response.");
      }
      const at = now();
      const itemIds = [];
      for (const entry of validated) {
        entry.item.response = {
          actionId: body.actionId,
          decision: entry.decision,
          ...(entry.item.kind !== "component" ? { pick: entry.pick } : {}),
          ...(entry.comment !== undefined ? { comment: entry.comment } : {}),
          submittedAt: at,
        };
        // Fulfill/cancel any stale pending expand on an item that the owner already decided.
        for (const req of doc.expandRequests) {
          if (req.itemId === entry.item.itemId && req.status === "pending") {
            req.status = "cancelled";
            req.fulfilledAt = at;
          }
        }
        itemIds.push(entry.item.itemId);
      }
      if (note?.trim()) doc.note = doc.note ? `${doc.note}\n\n${note}` : note;
      const openItems = doc.items.filter((entry) => entry.status === "open");
      doc.status = openItems.every((entry) => entry.response !== null) ? "submitted" : "partial";
      doc.lastResponseAt = at;
      doc.responseActions.push({ actionId: body.actionId, requestSha256, itemIds, at });
      return {
        value: { outcome: "submitted", replay: false, itemIds, status: doc.status },
        onCommit: (next) => { next.lastResponseRevision = next.revision; },
      };
    });
  }

  /** Agent: confirm that it has read the latest submitted response(s). */
  markReceived(sessionId) {
    return this.#mutate(sessionId, (doc) => {
      if (!doc.lastResponseRevision) fail("INVALID_TRANSITION", "A receipt follows at least one submitted response of the owner.");
      if (doc.receivedRevision >= doc.lastResponseRevision && doc.receivedAt) {
        return { replay: true, value: { receivedAt: doc.receivedAt, receivedRevision: doc.receivedRevision, replay: true } };
      }
      doc.receivedAt = now();
      doc.receivedRevision = doc.lastResponseRevision;
      return { value: { receivedAt: doc.receivedAt, receivedRevision: doc.receivedRevision, replay: false } };
    });
  }

  /** Agent: record a short final outcome summary. */
  recordOutcome(sessionId, input) {
    const body = capture(input);
    shape(body, ["actionId", "summary"]);
    shortId(body.actionId, "actionId");
    const requestSha256 = hash(canonical(body));
    return this.#mutate(sessionId, (doc) => {
      if (doc.outcome?.actionId === body.actionId) {
        receipt(doc.outcome, requestSha256);
        return { replay: true, value: { outcome: doc.outcome, replay: true } };
      }
      if (!doc.lastResponseRevision) fail("INVALID_TRANSITION", "An outcome follows at least one submitted response of the owner.");
      if (doc.outcome) fail("OUTCOME_EXISTS", "This Feedback session already has an outcome.");
      doc.outcome = { actionId: body.actionId, requestSha256, summary: text(body.summary, "Outcome summary"), at: now() };
      return { value: { outcome: doc.outcome, replay: false } };
    });
  }

  /** Owner: rate the session from 1 to 10 (half stars). */
  rate(sessionId, input) {
    const body = capture(input);
    shape(body, ["actionId", "rating"], ["note"]);
    shortId(body.actionId, "actionId");
    const requestSha256 = hash(canonical(body));
    return this.#mutate(sessionId, (doc) => {
      const prior = doc.ratings.find((rating) => rating.actionId === body.actionId);
      if (prior) { receipt(prior, requestSha256); return { replay: true, value: { rating: prior, replay: true } }; }
      if (!Number.isInteger(body.rating) || body.rating < RATING_MIN || body.rating > RATING_MAX) {
        fail("INVALID_REQUEST", `rating is a whole number from ${RATING_MIN} to ${RATING_MAX}: one point for each half star.`);
      }
      const note = text(body.note, "Rating note", { optional: true, empty: true, max: LIMITS.summary });
      const rating = { actionId: body.actionId, requestSha256, value: body.rating, ...(note?.trim() ? { note } : {}), at: now() };
      doc.ratings.push(rating);
      return { value: { rating, replay: false } };
    });
  }
}

const current = (doc) => doc.ratings.at(-1) ?? null;

function pendingExpandsOf(doc) {
  const itemsById = new Map(doc.items.map((item) => [item.itemId, item]));
  const out = [];
  for (const req of doc.expandRequests ?? []) {
    if (req.status !== "pending") continue;
    const item = itemsById.get(req.itemId);
    if (!item || item.status !== "open" || item.response !== null) continue;
    const remaining = req.optionIds.filter((optId) => {
      const opt = item.options?.find((entry) => entry.optionId === optId);
      return Boolean(opt && opt.expandable && !opt.expanded);
    });
    if (remaining.length) out.push({ itemId: req.itemId, optionIds: remaining, requestedAt: req.requestedAt });
  }
  return out;
}

function countsOf(doc) {
  const actionable = doc.items.filter((item) => item.status === "open");
  const answered = actionable.filter((item) => item.response !== null);
  return { actionableCount: actionable.length, answeredCount: answered.length, openCount: actionable.length - answered.length };
}

function summary(doc) {
  const { actionableCount, answeredCount, openCount } = countsOf(doc);
  const pendingExpands = pendingExpandsOf(doc);
  return {
    sessionId: doc.sessionId,
    workflow: doc.workflow,
    layout: doc.layout,
    title: doc.title,
    status: doc.status,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    revision: doc.revision,
    items: doc.items.length,
    actionableCount,
    answeredCount,
    openCount,
    pendingExpands: pendingExpands.length,
    rating: current(doc)?.value ?? null,
    hasOutcome: Boolean(doc.outcome),
    isNew: !doc.seenAt,
    ...(doc.round > 1 ? { round: doc.round } : {}),
    ...(doc.previous ? { previousSessionId: doc.previous.sessionId } : {}),
  };
}

function view(doc) {
  return {
    ...structuredClone(doc),
    rating: current(doc),
    isNew: !doc.seenAt,
    pendingExpands: pendingExpandsOf(doc),
    ...countsOf(doc),
  };
}
