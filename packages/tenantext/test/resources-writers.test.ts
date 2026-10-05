import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ResourceFileError, buildInventory, itemKey, readFiles, type Dirs, type ResourceItem } from "../extensions/resources/inventory.ts";
import { commitWrites, planWrites } from "../extensions/resources/writers.ts";

function put(file: string, content: string | object = "") {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
}

const MCP = { autoEnableCodemode: false, mcpServers: { live: { command: "a", args: ["--x"] }, parked: { command: "b", enabled: false } }, disabledMcpServers: { old: { command: "c" } } };

function fixture(settings: object, projectSettings?: object): Dirs & { root: string } {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "resources-wr-")));
	const agentDir = join(root, "home/.pi/agent"), projectDir = join(root, "project/.pi"), homeDir = join(root, "home");
	for (const file of ["extensions/solo.ts", "extensions/other.ts", "skills/alpha/SKILL.md", "skills/beta/SKILL.md", "prompts/review.md"]) put(join(agentDir, file));
	put(join(homeDir, ".agents/skills/shared/SKILL.md"));
	put(join(projectDir, "extensions/pe.ts"));
	put(join(root, "home/.pi/kit/package.json"), { name: "kit", pi: { extensions: ["./extensions/a/index.ts", "./extensions/b/index.ts"], skills: ["./skills"] } });
	for (const file of ["extensions/a/index.ts", "extensions/b/index.ts", "skills/kit-skill/SKILL.md"]) put(join(root, "home/.pi/kit", file));
	put(join(agentDir, "npm/node_modules/npm-kit/extensions/x.ts"));
	put(join(agentDir, "npm/node_modules/npm-kit/prompts/p.md"));
	put(join(agentDir, "settings.json"), settings);
	if (projectSettings) put(join(projectDir, "settings.json"), projectSettings);
	put(join(agentDir, "mcp.json"), MCP);
	put(join(projectDir, "mcp.json"), { mcpServers: { proj: { url: "http://localhost/mcp" } } });
	return { root, agentDir, projectDir, homeDir };
}

const SETTINGS = { defaultModel: "m", packages: ["../kit", "npm:npm-kit"], theme: "dark", nested: { keep: [1, 2] } };
const read = (dirs: Dirs, name: string) => readFileSync(join(dirs.agentDir, name), "utf8");
const json = (dirs: Dirs, name: string) => JSON.parse(read(dirs, name));

/** Set one item, write the files, and check the new inventory. */
function toggle(dirs: Dirs, match: Partial<ResourceItem>, enabled: boolean, writeProject = false) {
	const inventory = buildInventory(dirs, readFiles(dirs));
	const item = inventory.find(candidate => Object.entries(match).every(([key, value]) => candidate[key as keyof ResourceItem] === value));
	assert.ok(item, `no item ${JSON.stringify(match)}`);
	const plan = planWrites(dirs, readFiles(dirs), [{ ...item, enabled }], { writeProject });
	commitWrites(plan.writes);
	const after = buildInventory(dirs, readFiles(dirs));
	if (plan.changes.length) assert.equal(after.find(candidate => itemKey(candidate) === itemKey(item))?.enabled, enabled);
	// No other item changes.
	for (const other of inventory) if (itemKey(other) !== itemKey(item)) assert.equal(after.find(candidate => itemKey(candidate) === itemKey(other))?.enabled, other.enabled, other.id);
	return plan;
}

function withFixture(settings: object, run: (dirs: Dirs) => void, projectSettings?: object) {
	const dirs = fixture(settings, projectSettings);
	try { run(dirs); } finally { rmSync(dirs.root, { recursive: true, force: true }); }
}

test("round trip: a local item, a skill, a package item, an MCP server and a built-in leave the files byte-equal", () => {
	withFixture(SETTINGS, dirs => {
		const settings = read(dirs, "settings.json"), mcp = read(dirs, "mcp.json");
		const cases: [Partial<ResourceItem>, (now: any) => void][] = [
			[{ id: "extensions/solo.ts" }, now => assert.deepEqual(now.extensions, ["-extensions/solo.ts"])],
			[{ id: "skills/alpha" }, now => assert.deepEqual(now.skills, ["-skills/alpha"])],
			[{ id: "~/.agents/skills/shared" }, now => assert.deepEqual(now.skills, ["-skills/shared"])],
			[{ id: "prompts/review.md" }, now => assert.deepEqual(now.prompts, ["-prompts/review.md"])],
			[{ id: "builtin:mcp" }, now => assert.deepEqual(now.extensions, ["-builtin:mcp"])],
			[{ id: "extensions/a/index.ts" }, now => assert.deepEqual(now.packages, [{ source: "../kit", extensions: ["!extensions/a/index.ts"] }, "npm:npm-kit"])],
			[{ id: "skills/kit-skill" }, now => assert.deepEqual(now.packages[0], { source: "../kit", skills: ["!skills/kit-skill"] })],
			[{ id: "prompts/p.md" }, now => assert.deepEqual(now.packages[1], { source: "npm:npm-kit", prompts: ["!prompts/p.md"] })],
		];
		for (const [match, check] of cases) {
			const plan = toggle(dirs, match, false);
			assert.deepEqual(plan.writes.map(write => write.file), [join(dirs.agentDir, "settings.json")]);
			const now = json(dirs, "settings.json");
			check(now);
			assert.deepEqual(Object.keys(now).slice(0, 4), ["defaultModel", "packages", "theme", "nested"]);
			assert.equal(read(dirs, "mcp.json"), mcp);
			toggle(dirs, match, true);
			assert.equal(read(dirs, "settings.json"), settings, JSON.stringify(match));
		}
		const plan = toggle(dirs, { kind: "mcp", id: "live" }, false);
		assert.deepEqual(plan.writes.map(write => write.file), [join(dirs.agentDir, "mcp.json")]);
		assert.deepEqual(json(dirs, "mcp.json").mcpServers.live, { command: "a", args: ["--x"], enabled: false });
		assert.equal(read(dirs, "settings.json"), settings);
		toggle(dirs, { kind: "mcp", id: "live" }, true);
		assert.equal(read(dirs, "mcp.json"), mcp);
	});
});

test("several changes go to the files in one plan, and no change gives no write", () => {
	withFixture(SETTINGS, dirs => {
		const inventory = buildInventory(dirs, readFiles(dirs));
		assert.deepEqual(planWrites(dirs, readFiles(dirs), inventory).writes, []);
		const off = new Set(["extensions/solo.ts", "extensions/b/index.ts", "live", "builtin:codemode"]);
		const plan = planWrites(dirs, readFiles(dirs), inventory.map(item => off.has(item.id) ? { ...item, enabled: false } : item));
		assert.equal(plan.changes.length, 4);
		assert.equal(plan.writes.length, 2);
		for (const write of plan.writes) assert.ok(write.content.endsWith("}\n") && write.content.includes('\n  "'));
		commitWrites(plan.writes);
		assert.deepEqual(buildInventory(dirs, readFiles(dirs)).filter(item => !item.enabled).map(item => item.id).sort(),
			["builtin:codemode", "extensions/b/index.ts", "extensions/solo.ts", "live", "old", "parked"]);
	});
});

test("MCP: enabled goes on the defining entry, and a disabledMcpServers entry moves only when it is toggled", () => {
	withFixture(SETTINGS, dirs => {
		toggle(dirs, { kind: "mcp", id: "parked" }, true);
		assert.deepEqual(json(dirs, "mcp.json").mcpServers.parked, { command: "b" });
		assert.deepEqual(json(dirs, "mcp.json").disabledMcpServers, { old: { command: "c" } });
		toggle(dirs, { kind: "mcp", id: "old" }, true);
		const now = json(dirs, "mcp.json");
		assert.deepEqual(now.mcpServers.old, { command: "c" });
		assert.equal(now.disabledMcpServers, undefined);
		assert.equal(now.autoEnableCodemode, false);
		toggle(dirs, { kind: "mcp", id: "old" }, false);
		assert.deepEqual(json(dirs, "mcp.json").mcpServers.old, { command: "c", enabled: false });
	});
});

test("existing filters: [] takes a plain path, a broad !glob takes +path, and a lone !pattern goes away", () => {
	withFixture({ packages: [{ source: "../kit", extensions: [], skills: ["!kit-skill"] }, "npm:npm-kit"], extensions: ["!*.ts"], skills: ["!alpha"] }, dirs => {
		toggle(dirs, { id: "extensions/a/index.ts" }, true);
		assert.deepEqual(json(dirs, "settings.json").packages[0].extensions, ["extensions/a/index.ts"]);
		toggle(dirs, { id: "extensions/b/index.ts" }, true);
		assert.deepEqual(json(dirs, "settings.json").packages[0].extensions, ["extensions/a/index.ts", "extensions/b/index.ts"]);
		toggle(dirs, { id: "extensions/a/index.ts" }, false);
		toggle(dirs, { id: "extensions/a/index.ts" }, true);
		assert.deepEqual(json(dirs, "settings.json").packages[0].extensions, ["extensions/a/index.ts", "extensions/b/index.ts"]);
		// `!*.ts` covers solo.ts and other.ts, so it stays.
		toggle(dirs, { id: "extensions/solo.ts" }, true);
		assert.deepEqual(json(dirs, "settings.json").extensions, ["!*.ts", "+extensions/solo.ts"]);
		toggle(dirs, { id: "extensions/solo.ts" }, false);
		assert.deepEqual(json(dirs, "settings.json").extensions, ["!*.ts", "-extensions/solo.ts"]);
		// `!alpha` matches only skills/alpha.
		toggle(dirs, { id: "skills/alpha" }, true);
		assert.equal(json(dirs, "settings.json").skills, undefined);
	});
	withFixture({ packages: [{ source: "../kit", skills: ["!kit-skill"] }, { source: "npm:npm-kit", autoload: true }] }, dirs => {
		// `!kit-skill` is a glob on the name, not the exact entry, so it stays and `+path` wins.
		toggle(dirs, { id: "skills/kit-skill" }, true);
		assert.deepEqual(json(dirs, "settings.json").packages, [{ source: "../kit", skills: ["!kit-skill", "+skills/kit-skill"] }, { source: "npm:npm-kit", autoload: true }]);
	});
});

test("project items stay unchanged unless writeProject is set", () => {
	withFixture(SETTINGS, dirs => {
		const project = join(dirs.projectDir, "settings.json");
		const before = readFileSync(project, "utf8");
		const plan = toggle(dirs, { id: "extensions/pe.ts" }, false);
		assert.deepEqual(plan.writes, []);
		assert.match(plan.notes.join("\n"), /Project item left unchanged/);
		assert.equal(readFileSync(project, "utf8"), before);
		toggle(dirs, { id: "extensions/pe.ts" }, false, true);
		assert.deepEqual(JSON.parse(readFileSync(project, "utf8")), { quiet: true, extensions: ["-extensions/pe.ts"] });
	}, { quiet: true });
});

test("a malformed file aborts the plan", () => {
	withFixture(SETTINGS, dirs => {
		const inventory = buildInventory(dirs, readFiles(dirs));
		writeFileSync(join(dirs.agentDir, "settings.json"), "{ broken");
		assert.throws(() => planWrites(dirs, readFiles(dirs), inventory.map(item => ({ ...item, enabled: false }))), ResourceFileError);
		assert.equal(read(dirs, "settings.json"), "{ broken");
	});
});

/** Off then on for one item of each writer path; both files must come back byte-equal. */
function roundTrips(dirs: Dirs) {
	const settings = read(dirs, "settings.json"), mcp = read(dirs, "mcp.json");
	for (const match of [{ id: "extensions/solo.ts" }, { id: "builtin:mcp" }, { id: "extensions/a/index.ts" }, { kind: "mcp", id: "live" }] as Partial<ResourceItem>[]) {
		const plan = toggle(dirs, match, false);
		assert.equal(plan.writes.length, 1);
		assert.notEqual(read(dirs, "settings.json") + read(dirs, "mcp.json"), settings + mcp);
		toggle(dirs, match, true);
		assert.equal(read(dirs, "settings.json"), settings, JSON.stringify(match));
		assert.equal(read(dirs, "mcp.json"), mcp, JSON.stringify(match));
	}
}

test("round trip on a file that Pi wrote: 2 spaces and no trailing newline", () => {
	withFixture(SETTINGS, dirs => {
		writeFileSync(join(dirs.agentDir, "settings.json"), JSON.stringify(SETTINGS, null, 2));
		writeFileSync(join(dirs.agentDir, "mcp.json"), JSON.stringify(MCP, null, 2));
		toggle(dirs, { id: "extensions/solo.ts" }, false);
		assert.ok(read(dirs, "settings.json").endsWith("}"), "no newline is added");
		toggle(dirs, { id: "extensions/solo.ts" }, true);
		roundTrips(dirs);
	});
});

test("round trip on a file with 4 spaces, and on one with tabs", () => {
	for (const indent of [4, "\t"]) withFixture(SETTINGS, dirs => {
		writeFileSync(join(dirs.agentDir, "settings.json"), `${JSON.stringify(SETTINGS, null, indent)}\n`);
		writeFileSync(join(dirs.agentDir, "mcp.json"), `${JSON.stringify(MCP, null, indent)}\n`);
		toggle(dirs, { id: "extensions/solo.ts" }, false);
		assert.match(read(dirs, "settings.json"), indent === 4 ? /\n {4}"extensions": \[\n {8}"-extensions\/solo\.ts"\n {4}\]\n\}\n$/ : /\n\t"extensions": \[\n\t\t"-extensions\/solo\.ts"\n\t\]\n\}\n$/);
		toggle(dirs, { id: "extensions/solo.ts" }, true);
		roundTrips(dirs);
	});
});

test("a new file gets 2 spaces and a trailing newline", () => {
	withFixture(SETTINGS, dirs => {
		rmSync(join(dirs.agentDir, "settings.json"));
		toggle(dirs, { id: "builtin:codemode" }, false);
		assert.equal(read(dirs, "settings.json"), '{\n  "extensions": [\n    "-builtin:codemode"\n  ]\n}\n');
	});
});

test("three keys added in turn go away in the same order, and the files are byte-equal", () => {
	withFixture(SETTINGS, dirs => {
		const settings = read(dirs, "settings.json");
		const order = ["extensions/solo.ts", "skills/alpha", "prompts/review.md"];
		for (const id of order) toggle(dirs, { id }, false);
		assert.deepEqual(Object.keys(json(dirs, "settings.json")).slice(-3), ["extensions", "skills", "prompts"]);
		for (const id of order) toggle(dirs, { id }, true);
		assert.equal(read(dirs, "settings.json"), settings);
	});
});

test("an original empty array and an explicit enabled: true are lost on turn-on", () => {
	withFixture({ extensions: [], packages: ["../kit"], skills: ["-skills/alpha"], theme: "dark" }, dirs => {
		toggle(dirs, { id: "extensions/solo.ts" }, false);
		toggle(dirs, { id: "extensions/solo.ts" }, true);
		toggle(dirs, { id: "skills/alpha" }, true);
		assert.deepEqual(json(dirs, "settings.json"), { packages: ["../kit"], theme: "dark" });

		put(join(dirs.agentDir, "mcp.json"), { mcpServers: { live: { enabled: true, command: "a" }, parked: { enabled: false, command: "b" } } });
		toggle(dirs, { kind: "mcp", id: "live" }, false);
		assert.deepEqual(json(dirs, "mcp.json").mcpServers.live, { enabled: false, command: "a" });
		toggle(dirs, { kind: "mcp", id: "live" }, true);
		toggle(dirs, { kind: "mcp", id: "parked" }, true);
		assert.deepEqual(json(dirs, "mcp.json").mcpServers, { live: { command: "a" }, parked: { command: "b" } });
	});
});

test("a symlinked mcp.json with mode 600 keeps its link and its mode after a write", () => {
	withFixture(SETTINGS, dirs => {
		const link = join(dirs.agentDir, "mcp.json"), target = join(dirs.homeDir!, "dotfiles/mcp.json");
		mkdirSync(dirname(target), { recursive: true });
		renameSync(link, target);
		chmodSync(target, 0o600);
		symlinkSync(target, link);
		chmodSync(join(dirs.agentDir, "settings.json"), 0o600);
		toggle(dirs, { kind: "mcp", id: "live" }, false);
		toggle(dirs, { id: "extensions/solo.ts" }, false);
		assert.ok(lstatSync(link).isSymbolicLink(), "the link is still a link");
		assert.equal(statSync(target).mode & 0o777, 0o600);
		assert.equal(JSON.parse(readFileSync(target, "utf8")).mcpServers.live.enabled, false);
		assert.equal(statSync(join(dirs.agentDir, "settings.json")).mode & 0o777, 0o600);
		assert.ok(!lstatSync(join(dirs.agentDir, "settings.json")).isSymbolicLink());
	});
});

const projectFile = (dirs: Dirs) => join(dirs.projectDir, "mcp.json");
const plan = (dirs: Dirs, match: Partial<ResourceItem>, enabled: boolean, writeProject = false) => {
	const item = buildInventory(dirs, readFiles(dirs)).find(candidate => Object.entries(match).every(([key, value]) => candidate[key as keyof ResourceItem] === value));
	assert.ok(item, `no item ${JSON.stringify(match)}`);
	const result = planWrites(dirs, readFiles(dirs), [{ ...item, enabled }], { writeProject });
	commitWrites(result.writes);
	return result;
};

test("MCP override: a user row writes the user file, and the result names the project override that decides", () => {
	withFixture(SETTINGS, dirs => {
		put(projectFile(dirs), { mcpServers: { live: { enabled: false }, parked: { exposure: "direct" }, proj: { url: "http://localhost/mcp" } } });
		const project = readFileSync(projectFile(dirs), "utf8");
		const off = plan(dirs, { kind: "mcp", scope: "user", id: "live" }, false);
		assert.deepEqual(off.writes.map(write => write.file), [join(dirs.agentDir, "mcp.json")]);
		assert.equal(json(dirs, "mcp.json").mcpServers.live.enabled, false);
		assert.deepEqual(off.changes.map(change => change.id), ["live"]);
		assert.deepEqual(off.notes, [`In a trusted project, the project override in ${projectFile(dirs)} keeps mcp live off.`]);
		const on = plan(dirs, { kind: "mcp", scope: "user", id: "live" }, true);
		assert.equal(json(dirs, "mcp.json").mcpServers.live.enabled, undefined);
		assert.match(on.notes.join("\n"), /In a trusted project, the project override in .* keeps mcp live off\./);
		// An override that sets only `exposure` does not decide the state: no note, and the override row follows the user file.
		const tuned = plan(dirs, { kind: "mcp", scope: "user", id: "parked" }, true);
		assert.deepEqual(tuned.notes, []);
		assert.equal(buildInventory(dirs, readFiles(dirs)).find(item => item.override && item.id === "parked")?.enabled, true);
		// A saved state with the user row and that override row: the user row write gives both. No note and no project write, also with the option.
		const saved = buildInventory(dirs, readFiles(dirs)).filter(item => item.kind === "mcp" && item.id === "parked");
		assert.deepEqual(saved.map(item => item.enabled), [true, true]);
		plan(dirs, { kind: "mcp", scope: "user", id: "parked" }, false);
		for (const writeProject of [false, true]) {
			const back = planWrites(dirs, readFiles(dirs), saved, { writeProject });
			assert.deepEqual(back.notes, []);
			assert.deepEqual(back.writes.map(write => write.file), [join(dirs.agentDir, "mcp.json")]);
			assert.deepEqual(back.changes.map(change => change.scope), ["user"]);
		}
		// A different desired state for that override row alone is still a project change.
		const pin = planWrites(dirs, readFiles(dirs), [{ ...saved[1], enabled: true }]);
		assert.deepEqual(pin.notes, ["Project item left unchanged: mcp parked."]);
		plan(dirs, { kind: "mcp", scope: "user", id: "parked" }, true);
		// The project scope is read-only by default.
		const refused = plan(dirs, { kind: "mcp", scope: "project", id: "live" }, true);
		assert.deepEqual(refused.writes, []);
		assert.deepEqual(refused.notes, ["Project item left unchanged: mcp live."]);
		assert.equal(readFileSync(projectFile(dirs), "utf8"), project);
	});
});

test("MCP override: with the project write option, on and off write an explicit enabled value, as Pi does", async () => {
	const config = new URL("./extensions/mcp/config.js", import.meta.resolve("@earendil-works/pi-coding-agent"));
	const { updateMcpServerConfig } = await import(config.href);
	withFixture(SETTINGS, dirs => {
		const start = { mcpServers: { live: { enabled: false, exposure: "direct" }, parked: { exposure: "direct" }, ghost: { enabled: false }, proj: { url: "http://localhost/mcp" } } };
		put(projectFile(dirs), start);
		const user = read(dirs, "mcp.json");
		const twin = join(dirs.projectDir, "pi-twin.json");
		put(twin, start);
		for (const [id, enabled] of [["live", true], ["live", false], ["parked", true], ["parked", false]] as [string, boolean][]) {
			const result = plan(dirs, { kind: "mcp", scope: "project", id }, enabled, true);
			assert.deepEqual(result.writes.map(write => write.file), [projectFile(dirs)], `${id} ${enabled}`);
			assert.equal(JSON.parse(readFileSync(projectFile(dirs), "utf8")).mcpServers[id].enabled, enabled, `${id} ${enabled}`);
			updateMcpServerConfig(twin, id, { enabled }, { override: true });
			assert.equal(readFileSync(projectFile(dirs), "utf8"), readFileSync(twin, "utf8"), `${id} ${enabled}`);
		}
		assert.deepEqual(JSON.parse(readFileSync(projectFile(dirs), "utf8")).mcpServers.live, { enabled: false, exposure: "direct" });
		// Pi ignores an override without a user server, so no write changes it.
		const ghost = plan(dirs, { kind: "mcp", scope: "project", id: "ghost" }, true, true);
		assert.deepEqual(ghost.writes, []);
		assert.deepEqual(ghost.notes, ["Pi has no setting that changes this item: mcp ghost."]);
		// A project server keeps the old rule: turn-on deletes the key.
		plan(dirs, { kind: "mcp", scope: "project", id: "proj" }, false, true);
		plan(dirs, { kind: "mcp", scope: "project", id: "proj" }, true, true);
		assert.deepEqual(JSON.parse(readFileSync(projectFile(dirs), "utf8")).mcpServers.proj, { url: "http://localhost/mcp" });
		assert.equal(read(dirs, "mcp.json"), user);
	});
});

test("MCP: a project server with the name of a user server replaces it, and the result says so", () => {
	withFixture(SETTINGS, dirs => {
		put(projectFile(dirs), { mcpServers: { live: { command: "p" } } });
		const result = plan(dirs, { kind: "mcp", scope: "user", id: "live" }, false);
		assert.equal(json(dirs, "mcp.json").mcpServers.live.enabled, false);
		assert.deepEqual(result.notes, [`The project server in ${projectFile(dirs)} replaces mcp live in this project, when the project is trusted.`]);
	});
});
