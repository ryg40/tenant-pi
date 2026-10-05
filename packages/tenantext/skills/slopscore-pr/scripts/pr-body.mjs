#!/usr/bin/env node
// pr-body: put a slopscore block into the `## slopscore` section of the open PR for a branch.
// Usage: slopscore pr | node pr-body.mjs [--branch NAME] [--apply]
// Without --apply it prints the new body and changes nothing. It never pushes.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

const SECTION = "## slopscore";

const HEADING_RE = /^ {0,3}#{1,2}(?:\s|$)/;
const SECTION_RE = /^ {0,3}## +slopscore\s*$/;

/**
 * Locate the `## slopscore` section: [start, end) line indexes, where end is the next h1 or h2 heading or the end of
 * the body. Lines inside fenced code blocks are neither headings nor the section, so a quoted copy of the block is skipped.
 */
function findSection(lines) {
	let fenced = false;
	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		if (/^ {0,3}(```|~~~)/.test(lines[i])) { fenced = !fenced; continue; }
		if (fenced) continue;
		if (start < 0) { if (SECTION_RE.test(lines[i])) start = i; continue; }
		if (HEADING_RE.test(lines[i])) return { start, end: i };
	}
	return start < 0 ? undefined : { start, end: lines.length };
}

/** The current text of the `## slopscore` section, trimmed, or undefined when the body has none. */
export function currentSection(body) {
	const lines = body.split(/\r?\n/);
	const at = findSection(lines);
	return at ? lines.slice(at.start, at.end).join("\n").trim() : undefined;
}

/**
 * Replace the `## slopscore` section of a PR body with the block, or append the block when the section is missing.
 * Lines outside the section keep their text; the body's own line ending is kept.
 */
export function replaceSection(body, block) {
	const eol = body.includes("\r\n") ? "\r\n" : "\n";
	const lines = body.split(/\r?\n/);
	const blockLines = block.replace(/\r\n/g, "\n").trim().split("\n");
	const at = findSection(lines);
	if (!at) {
		const before = lines.slice();
		while (before.length && before[before.length - 1].trim() === "") before.pop();
		return [...before, ...(before.length ? [""] : []), ...blockLines, ""].join(eol);
	}
	const before = lines.slice(0, at.start);
	while (before.length && before[before.length - 1].trim() === "") before.pop();
	const after = lines.slice(at.end);
	while (after.length && after[0].trim() === "") after.shift();
	while (after.length && after[after.length - 1].trim() === "") after.pop();
	return [...before, ...(before.length ? [""] : []), ...blockLines, ...(after.length ? ["", ...after] : []), ""].join(eol);
}

/** Owner, repo and host from a git remote URL. Undefined when the URL has no recognisable shape. */
export function parseRemote(url) {
	const m = url.trim().match(/^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|[^@]+@)([^/:]+)[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
	if (!m) return undefined;
	return { host: m[1], owner: m[2], repo: m[3] };
}

function git(args, cwd) {
	try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return undefined; }
}

/** Live host access. github.com goes through gh; every other host is treated as Gitea. Tests replace this with fakes. */
export function liveIo(remote, env = process.env) {
	const github = remote.host === "github.com";
	const api = `https://${remote.host}/api/v1/repos/${remote.owner}/${remote.repo}`;
	const headers = { Authorization: `token ${env.GITEA_TOKEN}`, "Content-Type": "application/json" };
	return {
		credential() {
			if (github) { try { execFileSync("gh", ["auth", "status"], { stdio: "ignore" }); return true; } catch { return false; } }
			return Boolean(env.GITEA_TOKEN);
		},
		async findPr(branch) {
			if (github) {
				const raw = execFileSync("gh", ["pr", "list", "--repo", `${remote.owner}/${remote.repo}`, "--head", branch, "--state", "open", "--json", "number,body,url"], { encoding: "utf8" });
				const [pr] = JSON.parse(raw);
				return pr ? { number: pr.number, body: pr.body ?? "", url: pr.url } : undefined;
			}
			for (let page = 1; page <= 10; page++) {
				const res = await fetch(`${api}/pulls?state=open&limit=50&page=${page}`, { headers });
				if (!res.ok) throw new Error(`Gitea API ${res.status} listing pulls.`);
				const pulls = await res.json();
				const pr = pulls.find((p) => p.head?.ref === branch);
				if (pr) return { number: pr.number, body: pr.body ?? "", url: pr.html_url };
				if (pulls.length < 50) break;
			}
			return undefined;
		},
		async updatePr(number, body) {
			if (github) { execFileSync("gh", ["pr", "edit", String(number), "--repo", `${remote.owner}/${remote.repo}`, "--body-file", "-"], { input: body, stdio: ["pipe", "ignore", "inherit"] }); return; }
			const res = await fetch(`${api}/pulls/${number}`, { method: "PATCH", headers, body: JSON.stringify({ body }) });
			if (!res.ok) throw new Error(`Gitea API ${res.status} updating pull ${number}.`);
		},
	};
}

const PASTE = `Paste the block under "${SECTION}" in the PR body.`;

/**
 * Run with explicit inputs. `remotes` is the list to try in order: upstream first in a fork, then origin.
 * Returns { exitCode, output }. Exit 0: body printed or updated.
 * Exit 2: no PR on any remote, or no credential; the block and the paste instruction are in the output.
 */
export async function run({ block, branch, remotes, apply, ioFor }) {
	const blockText = block.trim();
	if (!blockText.startsWith(SECTION)) return { exitCode: 1, output: `stdin must be the slopscore block, starting with "${SECTION}".` };
	if (!remotes?.length) return { exitCode: 2, output: `No recognisable git remote. ${PASTE}\n\n${blockText}` };
	let pr;
	let remote;
	const reasons = [];
	for (const candidate of remotes) {
		const io = ioFor(candidate);
		if (!io.credential()) {
			reasons.push(`${candidate.host === "github.com" ? "gh is not logged in" : "GITEA_TOKEN is not set"} for ${candidate.host}`);
			continue;
		}
		const found = await io.findPr(branch);
		if (found) { pr = found; remote = candidate; break; }
		reasons.push(`No open PR for branch ${branch} on ${candidate.host} (${candidate.owner}/${candidate.repo})`);
	}
	if (!pr) return { exitCode: 2, output: `${reasons.join(". ")}. ${PASTE}\n\n${blockText}` };
	const io = ioFor(remote);
	if (currentSection(pr.body) === blockText) return { exitCode: 0, output: `PR #${pr.number} already carries this block. Nothing to change.` };
	const body = replaceSection(pr.body, blockText);
	if (!apply) return { exitCode: 0, output: `Dry run for PR #${pr.number} (${pr.url}). New body:\n\n${body}\nRerun with --apply to update the PR body.` };
	await io.updatePr(pr.number, body);
	return { exitCode: 0, output: `Updated the ${SECTION} section of PR #${pr.number}: ${pr.url}` };
}

async function main() {
	const args = process.argv.slice(2);
	const apply = args.includes("--apply");
	const branchIndex = args.indexOf("--branch");
	const cwd = process.cwd();
	const branch = branchIndex >= 0 ? args[branchIndex + 1] : git(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd);
	if (!branch) { console.log("Detached HEAD. Pass --branch NAME."); process.exit(1); }
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	const block = Buffer.concat(chunks).toString("utf8");
	// In a fork the PR lives on upstream; try it first, then origin.
	const remotes = ["upstream", "origin"]
		.map((name) => parseRemote(git(["remote", "get-url", name], cwd) ?? ""))
		.filter(Boolean);
	try {
		const result = await run({ block, branch, remotes, apply, ioFor: liveIo });
		console.log(result.output);
		process.exit(result.exitCode);
	} catch (error) {
		console.log(`${error instanceof Error ? error.message : String(error)} ${PASTE}\n\n${block.trim()}`);
		process.exit(2);
	}
}

function isMain() {
	try { return Boolean(process.argv[1]) && import.meta.url === new URL(`file://${realpathSync(process.argv[1])}`).href; } catch { return false; }
}

if (isMain()) await main();
