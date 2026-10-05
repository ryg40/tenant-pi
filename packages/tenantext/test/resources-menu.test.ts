import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { Dirs } from "../extensions/resources/inventory.ts";
import { APPLY_PROFILE, DISCARD, SAVE_PROFILE, SET_DEFAULT, runResources, type ResourcesContext } from "../extensions/resources/menu.ts";
import { listProfiles, loadProfile } from "../extensions/resources/profiles.ts";

function put(file: string, content: string | object = "") {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
}

function fixture(): Dirs & { root: string } {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "resources-menu-")));
	const agentDir = join(root, "home/.pi/agent"), projectDir = join(root, "project/.pi"), homeDir = join(root, "home");
	for (const file of ["extensions/solo.ts", "skills/alpha/SKILL.md", "prompts/review.md"]) put(join(agentDir, file));
	put(join(projectDir, "extensions/pe.ts"));
	put(join(root, "home/.pi/kit/extensions/a.ts"));
	put(join(agentDir, "settings.json"), { theme: "dark", packages: ["../kit"] });
	put(join(agentDir, "mcp.json"), { mcpServers: { live: { command: "a" } } });
	return { root, agentDir, projectDir, homeDir };
}

interface Script { choices?: (string | undefined)[]; inputs?: (string | undefined)[]; confirms?: boolean[]; hasUI?: boolean }

/** A mocked `ctx.ui`. A choice selects the first option that contains the text. */
function mock(script: Script) {
	const choices = [...script.choices ?? []], inputs = [...script.inputs ?? []], confirms = [...script.confirms ?? []];
	const log = { notices: [] as string[], titles: [] as string[], options: [] as string[][], confirmed: [] as string[], reloads: 0 };
	const ctx: ResourcesContext = {
		hasUI: script.hasUI ?? true,
		reload: async () => { log.reloads++; },
		ui: {
			select: async (title: string, options: string[]) => {
				log.titles.push(title);
				log.options.push(options);
				assert.ok(choices.length > 0, "the script has no more choices");
				const next = choices.shift();
				return next === undefined ? undefined : options.find(option => option.includes(next)) ?? assert.fail(`missing ${next}`);
			},
			input: async () => inputs.shift(),
			confirm: async (title: string, message: string) => { log.confirmed.push(`${title}\n${message}`); return confirms.shift() ?? assert.fail("unexpected confirm"); },
			notify: (text: string) => { log.notices.push(text); },
		},
	};
	return { ctx, log };
}

function snapshot(dirs: Dirs) {
	return ["settings.json", "mcp.json"].map(name => readFileSync(join(dirs.agentDir, name), "utf8")).join("\u0000");
}

async function withFixture(run: (dirs: Dirs) => Promise<void>) {
	const dirs = fixture();
	try { await run(dirs); } finally { rmSync(dirs.root, { recursive: true, force: true }); }
}

test("the menu lists the groups in order, toggles one item, writes it as the default and reloads", () => withFixture(async dirs => {
	const { ctx, log } = mock({ choices: ["user local extensions/solo.ts", SET_DEFAULT] });
	await runResources("", ctx, { dirs });
	assert.deepEqual(log.options[0], [
		"[x] extension user package extensions/a.ts (../kit)",
		"[x] extension project local extensions/pe.ts (read-only)",
		"[x] extension user local extensions/solo.ts",
		"[x] extension user local builtin:mcp",
		"[x] extension user local builtin:llama.cpp",
		"[x] extension user local builtin:codemode",
		"[x] extension user local builtin:tool-search",
		"[x] mcp user mcp live",
		"[x] skill user local skills/alpha",
		"[x] prompt user local prompts/review.md",
		SET_DEFAULT, SAVE_PROFILE, APPLY_PROFILE, DISCARD,
	]);
	assert.ok(log.options[1]!.includes("[ ] extension user local extensions/solo.ts (changed)"));
	assert.match(log.titles[1]!, /1 changed/);
	assert.deepEqual(JSON.parse(readFileSync(join(dirs.agentDir, "settings.json"), "utf8")), { theme: "dark", packages: ["../kit"], extensions: ["-extensions/solo.ts"] });
	assert.equal(log.reloads, 1);
	assert.equal(log.options.length, 2, "the loop ends after the write");
	assert.match(log.notices.join("\n"), /Wrote 1 change/);
}));

test("discard and Esc write nothing, and a project item is read-only", () => withFixture(async dirs => {
	const before = snapshot(dirs);
	for (const last of [DISCARD, undefined]) {
		const { ctx, log } = mock({ choices: ["extensions/solo.ts", "mcp user mcp live", "extensions/pe.ts", last] });
		await runResources("", ctx, { dirs });
		assert.equal(snapshot(dirs), before);
		assert.equal(log.reloads, 0);
		assert.match(log.titles[3]!, /2 changed/);
		assert.ok(log.options[3]!.includes("[x] extension project local extensions/pe.ts (read-only)"));
		assert.match(log.notices.join("\n"), /read-only/);
	}
	const { ctx, log } = mock({ choices: [SET_DEFAULT, DISCARD] });
	await runResources("", ctx, { dirs });
	assert.equal(snapshot(dirs), before);
	assert.equal(log.reloads, 0);
	assert.match(log.notices.join("\n"), /No changes to write/);
}));

test("save as profile keeps the settings, and apply profile shows the diff before it writes", () => withFixture(async dirs => {
	const before = snapshot(dirs);
	const save = mock({ choices: ["extensions/a.ts", "mcp user mcp live", SAVE_PROFILE, SAVE_PROFILE, DISCARD], inputs: ["Bad Name", "lean"] });
	await runResources("", save.ctx, { dirs });
	assert.equal(snapshot(dirs), before);
	assert.equal(save.log.reloads, 0);
	assert.match(save.log.notices[0]!, /not a valid profile name/);
	assert.deepEqual(listProfiles(dirs.agentDir).map(profile => profile.name), ["lean"]);
	assert.deepEqual(loadProfile(dirs.agentDir, "lean").items.filter(item => !item.enabled).map(item => item.id), ["extensions/a.ts", "live"]);

	const refuse = mock({ choices: [APPLY_PROFILE, "lean", DISCARD], confirms: [false] });
	await runResources("", refuse.ctx, { dirs });
	assert.equal(snapshot(dirs), before);
	assert.match(refuse.log.confirmed[0]!, /Apply profile "lean"\noff  extension user package extensions\/a\.ts \(\.\.\/kit\)\noff  mcp user mcp live/);

	const apply = mock({ choices: [APPLY_PROFILE, "lean"], confirms: [true] });
	await runResources("", apply.ctx, { dirs });
	assert.equal(apply.log.reloads, 1);
	assert.deepEqual(JSON.parse(readFileSync(join(dirs.agentDir, "settings.json"), "utf8")).packages, [{ source: "../kit", extensions: ["!extensions/a.ts"] }]);
	assert.deepEqual(JSON.parse(readFileSync(join(dirs.agentDir, "mcp.json"), "utf8")).mcpServers.live, { command: "a", enabled: false });
}));

test("the command arguments: list, save, profiles, apply and delete", () => withFixture(async dirs => {
	const before = snapshot(dirs);
	const list = mock({ hasUI: false });
	await runResources("list", list.ctx, { dirs });
	await runResources("", list.ctx, { dirs });
	assert.equal(list.log.notices[0], list.log.notices[1], "with no UI the menu prints the list");
	assert.equal(list.log.notices[0]!.split("\n")[0], "[x] extension user package extensions/a.ts (../kit)");
	assert.equal(list.log.notices[0]!.split("\n").length, 10);

	const run = mock({ confirms: [true, false, true] });
	await runResources("save base", run.ctx, { dirs });
	await runResources("profiles", run.ctx, { dirs });
	assert.match(run.log.notices[1]!, /^base {2}\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
	// The settings change after the save. The profile brings the old state back.
	put(join(dirs.agentDir, "settings.json"), { theme: "dark", packages: ["../kit"], prompts: ["-prompts/review.md"] });
	await runResources("apply base", run.ctx, { dirs });
	assert.match(run.log.confirmed[0]!, /on {3}prompt user local prompts\/review\.md/);
	assert.equal(snapshot(dirs), before);
	assert.equal(run.log.reloads, 1);
	await runResources("delete base", run.ctx, { dirs });
	assert.equal(listProfiles(dirs.agentDir).length, 1, "a refused confirm keeps the profile");
	await runResources("delete base", run.ctx, { dirs });
	assert.deepEqual(listProfiles(dirs.agentDir), []);
	for (const bad of ["apply none", "delete none", "save", "save a b", "nonsense", "save Bad"]) await runResources(bad, run.ctx, { dirs });
	assert.match(run.log.notices.slice(-6).join("\n"), /does not exist[\s\S]*does not exist[\s\S]*Usage[\s\S]*Usage[\s\S]*Usage[\s\S]*not a valid profile name/);
	assert.equal(run.log.reloads, 1);
}));

test("a malformed file gives a message that names the file, and nothing is written", () => withFixture(async dirs => {
	writeFileSync(join(dirs.agentDir, "settings.json"), "{ broken");
	const before = snapshot(dirs);
	const { ctx, log } = mock({});
	for (const args of ["", "list", "save x", "apply x"]) await runResources(args, ctx, { dirs });
	assert.equal(log.notices.length, 4);
	for (const notice of log.notices) assert.ok(notice.includes(join(dirs.agentDir, "settings.json")), notice);
	assert.equal(snapshot(dirs), before);
	assert.deepEqual(listProfiles(dirs.agentDir), []);
	assert.equal(log.reloads, 0);
}));

test("the menu shows a project MCP override, and a change of the user row reports that the override decides", () => withFixture(async dirs => {
	put(join(dirs.projectDir, "mcp.json"), { mcpServers: { live: { enabled: false } } });
	const { ctx, log } = mock({ choices: ["mcp user mcp live", SET_DEFAULT] });
	await runResources("", ctx, { dirs });
	const rows = log.options[0]!.filter(row => row.includes(" mcp "));
	assert.deepEqual(rows, [
		"[ ] mcp user mcp live (project override: off in a trusted project; user file: on)",
		"[ ] mcp project override live (override of the user server) (read-only)",
	]);
	assert.ok(log.options[1]!.includes("[ ] mcp user mcp live (project override: off in a trusted project; user file: off) (changed)"));
	assert.equal(JSON.parse(readFileSync(join(dirs.agentDir, "mcp.json"), "utf8")).mcpServers.live.enabled, false);
	assert.deepEqual(JSON.parse(readFileSync(join(dirs.projectDir, "mcp.json"), "utf8")), { mcpServers: { live: { enabled: false } } });
	assert.match(log.notices.join("\n"), /Wrote 1 change\(s\).*\nIn a trusted project, the project override in .*mcp\.json keeps mcp live off\./);
	const list = mock({ hasUI: false });
	await runResources("list", list.ctx, { dirs });
	assert.match(list.log.notices[0]!, /\[ \] mcp project override live \(override of the user server\)/);
}));
