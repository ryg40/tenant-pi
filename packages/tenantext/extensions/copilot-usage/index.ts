import { readStoredCredential, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agentDir, loadCopilotSettings, type CopilotUsageSettings } from "./settings.ts";
import { COPILOT_REFRESH_EVENT, createCopilotStatus } from "./status.ts";

const ENTRY_TYPE = "copilot-usage-report";
const COMMANDS = ["report", "refresh", "help"];
/** Premium requests are spent per request, so a settled Copilot turn may refresh sooner than the poll interval. */
const TURN_REFRESH_MS = 60_000;

const readPiSettings = (): unknown => {
	const path = join(agentDir(), "settings.json");
	return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
};

export default function copilotUsage(pi: ExtensionAPI) {
	let settings: CopilotUsageSettings = loadCopilotSettings();
	let provider: string | undefined;
	const status = createCopilotStatus({
		settings: () => settings,
		detect: () => ({ sources: settings.sources, domain: settings.domain, readPiCredential: () => readStoredCredential("github-copilot"), readPiSettings }),
		emit: (event, value) => pi.events.emit(event, value),
	});
	let active = false;
	pi.registerEntryRenderer(ENTRY_TYPE, entry => new Text((entry.data as { body: string }).body, 0, 0));
	const show = (body: string) => { if (active) pi.appendEntry(ENTRY_TYPE, { body }); };
	const unsubscribe = pi.events.on(COPILOT_REFRESH_EVENT, () => { if (active) void status.refresh(); });
	pi.on("session_start", (_event, ctx) => {
		active = true; settings = loadCopilotSettings(); provider = ctx.model?.provider;
		void status.refresh();
	});
	pi.on("model_select", (_event, ctx) => { provider = ctx.model?.provider; });
	pi.on("agent_settled", () => { if (active && provider === "github-copilot") void status.refresh(false, TURN_REFRESH_MS); });
	pi.on("session_shutdown", () => { active = false; status.stop(); unsubscribe(); });

	pi.registerCommand("copilot-usage", {
		description: "Show GitHub Copilot quota and which local credential the meter uses",
		getArgumentCompletions: (prefix: string) => {
			const items = COMMANDS.filter(c => c.startsWith(prefix)).map(c => ({ value: c, label: c }));
			return items.length ? items : null;
		},
		handler: async args => {
			const command = args.trim() || "report";
			if (command === "report" || command === "refresh") {
				settings = loadCopilotSettings();
				await status.refresh(true);
				show(status.report());
			} else show("## /copilot-usage\n\n- `/copilot-usage` or `/copilot-usage report`: probe local credentials and show quota.\n- `/copilot-usage refresh`: same, and update the footer.\n- `/tenantext-doctor`: check and write the local setup.\n\nSettings: `~/.pi/agent/copilot-usage/settings.json` (`mode`: auto, on, off; `sources`; `domain`; `pollSeconds`). Environment: `TENANTEXT_COPILOT_USAGE=auto|on|off`.");
		},
	});
}
