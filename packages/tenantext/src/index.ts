import { formatSkillsForPrompt, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type Skill } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { createGuardState, onAgentStart, onInput, onProviderRequest, statusText, type GuardState } from "./guard.ts";
import { buildContextReport, type PromptOptionsLike } from "./report.ts";
import { RULES_BLOCK, RULES_VERSION, estimateTokensFromText } from "./rules.ts";
import { DECISIONS_EVENT, ensureSettings, loadSettings, saveSettings, settingsPath, type TenantextSettings } from "./settings.ts";
import { settingsMenu } from "./settings-menu.ts";
import { loadSettings as loadMeterSettings } from "../extensions/context-meter/settings.ts";

const STATUS_KEY = "tenantext";
const ENTRY_TYPE = "tenantext-note";
const SUBCOMMANDS = ["on", "off", "guard on", "guard off", "settings", "save", "context", "rules", "help"];
const DECISIONS_SUBCOMMANDS = ["on", "off", "status"];

const HELP = `## /tenantext
| Command | Effect |
| --- | --- |
| /tenantext | Show status |
| /tenantext on, off | Language rules for this session |
| /tenantext guard on, off | Startup guard for this session |
| /tenantext settings | Edit main and operations footer settings in the TUI |
| /tenantext-decisions on, off | Allow or block every decision-server call; saved at once |
| /tenantext save | Store the current on/off states as defaults |
| /tenantext context | Report startup context size by source |
| /tenantext rules | Print the rule block |`;

export default function tenantext(pi: ExtensionAPI) {
	let settings: TenantextSettings = loadSettings();
	let session: TenantextSettings = { ...settings };
	let guard: GuardState = createGuardState();
	let lastTurnChainedChars: number | undefined;
	let baseSystemPrompt = "";
	let lastStatus = "";

	const note = (data: { title: string; body: string }) => pi.appendEntry(ENTRY_TYPE, data);

	pi.registerEntryRenderer(ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data as { title: string; body: string };
		return new Text(`${theme.fg("accent", data.title)}\n${data.body}`, 0, 0);
	});

	const refreshStatus = (ctx: ExtensionContext) => {
		const text = statusText(guard, session.rules, session.guard);
		if (text === lastStatus) return;
		lastStatus = text;
		ctx.ui.setStatus(STATUS_KEY, text);
	};

	const branchHasHumanMessage = (ctx: ExtensionContext): boolean => {
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "message" && entry.message.role === "user") return true;
		}
		return false;
	};

	const firstRequestInputTokens = (ctx: ExtensionContext): number | undefined => {
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				const usage = (entry.message as { usage?: { input?: number; cacheRead?: number } }).usage;
				if (usage && (usage.input ?? 0) + (usage.cacheRead ?? 0) > 0) return (usage.input ?? 0) + (usage.cacheRead ?? 0);
			}
		}
		return undefined;
	};

	// --- session lifecycle ---
	pi.on("session_start", async (_event, ctx) => {
		try { ensureSettings(); } catch { ctx.ui.notify("Cannot initialize Tenantext settings files.", "warning"); }
		settings = loadSettings();
		session = { ...settings };
		guard = createGuardState(branchHasHumanMessage(ctx));
		lastTurnChainedChars = undefined;
		baseSystemPrompt = "";
		lastStatus = "";
		refreshStatus(ctx);
	});

	// --- startup guard: input path ---
	pi.on("input", async (event, ctx) => {
		// Before the first turn, agent.state.systemPrompt is the complete, unmodified base prompt:
		// resources_discover has run (it fires after session_start) and no extension has appended yet.
		// After a turn it holds the last chained prompt, so snapshot only while no turn has run.
		if (lastTurnChainedChars === undefined) baseSystemPrompt = ctx.getSystemPrompt();
		const decision = onInput(guard, event.source, session.guard);
		refreshStatus(ctx);
		if (decision === "block") {
			const preview = event.text.replace(/\s+/g, " ").slice(0, 80);
			ctx.ui.notify(`tenantext guard: blocked an extension prompt before your first prompt: "${preview}"`, "warning");
			note({ title: "tenantext guard: blocked extension prompt", body: preview });
			return { action: "handled" };
		}
		return { action: "continue" };
	});

	// --- rules injection ---
	pi.on("before_agent_start", async (event, ctx) => {
		lastTurnChainedChars = event.systemPrompt.length;
		if (!session.rules) return;
		return { systemPrompt: `${RULES_BLOCK}\n\n${event.systemPrompt}` };
	});

	// --- run audit: agent_start fires for every run, including pi.sendMessage({ triggerTurn: true }),
	// which bypasses both the input event and before_agent_start. Detect-only on that path. ---
	pi.on("agent_start", async (_event, ctx) => {
		if (!session.guard) return;
		if (onAgentStart(guard)) {
			ctx.ui.notify("tenantext guard: an agent run started before your first prompt", "warning");
			note({ title: "tenantext guard: unverified run", body: `run #${guard.unverifiedRuns} started with no human prompt in this session` });
			refreshStatus(ctx);
		}
	});

	pi.on("before_provider_request", (_event, ctx) => {
		if (!session.guard) return;
		if (onProviderRequest(guard)) {
			ctx.ui.notify("tenantext guard: a provider request was sent before your first prompt", "warning");
			note({ title: "tenantext guard: request before human prompt", body: `request #${guard.requestsTotal}` });
			refreshStatus(ctx);
		}
	});

	// --- command ---
	pi.registerCommand("tenantext", {
		description: "Simplified English rules, startup guard, and context report",
		getArgumentCompletions: (prefix: string) => {
			const items = SUBCOMMANDS.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
			return items.length ? items : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const words = args.trim().split(/\s+/).filter(Boolean);
			const [cmd, arg] = words;
			switch (cmd) {
				case undefined:
				case "status": {
					const lines = [
						`- rules: ${session.rules ? "on" : "off"} (default ${settings.rules ? "on" : "off"}, v${RULES_VERSION}, ~${estimateTokensFromText(RULES_BLOCK)} tokens per turn)`,
						`- guard: ${session.guard ? "on" : "off"} (default ${settings.guard ? "on" : "off"}), ${guard.humanPromptSeen ? "passed" : "armed"}`,
						`- decisions: ${settings.decisions ? "on" : "off"} (/tenantext-decisions)`,
						`- flagged: ${guard.blockedInputs} blocked inputs, ${guard.unverifiedRuns} unverified runs, ${guard.requestsBeforeHuman} early requests`,
						`- provider requests this session: ${guard.requestsTotal}`,
						`- settings file: ${settingsPath()}`,
					];
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}
				case "on":
				case "off":
					session.rules = cmd === "on";
					refreshStatus(ctx);
					ctx.ui.notify(`tenantext rules ${cmd} for this session`, "info");
					return;
				case "guard":
					if (arg !== "on" && arg !== "off") {
						ctx.ui.notify("usage: /tenantext guard on|off", "warning");
						return;
					}
					session.guard = arg === "on";
					refreshStatus(ctx);
					ctx.ui.notify(`tenantext guard ${arg} for this session`, "info");
					return;
				case "settings":
					await settingsMenu(ctx, {
						mainChanged(next) {
							const toggled = next.decisions !== settings.decisions;
							settings = next; session = { ...next }; refreshStatus(ctx);
							if (toggled) pi.events.emit(DECISIONS_EVENT, { enabled: next.decisions });
						},
						footerChanged() { pi.events.emit("tenantext:ops-footer:settings-reload", undefined); },
					});
					return;
				case "save":
					settings = { ...session };
					saveSettings(settings);
					ctx.ui.notify(`saved defaults to ${settingsPath()}: rules ${settings.rules ? "on" : "off"}, guard ${settings.guard ? "on" : "off"}`, "info");
					return;
				case "rules":
					note({ title: `tenantext rules v${RULES_VERSION} (~${estimateTokensFromText(RULES_BLOCK)} tokens)`, body: RULES_BLOCK });
					return;
				case "context": {
					const options = ctx.getSystemPromptOptions() as PromptOptionsLike & { skills?: Skill[] };
					const skillsChars = options.skills ? formatSkillsForPrompt(options.skills).length : 0;
					const report = buildContextReport({
						baseSystemPrompt: lastTurnChainedChars === undefined ? ctx.getSystemPrompt() : baseSystemPrompt,
						skillsChars,
						options,
						lastTurnChainedChars,
						rulesChars: RULES_BLOCK.length,
						rulesEnabled: session.rules,
						firstRequestInputTokens: firstRequestInputTokens(ctx),
						messageTokens: ctx.getContextUsage()?.tokens ?? undefined,
					});
					note({ title: "tenantext context report", body: report });
					return;
				}
				case "help":
				default:
					note({ title: "tenantext help", body: HELP });
			}
		},
	});

	// --- decision servers: one switch for every tenantext caller. The state is saved at once and applied without a restart. ---
	pi.registerCommand("tenantext-decisions", {
		description: "Allow or block calls to the decision server (nextMoveUrl): on, off, status",
		getArgumentCompletions: (prefix: string) => {
			const items = DECISIONS_SUBCOMMANDS.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
			return items.length ? items : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const cmd = args.trim().split(/\s+/)[0] || "status";
			if (cmd === "on" || cmd === "off") {
				const enabled = cmd === "on";
				settings = { ...settings, decisions: enabled };
				session.decisions = enabled;
				try { saveSettings(settings); } catch { ctx.ui.notify("Cannot save Tenantext settings.", "error"); return; }
				pi.events.emit(DECISIONS_EVENT, { enabled });
				ctx.ui.notify(`decision-server calls ${cmd}; saved to ${settingsPath()}`, "info");
				return;
			}
			if (cmd !== "status") { ctx.ui.notify("usage: /tenantext-decisions on|off|status", "warning"); return; }
			const meter = loadMeterSettings().settings;
			ctx.ui.notify([
				`- decision-server calls: ${settings.decisions ? "on" : "off"}`,
				`- callers: context-meter next-move chip (nextMoveUrl ${meter.nextMoveUrl ? "configured" : "unset"}, timeout ${meter.nextMoveTimeoutMs} ms)`,
				`- settings file: ${settingsPath()}`,
			].join("\n"), "info");
		},
	});
}
