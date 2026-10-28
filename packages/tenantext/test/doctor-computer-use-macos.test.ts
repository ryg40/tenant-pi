import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { macosComputerUseChecks } from "../extensions/doctor/computer-use.ts";

// The fixture follows the kit pin, so a pin move does not break the test.
const spec: string = JSON.parse(readFileSync(new URL("../../../config/manifest.json", import.meta.url), "utf8")).components["computer-use-macos"].source.spec;
const version = spec.split("@").at(-1);

function profile(desktop?: Record<string, unknown>): string {
	const dir = mkdtempSync(join(tmpdir(), "doctor-cu-macos-"));
	writeFileSync(join(dir, "settings.json"), JSON.stringify({ packages: [`npm:${spec}`], ...(desktop ? { "pi-computer-use": desktop } : {}) }));
	const root = join(dir, "npm", "node_modules", "@amaster.ai", "pi-computer-use");
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "package.json"), JSON.stringify({ version }));
	// A placeholder file at the driver path; the checks never start it.
	const bin = join(dir, "npm", "node_modules", "@amaster.ai", "pi-computer-use-cua-driver-darwin-universal", "bin", "CuaDriver.app", "Contents", "MacOS");
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, "cua-driver"), "");
	chmodSync(join(bin, "cua-driver"), 0o755);
	return dir;
}

const status = (checks: { id: string; status: string }[]) => Object.fromEntries(checks.map(c => [c.id, c.status]));

test("macOS doctor checks stay off other platforms and warn when the safe defaults change", () => {
	assert.deepEqual(status(macosComputerUseChecks({ dir: profile(), env: {}, platform: "linux" })), { "computer-use-macos": "warn" });
	const safe = status(macosComputerUseChecks({ dir: profile({ mode: "bundled", toolProfile: "core" }), env: {}, platform: "darwin" }));
	assert.equal(safe["computer-use-macos-version"], "ok");
	assert.equal(safe["computer-use-macos-driver"], "ok");
	assert.equal(safe["computer-use-macos-settings"], "ok");
	const full = status(macosComputerUseChecks({ dir: profile({ toolProfile: "full", confirmDangerousActions: false }), env: {}, platform: "darwin" }));
	assert.equal(full["computer-use-macos-settings"], "warn");
});
