// The replay command: it leaks no prompt or memory text outside the output that the owner names,
// and it refuses an output path inside a git repository, through a link into one, or at an existing file.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { projectPeer } from "../src/shadow.mjs";
import { buildPluginConfig } from "../../openviking-pi/shared/plugin-config.mjs";
import { fakeOpenViking, sandbox } from "./helpers.mjs";

const REPLAY = fileURLToPath(new URL("../scripts/replay.mjs", import.meta.url));

/** Run the replay command as a child process. The fake server answers in this process meanwhile. */
function runReplay(args, env) {
	return new Promise((resolve, reject) => {
		const proc = spawn(process.execPath, [REPLAY, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		proc.stdout.on("data", (chunk) => { stdout += chunk; });
		proc.stderr.on("data", () => {});
		proc.on("error", reject);
		proc.on("close", (status) => resolve({ status, stdout }));
	});
}

/** Every file below `dir`, links not followed. */
function allFiles(dir) {
	const found = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...allFiles(path));
		else if (entry.isFile()) found.push(path);
	}
	return found;
}

/** The chain search asks with `query_expansion: "off"`; the recall with no session id does not. */
const isChainSearch = (body) => body?.query_expansion === "off";

test("the replay writes the prompt and memory text only into the --out file, and keeps the sample", async (t) => {
	let peer = "";
	const server = await fakeOpenViking(t, (body) => {
		const mark = isChainSearch(body) ? "CHAINMARK" : "RECALLMARK";
		return { status: 200, json: { status: "ok", result: {
			entries: [{ uri: `viking://user/tester/peers/${peer}/memories/SOURCEMARK.md`, text: `MEMORYMARK ${mark} alpha zebra`, score: 0.8 }],
			rendered: `MEMORYMARK ${mark} alpha zebra`,
		} } };
	});
	const box = sandbox(t, { base: server.base, mode: "off" });
	const root = dirname(box.home);
	const env = { ...box.env, TMPDIR: join(root, "tmp"), OPENVIKING_STATE_DIR: join(box.home, "ov-state") };
	mkdirSync(env.TMPDIR);
	writeFileSync(join(env.TMPDIR, "KEEP.txt"), "KEEPMARK\n");
	const tmpBefore = readdirSync(env.TMPDIR).sort();
	peer = projectPeer(buildPluginConfig("pi", { cwd: box.project, env }), box.project, env);
	const sample = join(root, "sample.json");
	const sampleBytes = JSON.stringify({ prompts: [{ harness: "pi", cwd: box.project, prompt: "PROMPTMARK alpha zebra" }] });
	writeFileSync(sample, sampleBytes);
	const out = join(root, "replay.md");

	const child = await runReplay(["--sample", sample, "--out", out], env);
	assert.equal(child.status, 0);
	const output = readFileSync(out, "utf8");
	assert.ok(output.includes("CHAINMARK"), "the output holds the chain result");
	assert.ok(output.includes("RECALLMARK"), "the output holds the recall result");
	assert.equal(statSync(out).mode & 0o777, 0o600);
	assert.equal(readFileSync(sample, "utf8"), sampleBytes);
	for (const file of allFiles(root)) {
		if (file === out || file === sample) continue;
		const text = readFileSync(file, "latin1");
		for (const mark of ["PROMPTMARK", "MEMORYMARK", "SOURCEMARK", "CHAINMARK", "RECALLMARK"]) assert.ok(!text.includes(mark), `${mark} in ${file}`);
	}
	assert.deepEqual(readdirSync(env.TMPDIR).sort(), tmpBefore, "the private state folder is removed");
	assert.equal(existsSync(box.state), false, "no shadow record line");
});

test("the replay refuses --out inside a git repository, through a link and at an existing file, and sends no request", async (t) => {
	const server = await fakeOpenViking(t, () => ({ status: 200, json: { status: "ok", result: { entries: [], rendered: "" } } }));
	const box = sandbox(t, { base: server.base, mode: "off" });
	const root = dirname(box.home);
	const sample = join(root, "sample.json");
	writeFileSync(sample, JSON.stringify({ prompts: [{ harness: "claude-code", cwd: box.project, prompt: "PROMPTMARK alpha zebra" }] }));
	const repo = join(root, "repo");
	mkdirSync(join(repo, "inner"), { recursive: true });
	spawnSync("git", ["init", "-q", repo]);
	const inRepo = join(repo, "replay.md");
	const link = join(root, "link");
	symlinkSync(join(repo, "inner"), link);
	const existing = join(root, "existing.md");
	writeFileSync(existing, "KEEPMARK\n");

	const first = await runReplay(["--sample", sample, "--out", inRepo], box.env);
	assert.notEqual(first.status, 0);
	assert.equal(existsSync(inRepo), false);
	const second = await runReplay(["--sample", sample, "--out", existing], box.env);
	assert.notEqual(second.status, 0);
	assert.equal(readFileSync(existing, "utf8"), "KEEPMARK\n");
	const third = await runReplay(["--sample", sample, "--out", join(link, "report.md")], box.env);
	assert.notEqual(third.status, 0);
	assert.deepEqual(readdirSync(join(repo, "inner")), [], "the real folder gets no file");
	assert.equal(first.stdout + second.stdout + third.stdout, "");
	assert.deepEqual(server.requests, [], "a refusal sends no request");
});
