import { boundedName, MAX_REF_LENGTH, resolveBranchScope } from "./branch.ts";
import { collectClaude } from "./claude-trace.ts";
import { okfBranchLine, readOkf } from "./okf.ts";
import { collectPi } from "./pi-trace.ts";
import { scoreRepo } from "./provenance.ts";
import { aggregate, effortShare, points } from "./report.ts";
import { isDefaultConfig, loadConfig, type SlopscoreConfig } from "./tiers.ts";
import { runTrailers } from "./trailers.ts";
import type { CallRecord } from "./types.ts";

const MAX_ARGS = 8;
const MAX_PUBLIC_NAME_LENGTH = 120;
const TICKET_RE = /#\d+\b|\bissues?\/\d+|\b[A-Z]{2,}-\d+\b/g;
// Date suffixes in model names (8 digits) are public identifiers, not session IDs. A hex run of 12 or more, whole or embedded, is an ID.
const SESSION_ID_RE = /(?:^[0-9a-f]{8,}$|^subagent:[0-9a-f]{8,}$|\b[0-9a-f]{12,}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b)/i;

export interface PrOptions {
	base?: string;
	json: boolean;
	help: boolean;
	noSpend?: boolean;
	addTrailers?: boolean;
	yes?: boolean;
	force?: boolean;
}

export interface PrRoleRow {
	role: string;
	mainModel: string;
	topThinking: string;
	share: number;
}

export interface PrTraceSummary {
	sessions: number;
	calls: number;
	spend: number | null;
	effortShare: number;
	modelPoints: number;
	roles: PrRoleRow[];
}

export interface PrData {
	scope: {
		branch: string;
		base: string;
		commits: number;
		days: number;
	};
	localTraces: boolean;
	trace?: PrTraceSummary;
	provenance: {
		codeCommits: number;
		modelTrailerCommits: number;
		ticketReferences: string[];
		fixOrReviewCommits: number;
	};
	/** The OKF bundle at HEAD, measured over the branch commits only. Undefined when HEAD has no bundle. */
	bundle?: { concepts: number; keptCurrentShare: number };
	flags: string[];
	generatedOn: string;
}

export type PrResult =
	| { ok: true; data: PrData }
	| { ok: false; error: string };

function publicName(value: string | undefined, kind: "role" | "model" | "thinking"): string {
	if (!value) return "unknown";
	const singleLine = value.replace(/[\u0000-\u001f\u007f]/g, "?").trim();
	const pathLike = /^(?:[.~]?[/\\]|[A-Za-z]:[/\\])/.test(singleLine) || /[/\\](?:home|Users)[/\\]/.test(singleLine);
	const rolePath = kind !== "model" && /[/\\]/.test(singleLine);
	if (!singleLine || pathLike || rolePath || SESSION_ID_RE.test(singleLine)) return "redacted";
	return singleLine.slice(0, MAX_PUBLIC_NAME_LENGTH);
}

function markdown(value: string): string {
	return boundedName(value).replace(/([\\`*_\[\]|<>])/g, "\\$1");
}

function buildRoleRow(role: string, records: CallRecord[], totalSpend: number): PrRoleRow {
	const models = new Map<string, { spend: number; thinking: Map<string, number> }>();
	for (const record of records) {
		const model = publicName(record.model, "model");
		let data = models.get(model);
		if (!data) {
			data = { spend: 0, thinking: new Map() };
			models.set(model, data);
		}
		data.spend += record.cost ?? 0;
		const thinking = publicName(record.thinking, "thinking");
		data.thinking.set(thinking, (data.thinking.get(thinking) ?? 0) + 1);
	}
	const [mainModel = "unknown", main] = [...models.entries()].sort((a, b) => b[1].spend - a[1].spend || a[0].localeCompare(b[0]))[0] ?? [];
	const topThinking = main
		? [...main.thinking.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "unknown"
		: "unknown";
	const spend = records.reduce((sum, record) => sum + (record.cost ?? 0), 0);
	return { role, mainModel, topThinking, share: totalSpend > 0 ? spend / totalSpend : 0 };
}

function traceSummary(records: CallRecord[], cfg: SlopscoreConfig, hideSpend: boolean): PrTraceSummary {
	const agg = aggregate(records, cfg);
	const grouped = new Map<string, CallRecord[]>();
	for (const record of records) {
		const role = publicName(record.role, "role");
		grouped.set(role, [...(grouped.get(role) ?? []), record]);
	}
	const sorted = [...grouped.entries()].sort((a, b) => {
		const aSpend = a[1].reduce((sum, record) => sum + (record.cost ?? 0), 0);
		const bSpend = b[1].reduce((sum, record) => sum + (record.cost ?? 0), 0);
		return bSpend - aSpend || a[0].localeCompare(b[0]);
	});
	const visible = sorted.slice(0, 6).map(([role, roleRecords]) => buildRoleRow(role, roleRecords, agg.total.cost));
	if (sorted.length > 6) visible.push(buildRoleRow("other", sorted.slice(6).flatMap(([, roleRecords]) => roleRecords), agg.total.cost));
	return {
		sessions: agg.sessions.size,
		calls: agg.total.calls,
		spend: hideSpend ? null : agg.total.cost,
		effortShare: effortShare(agg.total),
		modelPoints: points(agg.total),
		roles: visible,
	};
}

export function parsePrArgs(args: string[]): PrOptions {
	if (args.length > MAX_ARGS) throw new Error("Too many arguments.");
	const options: PrOptions = { json: false, help: false, noSpend: false };
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--help" || arg === "-h") {
			options.help = true;
		} else if (arg === "--json") {
			options.json = true;
		} else if (arg === "--no-spend") {
			options.noSpend = true;
		} else if (arg === "--add-trailers") {
			options.addTrailers = true;
		} else if (arg === "--yes") {
			options.yes = true;
		} else if (arg === "--force") {
			options.force = true;
		} else if (arg === "--base") {
			const ref = args[++i];
			if (!ref || ref.startsWith("--")) throw new Error("--base requires a ref.");
			if (ref.length > MAX_REF_LENGTH) throw new Error("Base ref is too long.");
			if (options.base !== undefined) throw new Error("--base can be used once.");
			options.base = ref;
		} else {
			throw new Error("Unknown argument.");
		}
	}
	if ((options.yes || options.force) && !options.addTrailers) throw new Error("--yes and --force need --add-trailers.");
	if (options.addTrailers && options.noSpend) throw new Error("--no-spend does not apply to --add-trailers.");
	return options;
}

export function collectPrData(dir: string, options: PrOptions, cfg: SlopscoreConfig = loadConfig()): PrResult {
	const resolved = resolveBranchScope(dir, options.base);
	if (!resolved.ok) return resolved;
	const { root, head, base: baseName, mergeBase, mergeBaseTime, commits, branch } = resolved.scope;
	const provenance = scoreRepo(root, cfg, commits);
	const ticketReferences = [...new Set(commits.flatMap((commit) => commit.subject.match(TICKET_RE) ?? []))];
	const modelTrailerCommits = commits.filter((commit) => commit.coauthors.length > 0).length;
	const missingTrailers = commits.length - modelTrailerCommits;
	const filter = { cwdInside: root, sessionStartedSince: mergeBaseTime };
	const records = [...collectPi(filter), ...collectClaude(filter, undefined, cfg.prices)];
	const flags: string[] = [];
	if (!records.length) flags.push("no local traces");
	if (missingTrailers) flags.push(`${missingTrailers} commits without a model trailer`);
	if (!isDefaultConfig(cfg)) flags.push("tiers.json differs from defaults");
	let bundle: PrData["bundle"];
	try {
		const okf = readOkf(root, { revision: head, range: `${mergeBase}..${head}` });
		if (okf.present) bundle = { concepts: okf.conceptCount, keptCurrentShare: okf.keptCurrentShare };
	} catch {
		bundle = undefined;
	}

	return {
		ok: true,
		data: {
			scope: {
				branch,
				base: baseName,
				commits: commits.length,
				days: provenance.activeDays,
			},
			localTraces: records.length > 0,
			...(records.length ? { trace: traceSummary(records, cfg, options.noSpend ?? false) } : {}),
			provenance: {
				codeCommits: provenance.codeCommits,
				modelTrailerCommits,
				ticketReferences,
				fixOrReviewCommits: provenance.fixCommits,
			},
			...(bundle ? { bundle } : {}),
			flags,
			generatedOn: new Date().toISOString().slice(0, 10),
		},
	};
}

const usd = (value: number | null) => value === null ? "n/a" : `$${value.toFixed(value >= 100 ? 0 : 2)}`;
const pct = (value: number) => `${Math.round(value * 100)}%`;

export function renderPrMarkdown(data: PrData): string {
	const tickets = data.provenance.ticketReferences.length
		? data.provenance.ticketReferences.map(markdown).join(", ")
		: "none";
	const lines = ["## slopscore", ""];
	if (data.localTraces && data.trace) {
		lines.push(
			"| Scope | Sessions | Calls | Spend | Effort share | Model points |",
			"| --- | ---: | ---: | ---: | ---: | ---: |",
			`| branch ${markdown(data.scope.branch)} vs ${markdown(data.scope.base)}, ${data.scope.commits} commits, ${data.scope.days} days | ${data.trace.sessions} | ${data.trace.calls} | ${usd(data.trace.spend)} | ${pct(data.trace.effortShare)} | ${data.trace.modelPoints} / 20 |`,
			"",
			"| Role | Main model | Top thinking | Share |",
			"| --- | --- | --- | ---: |",
			...data.trace.roles.map((row) => `| ${markdown(row.role)} | ${markdown(row.mainModel)} | ${markdown(row.topThinking)} | ${pct(row.share)} |`),
		);
	} else {
		lines.push(
			`**Scope:** branch ${markdown(data.scope.branch)} vs ${markdown(data.scope.base)}, ${data.scope.commits} commits, ${data.scope.days} days`,
			"",
			"No local traces for this branch.",
		);
	}
	lines.push(
		"",
		`**Provenance:** ${data.provenance.codeCommits} code commits; ${data.provenance.modelTrailerCommits} commits with model Co-Authored-By provenance; tickets ${tickets}; ${data.provenance.fixOrReviewCommits} fix or review commits.`,
		`**Flags:** ${data.flags.length ? data.flags.map(markdown).join("; ") : "none"}`,
		`**Bundle:** ${data.bundle ? `${data.bundle.concepts} concepts, ${pct(data.bundle.keptCurrentShare)} kept current on this branch` : "none"}`,
		"",
		`_Generated by slopscore-pr on ${data.generatedOn}. Traces stay on the contributor's machine._`,
	);
	return lines.join("\n");
}

export function prHelp(): string {
	return [
		"Usage: slopscore pr [--base REF] [--no-spend] [--json] [--add-trailers [--yes] [--force]] [--help]",
		"",
		"  --base REF       branch point; default tries upstream/HEAD, origin/HEAD, origin/main, main",
		"  --no-spend       print n/a for spend; effort share and model points stay",
		"  --json           print the block data as JSON",
		"  --add-trailers   per-commit Co-Authored-By proposals from traces; dry run by default",
		"  --yes            rebase and add the proposed trailers; never pushes",
		"  --force          rewrite although the branch is on a remote or signed commits follow",
		"",
		"Remote presence is judged from remote-tracking refs and the configured upstream. Run git fetch first.",
	].join("\n");
}

export function runPr(args: string[], dir = process.cwd()): { exitCode: number; output: string } {
	let options: PrOptions;
	try {
		options = parsePrArgs(args);
	} catch (error) {
		return { exitCode: 1, output: error instanceof Error ? error.message : "Invalid arguments." };
	}
	if (options.help) return { exitCode: 0, output: prHelp() };
	if (options.addTrailers) return runTrailers(dir, { base: options.base, yes: options.yes ?? false, force: options.force ?? false, json: options.json });
	const result = collectPrData(dir, options);
	if (!result.ok) return { exitCode: 1, output: result.error };
	return {
		exitCode: 0,
		output: options.json ? JSON.stringify(result.data, null, 2) : renderPrMarkdown(result.data),
	};
}
