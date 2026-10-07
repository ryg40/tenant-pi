import { readStoredCredential, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { applyFixes, formatChecks, runChecks } from "./checks.ts";

const ENTRY_TYPE = "tenantext-doctor-report";

/** `/tenantext-doctor [check|fix]`: detect what this machine has and write the matching tenantext settings. */
export default function doctor(pi: ExtensionAPI) {
	let active = false;
	pi.on("session_start", () => { active = true; });
	pi.on("session_shutdown", () => { active = false; });
	pi.registerEntryRenderer(ENTRY_TYPE, entry => new Text((entry.data as { body: string }).body, 0, 0));
	pi.registerCommand("tenantext-doctor", {
		description: "Check the local tenantext setup (Codex, Copilot, Anthropic, footer) and optionally write the detected settings",
		getArgumentCompletions: (prefix: string) => {
			const items = ["check", "fix"].filter(c => c.startsWith(prefix)).map(c => ({ value: c, label: c }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const fix = args.trim() === "fix";
			const checks = await runChecks({ cwd: ctx.cwd, readCredential: provider => readStoredCredential(provider) });
			const { applied, failed } = fix ? applyFixes(checks) : { applied: [], failed: [] };
			const body = `## tenantext doctor\n\n${formatChecks(checks, applied)}${failed.length ? `\n\nFailed: ${failed.join(", ")}.` : ""}`;
			if (active) pi.appendEntry(ENTRY_TYPE, { body });
		},
	});
}
