// The on-demand search (`scripts/search.mjs`): the fallback of the CLI, the read-only Hermes database,
// the cut of each candidate before the decider, a hit at a late store rank and the refused OpenViking redirect.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { runSearch } from "../src/ondemand.mjs";
import { hermesDbStore, openvikingAllStore } from "../src/stores-ondemand.mjs";
import { fakeDecider, fakeOpenViking, readyStore, sandbox } from "./helpers.mjs";

const CLI = fileURLToPath(new URL("../scripts/search.mjs", import.meta.url));
const QUERY = "alpha build steps";

function hermesDb(agentDir, rows) {
	const dir = join(agentDir, "pi-hermes-memory");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "sessions.db");
	const db = new DatabaseSync(file);
	db.exec(`PRAGMA journal_mode = WAL;
		CREATE TABLE memories (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT, target TEXT NOT NULL, category TEXT,
			content TEXT NOT NULL, created DATE NOT NULL, last_referenced DATE, hit_count INTEGER DEFAULT 0);
		CREATE VIRTUAL TABLE memory_fts USING fts5(content, content='memories', content_rowid='id', tokenize='trigram');
		CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN INSERT INTO memory_fts(rowid, content) VALUES (new.id, new.content); END;`);
	const insert = db.prepare("INSERT INTO memories (project, target, content, created) VALUES (?, 'memory', ?, '2026-01-01')");
	for (const [project, content] of rows) insert.run(project, content);
	db.close();
	return file;
}

/** Run the CLI without blocking this process: the fake servers of the test answer from here. */
function cli(args, { cwd, env }) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("close", (status) => resolve({ status, stdout, stderr }));
	});
}

const digest = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** A sandbox with one hit in each store: OpenViking (fake server), the personal wiki and Hermes. */
async function stores(t, { ovText = "OVMARK alpha build steps", wikiText = "WIKIMARK alpha build steps", factText = "FACTMARK alpha build steps", first = [] } = {}) {
	const server = await fakeOpenViking(t, () => ({ status: 200, json: { status: "ok", result: { entries: [
		...first,
		{ uri: "viking://user/tester/peers/other/memories/one.md", text: ovText, score: 0.9 },
		{ uri: "viking://user/tester/memories/two.md", text: "OVTWO alpha build", score: 0.8 },
		{ uri: "viking://user/tester/resources/doc.md", text: "RESOURCEMARK alpha build", score: 0.95 },
	] } } }));
	const box = sandbox(t, { base: server.base, mode: "" });
	const wiki = join(box.home, ".llm-wiki", "wiki", "concepts");
	mkdirSync(wiki, { recursive: true });
	writeFileSync(join(wiki, "alpha.md"), `---\ntitle: Alpha page\n---\n\n${wikiText}\n`);
	const agentDir = box.env.PI_CODING_AGENT_DIR;
	mkdirSync(join(agentDir, "pi-hermes-memory"), { recursive: true });
	writeFileSync(join(agentDir, "pi-hermes-memory", "MEMORY.md"), factText);
	return { box, agentDir, server };
}

test("CLI fallback: with the decider down, exit 0, the first 3 hits in store turn and the fallback note", async (t) => {
	const longId = `viking://user/tester/memories/${"x".repeat(4000)}.md`;
	const { box } = await stores(t, { first: [{ uri: longId, text: "LONGIDMARK alpha build", score: 0.95 }] });
	const env = { ...box.env };
	delete env.DECISION_API_KEY;
	const run = await cli(["--", QUERY], { cwd: box.home, env });
	assert.equal(run.status, 0, run.stderr);
	const lines = run.stdout.split("\n");
	const excerpts = lines.filter((line) => /^\[\d\] /.test(line)).map((line) => line.slice(4).split(" | "));
	assert.deepEqual(excerpts.map(([store, id]) => [store, id]),
		[["openviking", "(id too long)"], ["personal-wiki", "~/.llm-wiki/wiki/concepts/alpha.md"], ["hermes-facts", "hermes:pi-hermes-memory/MEMORY.md#1"]]);
	const pointerIds = lines.filter((line) => line.startsWith("- ")).map((line) => line.split(" | ")[1]);
	assert.ok(pointerIds.some((id) => id === "viking://user/tester/peers/other/memories/one.md"));
	assert.equal(run.stdout.includes("RESOURCEMARK"), false);
	assert.match(run.stdout, /^Ranking fell back /m);
	assert.ok(run.stdout.trimEnd().length <= 1600, `${run.stdout.length} characters`);

	assert.notEqual((await cli([], { cwd: box.home, env })).status, 0);
	assert.notEqual((await cli(["--pi-agent-dir", "--no-personal-wiki", QUERY], { cwd: box.home, env })).status, 0);
});

test("read-only Hermes: a search adds no file beside sessions.db and leaves it the same; a WAL row is found", async (t) => {
	const box = sandbox(t, { mode: "" });
	const agentDir = box.env.PI_CODING_AGENT_DIR;
	const store = hermesDbStore({ agentDir });
	assert.equal((await store.search({ query: QUERY })).status, "omitted");

	const file = hermesDb(agentDir, [["alpha", "DBMARK alpha build steps"], [null, "unrelated note"]]);
	const folder = dirname(file);
	const before = { files: readdirSync(folder).sort(), hash: digest(file) };
	const clean = await store.search({ query: QUERY });
	assert.ok(clean.hits.some((hit) => hit.text.includes("DBMARK")));
	assert.deepEqual({ files: readdirSync(folder).sort(), hash: digest(file) }, before);

	// A writer that holds a committed row in the WAL: the sidecars are there before the search.
	const writer = new DatabaseSync(file);
	t.after(() => writer.close());
	writer.exec("PRAGMA wal_autocheckpoint = 0; INSERT INTO memories (project, target, content, created) VALUES (NULL, 'memory', 'WALMARK alpha build steps', '2026-01-02');");
	const withWal = readdirSync(folder).sort();
	assert.deepEqual(withWal, ["sessions.db", "sessions.db-shm", "sessions.db-wal"]);
	const live = await store.search({ query: QUERY });
	assert.ok(live.hits.some((hit) => hit.text.includes("WALMARK")));
	assert.deepEqual(readdirSync(folder).sort(), withWal);
});

test("no whole file leaves: each store reaches the decider, each candidate 200 characters or less", async (t) => {
	const long = (mark) => `${mark} alpha build steps ${"filler words ".repeat(4000)}`;
	// Two Hermes facts with the same first 200 characters and a different rest: both stay.
	const same = `SAMEPREFIX alpha build steps ${"same words ".repeat(30)}`;
	const factText = [long("FACTMARK"), `${same} TAILONE`, `${same} TAILTWO`].join("\n§\n");
	const { box, agentDir } = await stores(t, { ovText: long("OVMARK"), wikiText: long("WIKIMARK"), factText });
	const decider = await fakeDecider(t, { reply: (body) => ({ status: 200, json: { answers: { pick: { probabilities:
		Object.fromEntries(Object.keys(body.questions.pick.criteria).map((key) => [key, key === "c1" ? 0.9 : 0.01])) } } } }) });
	await runSearch({ query: QUERY, env: box.env, cwd: box.home, agentDir, decider: { baseUrl: decider.base, apiKey: "k" } });
	const texts = Object.entries(decider.requests[0].questions.pick.criteria).filter(([key]) => key !== "none").map(([, text]) => text);
	for (const mark of ["OVMARK", "WIKIMARK", "FACTMARK"]) assert.ok(texts.some((text) => text.includes(mark)), mark);
	for (const text of texts) assert.ok(text.length <= 200, `${text.length} characters`);
	assert.equal(texts.filter((text) => text.startsWith("SAMEPREFIX")).length, 2);
});

test("late rank: the hit at rank 8 of one store of four full stores reaches the decider: an excerpt, or with a low p the first pointer", async (t) => {
	const box = sandbox(t, { mode: "" });
	const store = (name) => readyStore(name, Array.from({ length: 8 }, (_, index) => ({
		source: `${name}-${index + 1}`, title: `${name} ${index + 1}`, text: `${index === 7 && name === "wiki" ? "LATEMARK" : index === 0 && name !== "wiki" && name !== "hermes-db" ? "TOPMARK" : "other"} alpha build ${name} ${index + 1}`, score: 1 - index / 10,
	})));
	const search = async (late, first) => {
		const decider = await fakeDecider(t, { reply: (body) => ({ status: 200, json: { answers: { pick: { probabilities: Object.fromEntries(
			Object.entries(body.questions.pick.criteria).map(([key, text]) => [key, text.includes("LATEMARK") ? late : text.includes("TOPMARK") ? first : 0.001])) } } } }) });
		return runSearch({ query: QUERY, env: box.env, agentDir: box.env.PI_CODING_AGENT_DIR, stores: ["openviking", "wiki", "hermes-facts", "hermes-db"].map(store),
			decider: { baseUrl: decider.base, apiKey: "k" } });
	};
	const high = await search(0.9, 0.001);
	assert.equal(high.excerpts[0].id, "wiki-8");
	// p 0.05 at decider rank 3: not kept, and the pointers follow the decider order.
	const low = await search(0.05, 0.9);
	assert.equal(low.excerpts.some((item) => item.id === "wiki-8"), false);
	assert.equal(low.pointers[0].id, "wiki-8");
});

test("on-demand OpenViking refuses a redirect: the second server gets no request, the store is not available", async (t) => {
	const second = await fakeOpenViking(t, () => ({ status: 200, json: { status: "ok", result: { entries: [] } } }));
	const first = createServer((request, response) => {
		request.resume();
		response.writeHead(307, { Location: `${second.base}/api/v1/search/search` });
		response.end();
	});
	await new Promise((resolve) => first.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => first.close(resolve)));
	const store = openvikingAllStore({ cfg: { baseUrl: `http://127.0.0.1:${first.address().port}` } });
	assert.equal((await store.search({ query: QUERY })).status, "omitted");
	assert.equal(second.requests.length, 0);
});
