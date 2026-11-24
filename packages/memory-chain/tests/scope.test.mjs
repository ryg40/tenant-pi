// Behavior 4: a hit of another project, an unapproved global fact and a store that refuses the scope
// never reach ranking, a link or the block.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectPeers, runShadow } from "../src/shadow.mjs";
import { hermesGlobalId } from "../src/stores.mjs";
import { buildPluginConfig } from "../../openviking-pi/shared/plugin-config.mjs";
import { deriveWorkspacePeerId } from "../../openviking-pi/shared/workspace-peer.mjs";
import { fakeClock, fakeOpenViking, ranker, sandbox } from "./helpers.mjs";

const PROMPT = "how does the alpha build work";

function peerUri(peer, mark) {
	return `viking://user/tester/peers/${peer}/memories/${mark}.md`;
}

async function setup(t, { refuse = false, cli = {}, extra = () => [] } = {}) {
	let peer = "";
	const server = await fakeOpenViking(t, () => refuse
		? { status: 422, json: { status: "error" } }
		: { status: 200, json: { status: "ok", result: { entries: [
			{ uri: peerUri(peer, "OWNMARK"), text: "OWNTEXT alpha build", score: 0.9 },
			{ uri: peerUri("other-project", "FOREIGNMARK"), text: "FOREIGNTEXT alpha build", score: 0.99 },
			{ uri: "viking://user/tester/memories/GLOBALMARK.md", text: "GLOBALTEXT alpha build", score: 0.98 },
			{ uri: "viking://user/tester/memories/APPROVEDMARK.md", text: "APPROVEDTEXT alpha build", score: 0.5 },
			...extra(),
		] } } });
	const approvedHermes = "APPROVEDHERMES alpha build notes";
	const box = sandbox(t, { base: server.base, cli,
		approved: ["viking://user/tester/memories/APPROVEDMARK.md", hermesGlobalId(approvedHermes)] });
	peer = projectPeers(buildPluginConfig("pi", { cwd: box.project, env: box.env }), box.project, box.env).peer;
	const agent = box.env.PI_CODING_AGENT_DIR;
	mkdirSync(join(agent, "pi-hermes-memory"), { recursive: true });
	writeFileSync(join(agent, "pi-hermes-memory", "MEMORY.md"), `${approvedHermes}\n§\nHERMESGLOBALMARK alpha build`);
	mkdirSync(join(agent, "projects-memory", "alpha"), { recursive: true });
	writeFileSync(join(agent, "projects-memory", "alpha", "MEMORY.md"), "PROJECTMARK alpha build fact");
	mkdirSync(join(agent, "projects-memory", "beta"), { recursive: true });
	writeFileSync(join(agent, "projects-memory", "beta", "MEMORY.md"), "BETAMARK alpha build fact");
	mkdirSync(join(box.home, ".llm-wiki"), { recursive: true });
	writeFileSync(join(box.home, ".llm-wiki", "VAULTMARK.md"), "VAULTMARK alpha build");
	return { server, box, peer };
}

const FORBIDDEN = ["FOREIGN", "GLOBALMARK", "GLOBALTEXT", "HERMESGLOBALMARK", "BETAMARK", "VAULTMARK"];

function assertClean(text) {
	for (const mark of FORBIDDEN) assert.ok(!text.includes(mark), `${mark} leaked`);
}

/** A ranker that keeps what it saw and ranks in the given order. */
function seeingRanker() {
	const seen = { candidates: [] };
	seen.rank = ranker((candidates) => { seen.candidates = candidates; return candidates.map((candidate) => candidate.id); });
	return seen;
}

function recordText(state) {
	if (!existsSync(state)) return "";
	return readdirSync(state).map((name) => readFileSync(join(state, name), "utf8")).join("");
}

test("pi: foreign and unapproved hits never reach the ranker or the block", async (t) => {
	const { server, box, peer } = await setup(t);
	const seen = seeingRanker();
	const { ran, result } = await runShadow({ harness: "pi", prompt: PROMPT, cwd: box.project, env: box.env, rank: seen.rank });
	assert.equal(ran, true);
	assert.equal(server.requests.length, 1);
	assert.equal(server.requests[0].body.peer_scope, "actor");
	assert.equal(server.requests[0].actor, peer);
	const text = JSON.stringify(seen.candidates);
	for (const mark of ["APPROVEDHERMES", "APPROVEDTEXT", "OWNTEXT", "PROJECTMARK"]) assert.ok(text.includes(mark), `${mark} missing`);
	assertClean(text);
	assertClean(result.block);
});

test("claude-code: no Pi private store reaches the ranker", async (t) => {
	const { box } = await setup(t);
	const seen = seeingRanker();
	await runShadow({ harness: "claude-code", prompt: PROMPT, cwd: box.project, env: box.env, rank: seen.rank });
	const text = JSON.stringify(seen.candidates);
	assert.ok(text.includes("OWNTEXT"));
	for (const mark of ["PROJECTMARK", "APPROVEDHERMES"]) assert.ok(!text.includes(mark), `${mark} reached Claude Code`);
	assertClean(text);
});

test("pi: the links fallback holds only permitted sources", async (t) => {
	const { box } = await setup(t);
	const clock = fakeClock();
	let asked;
	const rankAsked = new Promise((resolve) => { asked = resolve; });
	const rank = ranker(() => { asked(); return new Promise(() => {}); });
	const run = runShadow({ harness: "pi", prompt: PROMPT, cwd: box.project, env: box.env, rank, clock });
	await rankAsked;
	await clock.advance(2000);
	const { result } = await run;
	assert.equal(result.kind, "links");
	assert.ok(result.block.includes("OWNMARK"));
	assertClean(result.block);
});

test("pi: a store that refuses the scope is skipped, named, and not asked again", async (t) => {
	const { server, box } = await setup(t, { refuse: true });
	const seen = seeingRanker();
	const { result } = await runShadow({ harness: "pi", prompt: PROMPT, cwd: box.project, env: box.env, rank: seen.rank });
	assert.equal(server.requests.length, 1);
	assert.equal(server.requests[0].body.peer_scope, "actor");
	assert.ok(result.omitted.some((item) => item.store === "openviking"), "the store that refused the scope is named as left out");
	assert.ok(!seen.candidates.some((candidate) => candidate.store === "openviking"));
	assert.ok(!result.block.includes("OWNMARK"));
	assertClean(result.block);
});

test("an explicit peer leaves OpenViking out; the legacy peer of the project counts, another folder does not", async (t) => {
	const explicit = await setup(t, { cli: { actor_peer_id: "account-peer" } });
	const first = await runShadow({ harness: "claude-code", prompt: PROMPT, cwd: explicit.box.project, env: explicit.box.env });
	assert.equal(explicit.server.requests.length, 0);
	assert.equal(first.result.steps.stores.openviking.status, "omitted");
	assert.ok(first.result.omitted.some((item) => item.store === "openviking"));

	let legacy = "";
	let otherFolder = "";
	const { server, box, peer } = await setup(t, { extra: () => [
		{ uri: peerUri(legacy, "LEGACYMARK"), text: "LEGACYTEXT alpha build", score: 0.7 },
		{ uri: peerUri(otherFolder, "PATHFOREIGNMARK"), text: "PATHFOREIGNTEXT alpha build", score: 0.95 },
	] });
	const cwd = join(box.project, "sub");
	mkdirSync(cwd);
	legacy = projectPeers(buildPluginConfig("claude_code", { cwd, env: box.env }), cwd, box.env).legacy;
	otherFolder = deriveWorkspacePeerId(join(box.project, "..", "beta"));
	assert.ok(legacy && legacy !== peer);
	const seen = seeingRanker();
	await runShadow({ harness: "claude-code", prompt: PROMPT, cwd, env: box.env, rank: seen.rank });
	assert.deepEqual(server.requests.map((request) => request.actor).sort(), [peer, legacy].sort());
	const text = JSON.stringify(seen.candidates);
	assert.ok(text.includes("LEGACYTEXT"));
	assert.ok(text.includes("OWNTEXT"));
	assert.ok(!text.includes("PATHFOREIGN"));
});

test("pi: in the home folder the personal vault never reaches the ranker, the links, the block or the record", async (t) => {
	const { box } = await setup(t);
	const seen = seeingRanker();
	const ranked = await runShadow({ harness: "pi", prompt: PROMPT, cwd: box.home, env: box.env, rank: seen.rank });
	// A ranker with no declaration gives the links block at once.
	const linked = await runShadow({ harness: "pi", prompt: PROMPT, cwd: box.home, env: box.env, rank: () => [] });
	assert.ok(!JSON.stringify(seen.candidates).includes("VAULTMARK"));
	for (const { result } of [ranked, linked]) assert.ok(!result.block.includes("VAULTMARK"));
	assert.ok(!recordText(box.state).includes("VAULTMARK"));
});
