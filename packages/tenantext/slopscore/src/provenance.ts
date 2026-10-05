import { execFileSync } from "node:child_process";
import { tierFor, type SlopscoreConfig } from "./tiers.ts";

/**
 * Provenance from git: did the planning artifacts get committed, does the
 * history show the path, and how many code iterations ran on which models.
 * Three Effort Score criteria come from here: planning artifacts (15),
 * git history (15), iterations x model quality (20). Nothing calls a model.
 */

export interface Commit {
	hash: string;
	/** YYYY-MM-DD. */
	date: string;
	/** Epoch ms of the author date. */
	time: number;
	subject: string;
	/** Model names from Co-Authored-By trailers, e.g. "Claude Fable 5.1". */
	coauthors: string[];
	files: string[];
}

export type ArtifactKind = "map" | "spec" | "tickets" | "decisions";

export interface Artifact {
	kind: ArtifactKind;
	file?: string;
	/** Short hash of the commit that first added it. */
	firstCommit?: string;
	/** True when it was committed at or before the first code commit. */
	beforeCode: boolean;
	points: number;
}

export interface Round { hash: string; date: string; subject: string; model: string; tier: string; weight: number; points: number }

export interface Provenance {
	dir: string;
	commits: number;
	/** Hours between the first and the last commit. */
	spanHours: number;
	/** No history, one commit, or all commits inside one short session. */
	oneShot: boolean;
	/** Human-readable flags. Non-empty means the reader should stop and look. */
	flags: string[];
	/** Cap on the 100-point Effort Score when flagged. Undefined when not flagged. */
	scoreCap?: number;
	codeCommits: number;
	firstCodeCommit?: string;
	activeDays: number;
	ticketRefs: number;
	fixCommits: number;
	artifacts: Artifact[];
	artifactPoints: number;
	historyPoints: number;
	rounds: Round[];
	iterationPoints: number;
	total: number;
}

export const ARTIFACT_MAX = 15;
export const HISTORY_MAX = 15;
export const ITERATION_MAX = 20;
export const PROVENANCE_MAX = ARTIFACT_MAX + HISTORY_MAX + ITERATION_MAX;

/** Points per code commit after the first ship, before the tier weight. Seven T1 rounds fill the criterion. */
const POINTS_PER_ROUND = 3;
/** A history whose commits all fall inside this many hours on one day reads as a single session. */
const ONE_SHOT_HOURS = 12;
/** Provenance points a one-shot repo can keep: a base, plus a little for kept specs and for a T1 or T2 model. */
const ONE_SHOT_BASE = 8;
const ONE_SHOT_SPEC_BONUS = 6;
const ONE_SHOT_MODEL_BONUS = 6;
/** Overall 100-point cap for a one-shot repo: F, or D at best with specs and a T1 or T2 model. */
const ONE_SHOT_SCORE_CAP = 39;
const ONE_SHOT_SCORE_CAP_LIFTED = 59;

const CODE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|c|cc|cpp|h|hpp|cs|rb|php|swift|sh|bash|zsh|lua|sql)$/i;
const TEST_DIR_RE = /(^|\/)(test|tests|__tests__|spec)\//i;
const TICKET_RE = /(#\d+\b|\bissues?\/\d+|\b[A-Z]{2,}-\d+\b)/;
const FIX_RE = /\b(fix|fixes|fixed|review|defect|regress|regression|bug|v2|revise|rework|repair)\b/i;

/** Filename patterns per artifact. `docs/plan/<name>` is the convention; the looser patterns catch other layouts. */
const ARTIFACT_RE: Record<ArtifactKind, RegExp> = {
	map: /(^|\/)(docs\/plan\/map\.md|[^/]*wayfinder[^/]*\.md)$/i,
	spec: /(^|\/)(docs\/plan\/spec\.md|[^/]*(spec|prd|brief)[^/]*\.md)$/i,
	tickets: /(^|\/)(docs\/plan\/tickets\/|[^/]*tickets?\/)[^/]+/i,
	decisions: /(^|\/)(docs\/plan\/decisions\.md|[^/]*(decisions?|grill)[^/]*\.md)$/i,
};

export function readCommits(dir: string, range?: string): Commit[] {
	let raw = "";
	try {
		const args = ["log", "--reverse", "--date=iso-strict", "--name-only", "--format=%x1e%h%x1f%ad%x1f%s%x1f%(trailers:key=Co-Authored-By,valueonly,separator=%x1d)"];
		if (range) args.push(range);
		raw = execFileSync(
			"git",
			args,
			{ cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
		);
	} catch {
		return [];
	}
	const out: Commit[] = [];
	for (const chunk of raw.split("\x1e")) {
		if (!chunk.trim()) continue;
		const nl = chunk.indexOf("\n");
		const head = nl < 0 ? chunk : chunk.slice(0, nl);
		const body = nl < 0 ? "" : chunk.slice(nl + 1);
		const [hash, iso, subject, trailers = ""] = head.split("\x1f");
		const time = Date.parse(iso);
		const date = iso.slice(0, 10);
		const coauthors = trailers
			.split("\x1d")
			.map((t) => t.replace(/<[^>]*>/, "").trim())
			.filter(Boolean);
		const files = body.split("\n").map((f) => f.trim()).filter(Boolean);
		out.push({ hash, date, time: Number.isFinite(time) ? time : 0, subject, coauthors, files });
	}
	return out;
}

export const isCodeFile = (f: string) => CODE_RE.test(f) && !TEST_DIR_RE.test(f);

function firstAdded(commits: Commit[], re: RegExp): { file: string; index: number } | undefined {
	for (let i = 0; i < commits.length; i++) {
		const f = commits[i].files.find((x) => re.test(x));
		if (f) return { file: f, index: i };
	}
	return undefined;
}

export function scoreRepo(dir: string, cfg: SlopscoreConfig, commits = readCommits(dir)): Provenance {
	const firstCodeIndex = commits.findIndex((c) => c.files.some(isCodeFile));
	const codeCommits = commits.filter((c) => c.files.some(isCodeFile));

	// Planning artifacts: 3.75 each when committed at or before the first code commit, half when after. The sum is rounded.
	const perArtifact = ARTIFACT_MAX / 4;
	const artifacts: Artifact[] = (Object.keys(ARTIFACT_RE) as ArtifactKind[]).map((kind) => {
		const hit = firstAdded(commits, ARTIFACT_RE[kind]);
		if (!hit) return { kind, beforeCode: false, points: 0 };
		const beforeCode = firstCodeIndex < 0 || hit.index <= firstCodeIndex;
		return { kind, file: hit.file, firstCommit: commits[hit.index].hash, beforeCode, points: beforeCode ? perArtifact : perArtifact / 2 };
	});
	const artifactPoints = Math.round(artifacts.reduce((s, a) => s + a.points, 0));

	// History: enough commits (3), ticket references (5), fix and review commits (4), more than one active day (3).
	const activeDays = new Set(commits.map((c) => c.date)).size;
	const ticketRefs = commits.filter((c) => TICKET_RE.test(c.subject)).length;
	const fixCommits = commits.filter((c) => FIX_RE.test(c.subject)).length;
	const historyPoints = Math.round(
		Math.min(3, commits.length * 0.6) +
		(commits.length ? (ticketRefs / commits.length) * 5 : 0) +
		Math.min(4, fixCommits) +
		(activeDays >= 3 ? 3 : activeDays === 2 ? 2 : 0),
	);

	// Iterations: every code commit after the first ship, weighted by the tier of the model in its trailer.
	// Git records no thinking level, so only the tier weight applies.
	const rounds: Round[] = codeCommits.slice(1).map((c) => {
		const model = c.coauthors[0] ?? "unknown";
		const tier = tierFor(model, cfg.tiers);
		const weight = tier.weight;
		return { hash: c.hash, date: c.date, subject: c.subject, model, tier: tier.name, weight, points: POINTS_PER_ROUND * weight };
	});
	const iterationPoints = Math.min(ITERATION_MAX, Math.round(rounds.reduce((s, r) => s + r.points, 0)));

	// One-shot: no history, one commit, or every commit inside one short session on one day.
	const times = commits.map((c) => c.time).filter((t) => t > 0);
	const spanHours = times.length > 1 ? (Math.max(...times) - Math.min(...times)) / 3_600_000 : 0;
	const oneShot = commits.length <= 1 || (activeDays === 1 && spanHours <= ONE_SHOT_HOURS);
	const flags: string[] = [];
	let scoreCap: number | undefined;
	let artifactPts = artifactPoints;
	let historyPts = historyPoints;
	let iterationPts = iterationPoints;
	if (oneShot) {
		const hasSpecs = artifacts.some((a) => a.kind === "spec" || a.kind === "decisions" ? a.file : false);
		const topModel = commits.some((c) => c.coauthors.some((m) => tierFor(m, cfg.tiers).weight >= 0.9));
		const keep = ONE_SHOT_BASE + (hasSpecs ? ONE_SHOT_SPEC_BONUS : 0) + (topModel ? ONE_SHOT_MODEL_BONUS : 0);
		scoreCap = hasSpecs && topModel ? ONE_SHOT_SCORE_CAP_LIFTED : ONE_SHOT_SCORE_CAP;
		const why = commits.length === 0 ? "no git history" : commits.length === 1 ? "one commit" : `${commits.length} commits inside ${spanHours.toFixed(1)} hours on one day`;
		flags.push(`ONE-SHOT: ${why}. Looks like a single session, never returned to. Provenance capped at ${keep} / ${PROVENANCE_MAX}, overall score capped at ${scoreCap}` +
			(hasSpecs ? ". Specs kept: small lift" : ". No specs kept") + (topModel ? ". T1 or T2 model in trailers: small lift" : ". No T1 or T2 model in trailers"));
		// Scale the three criteria down to the cap, keeping their proportions.
		const raw = artifactPoints + historyPoints + iterationPoints;
		if (raw > keep) {
			const f = keep / raw;
			artifactPts = Math.round(artifactPoints * f);
			historyPts = Math.round(historyPoints * f);
			iterationPts = Math.max(0, keep - artifactPts - historyPts);
		}
	}

	return {
		dir,
		commits: commits.length,
		spanHours,
		oneShot,
		flags,
		scoreCap,
		codeCommits: codeCommits.length,
		firstCodeCommit: firstCodeIndex >= 0 ? commits[firstCodeIndex].hash : undefined,
		activeDays,
		ticketRefs,
		fixCommits,
		artifacts,
		artifactPoints: artifactPts,
		historyPoints: historyPts,
		rounds,
		iterationPoints: iterationPts,
		total: artifactPts + historyPts + iterationPts,
	};
}

export function renderProvenance(p: Provenance, contextBundle?: string): string {
	const L: string[] = [];
	L.push(`## Provenance: ${p.dir}`);
	L.push("");
	for (const f of p.flags) L.push(`**Flag. ${f}.**`, "");
	L.push(`| Commits | Code commits | Active days | Span | Ticket refs | Fix or review commits | Artifacts | History | Iterations | Provenance points |`);
	L.push(`| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`);
	L.push(`| ${p.commits} | ${p.codeCommits} | ${p.activeDays} | ${p.spanHours < 48 ? p.spanHours.toFixed(1) + " h" : Math.round(p.spanHours / 24) + " d"} | ${p.ticketRefs} | ${p.fixCommits} | ${p.artifactPoints} / ${ARTIFACT_MAX} | ${p.historyPoints} / ${HISTORY_MAX} | ${p.iterationPoints} / ${ITERATION_MAX} | ${p.total} / ${PROVENANCE_MAX} |`);
	L.push("");
	L.push("### Planning artifacts");
	L.push("| Artifact | File | First commit | Before code | Points |");
	L.push("| --- | --- | --- | --- | ---: |");
	for (const a of p.artifacts) {
		L.push(`| ${a.kind} | ${a.file ?? "missing"} | ${a.firstCommit ?? "-"} | ${a.file ? (a.beforeCode ? "yes" : "no, half credit") : "-"} | ${Number(a.points.toFixed(2))} |`);
	}
	L.push("");
	if (contextBundle) L.push(contextBundle, "");
	L.push("### Iterations after first ship");
	if (!p.rounds.length) L.push("None. One code commit, never touched again.");
	else {
		L.push("| Commit | Date | Model from trailer | Tier | Points |");
		L.push("| --- | --- | --- | --- | ---: |");
		for (const r of p.rounds) L.push(`| ${r.hash} ${r.subject} | ${r.date} | ${r.model} | ${r.tier} | ${r.points.toFixed(1)} |`);
	}
	L.push("");
	L.push("### Reading the provenance");
	L.push(`- Artifacts: docs/plan/map.md (Wayfinder), spec.md (to-spec), tickets/ (to-tickets), decisions.md (grill-me). ${ARTIFACT_MAX / 4} points each when committed before the first code commit, half when written after the fact, sum rounded.`);
	L.push(`- History: 3 for five or more commits, up to 5 for commits that reference a ticket, up to 4 for fix or review commits, 3 for three or more active days.`);
	L.push(`- Iterations: ${POINTS_PER_ROUND} points per code commit after the first ship, times the tier weight of the model in its Co-Authored-By trailer. No trailer counts as unknown. Seven T1 rounds fill the criterion.`);
	L.push(`- One-shot: no history, one commit, or all commits inside ${ONE_SHOT_HOURS} hours on one day. Flagged. Provenance capped at ${ONE_SHOT_BASE}, plus ${ONE_SHOT_SPEC_BONUS} when a spec or decisions file is kept and ${ONE_SHOT_MODEL_BONUS} when a T1 or T2 model signed the commits. Overall score capped at ${ONE_SHOT_SCORE_CAP} (F), or ${ONE_SHOT_SCORE_CAP_LIFTED} (D) with both lifts.`);
	L.push(`- These ${PROVENANCE_MAX} points join the context bundle (10, table above when a bundle exists), the model points from traces (20), independent review (15) and live verification (5) for the 100-point Agent Loop Effort Score. A one-shot repo earns zero bundle points.`);
	return L.join("\n");
}
