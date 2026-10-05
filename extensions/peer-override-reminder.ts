/**
 * Peer Override Reminder
 *
 * Shows one alert at startup when an installed extension package needs the
 * host-provided peer override again, or when the automatic step is not active.
 * It reads manifests and settings only. It changes no file and runs no command.
 * See docs/host-peer-overrides.md in the tenant-pi repository.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The list that Pi 0.99 checks in dist/core/resource-loader.js.
const HOST_PROVIDED = new Set([
	"@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui",
	"@mariozechner/pi-agent-core", "@mariozechner/pi-ai", "@mariozechner/pi-coding-agent", "@mariozechner/pi-tui",
	"@sinclair/typebox", "typebox",
]);
const PATCH_NAME = "patch-extension-peers.mjs";
const WRAPPER_NAME = "pi-npm-wrapper.sh";

const readJson = (path: string): any => {
	try {
		return JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
	} catch {
		return undefined;
	}
};

/** Returns the alert lines. An empty list means that no action is necessary. */
export function findProblems(agentDir: string): string[] {
	const overrides = join(agentDir, "local-overrides");
	const patch = join(overrides, PATCH_NAME);
	const npmRoot = join(agentDir, "npm");
	const needed: string[] = [];
	// Pi checks only the packages that settings.json loads, so an unused installed package gives no alert.
	const settings = readJson(join(agentDir, "settings.json"));
	const names = new Set<string>();
	for (const entry of Array.isArray(settings?.packages) ? settings.packages : []) {
		const source = typeof entry === "string" ? entry : entry?.source;
		if (typeof source !== "string" || !source.startsWith("npm:")) continue;
		const spec = source.slice(4);
		const at = spec.lastIndexOf("@");
		names.add(at > 0 ? spec.slice(0, at) : spec);
	}
	for (const name of [...names].sort()) {
		const dependencies = readJson(join(npmRoot, "node_modules", name, "package.json"))?.dependencies;
		if (!dependencies || typeof dependencies !== "object") continue;
		const host = Object.keys(dependencies).filter((module) => HOST_PROVIDED.has(module)).sort();
		if (host.length > 0) needed.push(`${name} (${host.join(", ")})`);
	}
	const lines: string[] = [];
	if (needed.length > 0) {
		lines.push(`Extension packages list host-provided modules under dependencies: ${needed.join("; ")}.`);
		if (existsSync(patch)) {
			const covered = readFileSync(patch, "utf8");
			const missing = needed.map((item) => item.split(" ")[0]).filter((name) => !covered.includes(`"${name}"`));
			lines.push(`Run: node ${patch}  Then restart Pi.`);
			if (missing.length > 0) lines.push(`Not in the override list: ${missing.join(", ")}. Add each package to ${PATCH_NAME} first.`);
		} else {
			lines.push(`The override script is missing: ${patch}. Copy it from the tenant-pi repository.`);
		}
	}
	const npmCommand = settings?.npmCommand;
	const wrapper = join(overrides, WRAPPER_NAME);
	if (!Array.isArray(npmCommand) || npmCommand[0] !== wrapper) {
		lines.push(`The automatic override is not active: settings.json npmCommand does not start with ${wrapper}.`);
	} else if (!existsSync(wrapper) || !existsSync(patch)) {
		lines.push(`The automatic override cannot run: ${WRAPPER_NAME} or ${PATCH_NAME} is missing in ${overrides}.`);
	}
	return lines;
}

export default function peerOverrideReminder(pi: ExtensionAPI) {
	let shown = false;
	pi.on("session_start", (_event, ctx) => {
		if (shown || !ctx.hasUI) return;
		shown = true;
		try {
			const lines = findProblems(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"));
			if (lines.length > 0) ctx.ui.notify(`Peer override reminder\n${lines.join("\n")}`, "warning");
		} catch {
			// A reminder must never stop a session.
		}
	});
}
