import { execFileSync } from "node:child_process";
import { readCommits, type Commit } from "./provenance.ts";

/** Branch scope shared by the PR block and the trailer rewriter: base ref, merge base and the branch commits. */

export const BASE_REFS = ["upstream/HEAD", "origin/HEAD", "origin/main", "main"] as const;
export const MAX_REF_LENGTH = 200;

export interface BranchScope {
	root: string;
	head: string;
	branch: string;
	/** The base ref name that resolved, bounded for output. */
	base: string;
	mergeBase: string;
	/** Epoch ms of the merge-base author date. */
	mergeBaseTime: number;
	/** Oldest first. */
	commits: Commit[];
}

export type ScopeResult = { ok: true; scope: BranchScope } | { ok: false; error: string };

export function git(dir: string, args: string[]): string | undefined {
	try {
		return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return undefined;
	}
}

export function resolveCommit(dir: string, ref: string): string | undefined {
	return git(dir, ["rev-parse", "--verify", `${ref}^{commit}`]);
}

export function boundedName(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, MAX_REF_LENGTH);
}

export function resolveBranchScope(dir: string, base?: string): ScopeResult {
	const root = git(dir, ["rev-parse", "--show-toplevel"]);
	if (!root) return { ok: false, error: "Not a git repository." };
	const head = resolveCommit(root, "HEAD");
	if (!head) return { ok: false, error: "HEAD does not resolve to a commit." };

	let baseName: string | undefined;
	let baseHash: string | undefined;
	for (const candidate of base ? [base] : BASE_REFS) {
		const resolved = resolveCommit(root, candidate);
		if (resolved) {
			baseName = boundedName(candidate);
			baseHash = resolved;
			break;
		}
	}
	if (!baseHash || !baseName) return { ok: false, error: base ? "Base ref does not resolve." : "No base ref resolves." };

	const mergeBase = git(root, ["merge-base", baseHash, head]);
	if (!mergeBase) return { ok: false, error: "The base ref has no merge base with HEAD." };
	if (mergeBase === head) return { ok: false, error: "No commits exist on this branch." };
	const mergeBaseTime = Number(git(root, ["show", "-s", "--format=%at", mergeBase])) * 1000;
	if (!Number.isFinite(mergeBaseTime)) return { ok: false, error: "The merge-base time is unavailable." };

	const commits = readCommits(root, `${mergeBase}..${head}`);
	if (!commits.length) return { ok: false, error: "No commits exist on this branch." };
	const branch = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]) || "HEAD";
	return { ok: true, scope: { root, head, branch: boundedName(branch), base: baseName, mergeBase, mergeBaseTime, commits } };
}
