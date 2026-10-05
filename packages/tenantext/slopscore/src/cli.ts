#!/usr/bin/env node --experimental-strip-types
// slopscore CLI: node --experimental-strip-types slopscore/src/cli.ts [--pi] [--claude] [--days N] [--cwd PATH] [--session FILE] [--repo PATH] [--json]
import { collectClaude } from "./claude-trace.ts";
import { collectPi } from "./pi-trace.ts";
import { runPr } from "./pr.ts";
import { readOkf, renderOkf, runOkf, type OkfSummary } from "./okf.ts";
import { renderProvenance, scoreRepo, type Provenance } from "./provenance.ts";
import { aggregate, renderReport } from "./report.ts";
import { configPath, loadConfig } from "./tiers.ts";
import type { CallRecord, TraceFilter } from "./types.ts";

const args = process.argv.slice(2);
if (args[0] === "pr" || args[0] === "okf") {
	const result = args[0] === "pr" ? runPr(args.slice(1)) : runOkf(args.slice(1));
	console.log(result.output);
	process.exit(result.exitCode);
}

const flag = (n: string) => args.includes(n);
const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

if (flag("--help") || flag("-h")) {
	console.log(`slopscore: spend by model, role and tool from harness traces.

Options
  --pi            pi sessions only        --claude   Claude Code transcripts only (default: both)
  --days N        last N days (default 7) --cwd PATH only sessions started in PATH
  --session FILE  one session file        --json     JSON instead of Markdown
  --repo PATH     git provenance of PATH: planning artifacts, history, iterations by model
  --config        print the config path
  pr ...          the PR block for this branch (slopscore pr --help)
  okf ...         the context bundle table (slopscore okf --help)`);
	process.exit(0);
}
if (flag("--config")) { console.log(configPath()); process.exit(0); }

const cfg = loadConfig();
const days = Number(opt("--days") ?? 7);
const filter: TraceFilter = { since: opt("--session") ? undefined : Date.now() - days * 86400_000, cwd: opt("--cwd") };
if (opt("--session")) filter.sessionFiles = [opt("--session")!];

const both = !flag("--pi") && !flag("--claude");
let records: CallRecord[] = [];
if (flag("--pi") || both) records = records.concat(collectPi(filter));
if (flag("--claude") || both) records = records.concat(collectClaude(filter, undefined, cfg.prices));

const agg = aggregate(records, cfg);
const scope = opt("--session") ? "one session" : `${filter.cwd ? filter.cwd + ", " : ""}last ${days} day(s)`;
let prov: Provenance | undefined;
let okf: OkfSummary | undefined;
const repo = opt("--repo");
if (repo) {
	try {
		prov = scoreRepo(repo, cfg);
		okf = readOkf(repo, { oneShot: prov.oneShot });
	} catch (error) {
		const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
		console.error(`slopscore: cannot read repository: ${message}`);
		process.exit(1);
	}
}
if (flag("--json")) {
	console.log(JSON.stringify({ scope, total: agg.total, byModel: Object.fromEntries([...agg.byModel].map(([k, v]) => [k, { ...v, thinking: Object.fromEntries(v.thinking) }])), byRole: Object.fromEntries([...agg.byRole].map(([k, v]) => [k, { ...v, models: Object.fromEntries(v.models) }])), byTool: Object.fromEntries(agg.byTool), provenance: prov, okf }, null, 2));
} else {
	console.log(renderReport(agg, cfg, scope));
	if (prov) console.log("\n" + renderProvenance(prov, okf ? renderOkf(okf) : undefined));
}
