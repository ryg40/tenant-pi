import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";

// The setup lines of the kit plan (`scripts/profile_plan.py`) depend on three rules of the Pi package manager.
// These tests read the rules from the linked Pi, so a pin move finds a change. They use no network: `npmCommand`
// is a stub that records its arguments and installs nothing.
const EXACT = "npm:@scope/exact-kit@1.2.3";
const FLOATING = "npm:floating-kit";

function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-install-")));
	const agentDir = join(root, "home/.pi/agent"), cwd = join(root, "project"), log = join(root, "npm-calls.jsonl");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	const stub = join(root, "npm-stub.mjs");
	writeFileSync(stub, 'import { appendFileSync } from "node:fs";\nappendFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)) + "\\n");\n');
	// The shape that the kit writes: an object entry with a resource filter, 2-space indent.
	const settings = join(agentDir, "settings.json");
	writeFileSync(settings, `${JSON.stringify({
		npmCommand: [process.execPath, stub, log],
		packages: [{ source: FLOATING, extensions: ["index.ts"], skills: [] }, { source: EXACT, extensions: ["index.ts"], skills: [] }],
	}, null, 2)}\n`);
	const calls = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]) : [];
	return { root, agentDir, cwd, settings, calls };
}

async function withManager(run: (manager: DefaultPackageManager, settingsManager: SettingsManager, dirs: ReturnType<typeof fixture>) => Promise<void>) {
	const dirs = fixture();
	const env = { HOME: process.env.HOME, PI_OFFLINE: process.env.PI_OFFLINE };
	try {
		process.env.HOME = join(dirs.root, "home");
		// `PI_OFFLINE` makes `update()` a no-op, which hides the rule.
		delete process.env.PI_OFFLINE;
		const settingsManager = SettingsManager.create(dirs.cwd, dirs.agentDir, { projectTrusted: true });
		const manager = new DefaultPackageManager({ cwd: dirs.cwd, agentDir: dirs.agentDir, settingsManager } as ConstructorParameters<typeof DefaultPackageManager>[0]);
		await run(manager, settingsManager, dirs);
	} finally {
		for (const [key, value] of Object.entries(env)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
		rmSync(dirs.root, { recursive: true, force: true });
	}
}

const installs = (calls: string[][]) => calls.filter(args => args[0] === "install");

test("Pi update installs a missing npm source without a version, and no missing source with an exact version", async () => {
	await withManager(async (manager, settingsManager, dirs) => {
		const before = readFileSync(dirs.settings);
		await manager.update();
		await settingsManager.flush();
		const run = installs(dirs.calls());
		assert.equal(run.length, 1, JSON.stringify(dirs.calls()));
		// One install for the source without a version.
		assert.ok(run[0]!.includes("floating-kit@latest"), JSON.stringify(run[0]));
		// No install for the source with an exact version: the kit plan prints `pi install <source>` for it.
		assert.ok(!dirs.calls().flat().some(arg => arg.includes("@scope/exact-kit")), JSON.stringify(dirs.calls()));
		assert.deepEqual(readFileSync(dirs.settings), before);
	});
});

test("Pi install of a declared source by its identical string runs one install and keeps the bytes of settings.json", async () => {
	for (const source of [EXACT, FLOATING]) {
		await withManager(async (manager, settingsManager, dirs) => {
			const before = readFileSync(dirs.settings);
			await manager.installAndPersist(source);
			await settingsManager.flush();
			assert.deepEqual(dirs.calls(), [["install", source.slice("npm:".length), "--prefix", join(dirs.agentDir, "npm"), "--legacy-peer-deps"]]);
			assert.deepEqual(readFileSync(dirs.settings), before, source);
			assert.equal(settingsManager.drainErrors().length, 0);
		});
	}
});
