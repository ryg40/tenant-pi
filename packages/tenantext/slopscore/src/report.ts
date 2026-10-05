import { thinkingFactor, tierFor, type SlopscoreConfig } from "./tiers.ts";
import type { CallRecord } from "./types.ts";

export interface Bucket { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; unpriced: number; weighted: number }

function bucket(): Bucket { return { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unpriced: 0, weighted: 0 }; }

function add(b: Bucket, r: CallRecord, weight: number, share = 1): void {
	b.calls += share;
	b.input += r.input * share;
	b.output += r.output * share;
	b.cacheRead += r.cacheRead * share;
	b.cacheWrite += r.cacheWrite * share;
	if (r.cost === null) b.unpriced += share;
	else { b.cost += r.cost * share; b.weighted += r.cost * weight * share; }
}

export interface Aggregate {
	total: Bucket;
	byModel: Map<string, Bucket & { tier: string; weight: number; thinking: Map<string, number> }>;
	byRole: Map<string, Bucket & { models: Map<string, number> }>;
	byTool: Map<string, Bucket>;
	byHarness: Map<string, Bucket>;
	sessions: Set<string>;
}

/** Effective weight of one call: tier weight times thinking factor. */
export function callWeight(r: CallRecord, cfg: SlopscoreConfig): number {
	return tierFor(r.model, cfg.tiers).weight * thinkingFactor(r.thinking, cfg.thinkingFactors);
}

export function aggregate(records: CallRecord[], cfg: SlopscoreConfig): Aggregate {
	const agg: Aggregate = { total: bucket(), byModel: new Map(), byRole: new Map(), byTool: new Map(), byHarness: new Map(), sessions: new Set() };
	for (const r of records) {
		const tier = tierFor(r.model, cfg.tiers);
		const w = callWeight(r, cfg);
		agg.sessions.add(`${r.harness}:${r.sessionId}`);
		add(agg.total, r, w);
		const mk = `${r.harness}/${r.model}`;
		let bm = agg.byModel.get(mk);
		if (!bm) { bm = { ...bucket(), tier: tier.name, weight: tier.weight, thinking: new Map() }; agg.byModel.set(mk, bm); }
		add(bm, r, w);
		const th = r.thinking ?? "unknown";
		bm.thinking.set(th, (bm.thinking.get(th) ?? 0) + 1);
		let br = agg.byRole.get(r.role);
		if (!br) { br = { ...bucket(), models: new Map() }; agg.byRole.set(r.role, br); }
		add(br, r, w);
		br.models.set(r.model, (br.models.get(r.model) ?? 0) + (r.cost ?? 0));
		let bh = agg.byHarness.get(r.harness);
		if (!bh) { bh = bucket(); agg.byHarness.set(r.harness, bh); }
		add(bh, r, w);
		// A turn's cost is split evenly across the tools it called. Text-only turns go to "(no tool)".
		const tools = r.tools.length ? r.tools : ["(no tool)"];
		for (const t of tools) {
			let bt = agg.byTool.get(t);
			if (!bt) { bt = bucket(); agg.byTool.set(t, bt); }
			add(bt, r, w, 1 / tools.length);
		}
	}
	return agg;
}

/** Effort-weighted share of spend, 0 to 1. Points for the Effort Score's model criteria, 0 to 20. */
export function effortShare(b: Bucket): number { return b.cost > 0 ? b.weighted / b.cost : 0; }
export function points(b: Bucket): number { return Math.round(effortShare(b) * 20); }

const usd = (n: number) => `$${n.toFixed(n >= 100 ? 0 : n >= 10 ? 2 : 3)}`;
const k = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)));
const pct = (n: number) => `${Math.round(n * 100)}%`;

function topThinking(m: Map<string, number>): string {
	return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([t, n]) => `${t} ×${n}`).join(", ");
}

/** Markdown report. */
export function renderReport(agg: Aggregate, cfg: SlopscoreConfig, title: string): string {
	const L: string[] = [];
	const t = agg.total;
	L.push(`## slopscore: ${title}`);
	L.push("");
	L.push(`| Sessions | Calls | Spend | Effort-weighted spend | Effort share | Model points |`);
	L.push(`| ---: | ---: | ---: | ---: | ---: | ---: |`);
	L.push(`| ${agg.sessions.size} | ${t.calls} | ${usd(t.cost)} | ${usd(t.weighted)} | ${pct(effortShare(t))} | ${points(t)} / 20 |`);
	if (t.unpriced > 0) L.push(`\n${t.unpriced} call(s) had no price. Add the model to \`prices\` in the config to include them.`);
	L.push("");
	L.push("### By model");
	L.push("| Model | Tier | Weight | Thinking | Calls | Input | Cache read | Output | Spend | Share |");
	L.push("| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |");
	for (const [m, b] of [...agg.byModel.entries()].sort((a, b) => b[1].cost - a[1].cost)) {
		L.push(`| ${m} | ${b.tier} | ${b.weight.toFixed(2)} | ${topThinking(b.thinking)} | ${b.calls} | ${k(b.input)} | ${k(b.cacheRead)} | ${k(b.output)} | ${usd(b.cost)} | ${t.cost ? pct(b.cost / t.cost) : "-"} |`);
	}
	L.push("");
	L.push("### By role");
	L.push("| Role | Calls | Spend | Share | Effort share | Main model |");
	L.push("| --- | ---: | ---: | ---: | ---: | --- |");
	for (const [role, b] of [...agg.byRole.entries()].sort((a, b) => b[1].cost - a[1].cost)) {
		const main = [...b.models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "-";
		L.push(`| ${role} | ${b.calls} | ${usd(b.cost)} | ${t.cost ? pct(b.cost / t.cost) : "-"} | ${pct(effortShare(b))} | ${main} |`);
	}
	L.push("");
	L.push("### By tool");
	L.push("Cost of a turn is split evenly across the tools it called.");
	L.push("| Tool | Turns | Spend | Share |");
	L.push("| --- | ---: | ---: | ---: |");
	for (const [tool, b] of [...agg.byTool.entries()].sort((a, b) => b[1].cost - a[1].cost).slice(0, 15)) {
		L.push(`| ${tool} | ${b.calls.toFixed(1)} | ${usd(b.cost)} | ${t.cost ? pct(b.cost / t.cost) : "-"} |`);
	}
	L.push("");
	L.push("### Reading the score");
	L.push(`- Effort share = spend × tier weight × thinking factor, divided by spend. 100% means every dollar went to a T1 model at xhigh or max.`);
	L.push(`- Model points feed the Agent Loop Effort Score criterion "Coordinator model". Review roles show whether a reviewer ran and at what tier.`);
	const reviewers = [...agg.byRole.keys()].filter((r) => /review/i.test(r));
	L.push(reviewers.length ? `- Reviewer roles seen: ${reviewers.join(", ")}.` : "- No reviewer role seen in this scope.");
	L.push(`- Tiers: ${cfg.tiers.map((x) => `${x.name} ${x.weight}`).join(", ")}. Unknown models get 0.40. Edit the config to change them.`);
	return L.join("\n");
}
