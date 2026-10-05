import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { collectClaude } from "./claude-trace.ts";
import { collectPi, parsePiSession } from "./pi-trace.ts";
import { runOkf } from "./okf.ts";
import { runPr } from "./pr.ts";
import { aggregate, points, renderReport } from "./report.ts";
import { configPath, loadConfig } from "./tiers.ts";
import type { CallRecord } from "./types.ts";

const ENTRY_TYPE = "slopscore-report";
const SUBCOMMANDS = ["session", "project", "all", "claude", "pr", "okf", "config", "help"];

const HELP = `## /slopscore
| Command | Scope |
| --- | --- |
| /slopscore | This session |
| /slopscore project [days] | Pi sessions started in this directory, default 30 days |
| /slopscore all [days] | All pi sessions, default 7 days |
| /slopscore claude [days] | Claude Code transcripts, default 7 days |
| /slopscore pr [--base REF] [--no-spend] [--json] | The PR block for this branch: sessions since the branch point and the branch commits |
| /slopscore pr --add-trailers [--yes] [--force] | Propose Co-Authored-By trailers per branch commit; --yes rebases, never pushes |
| /slopscore okf [--repo PATH] [--json] | The context bundle table: root, version, conformance, log, kept current, stale, points, and the failing concepts |
| /slopscore config | Print the config path and the tier table |

Spend is read from session traces. Nothing is sent to a model. A summary of this session is written to <agent dir>/slopscore/sessions/ after each turn.`;

/**
 * slopscore: spend by model, role and tool from harness traces, weighted by
 * a model tier table. Feeds the Agent Loop Effort Score.
 */
export default function slopscore(pi: ExtensionAPI) {
	const cfg = () => loadConfig();

	pi.registerEntryRenderer(ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data as { body: string };
		return new Text(data.body, 0, 0);
	});
	const show = (body: string) => pi.appendEntry(ENTRY_TYPE, { body });

	const currentRecords = (ctx: ExtensionCommandContext): CallRecord[] => {
		const file = ctx.sessionManager.getSessionFile();
		if (!file) return [];
		try { return parsePiSession(file); } catch { return []; }
	};

	// Ledger: one JSON summary per session, rewritten after each agent run. Cheap: the file is already on disk.
	pi.on("agent_end", async (_event, ctx) => {
		const file = ctx.sessionManager.getSessionFile();
		if (!file) return;
		try {
			const recs = parsePiSession(file);
			if (!recs.length) return;
			const agg = aggregate(recs, cfg());
			const out = join(dirname(configPath()), "sessions", `${recs[0].sessionId}.json`);
			mkdirSync(dirname(out), { recursive: true });
			writeFileSync(out, `${JSON.stringify({
				sessionId: recs[0].sessionId, sessionFile: file, cwd: recs[0].cwd, role: recs[0].role, updatedAt: new Date().toISOString(),
				calls: agg.total.calls, cost: agg.total.cost, weighted: agg.total.weighted, points: points(agg.total),
				models: Object.fromEntries([...agg.byModel].map(([m, b]) => [m, { cost: b.cost, calls: b.calls, tier: b.tier }])),
			}, null, 2)}\n`);
		} catch { /* never disturb the session */ }
	});

	pi.registerCommand("slopscore", {
		description: "Spend by model, role and tool from traces, weighted by model tier",
		getArgumentCompletions: (prefix: string) => {
			const items = SUBCOMMANDS.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
			return items.length ? items : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const [cmd, daysArg, ...more] = args.trim().split(/\s+/).filter(Boolean);
			const c = cfg();
			if (cmd === "pr" || cmd === "okf") {
				const rest = [daysArg, ...more].filter((a): a is string => a !== undefined);
				const result = cmd === "pr" ? runPr(rest, ctx.cwd) : runOkf(rest, ctx.cwd);
				if (result.exitCode !== 0) { ctx.ui.notify(`slopscore ${cmd}: ${result.output}`, "error"); return; }
				show(result.output);
				return;
			}
			const days = Number(daysArg);
			switch (cmd) {
				case undefined:
				case "session": {
					const recs = currentRecords(ctx);
					if (!recs.length) { ctx.ui.notify("slopscore: no model calls in this session yet", "info"); return; }
					show(renderReport(aggregate(recs, c), c, "this session"));
					return;
				}
				case "project": {
					const d = Number.isFinite(days) && days > 0 ? days : 30;
					const recs = collectPi({ since: Date.now() - d * 86400_000, cwd: ctx.cwd });
					show(renderReport(aggregate(recs, c), c, `pi sessions in ${ctx.cwd}, last ${d} days`));
					return;
				}
				case "all": {
					const d = Number.isFinite(days) && days > 0 ? days : 7;
					const recs = collectPi({ since: Date.now() - d * 86400_000 });
					show(renderReport(aggregate(recs, c), c, `all pi sessions, last ${d} days`));
					return;
				}
				case "claude": {
					const d = Number.isFinite(days) && days > 0 ? days : 7;
					const recs = collectClaude({ since: Date.now() - d * 86400_000 }, undefined, c.prices);
					show(renderReport(aggregate(recs, c), c, `Claude Code transcripts, last ${d} days`));
					return;
				}
				case "config": {
					const rows = c.tiers.map((t) => `| ${t.name} | ${t.weight.toFixed(2)} | ${t.patterns.join(", ")} |`).join("\n");
					show(`## slopscore config\nFile: \`${configPath()}\` (absent means defaults)\n\n| Tier | Weight | Patterns |\n| --- | ---: | --- |\n${rows}\n\nThinking factors: ${Object.entries(c.thinkingFactors).map(([k, v]) => `${k} ${v}`).join(", ")}.`);
					return;
				}
				default:
					show(HELP);
			}
		},
	});
}
