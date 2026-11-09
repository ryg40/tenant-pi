import { spawnSync } from "node:child_process";
import { findScript } from "../handoffs/index.ts";
import type { ResourceItem } from "./inventory.ts";

/**
 * Switch rows: settings of a kit script that `/resources` shows and toggles. The script is the only reader and writer
 * of its setting, so the row and the command of the script never disagree. Profiles do not store a switch row.
 * Now one row: `herdr-idle`, the startup check of the herdr-idle-cleanup skill (`idle_cleanup.py switch`, the key
 * `startup_assessment`).
 */
export const HERDR_IDLE = "herdr-idle";

export interface SwitchRun { code: number | null; stdout: string; stderr: string }
export interface SwitchDeps {
	/** The idle_cleanup.py to run, or undefined. No script means no row. */
	findScript(): string | undefined;
	/** Run python3 with the arguments, with no shell. */
	run(args: string[]): SwitchRun;
}

export const realSwitchDeps: SwitchDeps = {
	findScript: () => findScript(),
	run: args => {
		const p = spawnSync("python3", args, { encoding: "utf8", timeout: 5_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
		return { code: p.status, stdout: p.stdout ?? "", stderr: p.stderr || (p.error ? String(p.error) : "") };
	},
};

export const isSwitch = (item: Pick<ResourceItem, "kind">) => item.kind === "switch";

/** The switch rows with their current state. A missing script or a failed read gives no row. */
export function switchItems(deps: SwitchDeps): ResourceItem[] {
	const script = deps.findScript();
	if (!script) return [];
	const result = deps.run([script, "switch", "status", "--json"]);
	if (result.code !== 0) return [];
	try {
		const state = JSON.parse(result.stdout);
		if (typeof state?.on !== "boolean") return [];
		return [{ kind: "switch", scope: "user", source: "local", id: HERDR_IDLE, label: HERDR_IDLE, enabled: state.on,
			...(typeof state.settings === "string" ? { path: state.settings } : {}) }];
	} catch { return []; }
}

/** Write the state of each switch row through its script. Returns one error text for each failed write. */
export function writeSwitches(deps: SwitchDeps, changes: Pick<ResourceItem, "id" | "enabled">[]): string[] {
	const errors: string[] = [];
	for (const change of changes) {
		const script = change.id === HERDR_IDLE ? deps.findScript() : undefined;
		if (!script) { errors.push(`${change.id}: the script was not found.`); continue; }
		const result = deps.run([script, "switch", change.enabled ? "on" : "off"]);
		if (result.code !== 0) errors.push(`${change.id}: ${(result.stderr || result.stdout).trim() || `exit ${result.code}`}`);
	}
	return errors;
}
