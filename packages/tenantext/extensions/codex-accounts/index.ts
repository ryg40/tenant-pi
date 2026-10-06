import { readStoredCredential, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { codexAccountsSettingsPath, loadCodexAccountsSettings, type CodexAccountConfig } from "./config.ts";
import { type CodexLimitsResult, type CodexPlan } from "./limits.ts";
import { collectLimitsFor, createCodexStatus, NO_LOGIN_ERROR } from "./status.ts";
import { registerGateway } from "./routing.ts";
import { registerCodexAccountProviders } from "./openai-codex-2.ts";

const ENTRY_TYPE = "codex-accounts-report";
const COMMANDS = ["limits", "providers", "routing", "help"];

function credentialState({ provider, tokenFile }: CodexAccountConfig): string {
	if (tokenFile) return existsSync(tokenFile) ? `token file \`${tokenFile}\`` : `token file missing: \`${tokenFile}\``;
	const credential = readStoredCredential(provider) as { type?: string; accountId?: unknown } | undefined;
	return credential?.type === "oauth" && typeof credential.accountId === "string" ? "authenticated" : "not authenticated";
}

function providerReport(accounts: CodexAccountConfig[]): string {
	const rows = accounts
		.map((account) => `| ${account.label} | \`${account.provider}\` | ${credentialState(account)} |`)
		.join("\n");
	return `## Codex accounts\n\n| Account | Provider | State |\n| --- | --- | --- |\n${rows}\n\nSettings: \`${codexAccountsSettingsPath()}\``;
}

function resetText(date: Date | undefined): string {
	return date ? date.toISOString() : "not reported";
}

const PLAN_NAMES: Record<CodexPlan, string> = {
	free: "Free", go: "Go", plus: "Plus", pro: "Pro", pro_lite: "Pro Lite", team: "Team",
	business: "Business", enterprise: "Enterprise", edu: "Edu", unknown: "unrecognized",
};

export function planName(plan: CodexPlan | undefined): string {
	return plan ? PLAN_NAMES[plan] : "not reported";
}

export function limitsReport(results: Array<{ account: CodexAccountConfig; result: CodexLimitsResult }>): string {
	if (!results.length) return "## Codex account limits\n\nCollection cancelled or unavailable.";
	const rows: string[] = [];
	for (const { account, result } of results) {
		if (!result.success) {
			rows.push(result.error === NO_LOGIN_ERROR ? `| ${account.label} | — | no login | — | — | — |` : `| ${account.label} | — | error | — | — | ${result.error} |`);
			continue;
		}
		const plan = planName(result.plan);
		if (result.windows.length === 0) {
			rows.push(`| ${account.label} | ${plan} | none | — | — | not reported |`);
			continue;
		}
		for (const window of result.windows) {
			rows.push(
				window.unavailable
					? `| ${account.label} | ${plan} | ${window.label} | — | — | not reported by OpenAI |`
					: `| ${account.label} | ${plan} | ${window.label} | ${window.usedPercent.toFixed(0)}% | ${window.remainingPercent.toFixed(0)}% | ${resetText(window.resetsAt)} |`,
			);
		}
	}
	return `## Codex account limits\n\n| Account | Plan | Window | Used | Remaining | Reset |\n| --- | --- | --- | ---: | ---: | --- |\n${rows.join("\n")}`;
}

export default function codexAccounts(pi: ExtensionAPI) {
	const settings = loadCodexAccountsSettings();
	registerCodexAccountProviders(pi, settings.accounts);
	const status = createCodexStatus(pi, settings.accounts, collectLimitsFor(settings.explicit === true));
	const enabled = registerGateway(pi, status.setRouting, settings.preferredAccount);
	status.setRouting({ state: "unknown", preferredAccount: enabled ? settings.preferredAccount : undefined,
		summary: enabled ? "Gateway status endpoint unavailable." : "Gateway disabled: configuration or catalog unavailable." });

	pi.registerEntryRenderer(ENTRY_TYPE, (entry) => {
		const data = entry.data as { body: string };
		return new Text(data.body, 0, 0);
	});
	let active = true;
	pi.on("session_shutdown", () => { active = false; });
	const show = (body: string) => { if (active) pi.appendEntry(ENTRY_TYPE, { body }); };

	pi.registerCommand("codex-accounts", {
		description: "Display configured Codex accounts and their subscription limits",
		getArgumentCompletions: (prefix: string) => {
			const items = COMMANDS.filter((command) => command.startsWith(prefix)).map((command) => ({ value: command, label: command }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const command = args.trim() || "limits";
			switch (command) {
				case "limits":
					show(limitsReport(await status.refresh(ctx)));
					return;
				case "routing":
					show(status.report());
					return;
				case "providers":
					show(providerReport(settings.accounts));
					return;
				default:
					show("## /codex-accounts\n\n- `/codex-accounts` or `/codex-accounts limits`: fetch limits for every configured account.\n- `/codex-accounts providers`: show provider IDs and authentication state.\n- `/codex-accounts routing`: show safe local routing status.\n- `/codex-accounts help`: show this help.");
			}
		},
	});
}
