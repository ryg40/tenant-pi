import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { capture, fail, hash, id, inspect, readBytes } from "./double-archive.js";
import { canonical } from "./trainer-store.js";
import { isCanonicalAbsolute } from "./canonical-path.js";
import { POSIX_ONLY_CODE, posixOnlyRefusal } from "./posix-only.js";
import { RATING_MAX, RATING_MIN } from "./compare-stars.js";

export const SCHEMA = "walkr-compare-session";
export const VERSION = 1;
const RECORD = "session.json";
const SESSION = /^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$/;
const WORKFLOW = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const FORMATS = new Set(["html", "text", "markdown"]);
export const LIMITS = { options: [2, 3], content: 1024 * 1024, text: 8000, short: 200, clarifications: 12 };
const queues = new Map();

/** The configured session root, by default ~/.local/.walkr/compare. Tests and trials set HUMAN_REVIEW_COMPARE_ROOT. */
export function compareRoot(env = process.env, home = os.homedir()) {
  return env.HUMAN_REVIEW_COMPARE_ROOT || path.join(home, ".local", ".walkr", "compare");
}

export function sessionName(value) {
  if (typeof value !== "string" || !SESSION.test(value)) fail("INVALID_ID", "Unknown Compare session ID format.");
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

function content(value, name) {
  if (!FORMATS.has(value.format)) fail("INVALID_REQUEST", `${name} format must be html, text or markdown.`);
  if (typeof value.content !== "string" || !value.content.trim() || Buffer.byteLength(value.content) > LIMITS.content) {
    fail("INVALID_REQUEST", `${name} content must be a nonempty string of at most ${LIMITS.content} bytes.`);
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

function normalizeCreate(body) {
  shape(body, ["actionId", "workflow", "title", "brief", "options"], ["clarifications", "repo", "source"]);
  shortId(body.actionId, "actionId");
  if (typeof body.workflow !== "string" || !WORKFLOW.test(body.workflow)) {
    fail("INVALID_REQUEST", "workflow uses 1-64 lowercase letters, digits or hyphens, and starts with a letter or digit.");
  }
  const out = { workflow: body.workflow, title: text(body.title, "Title", { max: LIMITS.short }), brief: text(body.brief, "Brief") };
  if (body.repo !== undefined) {
    shape(body.repo, ["name"], ["revision"]);
    if (typeof body.repo.name !== "string" || !REPO.test(body.repo.name)) fail("INVALID_REQUEST", "repo.name uses 1-100 letters, digits, dots, underscores or hyphens.");
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
      return { question: text(item.question, "Clarification question", { max: 2000 }), answer: text(item.answer, "Clarification answer", { max: 2000 }) };
    });
  }
  if (body.source !== undefined) {
    shape(body.source, ["format", "content"], ["label"]);
    if (body.source.format === "html") fail("INVALID_REQUEST", "The source is text or markdown. Put rendered HTML in the options.");
    out.source = { label: text(body.source.label, "Source label", { max: LIMITS.short, optional: true }) ?? "Original", ...content(body.source, "Source") };
  }
  const [min, max] = LIMITS.options;
  if (!Array.isArray(body.options) || body.options.length < min || body.options.length > max) fail("INVALID_REQUEST", `Supply ${min} or ${max} options.`);
  const seen = new Set(), bytes = new Set();
  out.options = body.options.map((option) => {
    shape(option, ["optionId", "label", "format", "content"], ["summary"]);
    shortId(option.optionId, "optionId");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(option.optionId)) fail("INVALID_ID", "optionId uses 1-64 letters, digits, dots, underscores or hyphens.");
    if (seen.has(option.optionId)) fail("INVALID_REQUEST", "Each option needs a unique optionId.");
    seen.add(option.optionId);
    const saved = { optionId: option.optionId, label: text(option.label, "Option label", { max: LIMITS.short }) };
    if (option.summary !== undefined) saved.summary = text(option.summary, "Option summary", { max: 2000 });
    Object.assign(saved, content(option, "Option"));
    if (bytes.has(saved.contentSha256)) fail("INVALID_REQUEST", "Two options have the same content. Each option must differ.");
    bytes.add(saved.contentSha256);
    return saved;
  });
  return out;
}

/**
 * Durable Compare sessions: one record per session under <root>/sessions/<session-id>/session.json.
 * One server process owns a root. Records are replaced atomically and never deleted by this store.
 */
export class CompareStore {
  #root;

  constructor({ root, platform = process.platform }) {
    const refusal = posixOnlyRefusal(platform);
    if (refusal) fail(POSIX_ONLY_CODE, refusal);
    if (!isCanonicalAbsolute(root)) fail("UNSAFE_PATH", "The Compare root must be a canonical absolute directory without traversal or a trailing slash.");
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
        if (!create) fail("NOT_FOUND", "The Compare root does not exist yet.");
        missing.unshift(current);
        current = path.dirname(current);
      }
    }
    await inspect(current, true);
    for (const dir of missing) await fs.mkdir(dir, { mode: 0o700 });
    const stat = await inspect(this.#root, true);
    if (stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o022n)) {
      fail("UNSAFE_PATH", "The Compare root must belong to the current user and must not be group or world writable.");
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

  /** A replay answers only after the directory of the record is synced: the first try can have failed at that step. */
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
      if (error.code === "ENOENT" || error.code === "NOT_FOUND") fail("NOT_FOUND", "The Compare session does not exist.");
      throw error;
    }
    let doc;
    try {
      const { checksum, ...rest } = JSON.parse(bytes.toString("utf8"));
      if (checksum !== hash(JSON.stringify(rest))) throw new Error();
      doc = rest;
    } catch { fail("RECOVERY_REQUIRED", "The Compare record failed its checksum. Preserve it before recovery."); }
    if (doc.schema !== SCHEMA || doc.version !== VERSION || doc.sessionId !== sessionId) {
      fail("RECOVERY_REQUIRED", "The Compare record has an unknown schema or identity. Preserve it before recovery.");
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
        fail("RECOVERY_REQUIRED", "The Compare record changed outside this writer. Preserve it before recovery.");
      }
      replacing = true;
      await fs.rename(temporary, file);
      owned = false;
      await this.#syncDir(dir);
    } catch (error) {
      if (replacing) fail("COMMIT_UNCERTAIN", "The save may have committed. Retry the exact original request and action ID.", { reason: error.code || "UNKNOWN" });
      if (error.name === "DoubleStoreError") throw error;
      fail("WRITE_FAILED", "The Compare record was not replaced. Retry the exact original request.", { fsCode: error.code || "UNKNOWN" });
    } finally {
      if (handle) await handle.close().catch(() => {});
      // Only this call's uncommitted temporary file is removed. Records are never pruned.
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
      // A directory without a record is an interrupted create. It is kept, never deleted, and holds no result.
      catch (error) { if (error.code !== "NOT_FOUND") throw error; }
    }
    return docs;
  }

  /** The history: one summary per session, oldest first. A session ID starts with its creation time. */
  async list() {
    return (await this.run(() => this.#sessions())).map(summary);
  }

  /** Agent: create a session from 2 or 3 prepared options. */
  async create(input) {
    const body = capture(input);
    const fields = normalizeCreate(body);
    const requestSha256 = hash(canonical(body));
    return this.run(async () => {
      for (const doc of await this.#sessions()) {
        if (doc.createAction.actionId === body.actionId) {
          receipt(doc.createAction, requestSha256);
          await this.#confirm(this.#sessionDir(doc.sessionId), this.#sessionsDir());
          return { result: { sessionId: doc.sessionId, replay: true }, view: view(doc) };
        }
      }
      await this.#ensureRoot(true);
      await this.#privateDir(this.#sessionsDir());
      let sessionId, dir;
      for (let attempt = 0; !dir; attempt += 1) {
        sessionId = `${stamp()}-${randomBytes(6).toString("hex")}`;
        try {
          await fs.mkdir(this.#sessionDir(sessionId), { mode: 0o700 });
          dir = this.#sessionDir(sessionId);
        } catch (error) {
          if (error.code !== "EEXIST" || attempt >= 8) fail("WRITE_FAILED", "Could not reserve a unique Compare session directory.", { fsCode: error.code });
        }
      }
      await inspect(dir, true, true);
      await this.#syncDir(this.#sessionsDir());
      const createdAt = now();
      const doc = {
        schema: SCHEMA, version: VERSION, sessionId, createdAt, updatedAt: createdAt, revision: 1, status: "open",
        createAction: { actionId: body.actionId, requestSha256, at: createdAt },
        ...fields, result: null, outcome: null, ratings: [],
      };
      await this.#commit(dir, doc, null);
      return { result: { sessionId, replay: false }, view: view(doc) };
    });
  }

  async read(sessionId) {
    sessionName(sessionId);
    return view((await this.run(() => this.#load(sessionId))).doc);
  }

  /** Owner: the pick, the comments and the note. The first submitted result is final. */
  submit(sessionId, input) {
    const body = capture(input);
    shape(body, ["actionId", "pick"], ["comments", "note"]);
    shortId(body.actionId, "actionId");
    const requestSha256 = hash(canonical(body));
    return this.#mutate(sessionId, (doc) => {
      if (doc.result?.actionId === body.actionId) { receipt(doc.result, requestSha256); return { replay: true, value: { outcome: "submitted", replay: true, result: doc.result } }; }
      // A duplicate or uncertain Submit from another action resolves to the first saved result.
      if (doc.result) return { replay: true, value: { outcome: "already-submitted", replay: true, result: doc.result } };
      const known = new Set(doc.options.map((option) => option.optionId));
      if (body.pick !== null && !known.has(body.pick)) fail("INVALID_REQUEST", "pick names an option of this session, or null for no option.");
      const note = text(body.note, "Note", { optional: true, empty: true });
      if (body.pick === null && !note?.trim()) fail("INVALID_REQUEST", "Write a note that says what is missing when no option fits.");
      const comments = Object.create(null);
      if (body.comments !== undefined) {
        shape(body.comments, [], [...known]);
        for (const option of doc.options) {
          const comment = text(Object.hasOwn(body.comments, option.optionId) ? body.comments[option.optionId] : undefined, "Comment", { optional: true, empty: true });
          if (comment?.trim()) comments[option.optionId] = comment;
        }
      }
      doc.result = { actionId: body.actionId, requestSha256, pick: body.pick, comments: { ...comments }, ...(note?.trim() ? { note } : {}), submittedAt: now() };
      doc.status = "submitted";
      return { value: { outcome: "submitted", replay: false, result: doc.result } };
    });
  }

  /** Owner: the session was opened in the page. Only the first time is saved; the session list then stops showing it as new. */
  markSeen(sessionId) {
    return this.#mutate(sessionId, (doc) => {
      if (doc.seenAt) return { replay: true, value: { seenAt: doc.seenAt, replay: true } };
      doc.seenAt = now();
      return { value: { seenAt: doc.seenAt, replay: false } };
    });
  }

  /** Agent: one short report of what it did with the submitted result. The first outcome is final. */
  recordOutcome(sessionId, input) {
    const body = capture(input);
    shape(body, ["actionId", "summary"]);
    shortId(body.actionId, "actionId");
    const requestSha256 = hash(canonical(body));
    return this.#mutate(sessionId, (doc) => {
      if (doc.outcome?.actionId === body.actionId) { receipt(doc.outcome, requestSha256); return { replay: true, value: { outcome: doc.outcome, replay: true } }; }
      if (!doc.result) fail("INVALID_TRANSITION", "An outcome follows the submitted result of the owner.");
      if (doc.outcome) fail("OUTCOME_EXISTS", "This session already has an outcome.");
      doc.outcome = { actionId: body.actionId, requestSha256, summary: text(body.summary, "Outcome summary"), at: now() };
      return { value: { outcome: doc.outcome, replay: false } };
    });
  }

  /** Owner: rate the session from 1 to 10 (half stars). A later rating replaces the shown one; each stays in the record. */
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
      const note = text(body.note, "Rating note", { optional: true, empty: true, max: 2000 });
      const rating = { actionId: body.actionId, requestSha256, value: body.rating, ...(note?.trim() ? { note } : {}), at: now() };
      doc.ratings.push(rating);
      return { value: { rating, replay: false } };
    });
  }
}

const current = (doc) => doc.ratings.at(-1) ?? null;

function summary(doc) {
  const picked = doc.options.find((option) => option.optionId === doc.result?.pick);
  return {
    sessionId: doc.sessionId, workflow: doc.workflow, title: doc.title, status: doc.status, createdAt: doc.createdAt, updatedAt: doc.updatedAt,
    options: doc.options.length, pick: doc.result ? doc.result.pick : undefined, ...(picked ? { pickLabel: picked.label } : {}),
    rating: current(doc)?.value ?? null, hasOutcome: Boolean(doc.outcome), isNew: !doc.seenAt,
  };
}

function view(doc) {
  return { ...structuredClone(doc), rating: current(doc), isNew: !doc.seenAt };
}
