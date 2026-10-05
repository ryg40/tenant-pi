import { execFileSync } from "node:child_process";
import { posix, resolve } from "node:path";
import { parseDocument } from "yaml";
import { isCodeFile, readCommits, scoreRepo, type Commit } from "./provenance.ts";
import { loadConfig } from "./tiers.ts";

export interface OkfSummary {
	revision: string;
	present: boolean;
	root?: string;
	version?: string;
	conformant: boolean;
	conformanceFailures: string[];
	conceptCount: number;
	verifiedCount: number;
	logCurrent: boolean;
	codeDays: number;
	maintainedDays: number;
	keptCurrentShare: number;
	staleCount: number;
	staleConcepts: string[];
	calculatedPoints: number;
	points: number;
	oneShot: boolean;
}

export interface OkfOptions {
	revision?: string;
	now?: Date;
	oneShot?: boolean;
	/** Limit the maintenance history to this git range, for example `<merge-base>..HEAD` for a branch. */
	range?: string;
}

interface TreeFile { path: string; mode: string }
interface ParsedFrontmatter { value?: Record<string, unknown>; error?: string }

function git(dir: string, args: string[]): string {
	return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function resolveRevision(dir: string, revision: string): string {
	return git(dir, ["rev-parse", "--verify", `${revision}^{commit}`]).trim();
}

function treeFiles(dir: string, revision: string): TreeFile[] {
	const raw = git(dir, ["ls-tree", "-rz", "--full-tree", revision]);
	return raw.split("\0").filter(Boolean).flatMap((entry) => {
		const tab = entry.indexOf("\t");
		if (tab < 0) return [];
		const [mode, type] = entry.slice(0, tab).split(" ");
		return type === "blob" && mode !== "120000" ? [{ mode, path: entry.slice(tab + 1) }] : [];
	});
}

function readBlob(dir: string, revision: string, path: string): string {
	return git(dir, ["show", `${revision}:${path}`]);
}

function frontmatter(markdown: string): ParsedFrontmatter {
	const lines = markdown.replace(/\r\n/g, "\n").split("\n");
	if (lines[0] !== "---") return { error: "missing YAML frontmatter" };
	const end = lines.indexOf("---", 1);
	if (end < 0) return { error: "unterminated YAML frontmatter" };
	const source = lines.slice(1, end).join("\n");
	try {
		const doc = parseDocument(source, { prettyErrors: false, schema: "core" });
		if (doc.errors.length) return { error: `malformed YAML: ${doc.errors[0].message.split("\n")[0]}` };
		const value = doc.toJS({ maxAliasCount: 100 });
		if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "frontmatter is not a mapping" };
		return { value: value as Record<string, unknown> };
	} catch (error) {
		return { error: `malformed YAML: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}` };
	}
}

function insideRoot(path: string, root: string): boolean {
	return root === "" || path === root || path.startsWith(`${root}/`);
}

function relativeToRoot(path: string, root: string): string {
	return root === "" ? path : path.slice(root.length + 1);
}

function addDay(date: string): string {
	const instant = new Date(`${date}T00:00:00Z`);
	instant.setUTCDate(instant.getUTCDate() + 1);
	return instant.toISOString().slice(0, 10);
}

function parseInstant(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value;
	const time = Date.parse(normalized);
	return Number.isFinite(time) ? time : undefined;
}

function latestVerification(value: unknown): number | undefined {
	const entries = Array.isArray(value) ? value : value && typeof value === "object" ? [value] : [];
	const times = entries.flatMap((entry) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
		const time = parseInstant((entry as Record<string, unknown>).at);
		return time === undefined ? [] : [time];
	});
	return times.length ? Math.max(...times) : undefined;
}

/** A repo-relative path for a local source, or undefined for a URL or a path outside the repo. Deleted paths still resolve, so their deletion counts as a change. */
function localSourcePath(resource: unknown, conceptPath: string, root: string): string | undefined {
	if (typeof resource !== "string" || !resource || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(resource)) return undefined;
	const withoutSuffix = resource.split(/[?#]/, 1)[0];
	if (!withoutSuffix) return undefined;
	const candidate = withoutSuffix.startsWith("/")
		? posix.normalize(posix.join(root, withoutSuffix.slice(1)))
		: posix.normalize(posix.join(posix.dirname(conceptPath), withoutSuffix));
	if (candidate === ".." || candidate === "." || candidate.startsWith("../") || posix.isAbsolute(candidate)) return undefined;
	return candidate;
}

function sourceChangedAfter(path: string, verifiedAt: number, commits: Commit[]): boolean {
	return commits.some((commit) => commit.time > verifiedAt && commit.files.some((file) => file === path || file.startsWith(`${path}/`)));
}

/** `okf_version` is declared when the key is present with a non-empty scalar; `0.2` unquoted is a YAML number and still counts. */
function declaredVersion(value: unknown): string | undefined {
	if (typeof value === "string") return value.trim() || undefined;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return undefined;
}

/** True when the bundle's index already declares a version at the commit before a range starts. */
function bundleAtRangeStart(dir: string, range: string, indexPath: string): boolean {
	const start = range.split("..")[0];
	if (!start || start === range) return false;
	try {
		return declaredVersion(frontmatter(readBlob(dir, start, indexPath)).value?.okf_version) !== undefined;
	} catch {
		return false;
	}
}

function firstBundleCommit(dir: string, revision: string, indexPath: string): string | undefined {
	const raw = git(dir, ["--literal-pathspecs", "log", "--reverse", "--format=%H", revision, "--", indexPath]);
	for (const hash of raw.split("\n").filter(Boolean)) {
		try {
			if (declaredVersion(frontmatter(readBlob(dir, hash, indexPath)).value?.okf_version) !== undefined) return hash;
		} catch {
			// The path can be absent at a deletion commit in its bounded history.
		}
	}
	return undefined;
}

function emptySummary(revision: string, oneShot: boolean): OkfSummary {
	return {
		revision, present: false, conformant: false, conformanceFailures: [], conceptCount: 0, verifiedCount: 0,
		logCurrent: false, codeDays: 0, maintainedDays: 0, keptCurrentShare: 0,
		staleCount: 0, staleConcepts: [], calculatedPoints: 0, points: 0, oneShot,
	};
}

/** Read and score an OKF bundle only from committed Git objects. */
export function readOkf(dir: string, options: OkfOptions = {}): OkfSummary {
	const revision = resolveRevision(dir, options.revision ?? "HEAD");
	const oneShot = options.oneShot ?? false;
	const files = treeFiles(dir, revision);
	const paths = new Set(files.map((file) => file.path));
	const roots = files
		.filter((file) => posix.basename(file.path) === "index.md")
		.flatMap((file) => {
			const version = declaredVersion(frontmatter(readBlob(dir, revision, file.path)).value?.okf_version);
			return version !== undefined ? [{ root: posix.dirname(file.path) === "." ? "" : posix.dirname(file.path), version }] : [];
		})
		.sort((a, b) => a.root.length - b.root.length || (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));
	if (!roots.length) return emptySummary(revision, oneShot);

	const { root, version } = roots[0];
	const concepts = files.filter((file) => insideRoot(file.path, root) && file.path.endsWith(".md") && !["index.md", "log.md"].includes(posix.basename(file.path)));
	const conformanceFailures: string[] = [];
	const parsedConcepts = concepts.map((file) => {
		const parsed = frontmatter(readBlob(dir, revision, file.path));
		if (parsed.error) conformanceFailures.push(`${file.path}: ${parsed.error}`);
		else if (typeof parsed.value?.type !== "string" || !parsed.value.type.trim()) conformanceFailures.push(`${file.path}: missing non-empty type`);
		return { path: file.path, metadata: parsed.value };
	});
	const conformant = conformanceFailures.length === 0;
	const verifiedCount = parsedConcepts.filter((concept) => latestVerification(concept.metadata?.verified) !== undefined).length;

	const commits = readCommits(dir, options.range ?? revision);
	const indexPath = root ? `${root}/index.md` : "index.md";
	// In a bounded range the bundle can predate the range; every commit in the range then counts, even when a range commit edits the index.
	const predates = options.range !== undefined && bundleAtRangeStart(dir, options.range, indexPath);
	const firstHash = predates ? undefined : firstBundleCommit(dir, options.range ?? revision, indexPath);
	const firstIndex = firstHash ? commits.findIndex((commit) => firstHash.startsWith(commit.hash) || commit.hash.startsWith(firstHash)) : -1;
	const relevantCommits = predates ? commits : firstIndex >= 0 ? commits.slice(firstIndex) : [];
	const codeCommits = relevantCommits.filter((commit) => commit.files.some(isCodeFile));
	const codeDays = [...new Set(codeCommits.map((commit) => commit.date))].sort();
	const touchDays = new Set(relevantCommits.filter((commit) => commit.files.some((file) => insideRoot(file, root))).map((commit) => commit.date));
	const maintainedDays = codeDays.filter((date) => touchDays.has(date) || touchDays.has(addDay(date))).length;
	const keptCurrentShare = codeDays.length ? maintainedDays / codeDays.length : 0;

	const logPath = root ? `${root}/log.md` : "log.md";
	const lastCodeDay = codeDays.at(-1);
	let logCurrent = false;
	if (lastCodeDay && paths.has(logPath)) {
		const logDates = [...readBlob(dir, revision, logPath).matchAll(/^## (\d{4}-\d{2}-\d{2})\s*$/gm)]
			.map((match) => match[1])
			.filter((date) => { const instant = new Date(`${date}T00:00:00Z`); return Number.isFinite(instant.getTime()) && instant.toISOString().slice(0, 10) === date; });
		logCurrent = logDates.some((date) => date >= lastCodeDay);
	}

	const now = (options.now ?? new Date()).getTime();
	const staleConcepts: string[] = [];
	for (const concept of parsedConcepts) {
		const metadata = concept.metadata;
		if (!metadata) continue;
		let stale = false;
		const staleAfter = parseInstant(metadata.stale_after);
		if (staleAfter !== undefined && now >= staleAfter) stale = true;
		const verifiedAt = latestVerification(metadata.verified);
		if (verifiedAt !== undefined && Array.isArray(metadata.sources)) {
			for (const source of metadata.sources) {
				if (!source || typeof source !== "object" || Array.isArray(source)) continue;
				const sourcePath = localSourcePath((source as Record<string, unknown>).resource, concept.path, root);
				if (sourcePath && sourceChangedAfter(sourcePath, verifiedAt, commits)) stale = true;
			}
		}
		if (stale) staleConcepts.push(concept.path);
	}

	const calculatedPoints = Math.max(0, (conformant ? 3 : 0) + (logCurrent ? 2 : 0) + 5 * keptCurrentShare - staleConcepts.length);
	return {
		revision, present: true, root: root || ".", version, conformant, conformanceFailures, conceptCount: concepts.length,
		verifiedCount, logCurrent, codeDays: codeDays.length, maintainedDays, keptCurrentShare, staleCount: staleConcepts.length,
		staleConcepts, calculatedPoints, points: oneShot ? 0 : calculatedPoints, oneShot,
	};
}

/** The one-line bundle summary for the PR block. */
export function okfBranchLine(summary: OkfSummary | undefined): string {
	if (!summary?.present) return "none";
	return `${summary.conceptCount} concepts, ${Math.round(summary.keptCurrentShare * 100)}% kept current on this branch`;
}

function escapeCell(value: string): string {
	return value.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

/** Render the standalone context-bundle table and named failures. */
export function renderOkf(summary: OkfSummary): string {
	if (!summary.present) return "### Context bundle\n\nBundle: none";
	const percent = `${Math.round(summary.keptCurrentShare * 100)}%`;
	const lines = [
		"### Context bundle", "",
		"| Root | Version | Concepts | Conformant | Log current | Kept current | Stale | Verified | Points |",
		"| --- | --- | ---: | --- | --- | ---: | ---: | ---: | ---: |",
		`| ${escapeCell(summary.root ?? ".")} | ${escapeCell(summary.version ?? "unknown")} | ${summary.conceptCount} | ${summary.conformant ? "yes" : "no"} | ${summary.logCurrent ? "yes" : "no"} | ${percent} (${summary.maintainedDays}/${summary.codeDays}) | ${summary.staleCount} | ${summary.verifiedCount} | ${summary.points.toFixed(1)} / 10 |`,
	];
	for (const failure of summary.conformanceFailures) lines.push(`- Conformance: ${escapeCell(failure)}`);
	for (const path of summary.staleConcepts) lines.push(`- Stale: ${escapeCell(path)}`);
	if (summary.oneShot && summary.calculatedPoints > 0) lines.push(`- One-shot: calculated ${summary.calculatedPoints.toFixed(1)} points, awarded 0.`);
	return lines.join("\n");
}

export function okfHelp(): string {
	return "Usage: slopscore okf [--repo PATH] [--json] [--help]\n\n  Prints the context bundle table for PATH (default: the current directory) and one line per failing concept.";
}

/** `slopscore okf`: the standalone bundle table for one repository. Shared by the CLI, Pi and Claude Code. */
export function runOkf(args: string[], dir = process.cwd()): { exitCode: number; output: string } {
	let path = dir;
	let json = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--help" || arg === "-h") return { exitCode: 0, output: okfHelp() };
		if (arg === "--json") json = true;
		else if (arg === "--repo") {
			const value = args[++i];
			if (!value || value.startsWith("--")) return { exitCode: 1, output: "--repo requires a path." };
			path = resolve(dir, value);
		} else return { exitCode: 1, output: "Unknown argument." };
	}
	let summary: OkfSummary;
	try {
		// The same one-shot rule as the full report: a one-shot repository earns zero bundle points.
		const oneShot = scoreRepo(path, loadConfig()).oneShot;
		summary = readOkf(path, { oneShot });
	} catch (error) {
		const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
		return { exitCode: 1, output: `slopscore okf: cannot read repository: ${message}` };
	}
	return { exitCode: 0, output: json ? JSON.stringify(summary, null, 2) : renderOkf(summary) };
}
