#!/usr/bin/env node
// Backs the /herdr-idle command. Runs `idle_cleanup.py switch <on|off|status>` and prints its output as it is.
import { spawnSync } from "node:child_process";
import { handoffScript } from "./idle-script.mjs";

const USAGE = "Usage: /herdr-idle [on|off|status]. No argument means status.";
const args = process.argv.slice(2);
const form = args[0] ?? "status";
if (args.length > 1 || !["on", "off", "status"].includes(form)) {
	console.log(USAGE);
	process.exit(0);
}
const script = handoffScript();
if (!script) {
	console.log("The herdr-idle-cleanup skill is not installed: idle_cleanup.py was not found.");
	process.exit(0);
}
const p = spawnSync("python3", [script, "switch", form], { encoding: "utf8", timeout: 30_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
const text = (p.status === 0 ? p.stdout : p.stderr || p.stdout || String(p.error ?? "")).trim();
console.log(text || `exit ${p.status}`);
