// The replay of the chain: an explicit owner command. For each prompt of the owner's sample file it runs
// the chain (the same stores, scope rules, clock and ranker as the shadow run) and then the current
// recall of OpenViking, and renders both as Markdown. It writes no record line, no log line and no
// persistent cache. The current recall runs with a private state folder that the replay removes at its end.
import { execFileSync } from "node:child_process";
import { closeSync, constants, fchmodSync, lstatSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { parseExtraHeaders } from "../../openviking-pi/shared/mcp-proxy-config.mjs";
import { createOvHttp } from "../../openviking-pi/shared/ov-http.mjs";
import { buildRecallBlockDetailed, isRecallEnabled } from "../../openviking-pi/shared/recall-core.mjs";
import { resolveWorkspaceIdentity } from "../../openviking-pi/shared/workspace-identity.mjs";
import { resolveEffectivePeerId } from "../../openviking-pi/shared/workspace-peer.mjs";
import { realClock, testRanker } from "./core.mjs";
import { runPrompt } from "./shadow.mjs";

export const HARNESSES = Object.freeze(["pi", "claude-code"]);

/** A refusal of the command: it writes nothing and exits with a code other than 0. */
export class Refusal extends Error {}

/** Read the sample file read-only and check its form. */
export function readSample(path) {
	let value;
	try {
		value = JSON.parse(readFileSync(path, { encoding: "utf8", flag: "r" }));
	} catch {
		throw new Refusal("the sample file does not read as JSON");
	}
	const prompts = value?.prompts;
	if (!Array.isArray(prompts) || !prompts.length) throw new Refusal("the sample file has no prompts list");
	prompts.forEach((item, index) => {
		const where = `sample prompt ${index + 1}`;
		if (!HARNESSES.includes(item?.harness)) throw new Refusal(`${where}: harness is not pi or claude-code`);
		if (typeof item.cwd !== "string" || !isAbsolute(item.cwd)) throw new Refusal(`${where}: cwd is not an absolute path`);
		if (typeof item.prompt !== "string") throw new Refusal(`${where}: prompt is not a string`);
	});
	return prompts.map(({ harness, cwd, prompt }) => ({ harness, cwd, prompt }));
}

/** The environment of the git check: no variable that points git at another repository. */
function gitEnv() {
	const env = { ...process.env };
	for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_CEILING_DIRECTORIES"]) delete env[name];
	return env;
}

/** True when `path` exists, links not followed. */
function present(path) {
	try { lstatSync(path); return true; } catch { return false; }
}

/** True when `dir` holds the files of a bare repository: `HEAD`, `objects/` and `refs/`. */
function looksBare(dir) {
	try {
		return lstatSync(join(dir, "HEAD")).isFile() && lstatSync(join(dir, "objects")).isDirectory()
			&& lstatSync(join(dir, "refs")).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Is the real folder `dir` inside a git work tree, a `.git` folder or a bare repository?
 * `git rev-parse --absolute-git-dir` decides: any answer means a repository. The file test of each
 * real ancestor (a `.git` entry, or `HEAD`, `objects/` and `refs/`) runs too, so a repository that
 * git refuses to name (for example one of another owner) or a host with no git still counts.
 * Returns `{inside, gitRan}`.
 */
export function insideRepository(dir) {
	let gitRan = true;
	try {
		const answer = execFileSync("git", ["-C", dir, "rev-parse", "--absolute-git-dir"], {
			env: gitEnv(), stdio: ["ignore", "pipe", "ignore"], encoding: "utf8", timeout: 10_000,
		});
		if (answer.trim()) return { inside: true, gitRan };
	} catch (error) {
		// A status from git means "not a repository" (or a refusal); no status means git did not run.
		if (typeof error?.status !== "number") gitRan = false;
	}
	for (let current = dir; ; current = dirname(current)) {
		if (basename(current) === ".git" || present(join(current, ".git")) || looksBare(current)) return { inside: true, gitRan };
		if (dirname(current) === current) break;
	}
	return { inside: false, gitRan };
}

const OUT_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

/**
 * Check the `--out` path and create the file, before any request. The folder of the path is
 * resolved once to its real path; the real folder and each real ancestor must be outside every git
 * repository. The file is made in that real folder with an exclusive create, no link followed, mode
 * 0600. Returns `{fd, path, gitRan}`.
 */
export function openOut(path) {
	const target = resolve(path);
	const name = basename(target);
	if (!name || name === "." || name === "..") throw new Refusal("the output path names no file");
	let dir;
	try {
		dir = realpathSync(dirname(target));
	} catch {
		throw new Refusal("the folder of the output path is missing");
	}
	let folder = null;
	try { folder = statSync(dir); } catch { /* checked below */ }
	if (!folder?.isDirectory()) throw new Refusal("the folder of the output path is missing");
	const { inside, gitRan } = insideRepository(dir);
	if (inside) throw new Refusal("the output path is inside a git repository");
	const real = join(dir, name);
	let fd;
	try {
		fd = openSync(real, OUT_FLAGS, 0o600);
	} catch (error) {
		throw new Refusal(error?.code === "EEXIST" || error?.code === "ELOOP" ? "the output path exists" : "the output file cannot be created");
	}
	try {
		fchmodSync(fd, 0o600);
	} catch {
		closeSync(fd);
		throw new Refusal("the output file cannot be created");
	}
	return { fd, path: real, gitRan };
}

/** Write all of `text` to `fd`. */
function writeAll(fd, text) {
	const data = Buffer.from(text, "utf8");
	let done = 0;
	while (done < data.length) done += writeSync(fd, data, done, data.length - done);
}

/** Inline code that holds any text: the backtick run is longer than any run in the text. */
function code(text) {
	const value = String(text).replace(/\n/g, " ");
	const longest = Math.max(0, ...(value.match(/`+/g) || []).map((run) => run.length));
	const ticks = "`".repeat(longest + 1);
	return `${ticks}${value.startsWith("`") || value.endsWith("`") ? ` ${value} ` : value}${ticks}`;
}

/** A fenced block that holds any text. */
function fenced(text, info = "text") {
	const longest = Math.max(0, ...(String(text).match(/`{3,}/g) || []).map((run) => run.length));
	const fence = "`".repeat(Math.max(3, longest + 1));
	return `${fence}${info}\n${text}\n${fence}`;
}

/** The current recall of OpenViking for one prompt, with the peer options of the Pi extension. */
async function currentRecall({ cfg, query, cwd, env, stateDir }) {
	if (!cfg?.baseUrl) return { status: "not configured" };
	if (!isRecallEnabled(cfg)) return { status: "off in the OpenViking config" };
	const identity = resolveWorkspaceIdentity({ cwd, env, cache: false });
	const peer = resolveEffectivePeerId({ cfg, cwd, identity, env, onWarn: () => {} });
	const fetchJSON = createOvHttp(cfg, {
		defaultTimeoutMs: cfg.timeoutMs,
		extraHeaders: parseExtraHeaders(env.OPENVIKING_EXTRA_HEADERS, { onWarn: () => {} }),
	});
	const startedAt = Date.now();
	try {
		const recall = await buildRecallBlockDetailed(fetchJSON, cfg, query, {
			actorPeerId: peer.peerId,
			legacyPeerId: peer.legacyPeerId,
			excludeUris: cfg.recallExcludeUris,
			// No session: no session id. Every state file of the recall goes to the private folder.
			legacyCachePath: join(stateDir, "context-face.json"),
			digestCachePath: join(stateDir, "recall-digest.json"),
			peerScopeMemoPath: join(stateDir, "peer-scope.json"),
			log: () => {},
		});
		return { status: "ran", ms: Date.now() - startedAt, ...recall };
	} catch {
		return { status: "failed", ms: Date.now() - startedAt };
	}
}

function renderChain(lines, number, result, ms) {
	lines.push("### Chain", "");
	lines.push(`- Kind: ${code(result.kind)}; items: ${result.items.length}; characters: ${result.chars}; time: ${ms} ms`);
	const omission = result.omitted.map((item) => `${item.store} (${item.reason})`).join(", ");
	lines.push(`- Left out: ${omission ? code(omission) : "none"}`, "");
	// The proposed block, unchanged, as the model would see it. The local labels follow below it.
	lines.push("Proposed block:", "", result.block ? fenced(result.block) : "The block is empty: the model would see nothing.", "");
	result.items.forEach((item, index) => {
		lines.push(`#### P${number}.L${index + 1}: ${code(item.id)}, score ${Number(item.score).toFixed(2)}, store ${code(item.store)}`, "");
		lines.push(`- Source: ${code(item.source)}`, "- Useful: [ ]", "- Unrelated: [ ]", "");
		lines.push(item.excerpt ? fenced(item.excerpt) : "No excerpt (the block gives the link only).", "");
	});
}

const RECALL_LABEL = "- This is the vendored OpenViking recall (`buildRecallBlockDetailed`) with the peer options of the Pi extension and no session id.";
const PLUGIN_NOTE = "- It is not the recall of the Claude Code plugin. That plugin resolves the peer by session and folder, can skip a prompt by session, sends a session id for query expansion, and has its own fallback and rendering.";

function renderRecall(lines, recall, harness) {
	lines.push("### Current recall", "", RECALL_LABEL);
	if (harness === "claude-code") lines.push(PLUGIN_NOTE);
	if (recall.status !== "ran") {
		lines.push(`- Status: ${recall.status}`, "");
		return;
	}
	lines.push(`- Stage: ${code(recall.stage)}; content items: ${recall.contentCount}; hint items: ${recall.hintCount}; tokens: about ${recall.budgetUsed}; time: ${recall.ms} ms`, "");
	lines.push(recall.block ? fenced(recall.block) : "No block.", "");
}

/**
 * Run the replay of `prompts` and return the Markdown. The chain and the recall of one prompt run one
 * after the other. `env` is the environment of the chain; `stateDir` the private state folder.
 * `emit(text)`, when given, gets the header and then each prompt part as soon as it is done.
 */
export async function replay(prompts, { env, stateDir, fetchImpl, rank = testRanker, emit = () => {}, notes = [] }) {
	const parts = [];
	const send = (lines) => {
		const text = `${lines.join("\n")}\n`;
		parts.push(text);
		emit(text);
	};
	send([
		"# Memory chain replay", "",
		`- Prompts: ${prompts.length}`,
		"- Ranker: `testRanker` (score order). No shadow record line is written.",
		"- The current recall ran with a fresh memo state: a private state folder, removed at the end.",
		"- A label such as P1.L1 maps the `c<n>` id of this run to its source, only in this output.",
		...notes, "",
	]);
	for (const [index, sample] of prompts.entries()) {
		const number = index + 1;
		const lines = [`## Prompt ${number}`, "", `- Harness: ${code(sample.harness)}`, `- Project folder: ${code(sample.cwd)}`, "", "Prompt:", "", fenced(sample.prompt), ""];
		const startedAt = realClock.now();
		const run = await runPrompt({ harness: sample.harness, prompt: sample.prompt, cwd: sample.cwd, env,
			clock: realClock, startedAt, fetchImpl, rank, record: false });
		if (!run.ran) {
			lines.push("### Skipped", "", `- Reason: ${run.reason}. No store and no recall ran.`, "");
		} else {
			renderChain(lines, number, run.result, run.result.totalMs);
			renderRecall(lines, await currentRecall({ cfg: run.cfg, query: run.query, cwd: sample.cwd, env, stateDir }), sample.harness);
		}
		lines.push("Missing facts:", "");
		send(lines);
	}
	return `${parts.join("").trimEnd()}\n`;
}

const USAGE = "usage: replay.mjs --sample <file> [--out <file>]\n";
const FAILED_LINE = "\nThe replay failed: the run stopped before its end. The parts above are what it wrote.\n";
const SIGNALS = Object.freeze(["SIGINT", "SIGTERM", "SIGHUP"]);

/**
 * The command. `argv` holds `--sample <file>` and an optional `--out <file>`. Returns the exit code.
 * The order: read and check the sample, make the `--out` file, install the signal handlers, make the
 * private state folder, run. The state folder is removed at the end, also after an error or one of
 * the signals SIGINT, SIGTERM and SIGHUP. A kill with SIGKILL or a crash can leave it.
 */
export async function main(argv, { stdout = process.stdout, stderr = process.stderr, fetchImpl } = {}) {
	let samplePath = "";
	let outPath = "";
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === "--sample" && i + 1 < argv.length) samplePath = argv[++i];
		else if (argv[i] === "--out" && i + 1 < argv.length) outPath = argv[++i];
		else {
			stderr.write(USAGE);
			return 2;
		}
	}
	if (!samplePath) {
		stderr.write(USAGE);
		return 2;
	}
	const hadStateDir = Object.hasOwn(process.env, "OPENVIKING_STATE_DIR");
	const earlierStateDir = process.env.OPENVIKING_STATE_DIR;
	let stateDir = "";
	let out = null;
	let finished = false;
	const removeState = () => {
		if (stateDir) rmSync(stateDir, { recursive: true, force: true });
		stateDir = "";
	};
	const closeOut = (failed) => {
		if (!out) return;
		try { if (failed) writeAll(out.fd, FAILED_LINE); } catch { /* keep what was written */ }
		try { closeSync(out.fd); } catch { /* already closed */ }
		out = null;
	};
	const onSignal = (signal) => {
		removeState();
		closeOut(true);
		stderr.write(`replay refused: stopped by ${signal}\n`);
		process.exit(128 + (osConstants.signals[signal] ?? 1));
	};
	for (const signal of SIGNALS) process.on(signal, onSignal);
	try {
		const prompts = readSample(samplePath);
		out = outPath ? openOut(outPath) : null;
		const notes = out && !out.gitRan
			? ["- git did not run: the output folder was checked for git repositories by its files only."] : [];
		stateDir = mkdtempSync(join(tmpdir(), "memory-chain-replay-"));
		// recall-core reads OPENVIKING_STATE_DIR from the process environment for any state file that
		// the options do not name. A sample prompt stands for a primary session: the task-session marker
		// of this process does not apply to it.
		process.env.OPENVIKING_STATE_DIR = stateDir;
		const env = { ...process.env };
		delete env.OPENVIKING_RECALL_COMPRESS;
		const emit = out ? (text) => writeAll(out.fd, text) : (text) => stdout.write(text);
		await replay(prompts, { env, stateDir, fetchImpl, emit, notes });
		finished = true;
		return 0;
	} catch (error) {
		stderr.write(`replay refused: ${error instanceof Refusal ? error.message : "the run failed"}\n`);
		return error instanceof Refusal ? 2 : 1;
	} finally {
		closeOut(!finished);
		removeState();
		if (hadStateDir) process.env.OPENVIKING_STATE_DIR = earlierStateDir;
		else delete process.env.OPENVIKING_STATE_DIR;
		for (const signal of SIGNALS) process.off(signal, onSignal);
	}
}
