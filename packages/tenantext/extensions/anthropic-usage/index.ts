import { readStoredCredential, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { loadAnthropicSettings, type AnthropicUsageSettings } from "./settings.ts";
import { ANTHROPIC_REFRESH_EVENT, createAnthropicStatus } from "./status.ts";

const ENTRY_TYPE = "anthropic-usage-report";
const COMMANDS = ["report", "refresh", "help"];
/** A settled Anthropic turn spends quota, so it may refresh sooner than the poll interval, at most once a minute. */
const TURN_REFRESH_MS = 60_000;

export default function anthropicUsage(pi: ExtensionAPI) {
	let settings: AnthropicUsageSettings = loadAnthropicSettings();
	let provider: string | undefined;
	const status = createAnthropicStatus({
		settings: () => settings,
		detect: () => ({ readPiCredential: () => readStoredCredential("anthropic") }),
		emit: (event, value) => pi.events.emit(event, value),
	});
	let active = false;
	pi.registerEntryRenderer(ENTRY_TYPE, entry => new Text((entry.data as { body: string }).body, 0, 0));
	const show = (body: string) => { if (active) pi.appendEntry(ENTRY_TYPE, { body }); };
	const unsubscribe = pi.events.on(ANTHROPIC_REFRESH_EVENT, () => { if (active) void status.refresh(); });
	pi.on("session_start", (_event, ctx) => {
		active = true; settings = loadAnthropicSettings(); provider = ctx.model?.provider;
		void status.refresh();
	});
	pi.on("model_select", (_event, ctx) => { provider = ctx.model?.provider; });
	pi.on("agent_settled", () => { if (active && provider === "anthropic") void status.refresh(false, TURN_REFRESH_MS); });
	pi.on("session_shutdown", () => { active = false; status.stop(); unsubscribe(); });

	pi.registerCommand("anthropic-usage", {
		description: "Show Anthropic subscription quota and which local login the meter uses",
		getArgumentCompletions: (prefix: string) => {
			const items = COMMANDS.filter(c => c.startsWith(prefix)).map(c => ({ value: c, label: c }));
			return items.length ? items : null;
		},
		handler: async args => {
			const command = args.trim() || "report";
			if (command === "report" || command === "refresh") {
				settings = loadAnthropicSettings();
				await status.refresh(true);
				show(status.report());
			} else show("## /anthropic-usage\n\n- `/anthropic-usage` or `/anthropic-usage report`: probe the local logins and show quota.\n- `/anthropic-usage refresh`: same, and update the footer.\n- `/tenantext-doctor`: check the local setup.\n\nSettings: `~/.pi/agent/anthropic-usage/settings.json` (`mode`: auto, on, off; `sources`; `pollSeconds`). Environment: `TENANTEXT_ANTHROPIC_USAGE=auto|on|off`.");
		},
	});
}
