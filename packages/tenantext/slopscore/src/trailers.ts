import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, resolveBranchScope, type BranchScope } from "./branch.ts";
import { collectClaude } from "./claude-trace.ts";
import { collectPi } from "./pi-trace.ts";
import { loadConfig, type SlopscoreConfig } from "./tiers.ts";
import type { CallRecord } from "./types.ts";

/**
 * `slopscore pr --add-trailers`: propose one Co-Authored-By trailer per branch commit
 * from the traces in that commit's window, and rewrite the branch only on `--yes`.
 * The tool never pushes. It prints the force-push line for the contributor.
 */

/** A trailer value must be safe inside a single-quoted shell word in the rebase todo. */
const SAFE_VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,118}$/;
const UNKNOWN_DOMAIN = "slopscore.local";
/** Provider domain by model id prefix, then by trace provider name. */
const DOMAIN_BY_MODEL: Array<[RegExp, string]> = [
	[/^(gpt-|o[1-9](-|$)|codex)/i, "openai.com"],
	[/^claude/i, "anthropic.com"],
	[/^gemini/i, "google.com"],
	[/^grok/i, "x.ai"],
	[/^(mistral|codestral|devstral)/i, "mistral.ai"],
];
const DOMAIN_BY_PROVIDER: Array<[RegExp, string]> = [
	[/openai|codex/i, "openai.com"],
	[/anthropic|claude/i, "anthropic.com"],
	[/google|gemini|vertex/i, "google.com"],
	[/xai/i, "x.ai"],
	[/mistral/i, "mistral.ai"],
];

export interface TrailerOptions {
	base?: string;
	yes: boolean;
	force: boolean;
	json: boolean;
}

export interface TrailerRow {
	commit: string;
	subject: string;
	/** Existing Co-Authored-By names, when the commit already has any. */
	existing: string[];
	/** Full trailer text proposed for a commit without one. */
	proposed?: string;
	signed: boolean;
}

export interface TrailerPlan {
	branch: string;
	base: string;
	rows: TrailerRow[];
	/** Remote names that carry this branch, by name or as its configured upstream. */
	remotes: string[];
	/** Where the force-push line points: the configured upstream, else the first remote with the branch, else origin. */
	push: { remote: string; branch: string };
	/** Signed commits at or after the first rewritten commit lose their signature bytes. */
	signedAfterRewrite: number;
	/** Merge commits on the branch. The rewriter does not pick merges, so any means refusal. */
	mergeCommits: number;
}

export type TrailerPlanResult = { ok: true; plan: TrailerPlan; scope: BranchScope } | { ok: false; error: string };

export function providerDomain(model: string, provider?: string): string {
	for (const [re, domain] of DOMAIN_BY_MODEL) if (re.test(model)) return domain;
	if (provider) for (const [re, domain] of DOMAIN_BY_PROVIDER) if (re.test(provider)) return domain;
	return UNKNOWN_DOMAIN;
}

export function trailerText(model: string, provider?: string): string {
	return `Co-Authored-By: ${model} <noreply@${providerDomain(model, provider)}>`;
}

/** The main-role model with the most spend among records with previousTime < timestamp <= commitTime. */
export function proposeModel(records: CallRecord[], previousTime: number, commitTime: number): { model: string; provider?: string } | undefined {
	const spend = new Map<string, { spend: number; provider?: string }>();
	for (const record of records) {
		if (record.role !== "main" || record.timestamp <= previousTime || record.timestamp > commitTime) continue;
		if (!SAFE_VALUE_RE.test(record.model)) continue;
		const entry = spend.get(record.model) ?? { spend: 0, provider: record.provider };
		entry.spend += record.cost ?? 0;
		spend.set(record.model, entry);
	}
	const best = [...spend.entries()].sort((a, b) => b[1].spend - a[1].spend || a[0].localeCompare(b[0]))[0];
	return best ? { model: best[0], provider: best[1].provider } : undefined;
}

/** A commit is signed when its raw object carries a gpgsig header. `%G?` misses SSH signatures without an allowed-signers file. */
function isSigned(root: string, hash: string): boolean {
	const raw = git(root, ["cat-file", "commit", hash]) ?? "";
	return /^gpgsig(?:-sha256)? /m.test(raw);
}

/** Remotes that carry the branch: a remote-tracking ref with the same name, or the configured upstream under any name. */
function remotesWithBranch(root: string, branch: string): { remotes: string[]; push: { remote: string; branch: string } } {
	if (branch === "HEAD") return { remotes: [], push: { remote: "origin", branch } };
	const remotes: string[] = [];
	let push: { remote: string; branch: string } | undefined;
	const upstreamRemote = git(root, ["config", "--get", `branch.${branch}.remote`]);
	const upstreamMerge = git(root, ["config", "--get", `branch.${branch}.merge`]);
	if (upstreamRemote && upstreamMerge && upstreamRemote !== ".") {
		remotes.push(upstreamRemote);
		push = { remote: upstreamRemote, branch: upstreamMerge.replace(/^refs\/heads\//, "") };
	}
	const raw = git(root, ["for-each-ref", "--format=%(refname)", "refs/remotes"]) ?? "";
	const suffix = `/${branch}`;
	for (const ref of raw.split("\n")) {
		if (!ref.startsWith("refs/remotes/") || !ref.endsWith(suffix)) continue;
		const remote = ref.slice("refs/remotes/".length, ref.length - suffix.length);
		if (remote && !remote.includes("/") && !remotes.includes(remote)) remotes.push(remote);
	}
	return { remotes, push: push ?? { remote: remotes[0] ?? "origin", branch } };
}

function rebaseInProgress(root: string): boolean {
	return ["rebase-merge", "rebase-apply"].some((name) => {
		const path = git(root, ["rev-parse", "--git-path", name]);
		return path !== undefined && existsSync(path.startsWith("/") ? path : `${root}/${path}`);
	});
}

export function planTrailers(dir: string, options: TrailerOptions, cfg: SlopscoreConfig = loadConfig()): TrailerPlanResult {
	const resolved = resolveBranchScope(dir, options.base);
	if (!resolved.ok) return resolved;
	const scope = resolved.scope;
	const filter = { cwdInside: scope.root, sessionStartedSince: scope.mergeBaseTime };
	const records = [...collectPi(filter), ...collectClaude(filter, undefined, cfg.prices)];
	const mergeCommits = Number(git(scope.root, ["rev-list", "--merges", "--count", `${scope.mergeBase}..${scope.head}`]) ?? 0);

	let previousTime = scope.mergeBaseTime;
	const rows: TrailerRow[] = scope.commits.map((commit) => {
		const row: TrailerRow = { commit: commit.hash, subject: commit.subject, existing: commit.coauthors, signed: isSigned(scope.root, commit.hash) };
		if (!commit.coauthors.length) {
			const proposal = proposeModel(records, previousTime, commit.time);
			if (proposal) row.proposed = trailerText(proposal.model, proposal.provider);
		}
		previousTime = commit.time;
		return row;
	});
	const firstRewrite = rows.findIndex((row) => row.proposed);
	const signedAfterRewrite = firstRewrite < 0 ? 0 : rows.slice(firstRewrite).filter((row) => row.signed).length;
	const { remotes, push } = remotesWithBranch(scope.root, scope.branch);
	return {
		ok: true,
		scope,
		plan: { branch: scope.branch, base: scope.base, rows, remotes, push, signedAfterRewrite, mergeCommits },
	};
}

const cell = (value: string) => value.replace(/[\u0000-\u001f\u007f]/g, "?").replace(/\|/g, "\\|").slice(0, 120);

function renderTrailerTable(plan: TrailerPlan): string[] {
	return [
		`## slopscore trailers: branch ${cell(plan.branch)} vs ${cell(plan.base)}`,
		"",
		"| Commit | Subject | Trailer |",
		"| --- | --- | --- |",
		...plan.rows.map((row) => {
			const trailer = row.existing.length ? `existing: ${row.existing.map(cell).join(", ")}` : row.proposed ? `proposed: ${cell(row.proposed)}` : "no proposal";
			return `| ${row.commit} | ${cell(row.subject)} | ${trailer} |`;
		}),
		"",
	];
}

export function renderTrailerPlan(plan: TrailerPlan): string {
	const lines = renderTrailerTable(plan);
	const count = plan.rows.filter((row) => row.proposed).length;
	if (!count) lines.push("Nothing to add. Every commit has a trailer or no session in its window.");
	else lines.push(`Dry run. ${count} commit${count === 1 ? "" : "s"} would gain a trailer. Rerun with --yes to rebase.`);
	if (plan.signedAfterRewrite) lines.push(`${plan.signedAfterRewrite} signed commit${plan.signedAfterRewrite === 1 ? "" : "s"} at or after the first rewrite will be re-created; the signature is kept only when commit.gpgsign re-signs. --force is required.`);
	if (plan.remotes.length) lines.push(`Branch ${cell(plan.branch)} exists on remote ${plan.remotes.join(", ")}. --force is required.`);
	if (plan.mergeCommits) lines.push(`The branch has ${plan.mergeCommits} merge commit${plan.mergeCommits === 1 ? "" : "s"}. --add-trailers does not rewrite merges; rebase the branch onto its base first.`);
	return lines.join("\n");
}

/** Rewrite the branch with `git rebase -i` driven by a prepared todo list. Returns the rewritten count. */
export function applyTrailers(scope: BranchScope, plan: TrailerPlan): { ok: true; rewritten: number } | { ok: false; error: string } {
	const todo: string[] = [];
	let rewritten = 0;
	for (const row of plan.rows) {
		todo.push(`pick ${row.commit}`);
		if (row.proposed) {
			todo.push(`exec git commit --amend --no-edit --trailer '${row.proposed}'`);
			rewritten++;
		}
	}
	if (!rewritten) return { ok: true, rewritten: 0 };
	if (rebaseInProgress(scope.root)) return { ok: false, error: "A rebase is already in progress. Finish or abort it first." };
	const tmp = mkdtempSync(join(tmpdir(), "slopscore-rebase-"));
	const todoFile = join(tmp, "todo");
	writeFileSync(todoFile, todo.join("\n") + "\n");
	try {
		execFileSync("git", ["rebase", "--interactive", "--no-autosquash", scope.mergeBase], {
			cwd: scope.root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			// The todo path travels in the environment, so the shell never parses it; quotes or spaces in TMPDIR are safe.
			env: { ...process.env, SLOPSCORE_TODO: todoFile, GIT_SEQUENCE_EDITOR: 'cp "$SLOPSCORE_TODO"', GIT_EDITOR: "true" },
		});
	} catch (error) {
		// Only this process could have started the rebase: the in-progress check above ran first.
		git(scope.root, ["rebase", "--abort"]);
		const stderr = (error as { stderr?: string }).stderr ?? "";
		const reason = stderr.split("\n").map((line) => line.trim()).find((line) => line && !line.startsWith("hint:")) ?? "git rebase failed.";
		return { ok: false, error: `Rebase failed and was aborted: ${reason}` };
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
	return { ok: true, rewritten };
}

export function runTrailers(dir: string, options: TrailerOptions, cfg: SlopscoreConfig = loadConfig()): { exitCode: number; output: string } {
	const planned = planTrailers(dir, options, cfg);
	if (!planned.ok) return { exitCode: 1, output: planned.error };
	const { plan, scope } = planned;
	if (options.json && !options.yes) return { exitCode: 0, output: JSON.stringify(plan, null, 2) };
	if (!options.yes) return { exitCode: 0, output: renderTrailerPlan(plan) };
	if (scope.branch === "HEAD") return { exitCode: 1, output: "Detached HEAD. Check out the branch before --yes." };
	if (plan.remotes.length && !options.force) {
		return { exitCode: 1, output: `Branch ${cell(plan.branch)} exists on remote ${plan.remotes.join(", ")}. Rerun with --force to rewrite it.` };
	}
	if (plan.signedAfterRewrite && !options.force) {
		return { exitCode: 1, output: `${plan.signedAfterRewrite} signed commits would be re-created. Rerun with --force to accept that.` };
	}
	if (plan.mergeCommits) return { exitCode: 1, output: `The branch has ${plan.mergeCommits} merge commits. Rebase it onto its base first; --add-trailers does not rewrite merges.` };
	const applied = applyTrailers(scope, plan);
	if (!applied.ok) return { exitCode: 1, output: applied.error };
	const pushLine = `git push --force-with-lease ${plan.push.remote} ${plan.push.branch === plan.branch ? plan.branch : `HEAD:${plan.push.branch}`}`;
	const lines = [
		...renderTrailerTable(plan),
		`Rewrote ${applied.rewritten} commit${applied.rewritten === 1 ? "" : "s"} on ${cell(plan.branch)}. Nothing was pushed.`,
		"",
		"```",
		pushLine,
		"```",
	];
	if (options.json) return { exitCode: 0, output: JSON.stringify({ ...plan, rewritten: applied.rewritten, pushLine }, null, 2) };
	return { exitCode: 0, output: lines.join("\n") };
}
