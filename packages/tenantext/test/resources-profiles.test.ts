import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Dirs, ResourceItem } from "../extensions/resources/inventory.ts";
import { deleteProfile, listProfiles, loadProfile, matchProfile, portableSource, profileExists, saveProfile, validProfileName } from "../extensions/resources/profiles.ts";

function temp(): Dirs & { root: string } {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "resources-prof-")));
	return { root, agentDir: join(root, "home/.pi/agent"), projectDir: join(root, "project/.pi"), homeDir: join(root, "home") };
}

const items = (dirs: Dirs): ResourceItem[] => [
	{ kind: "extension", scope: "user", source: "local", id: "extensions/solo.ts", label: "solo", enabled: true, path: join(dirs.agentDir, "extensions/solo.ts") },
	{ kind: "extension", scope: "user", source: "package", packageSource: join(dirs.homeDir!, "kits/kit"), id: "extensions/a/index.ts", label: "a", enabled: false, path: join(dirs.homeDir!, "kits/kit/extensions/a/index.ts") },
	{ kind: "mcp", scope: "user", source: "mcp", id: "live", label: "live", enabled: true },
	{ kind: "skill", scope: "project", source: "local", id: "skills/alpha", label: "alpha", enabled: true },
];

test("the name rule accepts lowercase names up to 64 characters", () => {
	for (const name of ["a", "work", "0day", "a.b_c-d", "a".repeat(64)]) assert.ok(validProfileName(name), name);
	for (const name of ["", "Work", ".hidden", "-x", "a b", "a/b", "../x", "a".repeat(65), "naïve"]) assert.ok(!validProfileName(name), name);
});

test("save, list, load and delete a profile", () => {
	const dirs = temp();
	try {
		assert.deepEqual(listProfiles(dirs.agentDir), []);
		const file = saveProfile(dirs, "work", items(dirs), new Date("2026-10-02T08:09:10.000Z"));
		assert.equal(file, join(dirs.agentDir, "resource-profiles/work.json"));
		const text = readFileSync(file, "utf8");
		assert.ok(text.endsWith("}\n"));
		assert.ok(!text.includes(dirs.root), "no absolute path in a profile");
		assert.deepEqual(JSON.parse(text), {
			schemaVersion: 1, name: "work", savedAt: "2026-10-02T08:09:10.000Z",
			items: [
				{ kind: "extension", scope: "user", source: "local", id: "extensions/solo.ts", enabled: true },
				{ kind: "extension", scope: "user", source: "package", packageSource: "~/kits/kit", id: "extensions/a/index.ts", enabled: false },
				{ kind: "mcp", scope: "user", source: "mcp", id: "live", enabled: true },
				{ kind: "skill", scope: "project", source: "local", id: "skills/alpha", enabled: true },
			],
		});
		saveProfile(dirs, "home", [], new Date("2026-10-03T00:00:00.000Z"));
		writeFileSync(join(dirs.agentDir, "resource-profiles/Bad Name.json"), "{}");
		writeFileSync(join(dirs.agentDir, "resource-profiles/broken.json"), "{");
		assert.deepEqual(listProfiles(dirs.agentDir), [{ name: "home", savedAt: "2026-10-03T00:00:00.000Z" }, { name: "work", savedAt: "2026-10-02T08:09:10.000Z" }]);
		assert.equal(loadProfile(dirs.agentDir, "work").items.length, 4);
		assert.throws(() => loadProfile(dirs.agentDir, "broken"), /not valid JSON/);
		assert.throws(() => loadProfile(dirs.agentDir, "none"), /does not exist/);
		assert.equal(profileExists(dirs.agentDir, "work"), true);
		assert.equal(deleteProfile(dirs.agentDir, "work"), true);
		assert.equal(deleteProfile(dirs.agentDir, "work"), false);
		assert.deepEqual(listProfiles(dirs.agentDir).map(profile => profile.name), ["home"]);
	} finally { rmSync(dirs.root, { recursive: true, force: true }); }
});

test("a bad name writes nothing and cannot leave the profile directory", () => {
	const dirs = temp();
	try {
		mkdirSync(dirs.agentDir, { recursive: true });
		for (const name of ["../escape", "Work", ""]) {
			assert.throws(() => saveProfile(dirs, name, []), /not a valid profile name/);
			assert.throws(() => loadProfile(dirs.agentDir, name), /not a valid profile name/);
			assert.throws(() => deleteProfile(dirs.agentDir, name), /not a valid profile name/);
		}
		assert.deepEqual(readdirSync(dirs.agentDir), []);
	} finally { rmSync(dirs.root, { recursive: true, force: true }); }
});

test("matching a profile reports changes, missing items and items that it does not mention", () => {
	const dirs = temp();
	try {
		const saved = items(dirs).map(item => ({ ...item, enabled: !item.enabled })).slice(0, 3);
		saveProfile(dirs, "flip", [...saved, { kind: "prompt", scope: "user", source: "local", id: "prompts/gone.md", label: "gone", enabled: true }]);
		const inventory = items(dirs);
		const match = matchProfile(dirs, loadProfile(dirs.agentDir, "flip"), inventory);
		assert.deepEqual(match.desired.map(item => item.enabled), [false, true, false, true]);
		assert.deepEqual(match.changes.map(item => `${item.id} ${item.enabled}`), ["extensions/solo.ts false", "extensions/a/index.ts true", "live false"]);
		assert.deepEqual(match.missing.map(item => item.id), ["prompts/gone.md"]);
		assert.deepEqual(match.unmentioned.map(item => item.id), ["skills/alpha"]);
		assert.deepEqual(inventory.map(item => item.enabled), [true, false, true, true], "the inventory is not changed in place");
	} finally { rmSync(dirs.root, { recursive: true, force: true }); }
});

test("an absolute package source is stored without the host path", () => {
	const dirs = temp();
	assert.equal(portableSource("npm:kit@1.0.0", dirs), "npm:kit@1.0.0");
	assert.equal(portableSource("../kit", dirs), "../kit");
	assert.equal(portableSource(join(dirs.homeDir!, "kits/kit"), dirs), "~/kits/kit");
	assert.equal(portableSource(join(dirs.root, "opt/kit"), dirs), "../../../opt/kit");
	rmSync(dirs.root, { recursive: true, force: true });
});

test("a URL package source is stored without its credentials, and the item still matches", () => {
	const dirs = temp();
	try {
		assert.equal(portableSource("git:https://user:tok3n@github.com/o/r.git", dirs), "git:https://github.com/o/r.git");
		assert.equal(portableSource("https://tok3n@host.example/o/r@v1", dirs), "https://host.example/o/r@v1");
		assert.equal(portableSource("ssh://git@host.example/o/r.git", dirs), "ssh://host.example/o/r.git");
		assert.equal(portableSource("git:github.com/o/r@v1", dirs), "git:github.com/o/r@v1");
		assert.equal(portableSource("npm:@scope/kit@1.0.0", dirs), "npm:@scope/kit@1.0.0");
		const item: ResourceItem = { kind: "extension", scope: "user", source: "package", packageSource: "git:https://user:tok3n@github.com/o/r.git", id: "extensions/a.ts", label: "a", enabled: true };
		const text = readFileSync(saveProfile(dirs, "git", [{ ...item, enabled: false }]), "utf8");
		assert.ok(!text.includes("tok3n") && !text.includes("user:"), "no credential in a profile");
		const match = matchProfile(dirs, loadProfile(dirs.agentDir, "git"), [item]);
		assert.deepEqual(match.changes.map(change => `${change.packageSource} ${change.enabled}`), ["git:https://user:tok3n@github.com/o/r.git false"]);
		assert.deepEqual([match.missing, match.unmentioned], [[], []]);
	} finally { rmSync(dirs.root, { recursive: true, force: true }); }
});
