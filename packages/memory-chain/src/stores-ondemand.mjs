// The stores of the on-demand search (`scripts/search.mjs`): a search that a person or an agent starts
// on request. They read wider than the automatic stores of `stores.mjs`: all OpenViking memories of the
// user, all Hermes facts (project and global, approved or not) and the personal wiki `~/.llm-wiki`.
// The automatic run (`runPrompt` of `shadow.mjs`) never uses them. Every read is read-only.
// Each reader cuts the text of a hit (MAX_HIT_CHARS), so no whole file goes on.
import { open, readdir, realpath, stat } from "node:fs/promises";
import { constants, existsSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildOvHeaders } from "../../openviking-pi/shared/ov-http.mjs";
import { BIG, HERMES_DELIMITER, MAX_FILE_BYTES, overlap, readSmall, scoreThreshold, terms, TOO_LARGE } from "./stores.mjs";
import { configDir, home, readJson } from "./switch.mjs";

export const MAX_HIT_CHARS = 600;
export const WIKI_WINDOW_CHARS = 200;
const MAX_HITS = 8;
const MAX_TITLE_CHARS = 80;
const MAX_PERSONAL_WIKI_FILES = 10000;
const READ_BATCH = 64;
// The wiki reader scores with the first 32 distinct query terms. A question in one's own words holds far
// fewer, and the excerpt choice costs about the square of the term count for each top page, so a pasted
// long text cannot hold the event loop for long.
export const MAX_WIKI_QUERY_TERMS = 32;
const NOT_AVAILABLE = "not available";
// A page that the reader lists but cannot open or read (not a link, not too large): the store is then partial.
const UNREAD = Symbol("unread");
/**
 * The name rule of the wiki reader: a file or folder name below the vault root that holds one of these
 * characters gets no id, so the page is left out, never cut or rewritten. The characters: a control character
 * (Unicode Cc, line breaks included), a format character (Cf: zero-width and bidirectional marks), a surrogate,
 * a line or paragraph separator, a space other than U+0020 (Pi `read` changes U+00A0, U+2000-U+200A, U+202F,
 * U+205F and U+3000 to a plain space before it opens a path, so the id would name another file), and U+FFFD
 * (a name that is not valid UTF-8). Pi strips a leading `@` and expands a leading `~` only at the start of the
 * whole path, which is `~/` or `/` here, so a name that starts with them keeps its id.
 */
export const UNSAFE_WIKI_NAME = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\uFFFD]|(?! )\p{Zs}/u;

function cut(text, max = MAX_HIT_CHARS) {
	const value = String(text ?? "").replace(/\s+/g, " ").trim();
	return value.length <= max ? value : value.slice(0, max);
}

function titleOf(text) {
	return cut(text, MAX_TITLE_CHARS);
}

function best(hits) {
	return hits.filter((hit) => hit.score > 0).sort((a, b) => b.score - a.score).slice(0, MAX_HITS);
}

function expandHome(path, env) {
	const value = String(path || "").trim();
	if (value === "~") return home(env);
	return value.startsWith("~/") ? join(home(env), value.slice(2)) : value;
}

/**
 * The Pi agent folder, in this order: the flag `--pi-agent-dir`, `PI_CODING_AGENT_DIR`, the key `agentDir`
 * of the switch file, then `~/.pi/agent`. A leading `~/` is the home folder.
 */
export function resolveAgentDir({ flag = "", env = process.env } = {}) {
	const settings = readJson(join(configDir(env), "settings.json"));
	const fromSettings = typeof settings?.agentDir === "string" ? settings.agentDir : "";
	const chosen = [flag, env.PI_CODING_AGENT_DIR, fromSettings].map((value) => String(value || "").trim()).find(Boolean);
	return resolve(expandHome(chosen || join(home(env), ".pi", "agent"), env));
}

/** The source of a home path in the `~/` form, so that no personal path is printed. */
export function homeForm(path, env = process.env) {
	const base = resolve(home(env));
	const full = resolve(path);
	return full === base ? "~" : full.startsWith(`${base}/`) ? `~/${full.slice(base.length + 1)}` : full;
}

/** Only memories: `viking://user/<user>/memories/...` and `viking://user/<user>/peers/<peer>/memories/...`. */
const OV_MEMORY = /^viking:\/\/user\/[^/]+\/(?:peers\/[^/]+\/)?memories(?:\/|$)/;

function ovTitle(uri) {
	const parts = uri.replace(/\/+$/, "").split("/");
	const last = parts[parts.length - 1] || uri;
	return titleOf(last.startsWith(".") ? `${parts[parts.length - 2]}/${last}` : last.replace(/\.md$/, ""));
}

const ACTOR_HEADER = "x-openviking-actor-peer";

/**
 * OpenViking on demand: the request form of `openvikingStore`, with no `peer_scope` and no actor header
 * (also none from `OPENVIKING_EXTRA_HEADERS`, in any letter case), so the server searches all memories of
 * the user. Resources and skills are dropped: only memory URIs pass. A redirect is not followed, and a
 * redirect or a reply with no result array is "not available".
 * @param {{cfg: object|null, extraHeaders?: object, fetchImpl?: typeof fetch}} input
 */
export function openvikingAllStore({ cfg, extraHeaders = {}, fetchImpl = fetch }) {
	const extra = Object.fromEntries(Object.entries(extraHeaders ?? {}).filter(([name]) => name.toLowerCase() !== ACTOR_HEADER));
	return {
		name: "openviking",
		async search({ query, signal }) {
			if (!cfg?.baseUrl) return { status: "omitted", reason: "not configured" };
			const body = JSON.stringify({ query, mode: "context", purpose: "coding", score_threshold: scoreThreshold(cfg), query_expansion: "off" });
			const response = await fetchImpl(`${cfg.baseUrl}/api/v1/search/search`, {
				method: "POST", headers: buildOvHeaders(cfg, { extraHeaders: extra }), body, signal, redirect: "manual",
			});
			if (response.status >= 300 && response.status < 400) return { status: "omitted", reason: NOT_AVAILABLE };
			if (!response.ok) throw new Error("openviking request failed");
			const reply = await response.json().catch(() => null);
			if (!Array.isArray(reply?.result?.entries)) return { status: "omitted", reason: NOT_AVAILABLE };
			const entries = reply.result.entries;
			const hits = [];
			for (const entry of entries) {
				const uri = String(entry?.uri || "").trim();
				if (!OV_MEMORY.test(uri)) continue;
				hits.push({
					source: uri,
					title: ovTitle(uri),
					text: cut(entry.text || entry.content || entry.summary || entry.abstract || ""),
					score: Number(entry.score) || 0,
				});
			}
			return { status: "ready", hits: hits.slice(0, MAX_HITS) };
		},
	};
}

/**
 * The Hermes facts in the `MEMORY.md` files: `pi-hermes-memory/MEMORY.md` (global) and every
 * `projects-memory/<project>/MEMORY.md`. No file at all means "not available".
 */
export function hermesFactsStore({ agentDir }) {
	return {
		name: "hermes-facts",
		async search({ query, signal }) {
			const files = [join("pi-hermes-memory", "MEMORY.md")];
			const projects = await readdir(join(agentDir, "projects-memory"), { withFileTypes: true }).catch(() => []);
			for (const entry of projects.sort((a, b) => (a.name < b.name ? -1 : 1))) {
				if (entry.isDirectory() && !entry.name.startsWith(".")) files.push(join("projects-memory", entry.name, "MEMORY.md"));
			}
			const queryTerms = terms(query);
			const hits = [];
			let found = 0;
			for (const file of files) {
				if (signal?.aborted) break;
				const raw = await readSmall(join(agentDir, file));
				if (raw === null || raw === BIG) continue;
				found += 1;
				const scope = file.startsWith("projects-memory") ? file.split("/")[1] : "global";
				raw.split(HERMES_DELIMITER).map((entry) => entry.trim()).filter(Boolean).forEach((text, index) => {
					hits.push({ source: `hermes:${file}#${index + 1}`, title: titleOf(`${scope}: ${text}`), text: cut(text), score: overlap(queryTerms, text) });
				});
			}
			if (!found) return { status: "omitted", reason: NOT_AVAILABLE };
			return { status: "ready", hits: best(hits) };
		},
	};
}

/**
 * Open the Hermes database read-only so that no new file appears beside it. With no `-wal` file, no writer
 * has pending data: the URI form `immutable=1` opens it and makes no `-wal` or `-shm` file. With `-wal` and
 * `-shm` present, a writer is or was active: the normal read-only open sees the committed rows of the WAL
 * and the sidecars are already there. Any other set (a `-wal` with no `-shm`, a rollback `-journal`) would
 * make a file or need a write, so it returns null: the store is "not available".
 */
export function openReadOnly(file) {
	if (!statSync(file).isFile()) throw new Error("The store is not a file.");
	const has = (suffix) => existsSync(`${file}${suffix}`);
	let target;
	if (has("-journal")) return null;
	if (!has("-wal")) {
		target = pathToFileURL(file);
		target.searchParams.set("mode", "ro");
		target.searchParams.set("immutable", "1");
	} else if (has("-shm")) target = file;
	else return null;
	let db;
	try {
		db = new DatabaseSync(target, { readOnly: true });
		db.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get();
		return db;
	} catch (error) {
		db?.close();
		throw error;
	}
}

/** An FTS5 query of the terms of `query`, each one quoted, joined with OR. Trigram needs 3 characters. */
export function ftsQuery(query) {
	return terms(query).map((term) => `"${term.replace(/"/g, "\"\"")}"`).join(" OR ");
}

/**
 * The Hermes table `memories` through its FTS5 index `memory_fts` in `pi-hermes-memory/sessions.db`,
 * read-only. It writes no usage counter. A missing database means "not available".
 */
export function hermesDbStore({ agentDir }) {
	return {
		name: "hermes-db",
		async search({ query }) {
			const file = join(agentDir, "pi-hermes-memory", "sessions.db");
			if (!existsSync(file)) return { status: "omitted", reason: NOT_AVAILABLE };
			const match = ftsQuery(query);
			if (!match) return { status: "ready", hits: [] };
			const db = openReadOnly(file);
			if (!db) return { status: "omitted", reason: NOT_AVAILABLE };
			try {
				const rows = db.prepare(`SELECT m.id AS id, m.project AS project, m.target AS target, m.content AS content
					FROM memory_fts JOIN memories m ON m.id = memory_fts.rowid
					WHERE memory_fts MATCH ? ORDER BY bm25(memory_fts) LIMIT ?`).all(match, MAX_HITS * 2);
				const queryTerms = terms(query);
				const hits = rows.map((row) => ({
					source: `hermes-db:memories.id=${row.id}`,
					title: titleOf(`${row.project || "global"} ${row.target}: ${row.content}`),
					text: cut(row.content),
					score: overlap(queryTerms, String(row.content || "")),
				}));
				return { status: "ready", hits: best(hits) };
			} finally {
				db.close();
			}
		},
	};
}

async function wikiFiles(dir, out, signal, depth = 0) {
	if (depth > 4 || out.length >= MAX_PERSONAL_WIKI_FILES || signal?.aborted) return;
	// The root must list; a folder below it that cannot be listed is skipped.
	const entries = depth === 0 ? await readdir(dir, { withFileTypes: true }) : await readdir(dir, { withFileTypes: true }).catch(() => []);
	for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
		if (out.length >= MAX_PERSONAL_WIKI_FILES) return;
		if (entry.name.startsWith(".") || UNSAFE_WIKI_NAME.test(entry.name)) continue;
		const path = join(dir, entry.name);
		// A Dirent does not follow a symbolic link, so a link is never read.
		if (entry.isDirectory()) await wikiFiles(path, out, signal, depth + 1);
		else if (entry.isFile() && entry.name.endsWith(".md")) out.push(path);
	}
}

/**
 * The text of one page, at most MAX_FILE_BYTES: the file opens with no follow of a link at its name, and the
 * read takes the cap plus one byte, so a file that grows after the listing cannot pass. Null for a link or a
 * name that is not a file (a refusal); BIG for a larger file; UNREAD for any other open or read error.
 */
export async function readPage(path) {
	let handle;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		if (!(await handle.stat()).isFile()) return null;
		const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
		let size = 0;
		for (;;) {
			const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
			if (!bytesRead) break;
			size += bytesRead;
			if (size > MAX_FILE_BYTES) return BIG;
		}
		return buffer.toString("utf8", 0, size);
	} catch (error) {
		return error?.code === "ELOOP" ? null : UNREAD;
	} finally {
		await handle?.close().catch(() => {});
	}
}

function pageTitle(raw, path) {
	const front = /^---\n([\s\S]*?)\n---/.exec(raw);
	const fromFront = front && /^title:\s*(.+)$/m.exec(front[1]);
	if (fromFront) return titleOf(fromFront[1].replace(/^["']|["']$/g, ""));
	const heading = /^#\s+(.+)$/m.exec(raw);
	return titleOf(heading ? heading[1] : path.split("/").pop().replace(/\.md$/, ""));
}

/** The best window of `size` characters of `body` around the query terms: the most distinct terms, then the first. */
export function bestWindow(body, queryTerms, size = WIKI_WINDOW_CHARS) {
	const text = body.replace(/\s+/g, " ").trim();
	if (text.length <= size) return text;
	const lower = text.toLowerCase();
	let bestStart = 0;
	let bestCount = -1;
	for (const term of queryTerms) {
		for (let at = lower.indexOf(term); at >= 0; at = lower.indexOf(term, at + term.length)) {
			const start = Math.max(0, Math.min(at - Math.floor(size / 4), text.length - size));
			const window = lower.slice(start, start + size);
			const count = queryTerms.filter((other) => window.includes(other)).length;
			if (count > bestCount) { bestCount = count; bestStart = start; }
		}
	}
	return text.slice(bestStart, bestStart + size);
}

/**
 * The personal wiki: the pages under `~/.llm-wiki/wiki/` as plain files. A page scores by the share of
 * query terms that it holds (the first MAX_WIKI_QUERY_TERMS); the text of a hit is the best 200 characters
 * around the terms. It lists up to 10,000 page paths and returns up to 8 hits.
 * A page over 128 KB is skipped, and so is a name of UNSAFE_WIKI_NAME. The vault root resolves one time (the
 * root can itself be a link); the reads stay below the resolved root, and a link below it is never followed.
 * No wiki folder, or a root that cannot be listed, means "not available". A ready reply holds `unread`, the
 * count of listed pages that failed to open or read.
 * The signal is cooperative: it is checked before each batch of 64 pages, and the event loop gets a turn
 * after each batch, so a batch in progress and the excerpts of the top pages still finish after it aborts.
 */
export function personalWikiStore({ env = process.env } = {}) {
	return {
		name: "personal-wiki",
		async search({ query, signal }) {
			const shown = join(home(env), ".llm-wiki", "wiki");
			const dir = await realpath(shown).catch(() => null);
			const info = dir && await stat(dir).catch(() => null);
			if (!info?.isDirectory()) return { status: "omitted", reason: NOT_AVAILABLE };
			const files = [];
			try {
				await wikiFiles(dir, files, signal);
			} catch {
				return { status: "omitted", reason: NOT_AVAILABLE };
			}
			const queryTerms = terms(query).slice(0, MAX_WIKI_QUERY_TERMS);
			const scored = [];
			let tooLarge = 0;
			let unread = 0;
			for (let index = 0; index < files.length && !signal?.aborted; index += READ_BATCH) {
				const batch = files.slice(index, index + READ_BATCH);
				const pages = await Promise.all(batch.map((path) => readPage(path)));
				pages.forEach((raw, offset) => {
					if (raw === BIG) tooLarge += 1;
					if (raw === UNREAD) unread += 1;
					if (raw === null || raw === BIG || raw === UNREAD) return;
					const score = overlap(queryTerms, raw);
					if (score > 0) scored.push({ path: batch[offset], raw, score });
				});
				await new Promise((resolve) => setImmediate(resolve));
			}
			if (!scored.length && tooLarge && !unread) return { status: "omitted", reason: TOO_LARGE };
			const top = scored.sort((a, b) => (b.score - a.score) || (a.path < b.path ? -1 : 1)).slice(0, MAX_HITS);
			return { status: "ready", unread, hits: top.map(({ path, raw, score }) => ({
				// The id names the page below the unresolved root, so no resolved personal path is printed.
				source: homeForm(join(shown, relative(dir, path)), env),
				title: pageTitle(raw, path),
				text: bestWindow(raw.replace(/^---\n[\s\S]*?\n---\n?/, ""), queryTerms),
				score,
			})) };
		},
	};
}
