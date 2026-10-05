import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
	BUILTIN_EXTENSIONS, ResourceFileError, applyPatterns, buildInventory, formatItem, globToRegExp, isEnabledByOverrides, readFiles, sortItems,
	type Dirs, type ResourceItem,
} from "../extensions/resources/inventory.ts";

function put(file: string, content: string | object = "") {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
}

function fixture(settings: object, projectSettings?: object): Dirs & { root: string } {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "resources-inv-")));
	const agentDir = join(root, "home/.pi/agent"), projectDir = join(root, "project/.pi"), homeDir = join(root, "home");
	put(join(agentDir, "extensions/solo.ts"));
	put(join(agentDir, "extensions/multi/index.ts"));
	put(join(agentDir, "extensions/multi/helper.ts"));
	put(join(agentDir, "skills/alpha/SKILL.md"));
	put(join(agentDir, "skills/note.md"));
	put(join(agentDir, "prompts/review.md"));
	put(join(homeDir, ".agents/skills/shared/SKILL.md"));
	put(join(projectDir, "extensions/pe.ts"));
	// Local path package with a `pi` manifest.
	put(join(root, "home/.pi/kit/package.json"), { name: "kit", pi: { extensions: ["./extensions/a/index.ts", "./extensions/b/index.ts"], skills: ["./skills"] } });
	put(join(root, "home/.pi/kit/extensions/a/index.ts"));
	put(join(root, "home/.pi/kit/extensions/b/index.ts"));
	put(join(root, "home/.pi/kit/skills/kit-skill/SKILL.md"));
	put(join(root, "home/.pi/kit/prompts/unlisted.md"));
	// npm-style package with conventional directories.
	put(join(agentDir, "npm/node_modules/@scope/npm-kit/package.json"), { name: "@scope/npm-kit", version: "1.2.3" });
	put(join(agentDir, "npm/node_modules/@scope/npm-kit/extensions/x.ts"));
	put(join(agentDir, "npm/node_modules/@scope/npm-kit/extensions/y.ts"));
	put(join(agentDir, "npm/node_modules/@scope/npm-kit/prompts/p.md"));
	put(join(agentDir, "settings.json"), settings);
	if (projectSettings) put(join(projectDir, "settings.json"), projectSettings);
	put(join(agentDir, "mcp.json"), { mcpServers: { live: { command: "a" }, parked: { command: "b", enabled: false } }, disabledMcpServers: { old: { command: "c" } } });
	put(join(projectDir, "mcp.json"), { mcpServers: { proj: { url: "http://localhost/mcp" } } });
	return { root, agentDir, projectDir, homeDir };
}

const SETTINGS = {
	theme: "dark",
	packages: ["../kit", { source: "npm:@scope/npm-kit@1.2.3", extensions: ["!extensions/y.ts"] }],
	extensions: ["-extensions/solo.ts", "-builtin:codemode"],
	skills: ["!alpha"],
};

const line = (item: ResourceItem) => formatItem(item);

test("inventory lists local files, packages, built-ins and MCP servers with the Pi state", () => {
	const dirs = fixture(SETTINGS);
	try {
		const items = sortItems(buildInventory(dirs, readFiles(dirs)));
		assert.deepEqual(items.map(line), [
			"[x] extension user package extensions/a/index.ts (../kit)",
			"[x] extension user package extensions/b/index.ts (../kit)",
			"[x] extension user package extensions/x.ts (npm:@scope/npm-kit@1.2.3)",
			"[ ] extension user package extensions/y.ts (npm:@scope/npm-kit@1.2.3)",
			"[x] extension project local extensions/pe.ts",
			"[x] extension user local extensions/multi/index.ts",
			"[ ] extension user local extensions/solo.ts",
			"[x] extension user local builtin:mcp",
			"[x] extension user local builtin:llama.cpp",
			"[ ] extension user local builtin:codemode",
			"[x] extension user local builtin:tool-search",
			"[x] mcp user mcp live",
			"[ ] mcp user mcp parked",
			"[ ] mcp user mcp old",
			"[x] mcp project mcp proj",
			"[x] skill user package skills/kit-skill (../kit)",
			"[ ] skill user local skills/alpha",
			"[x] skill user local skills/note.md",
			"[x] skill user local ~/.agents/skills/shared",
			"[x] prompt user package prompts/p.md (npm:@scope/npm-kit@1.2.3)",
			"[x] prompt user local prompts/review.md",
		]);
		for (const item of items) {
			assert.ok(!item.id.startsWith("/"), item.id);
			assert.ok(!item.id.includes(dirs.root), item.id);
		}
		assert.equal(items.find(item => item.id === "extensions/multi/index.ts")?.label, "multi");
		assert.equal(items.find(item => item.id === "skills/alpha")?.path, join(dirs.agentDir, "skills/alpha/SKILL.md"));
	} finally { rmSync(dirs.root, { recursive: true, force: true }); }
});

test("a project entry overrides a built-in, and package filter lists follow the Pi rules", () => {
	const dirs = fixture({
		packages: [{ source: "../kit", extensions: [], skills: ["!kit-skill"], prompts: ["+prompts/unlisted.md"] }, { source: "npm:@scope/npm-kit", extensions: ["extensions/x.ts"] }],
	}, { extensions: ["-builtin:mcp"] });
	try {
		const state = Object.fromEntries(buildInventory(dirs, readFiles(dirs)).map(item => [`${item.scope} ${item.id}`, item.enabled]));
		assert.equal(state["project builtin:mcp"], false);
		assert.equal(state["user builtin:mcp"], undefined);
		assert.equal(state["user extensions/a/index.ts"], false); // [] means none
		assert.equal(state["user skills/kit-skill"], false);
		assert.equal(state["user prompts/unlisted.md"], true); // a filter object reads the conventional directory
		assert.equal(state["user extensions/x.ts"], true);
		assert.equal(state["user extensions/y.ts"], false); // a plain entry is an include
	} finally { rmSync(dirs.root, { recursive: true, force: true }); }
});

test("the inventory agrees with the Pi package manager", async () => {
	const cases: [object, object?][] = [
		[SETTINGS],
		[{ packages: [{ source: "../kit", extensions: [], skills: ["!kit-skill"], prompts: ["+prompts/unlisted.md"] }, { source: "npm:@scope/npm-kit@1.2.3", extensions: ["extensions/x.ts"], prompts: ["!p.md"] }] }],
		[{ packages: [{ source: "../kit", extensions: ["!extensions/a/index.ts", "!**/b/*"], skills: ["+skills/kit-skill"] }, "npm:@scope/npm-kit@1.2.3"], extensions: ["!*.ts", "+extensions/solo.ts", "../kit/extensions/b/index.ts"], prompts: ["!review.md"], skills: ["-skills/note.md", "-skills/shared"] }],
		[{ packages: ["npm:@scope/npm-kit@1.2.3"], extensions: ["!extensions/**", "+extensions/multi/index.ts", "-builtin:llama.cpp", "!builtin:tool-search"] }, { extensions: ["+builtin:llama.cpp", "-extensions/pe.ts"] }],
	];
	const env = { HOME: process.env.HOME, PI_OFFLINE: process.env.PI_OFFLINE };
	for (const [settings, projectSettings] of cases) {
		const dirs = fixture(settings, projectSettings);
		try {
			process.env.HOME = dirs.homeDir;
			process.env.PI_OFFLINE = "1";
			const cwd = dirname(dirs.projectDir);
			const settingsManager = SettingsManager.create(cwd, dirs.agentDir, { projectTrusted: true });
			const manager = new DefaultPackageManager({ cwd, agentDir: dirs.agentDir, settingsManager, builtinExtensions: BUILTIN_EXTENSIONS } as ConstructorParameters<typeof DefaultPackageManager>[0]);
			const resolved = await manager.resolve(async () => "skip");
			const pi = (["extensions", "skills", "prompts"] as const).flatMap(type => resolved[type].map(entry => `${type} ${entry.path} ${entry.enabled}`)).sort();
			const kinds = { extension: "extensions", skill: "skills", prompt: "prompts" } as const;
			const ours = buildInventory(dirs, readFiles(dirs)).filter(item => item.kind !== "mcp")
				.map(item => `${kinds[item.kind as keyof typeof kinds]} ${item.path ?? item.id} ${item.enabled}`).sort();
			assert.ok(pi.length >= 12, "Pi resolved the fixture");
			assert.deepEqual(ours, pi, JSON.stringify(settings));
		} finally {
			for (const [key, value] of Object.entries(env)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
			rmSync(dirs.root, { recursive: true, force: true });
		}
	}
});

test("pattern rules: pure negatives keep the rest, exact entries win in order", () => {
	const base = "/base";
	const all = ["/base/extensions/a.ts", "/base/extensions/b.ts", "/base/skills/s/SKILL.md"];
	assert.deepEqual([...applyPatterns(all, ["!extensions/a.ts"], base)], [all[1], all[2]]);
	assert.deepEqual([...applyPatterns(all, ["+extensions/a.ts"], base)], all);
	assert.deepEqual([...applyPatterns(all, ["extensions/a.ts"], base)], [all[0]]);
	assert.deepEqual([...applyPatterns(all, ["!*.ts", "+extensions/b.ts", "-skills/s"], base)], [all[1]]);
	assert.equal(isEnabledByOverrides(all[0]!, ["!a.ts", "+extensions/a.ts"], base), true);
	assert.equal(isEnabledByOverrides(all[0]!, ["+extensions/a.ts", "-./extensions/a.ts"], base), false);
	assert.equal(isEnabledByOverrides(all[2]!, ["!s"], base), false);
	assert.equal(isEnabledByOverrides("builtin:mcp", ["-builtin:mcp"], base), false);
	const secret: ResourceItem = { kind: "extension", scope: "user", source: "package", packageSource: "git:https://user:tok3n@github.com/o/r.git", id: "extensions/a.ts", label: "a", enabled: true };
	assert.equal(formatItem(secret), "[x] extension user package extensions/a.ts (git:https://github.com/o/r.git)");
	assert.ok(globToRegExp("**/*.{ts,js}").test("a/b/c.js"));
	assert.ok(!globToRegExp("*.ts").test("a/b.ts"));
	assert.ok(!globToRegExp("*").test(".hidden"));
});

test("a malformed file names the file", () => {
	const dirs = fixture(SETTINGS);
	try {
		writeFileSync(join(dirs.agentDir, "mcp.json"), "{ not json");
		assert.throws(() => buildInventory(dirs, readFiles(dirs)), (error: unknown) =>
			error instanceof ResourceFileError && error.file === join(dirs.agentDir, "mcp.json") && error.message.includes("mcp.json"));
		assert.throws(() => buildInventory(dirs, { userSettings: "[]" }), ResourceFileError);
	} finally { rmSync(dirs.root, { recursive: true, force: true }); }
});

const USER_MCP = { mcpServers: {
	live: { command: "a" }, parked: { command: "b", enabled: false }, tuned: { command: "c", enabled: false }, shadow: { command: "d" }, strict: { command: "e" }, typed: { command: "f" },
} };
const PROJECT_MCP = { mcpServers: {
	live: { enabled: false }, parked: { enabled: true }, tuned: { exposure: "direct" }, shadow: { command: "p", enabled: false },
	strict: { enabled: false, args: ["--x"] }, typed: { enabled: "no" }, ghost: { enabled: true }, proj: { url: "http://localhost/mcp" },
} };

test("MCP: a project override changes the user row, shows as an override, and agrees with the Pi loader", async () => {
	const dirs = fixture({});
	try {
		put(join(dirs.agentDir, "mcp.json"), USER_MCP);
		put(join(dirs.projectDir, "mcp.json"), PROJECT_MCP);
		const items = buildInventory(dirs, readFiles(dirs)).filter(item => item.kind === "mcp");
		assert.deepEqual(items.map(line), [
			"[ ] mcp user mcp live (project override: off in a trusted project; user file: on)",
			"[x] mcp user mcp parked (project override: on in a trusted project; user file: off)",
			"[ ] mcp user mcp tuned",
			"[ ] mcp user mcp shadow (replaced by the project server in a trusted project; user file: on)",
			"[x] mcp user mcp strict",
			"[x] mcp user mcp typed",
			"[ ] mcp project override live (override of the user server)",
			"[x] mcp project override parked (override of the user server)",
			"[ ] mcp project override tuned (override of the user server; the user file sets the state)",
			"[ ] mcp project mcp shadow",
			"[ ] mcp project override strict (Pi ignores this override: an override can set only enabled, exposure, toolExposure)",
			"[ ] mcp project override typed (Pi ignores this override: enabled is not true or false)",
			"[ ] mcp project override ghost (Pi ignores this override: no user server has this name)",
			"[x] mcp project mcp proj",
		]);
		// `enabled` of a user row stays the state of the user file, so a profile and the writer keep their meaning.
		assert.deepEqual(items.filter(item => item.scope === "user").map(item => item.enabled), [true, false, false, true, true, true]);

		// The same files through the loader of the installed Pi, for a trusted project.
		const config = new URL("./extensions/mcp/config.js", import.meta.resolve("@earendil-works/pi-coding-agent"));
		const { loadMcpConfig } = await import(config.href);
		const pi = loadMcpConfig({ agentDir: dirs.agentDir, cwd: dirname(dirs.projectDir), projectTrusted: true });
		const piState = pi.servers.map((server: any) => `${server.name} ${server.scope} ${server.override ? "override" : "plain"} ${server.config.enabled !== false}`).sort();
		const ours = items.filter(item => !item.override && !(item.scope === "user" && item.projectState?.by === "server")).map(item => {
			const override = items.find(other => other.override && !other.override.ignored && other.id === item.id);
			return `${item.id} ${item.scope === "user" ? "global" : "project"} ${override ? "override" : "plain"} ${override ? override.enabled : item.enabled}`;
		}).sort();
		assert.deepEqual(ours, piState);
		// Pi reports one error for each override that it ignores.
		assert.equal(pi.errors.length, items.filter(item => item.override?.ignored).length, pi.errors.join("\n"));
		// The user row shows the state that Pi uses when an override sets `enabled`.
		for (const item of items.filter(candidate => candidate.projectState?.by === "override")) {
			assert.equal(item.projectState!.enabled, pi.servers.find((server: any) => server.name === item.id).config.enabled !== false, item.id);
		}
	} finally { rmSync(dirs.root, { recursive: true, force: true }); }
});

test("MCP: with builtin:mcp off, each file gives its rows alone", () => {
	for (const [settings, projectSettings] of [[{ extensions: ["-builtin:mcp"] }, undefined], [{}, { extensions: ["-builtin:mcp"] }]] as [object, object?][]) {
		const dirs = fixture(settings, projectSettings);
		try {
			put(join(dirs.agentDir, "mcp.json"), USER_MCP);
			put(join(dirs.projectDir, "mcp.json"), PROJECT_MCP);
			const items = buildInventory(dirs, readFiles(dirs)).filter(item => item.kind === "mcp");
			assert.deepEqual(items.slice(0, 2).concat(items.slice(6, 9)).map(line), [
				"[x] mcp user mcp live", "[ ] mcp user mcp parked",
				"[ ] mcp project mcp live", "[x] mcp project mcp parked", "[x] mcp project mcp tuned",
			]);
			assert.ok(items.every(item => item.override === undefined && item.projectState === undefined));
		} finally { rmSync(dirs.root, { recursive: true, force: true }); }
	}
});
