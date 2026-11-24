// Behavior 5: the shadow record holds no prompt text and no memory text, and its write follows no link.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectPeer, runShadow, writeShadowRecord } from "../src/shadow.mjs";
import { buildPluginConfig } from "../../openviking-pi/shared/plugin-config.mjs";
import { fakeOpenViking, sandbox } from "./helpers.mjs";

test("the shadow record holds times, kinds and opaque identifiers, but no prompt or memory text", async (t) => {
	let peer = "";
	const server = await fakeOpenViking(t, (body) => ({ status: 200, json: { status: "ok", result: { entries: [
		{ uri: `viking://user/tester/peers/${peer}/memories/SOURCEMARK.md`, text: "MEMORYMARK alpha zebra", score: 0.8 },
	] } } }));
	const box = sandbox(t, { base: server.base });
	peer = projectPeer(buildPluginConfig("pi", { cwd: box.project, env: box.env }), box.project, box.env);
	const { result } = await runShadow({ harness: "pi", prompt: "PROMPTMARK alpha zebra", cwd: box.project, env: box.env });
	assert.equal(result.kind, "full");
	assert.ok(result.block.includes("MEMORYMARK"));
	const files = readdirSync(box.state);
	assert.equal(files.length, 1);
	const file = join(box.state, files[0]);
	assert.equal(statSync(box.state).mode & 0o777, 0o700);
	assert.equal(statSync(file).mode & 0o777, 0o600);
	const raw = readFileSync(file, "utf8");
	for (const mark of ["PROMPTMARK", "zebra", "MEMORYMARK", "SOURCEMARK", peer]) assert.ok(!raw.includes(mark), `${mark} in the record`);
	const record = JSON.parse(raw.trim());
	assert.equal(record.kind, "full");
	assert.equal(record.chars, result.block.length);
	assert.ok(record.selected.length >= 1);
	for (const item of record.selected) {
		assert.equal(typeof item.score, "number");
		assert.equal(typeof item.length, "number");
	}
});

test("a symbolic link at the day file or at the record folder is refused, and its target keeps its bytes and mode", async (t) => {
	const box = sandbox(t, {});
	const now = Date.UTC(2026, 0, 15);
	const outside = join(box.home, "outside");
	mkdirSync(outside, { mode: 0o755 });
	chmodSync(outside, 0o755);
	const victim = join(outside, "victim.txt");
	writeFileSync(victim, "KEEPMARK\n");
	chmodSync(victim, 0o644);
	// A link at the day file.
	mkdirSync(box.state, { recursive: true });
	symlinkSync(victim, join(box.state, "shadow-2026-01-15.jsonl"));
	assert.throws(() => writeShadowRecord({ v: 1 }, { env: box.env, now }));
	// A link at the record folder.
	const env = { ...box.env, XDG_STATE_HOME: join(box.home, "state-two") };
	mkdirSync(join(env.XDG_STATE_HOME, "tenant-pi"), { recursive: true });
	symlinkSync(outside, join(env.XDG_STATE_HOME, "tenant-pi", "memory-chain"));
	assert.throws(() => writeShadowRecord({ v: 1 }, { env, now }));
	assert.equal(readFileSync(victim, "utf8"), "KEEPMARK\n");
	assert.equal(statSync(victim).mode & 0o777, 0o644);
	assert.equal(statSync(outside).mode & 0o777, 0o755);
	assert.deepEqual(readdirSync(outside), ["victim.txt"]);
});

test("a record write removes no record file, also one 20 days old", async (t) => {
	const box = sandbox(t, {});
	const now = Date.UTC(2026, 0, 30);
	mkdirSync(box.state, { recursive: true });
	const old = join(box.state, `shadow-${new Date(now - 20 * 86400000).toISOString().slice(0, 10)}.jsonl`);
	writeFileSync(old, "OLDMARK\n");
	writeShadowRecord({ v: 1, mark: "NEWMARK" }, { env: box.env, now });
	assert.equal(readFileSync(old, "utf8"), "OLDMARK\n");
	const today = join(box.state, `shadow-${new Date(now).toISOString().slice(0, 10)}.jsonl`);
	assert.ok(readFileSync(today, "utf8").includes("NEWMARK"), "the new line is in the day file of now");
});
