import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

export const CUSTOM_TYPE = "herdr-watch";
export const DEFAULT_TIMEOUT_SECONDS = 1500;
/** The notification holds at most this many characters of the reply. */
export const REPLY_LIMIT = 12000;
const STDERR_LIMIT = 2000;
const TAIL_LIMIT = 2000;
/** ask.py clips its reply at 8000 characters by default. The output file keeps the full reply. */
const ASK_MAX_CHARS = 1_000_000;
/** A label in the notification has at most this many characters. */
export const LABEL_LIMIT = 80;
/** A pane id or an agent name in the notification has at most this many characters. */
export const PANE_LIMIT = 64;
/** ask.py exits with 0 and prints this line when the transcript has no new reply. The screen tail follows it. */
export const NO_NEW_REPLY_LINE = "NO NEW REPLY in the transcript";
/** The status of that exit 0: the pane gave no reply. */
export const NO_NEW_REPLY_STATUS = "no new reply, read the screen";
/** spawn.py waits up to 60 seconds for the agent and runs `pi --list-models` once; this bound covers both. */
export const SPAWN_TIMEOUT_SECONDS = 180;
/** After a stop, spawn.py gets this many milliseconds to end on SIGTERM; then its process group gets SIGKILL. */
export const SPAWN_KILL_GRACE_MS = 5000;
/** The extension keeps at most this many characters of each output stream of spawn.py. */
const CAPTURE_LIMIT = 65536;
const KIT_SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), "../../skills/herdr/scripts");

/** The exit codes of ask.py of the herdr skill (SKILL.md, section A2). */
export const EXIT_MEANING: Readonly<Record<number, string>> = {
	0: "reply",
	1: "error, read the stderr file",
	2: "usage error or bad target, nothing sent",
	3: "busy, the pane works on another turn, nothing sent",
	4: "blocked on a question, read the screen",
	5: "no turn started, read the screen",
	6: "API error, the transcript holds no other reply",
	124: "timeout, the pane still works",
};

/** The exit codes of spawn.py of the herdr skill (SPAWN.md, section 3). */
export const SPAWN_EXIT_MEANING: Readonly<Record<number, string>> = {
	1: "the start failed, spawn.py closed the new pane again",
	2: "an input is not valid, nothing was started",
	4: "the agent stopped at a startup question, the pane stays open",
};

export const HARNESSES = ["pi", "claude"] as const;
export const ROLES = ["coordinator", "researcher", "scout", "worker", "reviewer"] as const;

interface WatchFiles { dir: string; prompt: string; stdout: string; stderr: string }

interface Watch {
	id: string;
	pane: string;
	/** The agent name, for a pane that herdr_spawn started. */
	name?: string;
	/** The scripts directory of the herdr skill, for a pane that herdr_spawn started. */
	scripts?: string;
	label?: string;
	pid: number;
	startedAt: number;
	files: WatchFiles;
	state: "running" | "done" | "stopped";
	endedAt?: number;
	exitCode?: number | null;
	signal?: string | null;
	child?: ChildProcess;
}

export interface WatchNotificationDetails {
	id: string;
	pane: string;
	name?: string;
	label?: string;
	status: string;
	exitCode: number | null;
	signal: string | null;
	elapsedMs: number;
	outputFile: string;
	stderrFile: string;
	truncated: boolean;
}

/** A script of the herdr skill: `HERDR_SKILL_DIR` alone when it is set, else the installed skill, else the kit copy. */
export function findSkillScript(script: string, env: NodeJS.ProcessEnv = process.env, home = homedir(), kitScripts = KIT_SCRIPTS): { path?: string; searched: string[] } {
	const dirs = env.HERDR_SKILL_DIR ? [join(env.HERDR_SKILL_DIR, "scripts")] : [join(home, ".agents/skills/herdr/scripts"), kitScripts];
	const searched = dirs.map(dir => join(dir, script));
	return { path: searched.find(file => existsSync(file)), searched };
}

/** The ask.py to start, in the order of findSkillScript. */
export function findAskScript(env: NodeJS.ProcessEnv = process.env, home = homedir(), kitScripts = KIT_SCRIPTS): { path?: string; searched: string[] } {
	return findSkillScript("ask.py", env, home, kitScripts);
}

/** The last line of the output that is a JSON object: spawn.py prints its facts as one JSON line. */
export function lastJsonLine(output: string): Record<string, unknown> | undefined {
	for (const line of output.split("\n").reverse()) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		try {
			const value: unknown = JSON.parse(trimmed);
			if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
		} catch { /* not JSON */ }
	}
	return undefined;
}

/** A word that a POSIX shell reads as one argument. */
function shellWord(value: string): string {
	return /^[\w./:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

/** The command that closes a pane that spawn.py started. */
export function closeCommand(scripts: string, pane: string): string {
	return `python3 ${shellWord(join(scripts, "close.py"))} ${shellWord(pane)}`;
}

/** True when the status lines of the output of ask.py, before `--- reply ---` or `--- screen tail ---`, hold the NO NEW REPLY line. */
export function noNewReply(output: string): boolean {
	for (const line of output.split("\n")) {
		if (line === "--- reply ---" || line === "--- screen tail ---") return false;
		if (line.startsWith(NO_NEW_REPLY_LINE)) return true;
	}
	return false;
}

/** The status word of an ended ask.py. `output` is its standard output: an exit 0 without a new reply has its own word. */
export function statusOf(code: number | null | undefined, signal?: string | null, output = ""): string {
	if (code === null || code === undefined) return signal ? `killed by signal ${signal}` : "unknown";
	if (code === 0 && noNewReply(output)) return NO_NEW_REPLY_STATUS;
	return EXIT_MEANING[code] ?? "unknown exit code, read the output files";
}

/** A tool input for one line of the notification: no control character, line break or bidirectional control, at most `limit` characters. */
export function oneLine(value: string, limit: number): string {
	return head(value.replace(/[\p{Cc}\p{Zl}\p{Zp}\u200E\u200F\u202A-\u202E\u2066-\u2069]+/gu, " ").replace(/\s+/g, " ").trim(), limit).trimEnd();
}

export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	const h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60, s = total % 60;
	return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
}

/** The first `limit` characters, without a split surrogate pair. */
function head(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const end = /[\uD800-\uDBFF]/.test(text[limit - 1] ?? "") ? limit - 1 : limit;
	return text.slice(0, end);
}

function readText(file: string): string {
	try { return readFileSync(file, "utf8"); } catch { return ""; }
}

const titleOf = (watch: Pick<Watch, "id" | "label">) => watch.label ? `${watch.id} (${watch.label})` : watch.id;
const shownPane = (pane: string) => oneLine(pane, PANE_LIMIT);
const paneOf = (watch: Pick<Watch, "pane" | "name">) => watch.name ? `${shownPane(watch.pane)} (${shownPane(watch.name)})` : shownPane(watch.pane);
/** The status of a notification that has a reply: the renderer and the notice show it as a success. */
const isReply = (details: Pick<WatchNotificationDetails, "exitCode" | "status">) => details.exitCode === 0 && details.status === EXIT_MEANING[0];
/** Exit 124 (timeout) and exit 4 (blocked): the pane still works or waits for the user, so the notification has no close line. */
const PANE_STILL_WORKS = new Set([124, 4]);
const exitOf = (watch: Watch) => watch.exitCode !== null && watch.exitCode !== undefined ? String(watch.exitCode) : watch.signal ? `signal ${watch.signal}` : "none";

/** The task notification for the model, and the details for the renderer. */
export function buildNotification(watch: Watch): { content: string; details: WatchNotificationDetails } {
	const stdout = readText(watch.files.stdout), stderr = readText(watch.files.stderr).trim();
	const shown = head(stdout, REPLY_LIMIT), rest = stdout.length - shown.length;
	const status = statusOf(watch.exitCode, watch.signal, stdout);
	const lines = [
		"<herdr-task-notification>",
		`task: ${titleOf(watch)}`,
		`pane: ${paneOf(watch)}`,
		`status: ${status}`,
		`exit: ${exitOf(watch)}`,
		`output file: ${watch.files.stdout}`,
		`reply (first ${shown.length} characters):`,
		shown.trimEnd() || "(no output)",
	];
	if (rest > 0) lines.push(`[truncated: ${rest} more characters are in ${watch.files.stdout}]`);
	if (stderr) lines.push(`stderr (last ${Math.min(stderr.length, STDERR_LIMIT)} characters, file ${watch.files.stderr}):`, stderr.slice(-STDERR_LIMIT));
	if (watch.scripts && !PANE_STILL_WORKS.has(watch.exitCode ?? -1)) lines.push(`close: ${closeCommand(watch.scripts, watch.pane)}`);
	lines.push("</herdr-task-notification>");
	return {
		content: lines.join("\n"),
		details: {
			id: watch.id, pane: shownPane(watch.pane), ...(watch.name ? { name: shownPane(watch.name) } : {}), label: watch.label, status,
			exitCode: watch.exitCode ?? null, signal: watch.signal ?? null,
			elapsedMs: (watch.endedAt ?? Date.now()) - watch.startedAt,
			outputFile: watch.files.stdout, stderrFile: watch.files.stderr, truncated: rest > 0,
		},
	};
}

function summary(watch: Watch, now = Date.now()): string {
	const elapsed = formatElapsed((watch.endedAt ?? now) - watch.startedAt);
	const parts = [watch.id, watch.state, `pane=${shownPane(watch.pane)}`];
	if (watch.name) parts.push(`name=${shownPane(watch.name)}`);
	if (watch.label) parts.push(`label=${watch.label}`);
	parts.push(`elapsed=${elapsed}`);
	if (watch.state === "running") parts.push(`pid=${watch.pid}`);
	else if (watch.endedAt) parts.push(`exit=${exitOf(watch)} (${statusOf(watch.exitCode, watch.signal, readText(watch.files.stdout))})`);
	return parts.join("  ");
}

/** Plain data of one watch for tool details. */
function record(watch: Watch) {
	return {
		id: watch.id, pane: watch.pane, name: watch.name ?? null, label: watch.label ?? null, state: watch.state, pid: watch.pid,
		elapsedMs: (watch.endedAt ?? Date.now()) - watch.startedAt, exitCode: watch.exitCode ?? null, signal: watch.signal ?? null,
	};
}

function detail(watch: Watch): string {
	const tail = readText(watch.files.stdout).slice(-TAIL_LIMIT).trimEnd();
	return [
		summary(watch),
		`prompt file: ${watch.files.prompt}`,
		`output file: ${watch.files.stdout}`,
		`stderr file: ${watch.files.stderr}`,
		`output tail (last ${TAIL_LIMIT} characters):`,
		tail || "(no output yet; ask.py prints the reply when the pane finishes)",
	].join("\n");
}

/** The first line of the reply in a notification: after the `--- reply ---` line of ask.py when it is there. */
export function firstReplyLine(content: string): string {
	const lines = content.split("\n");
	let from = lines.findIndex(line => line.startsWith("reply (first ")) + 1;
	if (from === 0) return "";
	const marker = lines.indexOf("--- reply ---", from);
	if (marker >= 0) from = marker + 1;
	return lines.slice(from).find(line => line.trim() && line !== "</herdr-task-notification>") ?? "";
}

/** Send a signal to the process group of a watch: ask.py and the herdr client. False when no process of the group is left. */
function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
	try { process.kill(-pid, signal); return true; } catch { return false; }
}

/** Stop the process group of the child (ask.py and the herdr client), else the child alone. */
function terminate(watch: Watch, signal: NodeJS.Signals = "SIGTERM"): void {
	if (signalGroup(watch.pid, signal)) return;
	try { watch.child?.kill(signal); } catch { /* already gone */ }
}

const text = (value: string) => [{ type: "text" as const, text: value }];

interface SpawnRun { code: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean; aborted: boolean }

/** Run spawn.py with an argument list and no shell, in a process group of its own. A timeout or an abort ends the group. */
function runSpawn(script: string, args: string[], cwd: string, abort?: AbortSignal): Promise<SpawnRun> {
	return new Promise((done, fail) => {
		const child = spawn("python3", [script, ...args], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "", stderr = "", timedOut = false, aborted = false;
		child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { stdout = (stdout + chunk).slice(-CAPTURE_LIMIT); });
		child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-CAPTURE_LIMIT); });
		let killTimer: NodeJS.Timeout | undefined;
		const send = (signal: NodeJS.Signals) => {
			if (child.pid === undefined) return;
			try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* already gone */ } }
		};
		// SIGTERM first; a spawn.py that ignores it gets SIGKILL after the grace time.
		const stop = () => { send("SIGTERM"); killTimer ??= setTimeout(() => send("SIGKILL"), SPAWN_KILL_GRACE_MS); };
		const onAbort = () => { aborted = true; stop(); };
		const timer = setTimeout(() => { timedOut = true; stop(); }, SPAWN_TIMEOUT_SECONDS * 1000);
		const settle = () => { clearTimeout(timer); clearTimeout(killTimer); abort?.removeEventListener("abort", onAbort); };
		abort?.addEventListener("abort", onAbort, { once: true });
		child.once("error", error => { settle(); fail(new Error(`Could not start python3: ${error.message}`)); });
		child.once("close", (code, signal) => { settle(); done({ code, signal, stdout, stderr, timedOut, aborted }); });
	});
}

/** The facts of a started pane from the JSON line of spawn.py. */
export interface SpawnFacts { name: string; pane_id: string; model: string | null; model_source: string | null; thinking: string | null; placement: string | null; status: string | null }

function spawnFacts(line: Record<string, unknown> | undefined): SpawnFacts | undefined {
	const field = (key: string) => typeof line?.[key] === "string" ? line[key] as string : null;
	const name = field("name"), pane = field("pane_id");
	if (!name || !pane) return undefined;
	return { name, pane_id: pane, model: field("model"), model_source: field("model_source"), thinking: field("thinking"), placement: field("placement"), status: field("status") };
}

interface SpawnParams {
	harness: string;
	role: string;
	model?: string;
	thinking?: string;
	cwd: string;
	prompt?: string;
	prompt_file?: string;
	timeout_seconds?: number;
	label?: string;
	unattended?: boolean;
	strict?: boolean;
	extra_args?: string[];
}

/** The argument list of spawn.py. The native arguments of the harness follow `--`. */
export function spawnArgs(params: Pick<SpawnParams, "harness" | "role" | "model" | "thinking" | "cwd" | "unattended" | "strict" | "extra_args">): string[] {
	const args = ["--harness", params.harness, "--role", params.role];
	if (params.model?.trim()) args.push("--model", params.model.trim());
	if (params.thinking?.trim()) args.push("--thinking", params.thinking.trim());
	args.push("--cwd", params.cwd);
	if (params.strict) args.push("--strict");
	if (params.unattended) args.push("--unattended");
	if (params.extra_args?.length) args.push("--", ...params.extra_args);
	return args;
}

/** `herdr_spawn` and `herdr_watch_start`: wait on a Herdr pane in the background; the reply arrives later as a task notification. */
export default function herdrWatch(pi: ExtensionAPI) {
	const watches = new Map<string, Watch>();
	let stateDir: string | undefined;
	let counter = 0;
	let closed = false;
	let ui: ExtensionContext | undefined;
	const onExit = () => { for (const watch of watches.values()) if (watch.state === "running") terminate(watch); };
	let exitHook = false;

	function deliver(watch: Watch): void {
		if (closed) return;
		const { content, details } = buildNotification(watch);
		try {
			pi.sendMessage({ customType: CUSTOM_TYPE, content, display: true, details }, { triggerTurn: true, deliverAs: "followUp" });
		} catch { /* the runtime is gone */ }
		try {
			if (ui?.hasUI) ui.ui.notify(`herdr-watch ${titleOf(watch)}: pane ${paneOf(watch)} finished: ${details.status} (exit ${exitOf(watch)})`, isReply(details) ? "info" : "warning");
		} catch { /* a stale context */ }
	}

	function finish(watch: Watch, code: number | null, signal: string | null): void {
		if (watch.endedAt !== undefined) return;
		watch.endedAt = Date.now();
		watch.exitCode = code;
		watch.signal = signal;
		watch.child = undefined;
		if (watch.state !== "running") return;
		watch.state = "done";
		deliver(watch);
	}

	function readPrompt(params: { prompt?: string; prompt_file?: string }, ctx: ExtensionContext): string {
		if ((params.prompt === undefined) === (params.prompt_file === undefined)) throw new Error("Give exactly one of prompt and prompt_file.");
		let prompt = params.prompt;
		if (params.prompt_file !== undefined) {
			const file = resolve(ctx.cwd, params.prompt_file);
			try { prompt = readFileSync(file, "utf8"); } catch (error) { throw new Error(`Cannot read prompt_file ${file}: ${error instanceof Error ? error.message : String(error)}`); }
		}
		if (!prompt?.trim()) throw new Error("The prompt is empty.");
		return prompt;
	}

	function timeoutOf(value: number | undefined): number {
		const timeout = value ?? DEFAULT_TIMEOUT_SECONDS;
		if (!Number.isInteger(timeout) || timeout < 1) throw new Error("timeout_seconds must be a whole number of 1 or more.");
		return timeout;
	}

	/** Start ask.py on a pane as a child process and register the watch. herdr_watch_start and herdr_spawn share it. */
	async function launch(input: { pane: string; prompt: string; timeout: number; label?: string; ask: string; name?: string; scripts?: string }, ctx: ExtensionContext): Promise<Watch> {
		stateDir ??= mkdtempSync(join(tmpdir(), "herdr-watch-"));
		const id = `w${++counter}`;
		const dir = join(stateDir, id);
		mkdirSync(dir, { recursive: true });
		const files: WatchFiles = { dir, prompt: join(dir, "prompt.md"), stdout: join(dir, "stdout.txt"), stderr: join(dir, "stderr.txt") };
		writeFileSync(files.prompt, input.prompt);
		const out = openSync(files.stdout, "w"), err = openSync(files.stderr, "w");
		let child: ChildProcess;
		try {
			// A process group of its own, so a stop also ends the herdr client that ask.py waits on.
			child = spawn("python3", [input.ask, input.pane, "--file", files.prompt, "--timeout", String(input.timeout), "--max-chars", String(ASK_MAX_CHARS)],
				{ cwd: ctx.cwd, detached: true, stdio: ["ignore", out, err] });
		} finally {
			closeSync(out);
			closeSync(err);
		}
		if (child.pid === undefined) {
			const message = await new Promise<string>(done => child.once("error", e => done(e.message)));
			throw new Error(`Could not start python3: ${message}`);
		}
		const watch: Watch = {
			id, pane: input.pane, name: input.name, scripts: input.scripts, label: oneLine(input.label ?? "", LABEL_LIMIT) || undefined,
			pid: child.pid, startedAt: Date.now(), files, state: "running", child,
		};
		watches.set(id, watch);
		// The child runs, so "close" follows its exit. An "error" now is a failed kill; the watch goes on.
		child.on("error", () => {});
		// A signal from another process can end ask.py alone; SIGTERM to its group then ends the herdr client too.
		// After a stop or a shutdown the group got SIGTERM already, and a second one does no harm.
		child.once("exit", (_code, signal) => { if (signal) signalGroup(watch.pid, "SIGTERM"); });
		child.once("close", (code, signal) => finish(watch, code, signal));
		if (!exitHook) { process.on("exit", onExit); exitHook = true; }
		ui = ctx;
		return watch;
	}

	const watchLines = (watch: Watch, timeout: number) => [
		`Started watch ${titleOf(watch)} on pane ${shownPane(watch.pane)} (pid ${watch.pid}, timeout ${timeout}s).`,
		"Do not wait or poll: continue with other work.",
		"The reply arrives as a <herdr-task-notification> message when the pane finishes.",
	];
	const fileLines = (files: WatchFiles) => [`prompt file: ${files.prompt}`, `output file: ${files.stdout}`, `stderr file: ${files.stderr}`];

	async function start(params: { pane: string; prompt?: string; prompt_file?: string; timeout_seconds?: number; label?: string }, ctx: ExtensionContext) {
		if (closed) throw new Error("The session shuts down; no new watch starts.");
		const pane = params.pane.trim();
		if (!pane || pane.startsWith("-")) throw new Error("pane must be a pane id or an agent name.");
		const prompt = readPrompt(params, ctx);
		const timeout = timeoutOf(params.timeout_seconds);
		const ask = findAskScript();
		if (!ask.path) throw new Error(`ask.py of the herdr skill was not found. Searched: ${ask.searched.join(", ")}. Set HERDR_SKILL_DIR to the skill directory or install the herdr skill.`);
		const watch = await launch({ pane, prompt, timeout, label: params.label, ask: ask.path }, ctx);
		const body = [...watchLines(watch, timeout), ...fileLines(watch.files)].join("\n");
		return { content: text(body), details: { id: watch.id, pane, pid: watch.pid, files: watch.files } };
	}

	/** herdr_spawn: start a task session with spawn.py, then watch it with the prompt. A failed start starts no watch. */
	async function spawnAndWatch(params: SpawnParams, abort: AbortSignal | undefined, ctx: ExtensionContext) {
		if (closed) throw new Error("The session shuts down; no new pane starts.");
		if (params.role === "coordinator") {
			throw new Error("herdr_spawn starts task sessions only. A coordinator is a primary session, not a task session. "
				+ "For a coordinator handoff, run spawn.py of the herdr skill in the shell (SPAWN.md, section Coordinator handoff).");
		}
		const cwd = params.cwd.trim();
		if (!isAbsolute(cwd)) throw new Error("cwd must be an absolute path.");
		if (params.extra_args?.includes("--unattended")) throw new Error("--unattended is an option of spawn.py, not a native argument. Set unattended to true.");
		const prompt = readPrompt(params, ctx);
		const timeout = timeoutOf(params.timeout_seconds);
		const found = findSkillScript("spawn.py");
		if (!found.path) throw new Error(`spawn.py of the herdr skill was not found. Searched: ${found.searched.join(", ")}. Set HERDR_SKILL_DIR to the skill directory or install the herdr skill.`);
		const scripts = dirname(found.path), ask = join(scripts, "ask.py");
		if (!existsSync(ask)) throw new Error(`ask.py of the herdr skill was not found beside spawn.py: ${ask}.`);
		if (abort?.aborted) throw new Error("The tool call was stopped before spawn.py started. No pane was started.");

		const run = await runSpawn(found.path, spawnArgs({ ...params, cwd }), ctx.cwd, abort);
		const facts = spawnFacts(lastJsonLine(run.stdout));
		const fail = (lines: string[]) => {
			const out = run.stdout.trim(), err = run.stderr.trim();
			if (facts) lines.push(`pane: ${facts.pane_id} (${facts.name})`);
			// Exit 4: the pane waits for the decision of the user, so the result has no close command.
			if (facts && run.code !== 4) lines.push(`close: ${closeCommand(scripts, facts.pane_id)}`);
			lines.push(`stderr (last ${Math.min(err.length, STDERR_LIMIT)} characters):`, err.slice(-STDERR_LIMIT) || "(empty)");
			lines.push(`stdout (last ${Math.min(out.length, TAIL_LIMIT)} characters):`, out.slice(-TAIL_LIMIT) || "(empty)");
			return {
				content: text(lines.join("\n")), isError: true,
				details: { spawn: facts ?? null, exitCode: run.code, signal: run.signal, timedOut: run.timedOut, aborted: run.aborted },
			};
		};
		const orphan = "A new pane can be open without a task: list the panes with panes.py of the herdr skill and close it with close.py.";
		if (run.timedOut) return fail([`spawn.py did not finish in ${SPAWN_TIMEOUT_SECONDS} seconds and was stopped. No watch was started.`, orphan]);
		if (run.aborted) return fail(["The tool call was stopped while spawn.py ran. No watch was started.", orphan]);
		if (run.code !== 0) {
			const exit = run.code ?? (run.signal ? `signal ${run.signal}` : "none");
			const lines = [`spawn.py failed: exit ${exit} (${SPAWN_EXIT_MEANING[run.code ?? -1] ?? "unknown exit code"}). No watch was started.`];
			if (run.code === 4 && facts) lines.push(`Read the question with \`herdr agent read ${facts.pane_id} --source visible\`, show it to the user, and wait for the decision. Then send the task with herdr_watch_start, or close the pane.`);
			return fail(lines);
		}
		if (!facts) return fail(["spawn.py exited with 0 but printed no JSON line with name and pane_id. No watch was started."]);
		if (abort?.aborted || closed) {
			return fail([`The tool call was stopped after the pane started. The pane ${facts.pane_id} (${facts.name}) runs without a task. No watch was started.`,
				"Send the task with herdr_watch_start, or close the pane."]);
		}

		let watch: Watch;
		try {
			watch = await launch({ pane: facts.pane_id, prompt, timeout, label: params.label, ask, name: facts.name, scripts }, ctx);
		} catch (error) {
			return fail([`The pane ${facts.pane_id} (${facts.name}) started, but the watch did not start: ${error instanceof Error ? error.message : String(error)}`,
				"Send the task with herdr_watch_start, or close the pane."]);
		}
		const model = facts.model ? `${facts.model}${facts.model_source ? ` (${facts.model_source})` : ""}` : "harness default";
		const body = [
			`Started pane ${facts.pane_id} (${facts.name}): harness ${params.harness}, role ${params.role}, model ${model}, thinking ${facts.thinking ?? "harness default"}, placement ${facts.placement ?? "unknown"}.`,
			...watchLines(watch, timeout),
			`After you verify the result, close the pane: ${closeCommand(scripts, facts.pane_id)}`,
			...fileLines(watch.files),
		].join("\n");
		return { content: text(body), details: { spawn: facts, id: watch.id, pane: facts.pane_id, name: facts.name, pid: watch.pid, files: watch.files } };
	}

	function list(): string {
		return watches.size ? [...watches.values()].map(watch => summary(watch)).join("\n") : "No herdr watches in this session.";
	}

	function shutdown(): void {
		closed = true;
		for (const watch of watches.values()) {
			if (watch.state !== "running") continue;
			watch.state = "stopped";
			terminate(watch);
		}
		if (exitHook) { process.off("exit", onExit); exitHook = false; }
	}

	pi.on("session_start", (_event, ctx) => { ui = ctx; });
	pi.on("session_shutdown", () => shutdown());

	pi.registerMessageRenderer<WatchNotificationDetails>(CUSTOM_TYPE, (message, { expanded, outputPad }, theme) => {
		const d = message.details;
		const body = typeof message.content === "string" ? message.content : message.content.map(part => part.type === "text" ? part.text : "").join("\n");
		const headline = d
			? `herdr-watch ${titleOf(d)} · pane ${paneOf(d)} · ${d.status} · exit ${d.exitCode ?? d.signal ?? "none"} · ${formatElapsed(d.elapsedMs)}`
			: "herdr-watch";
		const color = d && isReply(d) ? "success" : "warning";
		const replyLine = firstReplyLine(body);
		const second = expanded ? body : theme.fg("dim", replyLine.length > 160 ? `${replyLine.slice(0, 160)}...` : replyLine);
		const box = new Box(outputPad, 1, t => theme.bg("customMessageBg", t));
		box.addChild(new Text(`${theme.fg(color, headline)}${second ? `\n${second}` : ""}`, 0, 0));
		return box;
	});

	pi.registerTool({
		name: "herdr_spawn",
		label: "Herdr spawn",
		description: "Start a task session in a new Herdr pane with spawn.py of the herdr skill, send it the task, and wait for its reply in the background. "
			+ "The call returns when spawn.py has started the pane (about 10 to 60 seconds, at most 180 seconds), with the pane id, the agent name and a task id. "
			+ "Then the watch runs in the background. When the pane finishes, the reply arrives as a <herdr-task-notification> message that starts a turn. "
			+ "A failed start returns an error and starts no watch.",
		promptSnippet: "Start a task session in a new Herdr pane, send the task, and get its reply later as a task notification",
		promptGuidelines: [
			"Start every task session (researcher, scout, worker, reviewer) with herdr_spawn: one call starts the pane, sends the task and watches it. Do not run spawn.py and the blocking ask.py in the shell for it.",
			"Use the blocking ask.py of the herdr skill only when the user says to wait for the reply or not to use the watch.",
			"For a fan-out, call herdr_spawn once for each task in one turn, then continue; the notifications arrive one by one.",
			"After a <herdr-task-notification> of a herdr_spawn pane, verify the result, then close the pane with the command in its close line. "
				+ "A notification with a timeout or a blocked status has no close line: the pane still works or waits for the user, so do not close it.",
		],
		parameters: Type.Object({
			harness: StringEnum(HARNESSES, { description: "The agent program: pi or claude" }),
			role: StringEnum(ROLES, { description: "The role of the task session. coordinator is refused: a coordinator is a primary session." }),
			model: Type.Optional(Type.String({ description: "pi: provider/model or a name that pi --list-models finds one time. claude: a model ID or a CLI alias. Omit it for the local default." })),
			thinking: Type.Optional(Type.String({ description: "off, minimal, low, medium, high, xhigh or max. Omit it for the local default." })),
			cwd: Type.String({ description: "Absolute working directory of the new agent" }),
			prompt: Type.Optional(Type.String({ description: "The task text. Give this or prompt_file." })),
			prompt_file: Type.Optional(Type.String({ description: "Path of a file with the task. Give this or prompt." })),
			timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, description: `Seconds that ask.py waits for the reply. Default ${DEFAULT_TIMEOUT_SECONDS}.` })),
			label: Type.Optional(Type.String({ description: "A short label for the notification" })),
			unattended: Type.Optional(Type.Boolean({ description: "claude write roles only: allow all shell commands and edits in advance. Only when the user asks for an unattended worker. Default false." })),
			strict: Type.Optional(Type.Boolean({ description: "Hard tool limits of the role (SPAWN.md). Only when the user asks for them. Default false." })),
			extra_args: Type.Optional(Type.Array(Type.String(), { description: "Native arguments of the harness, passed after --" })),
		}),
		execute: async (_id, params, signal, _onUpdate, ctx) => spawnAndWatch(params, signal, ctx),
	});

	pi.registerTool({
		name: "herdr_watch_start",
		label: "Herdr watch start",
		description: "Send a prompt to an agent in a Herdr pane that exists and wait for its reply in the background. Returns at once with a task id. When the pane finishes, the reply arrives as a <herdr-task-notification> message that starts a turn. Runs ask.py of the herdr skill. For a new task session, use herdr_spawn.",
		promptSnippet: "Send a prompt to a Herdr pane and get its reply later as a task notification",
		promptGuidelines: [
			"Send a prompt to a pane that exists with herdr_watch_start, not with the blocking ask.py, unless the user says to wait for the reply or not to use the watch.",
			"After herdr_spawn or herdr_watch_start, do not wait, sleep or poll for the reply. Continue with other work or end the turn; the reply arrives as a <herdr-task-notification> message.",
			"Act on a <herdr-task-notification> by its status line: a reply, no new reply (read the screen), a pane blocked on a question, or a timeout while the pane still works.",
		],
		parameters: Type.Object({
			pane: Type.String({ description: "Pane id or agent name of the Herdr pane" }),
			prompt: Type.Optional(Type.String({ description: "The prompt text. Give this or prompt_file." })),
			prompt_file: Type.Optional(Type.String({ description: "Path of a file with the prompt. Give this or prompt." })),
			timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, description: `Seconds that ask.py waits for the reply. Default ${DEFAULT_TIMEOUT_SECONDS}.` })),
			label: Type.Optional(Type.String({ description: "A short label for the notification" })),
		}),
		execute: async (_id, params, _signal, _onUpdate, ctx) => start(params, ctx),
	});

	pi.registerTool({
		name: "herdr_watch_status",
		label: "Herdr watch status",
		description: "List the Herdr pane watches of this session (id, pane, label, running or done, elapsed time, exit code), or show one watch with the tail of its output.",
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "A task id from herdr_watch_start. Omit it to list all watches." })),
		}),
		execute: async (_id, params) => {
			if (params.id === undefined) return { content: text(list()), details: { watches: [...watches.values()].map(record) } };
			const watch = watches.get(params.id);
			if (!watch) throw new Error(`No watch with id ${params.id}. ${list()}`);
			return { content: text(detail(watch)), details: { watches: [record(watch)] } };
		},
	});

	pi.registerTool({
		name: "herdr_watch_stop",
		label: "Herdr watch stop",
		description: "Stop one Herdr pane watch: SIGTERM to its ask.py process. The pane itself keeps running; only the wait stops.",
		parameters: Type.Object({ id: Type.String({ description: "A task id from herdr_watch_start" }) }),
		execute: async (_id, params) => {
			const watch = watches.get(params.id);
			if (!watch) throw new Error(`No watch with id ${params.id}. ${list()}`);
			if (watch.state !== "running") return { content: text(`Watch ${titleOf(watch)} is ${watch.state} already.`), details: { id: watch.id, state: watch.state } };
			watch.state = "stopped";
			terminate(watch);
			const body = `Stopped watch ${titleOf(watch)}. No notification follows for it. The pane ${shownPane(watch.pane)} keeps running: the prompt can be delivered already. Read its last reply later with last-reply.py of the herdr skill.`;
			return { content: text(body), details: { id: watch.id, state: watch.state } };
		},
	});

	pi.registerCommand(CUSTOM_TYPE, {
		description: "List the Herdr pane watches of this session; /herdr-watch <id> shows one with the tail of its output",
		handler: async (args, ctx) => {
			const id = args.trim();
			const watch = id ? watches.get(id) : undefined;
			ctx.ui.notify(id ? (watch ? detail(watch) : `No watch with id ${id}.\n${list()}`) : list(), "info");
		},
	});
}
