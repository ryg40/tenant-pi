import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
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

interface WatchFiles { dir: string; prompt: string; stdout: string; stderr: string }

interface Watch {
	id: string;
	pane: string;
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
	label?: string;
	status: string;
	exitCode: number | null;
	signal: string | null;
	elapsedMs: number;
	outputFile: string;
	stderrFile: string;
	truncated: boolean;
}

/** The ask.py to start: `HERDR_SKILL_DIR` alone when it is set, else the installed skill, else the kit copy. */
export function findAskScript(env: NodeJS.ProcessEnv = process.env, home = homedir(), kitScripts = KIT_SCRIPTS): { path?: string; searched: string[] } {
	const dirs = env.HERDR_SKILL_DIR ? [join(env.HERDR_SKILL_DIR, "scripts")] : [join(home, ".agents/skills/herdr/scripts"), kitScripts];
	const searched = dirs.map(dir => join(dir, "ask.py"));
	return { path: searched.find(file => existsSync(file)), searched };
}

export function statusOf(code: number | null | undefined, signal?: string | null): string {
	if (code === null || code === undefined) return signal ? `killed by signal ${signal}` : "unknown";
	return EXIT_MEANING[code] ?? "unknown exit code, read the output files";
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
const exitOf = (watch: Watch) => watch.exitCode !== null && watch.exitCode !== undefined ? String(watch.exitCode) : watch.signal ? `signal ${watch.signal}` : "none";

/** The task notification for the model, and the details for the renderer. */
export function buildNotification(watch: Watch): { content: string; details: WatchNotificationDetails } {
	const stdout = readText(watch.files.stdout), stderr = readText(watch.files.stderr).trim();
	const shown = head(stdout, REPLY_LIMIT), rest = stdout.length - shown.length;
	const status = statusOf(watch.exitCode, watch.signal);
	const lines = [
		"<herdr-task-notification>",
		`task: ${titleOf(watch)}`,
		`pane: ${watch.pane}`,
		`status: ${status}`,
		`exit: ${exitOf(watch)}`,
		`output file: ${watch.files.stdout}`,
		`reply (first ${shown.length} characters):`,
		shown.trimEnd() || "(no output)",
	];
	if (rest > 0) lines.push(`[truncated: ${rest} more characters are in ${watch.files.stdout}]`);
	if (stderr) lines.push(`stderr (last ${Math.min(stderr.length, STDERR_LIMIT)} characters, file ${watch.files.stderr}):`, stderr.slice(-STDERR_LIMIT));
	lines.push("</herdr-task-notification>");
	return {
		content: lines.join("\n"),
		details: {
			id: watch.id, pane: watch.pane, label: watch.label, status,
			exitCode: watch.exitCode ?? null, signal: watch.signal ?? null,
			elapsedMs: (watch.endedAt ?? Date.now()) - watch.startedAt,
			outputFile: watch.files.stdout, stderrFile: watch.files.stderr, truncated: rest > 0,
		},
	};
}

function summary(watch: Watch, now = Date.now()): string {
	const elapsed = formatElapsed((watch.endedAt ?? now) - watch.startedAt);
	const parts = [watch.id, watch.state, `pane=${watch.pane}`];
	if (watch.label) parts.push(`label=${watch.label}`);
	parts.push(`elapsed=${elapsed}`);
	if (watch.state === "running") parts.push(`pid=${watch.pid}`);
	else if (watch.endedAt) parts.push(`exit=${exitOf(watch)} (${statusOf(watch.exitCode, watch.signal)})`);
	return parts.join("  ");
}

/** Plain data of one watch for tool details. */
function record(watch: Watch) {
	return {
		id: watch.id, pane: watch.pane, label: watch.label ?? null, state: watch.state, pid: watch.pid,
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

/** Stop the process group of the child (ask.py and the herdr client), else the child alone. */
function terminate(watch: Watch, signal: NodeJS.Signals = "SIGTERM"): void {
	try { process.kill(-watch.pid, signal); return; } catch { /* no group: fall through */ }
	try { watch.child?.kill(signal); } catch { /* already gone */ }
}

const text = (value: string) => [{ type: "text" as const, text: value }];

/** `herdr_watch_start`: wait on a Herdr pane in the background; the reply arrives later as a task notification. */
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
			if (ui?.hasUI) ui.ui.notify(`herdr-watch ${titleOf(watch)}: pane ${watch.pane} finished: ${details.status} (exit ${exitOf(watch)})`, watch.exitCode === 0 ? "info" : "warning");
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

	async function start(params: { pane: string; prompt?: string; prompt_file?: string; timeout_seconds?: number; label?: string }, ctx: ExtensionContext) {
		if (closed) throw new Error("The session shuts down; no new watch starts.");
		const pane = params.pane.trim();
		if (!pane || pane.startsWith("-")) throw new Error("pane must be a pane id or an agent name.");
		if ((params.prompt === undefined) === (params.prompt_file === undefined)) throw new Error("Give exactly one of prompt and prompt_file.");
		let prompt = params.prompt;
		if (params.prompt_file !== undefined) {
			const file = resolve(ctx.cwd, params.prompt_file);
			try { prompt = readFileSync(file, "utf8"); } catch (error) { throw new Error(`Cannot read prompt_file ${file}: ${error instanceof Error ? error.message : String(error)}`); }
		}
		if (!prompt?.trim()) throw new Error("The prompt is empty.");
		const timeout = params.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS;
		if (!Number.isInteger(timeout) || timeout < 1) throw new Error("timeout_seconds must be a whole number of 1 or more.");
		const ask = findAskScript();
		if (!ask.path) throw new Error(`ask.py of the herdr skill was not found. Searched: ${ask.searched.join(", ")}. Set HERDR_SKILL_DIR to the skill directory or install the herdr skill.`);

		stateDir ??= mkdtempSync(join(tmpdir(), "herdr-watch-"));
		const id = `w${++counter}`;
		const dir = join(stateDir, id);
		mkdirSync(dir, { recursive: true });
		const files: WatchFiles = { dir, prompt: join(dir, "prompt.md"), stdout: join(dir, "stdout.txt"), stderr: join(dir, "stderr.txt") };
		writeFileSync(files.prompt, prompt);
		const out = openSync(files.stdout, "w"), err = openSync(files.stderr, "w");
		let child: ChildProcess;
		try {
			// A process group of its own, so a stop also ends the herdr client that ask.py waits on.
			child = spawn("python3", [ask.path, pane, "--file", files.prompt, "--timeout", String(timeout), "--max-chars", String(ASK_MAX_CHARS)],
				{ cwd: ctx.cwd, detached: true, stdio: ["ignore", out, err] });
		} finally {
			closeSync(out);
			closeSync(err);
		}
		if (child.pid === undefined) {
			const message = await new Promise<string>(done => child.once("error", e => done(e.message)));
			throw new Error(`Could not start python3: ${message}`);
		}
		const watch: Watch = { id, pane, label: params.label?.trim() || undefined, pid: child.pid, startedAt: Date.now(), files, state: "running", child };
		watches.set(id, watch);
		// The child runs, so "close" follows its exit. An "error" now is a failed kill; the watch goes on.
		child.on("error", () => {});
		child.once("close", (code, signal) => finish(watch, code, signal));
		if (!exitHook) { process.on("exit", onExit); exitHook = true; }
		ui = ctx;
		const body = [
			`Started watch ${titleOf(watch)} on pane ${pane} (pid ${watch.pid}, timeout ${timeout}s).`,
			"Do not wait or poll: continue with other work.",
			"The reply arrives as a <herdr-task-notification> message when the pane finishes.",
			`prompt file: ${files.prompt}`,
			`output file: ${files.stdout}`,
			`stderr file: ${files.stderr}`,
		].join("\n");
		return { content: text(body), details: { id, pane, pid: watch.pid, files } };
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
			? `herdr-watch ${titleOf(d)} · pane ${d.pane} · ${d.status} · exit ${d.exitCode ?? d.signal ?? "none"} · ${formatElapsed(d.elapsedMs)}`
			: "herdr-watch";
		const color = d?.exitCode === 0 ? "success" : "warning";
		const replyLine = firstReplyLine(body);
		const second = expanded ? body : theme.fg("dim", replyLine.length > 160 ? `${replyLine.slice(0, 160)}...` : replyLine);
		const box = new Box(outputPad, 1, t => theme.bg("customMessageBg", t));
		box.addChild(new Text(`${theme.fg(color, headline)}${second ? `\n${second}` : ""}`, 0, 0));
		return box;
	});

	pi.registerTool({
		name: "herdr_watch_start",
		label: "Herdr watch start",
		description: "Send a prompt to an agent in a Herdr pane and wait for its reply in the background. Returns at once with a task id. When the pane finishes, the reply arrives as a <herdr-task-notification> message that starts a turn. Runs ask.py of the herdr skill.",
		promptSnippet: "Send a prompt to a Herdr pane and get its reply later as a task notification",
		promptGuidelines: [
			"After herdr_watch_start, do not wait, sleep or poll for the reply. Continue with other work or end the turn; the reply arrives as a <herdr-task-notification> message.",
			"Act on a <herdr-task-notification> by its status line: a reply, a pane blocked on a question, or a timeout while the pane still works.",
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
			const body = `Stopped watch ${titleOf(watch)}. No notification follows for it. The pane ${watch.pane} keeps running: the prompt can be delivered already. Read its last reply later with last-reply.py of the herdr skill.`;
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
