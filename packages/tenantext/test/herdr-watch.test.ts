import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import herdrWatch, { CUSTOM_TYPE, REPLY_LIMIT, findAskScript, firstReplyLine, formatElapsed } from "../extensions/herdr-watch/index.ts";

// A fake ask.py. The prompt file is a JSON spec of the run; the script records its arguments beside it.
const FAKE_ASK = `import json, sys, time
args = sys.argv[1:]
prompt = args[args.index("--file") + 1]
with open(prompt + ".argv.json", "w") as f:
    json.dump(args, f)
spec = json.load(open(prompt))
time.sleep(spec.get("sleep", 0.05))
sys.stdout.write("x" * spec["size"] if "size" in spec else spec.get("reply", ""))
sys.stderr.write(spec.get("stderr", ""))
sys.exit(spec.get("exit", 0))
`;

interface Sent { message: { customType: string; content: string; display: boolean; details: any }; options: unknown }

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 10000) {
	const end = Date.now() + ms;
	while (!await check()) {
		if (Date.now() > end) assert.fail(`timed out: ${what}`);
		await new Promise(done => setTimeout(done, 20));
	}
}

function fixture(t: test.TestContext) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-watch-test-")));
	const skill = join(root, "skill"), tmp = join(root, "tmp");
	mkdirSync(join(skill, "scripts"), { recursive: true });
	mkdirSync(tmp);
	writeFileSync(join(skill, "scripts/ask.py"), FAKE_ASK);
	const saved = { HERDR_SKILL_DIR: process.env.HERDR_SKILL_DIR, TMPDIR: process.env.TMPDIR };
	process.env.HERDR_SKILL_DIR = skill;
	process.env.TMPDIR = tmp;
	const tools = new Map<string, any>(), commands = new Map<string, any>(), renderers = new Map<string, any>();
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const messages: Sent[] = [], notices: string[] = [];
	const pi = {
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			handlers.set(event, [...handlers.get(event) ?? [], handler]);
			return () => {};
		},
		registerTool(tool: { name: string }) { tools.set(tool.name, tool); },
		registerCommand(name: string, command: unknown) { commands.set(name, command); },
		registerMessageRenderer(type: string, renderer: unknown) { renderers.set(type, renderer); },
		sendMessage(message: Sent["message"], options: unknown) { messages.push({ message, options }); },
	} as unknown as ExtensionAPI;
	const ctx = { cwd: root, hasUI: true, ui: { notify: (text: string) => { notices.push(text); } } };
	const exitListeners = process.listenerCount("exit");
	herdrWatch(pi);
	const emit = async (event: string) => { for (const handler of handlers.get(event) ?? []) await handler({ type: event, reason: "quit" }, ctx); };
	t.after(async () => {
		await emit("session_shutdown");
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	});
	const run = (name: string, params: object) => tools.get(name).execute("call-1", params, undefined, undefined, ctx);
	const start = (pane: string, spec: object, extra: object = {}) => run("herdr_watch_start", { pane, prompt: JSON.stringify(spec), ...extra });
	const status = async (id?: string) => (await run("herdr_watch_status", id === undefined ? {} : { id })).content[0].text as string;
	return { root, skill, tmp, tools, commands, renderers, handlers, messages, notices, ctx, exitListeners, emit, run, start, status };
}

test("the factory registers the tools, the command, the renderer and two handlers, and starts nothing", t => {
	const f = fixture(t);
	assert.deepEqual([...f.tools.keys()], ["herdr_watch_start", "herdr_watch_status", "herdr_watch_stop"]);
	assert.deepEqual([...f.commands.keys()], ["herdr-watch"]);
	assert.deepEqual([...f.renderers.keys()], [CUSTOM_TYPE]);
	assert.deepEqual([...f.handlers.keys()].sort(), ["session_shutdown", "session_start"]);
	assert.equal(process.listenerCount("exit"), f.exitListeners);
	assert.deepEqual(readdirSync(f.tmp), []);
});

test("start returns at once, and exit 0 delivers the reply as a follow-up that triggers a turn", async t => {
	const f = fixture(t);
	const before = Date.now();
	const reply = "pane=pane-a agent=pi\n--- reply ---\nhello from the pane\n";
	const result = await f.start("pane-a", { sleep: 0.5, reply }, { label: "first" });
	assert.ok(Date.now() - before < 400, "start waits for the child");
	assert.equal(f.messages.length, 0);
	const { id, pane, pid, files } = result.details;
	assert.deepEqual([id, pane, typeof pid], ["w1", "pane-a", "number"]);
	assert.match(result.content[0].text, /Started watch w1 \(first\) on pane pane-a \(pid \d+, timeout 1500s\)/);
	assert.match(result.content[0].text, /Do not wait or poll/);
	assert.match(await f.status(), /^w1  running  pane=pane-a  label=first  elapsed=\d+s  pid=\d+$/);
	await until(() => f.messages.length === 1, "the notification");
	const [{ message, options }] = f.messages;
	assert.deepEqual(options, { triggerTurn: true, deliverAs: "followUp" });
	assert.equal(message.customType, CUSTOM_TYPE);
	assert.equal(message.display, true);
	assert.equal(message.content, [
		"<herdr-task-notification>",
		"task: w1 (first)",
		"pane: pane-a",
		"status: reply",
		"exit: 0",
		`output file: ${files.stdout}`,
		`reply (first ${reply.length} characters):`,
		"pane=pane-a agent=pi\n--- reply ---\nhello from the pane",
		"</herdr-task-notification>",
	].join("\n"));
	assert.deepEqual({ ...message.details, elapsedMs: 0 }, {
		id: "w1", pane: "pane-a", label: "first", status: "reply", exitCode: 0, signal: null, elapsedMs: 0,
		outputFile: files.stdout, stderrFile: files.stderr, truncated: false,
	});
	assert.deepEqual(JSON.parse(readFileSync(`${files.prompt}.argv.json`, "utf8")),
		["pane-a", "--file", files.prompt, "--timeout", "1500", "--max-chars", "1000000"]);
	assert.deepEqual(f.notices, ["herdr-watch w1 (first): pane pane-a finished: reply (exit 0)"]);
});

test("exit 4 and exit 124 give their status words, and stderr is part of the notification", async t => {
	const f = fixture(t);
	await f.start("pane-b", { exit: 4, reply: "BLOCKED: the target stopped on a question.\n", stderr: "a warning\n" });
	await f.start("pane-c", { exit: 124, reply: "TIMED OUT: the prompt was delivered.\n" }, { timeout_seconds: 7 });
	await until(() => f.messages.length === 2, "two notifications");
	const byId = Object.fromEntries(f.messages.map(sent => [sent.message.details.id, sent.message]));
	assert.match(byId.w1.content, /\nstatus: blocked on a question, read the screen\nexit: 4\n/);
	assert.match(byId.w1.content, /\nstderr \(last 9 characters, file .*stderr\.txt\):\na warning\n<\/herdr-task-notification>$/);
	assert.match(byId.w2.content, /\nstatus: timeout, the pane still works\nexit: 124\n/);
	assert.doesNotMatch(byId.w2.content, /stderr/);
	assert.deepEqual([byId.w1.details.exitCode, byId.w2.details.exitCode], [4, 124]);
	assert.equal(f.notices.filter(text => text.includes("w2") && text.includes("timeout, the pane still works (exit 124)")).length, 1);
	const files = (await f.run("herdr_watch_status", { id: "w2" })).content[0].text;
	assert.match(files, /prompt file: .*w2\/prompt\.md/);
	assert.deepEqual(JSON.parse(readFileSync(join(f.tmp, readdirSync(f.tmp)[0], "w2/prompt.md.argv.json"), "utf8")).slice(3, 5), ["--timeout", "7"]);
});

test("a reply longer than the limit is cut, and the notification names the file with the rest", async t => {
	const f = fixture(t);
	const { details } = await f.start("pane-d", { size: REPLY_LIMIT + 500 });
	await until(() => f.messages.length === 1, "the notification");
	const { content, details: sent } = f.messages[0].message;
	assert.ok(content.includes(`reply (first ${REPLY_LIMIT} characters):\n${"x".repeat(REPLY_LIMIT)}\n`));
	assert.ok(content.includes(`\n[truncated: 500 more characters are in ${details.files.stdout}]\n`));
	assert.equal(sent.truncated, true);
	assert.equal(readFileSync(details.files.stdout, "utf8").length, REPLY_LIMIT + 500);
});

test("prompt_file is read relative to the working directory and copied into the task directory", async t => {
	const f = fixture(t);
	const spec = JSON.stringify({ reply: "from the file" });
	writeFileSync(join(f.root, "task.json"), spec);
	const { details } = await f.run("herdr_watch_start", { pane: "pane-e", prompt_file: "task.json" });
	assert.equal(readFileSync(details.files.prompt, "utf8"), spec);
	await until(() => f.messages.length === 1, "the notification");
	assert.match(f.messages[0].message.content, /\nfrom the file\n/);
	await assert.rejects(f.run("herdr_watch_start", { pane: "pane-e", prompt_file: "missing.json" }), /Cannot read prompt_file .*missing\.json/);
});

test("a missing ask.py and bad parameters give an error result", async t => {
	const f = fixture(t);
	await assert.rejects(f.run("herdr_watch_start", { pane: "p", prompt: "a", prompt_file: "b" }), /exactly one of prompt and prompt_file/);
	await assert.rejects(f.run("herdr_watch_start", { pane: "p" }), /exactly one of prompt and prompt_file/);
	await assert.rejects(f.run("herdr_watch_start", { pane: "p", prompt: "  " }), /The prompt is empty/);
	await assert.rejects(f.run("herdr_watch_start", { pane: "--file", prompt: "a" }), /pane must be a pane id/);
	const empty = join(f.root, "empty-skill");
	mkdirSync(empty);
	process.env.HERDR_SKILL_DIR = empty;
	await assert.rejects(f.start("p", {}), new RegExp(`ask\\.py of the herdr skill was not found\\. Searched: ${join(empty, "scripts/ask.py")}\\.`));
	assert.deepEqual(readdirSync(f.tmp), []);
});

test("findAskScript takes HERDR_SKILL_DIR alone, else the installed skill, else the kit copy", t => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-watch-find-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const home = join(root, "home"), kit = join(root, "kit"), own = join(root, "own");
	const installed = join(home, ".agents/skills/herdr/scripts/ask.py");
	assert.deepEqual(findAskScript({}, home, kit), { path: undefined, searched: [installed, join(kit, "ask.py")] });
	mkdirSync(kit, { recursive: true });
	writeFileSync(join(kit, "ask.py"), "");
	assert.equal(findAskScript({}, home, kit).path, join(kit, "ask.py"));
	mkdirSync(join(home, ".agents/skills/herdr/scripts"), { recursive: true });
	writeFileSync(installed, "");
	assert.equal(findAskScript({}, home, kit).path, installed);
	assert.deepEqual(findAskScript({ HERDR_SKILL_DIR: own }, home, kit), { path: undefined, searched: [join(own, "scripts/ask.py")] });
	mkdirSync(join(own, "scripts"), { recursive: true });
	writeFileSync(join(own, "scripts/ask.py"), "");
	assert.equal(findAskScript({ HERDR_SKILL_DIR: own }, home, kit).path, join(own, "scripts/ask.py"));
});

test("status lists running and done watches, and one watch with the tail of its output", async t => {
	const f = fixture(t);
	await f.start("pane-f", { sleep: 30 }, { label: "slow" });
	await f.start("pane-g", { reply: "the tail text\n" });
	await until(() => f.messages.length === 1, "the notification of w2");
	const lines = (await f.status()).split("\n");
	assert.equal(lines.length, 2);
	assert.match(lines[0], /^w1  running  pane=pane-f  label=slow  elapsed=\d+s  pid=\d+$/);
	assert.match(lines[1], /^w2  done  pane=pane-g  elapsed=\d+s  exit=0 \(reply\)$/);
	const one = await f.status("w2");
	assert.match(one, /^w2  done  pane=pane-g/);
	assert.match(one, /\noutput file: .*w2\/stdout\.txt\n/);
	assert.match(one, /\noutput tail \(last 2000 characters\):\nthe tail text$/);
	assert.match(await f.status("w1"), /no output yet/);
	const listed = (await f.run("herdr_watch_status", {})).details.watches;
	assert.deepEqual(listed.map((item: { id: string; state: string }) => [item.id, item.state]), [["w1", "running"], ["w2", "done"]]);
	await assert.rejects(f.status("w9"), /No watch with id w9/);
});

test("stop ends a running child, says that the pane keeps running, and sends no notification", async t => {
	const f = fixture(t);
	const { details } = await f.start("pane-h", { sleep: 30 });
	const stopped = await f.run("herdr_watch_stop", { id: "w1" });
	assert.match(stopped.content[0].text, /^Stopped watch w1\. No notification follows for it\. The pane pane-h keeps running/);
	await until(async () => /exit=signal SIGTERM \(killed by signal SIGTERM\)$/.test(await f.status()), "the child ends");
	assert.match(await f.status(), /^w1  stopped  pane=pane-h  elapsed=\d+s  exit=signal SIGTERM \(killed by signal SIGTERM\)$/);
	assert.throws(() => process.kill(details.pid, 0), /ESRCH/);
	assert.match((await f.run("herdr_watch_stop", { id: "w1" })).content[0].text, /is stopped already/);
	await assert.rejects(f.run("herdr_watch_stop", { id: "w5" }), /No watch with id w5/);
	await new Promise(done => setTimeout(done, 200));
	assert.equal(f.messages.length, 0);
});

test("session_shutdown stops the children, removes the exit hook, and runs twice without harm", async t => {
	const f = fixture(t);
	const { details } = await f.start("pane-i", { sleep: 30 });
	assert.equal(process.listenerCount("exit"), f.exitListeners + 1);
	await f.emit("session_shutdown");
	await f.emit("session_shutdown");
	assert.equal(process.listenerCount("exit"), f.exitListeners);
	await until(async () => /exit=signal SIGTERM/.test(await f.status()), "the child ends");
	assert.match(await f.status(), /^w1  stopped  /);
	assert.throws(() => process.kill(details.pid, 0), /ESRCH/);
	await assert.rejects(f.start("pane-i", {}), /The session shuts down/);
	await new Promise(done => setTimeout(done, 200));
	assert.equal(f.messages.length, 0);
});

test("the renderer shows one headline and the first reply line, and the whole notification when expanded", async t => {
	const f = fixture(t);
	await f.start("pane-j", { reply: "pane=pane-j agent=pi\n--- reply ---\nDone: three files\nsecond line\n" }, { label: "docs" });
	await until(() => f.messages.length === 1, "the notification");
	const message = f.messages[0].message;
	const theme = { fg: (_color: string, value: string) => value, bg: (_color: string, value: string) => value };
	const render = (expanded: boolean) => (f.renderers.get(CUSTOM_TYPE)(message, { expanded, outputPad: 0 }, theme).render(100) as string[])
		.map(line => line.trimEnd()).filter(Boolean);
	const collapsed = render(false);
	assert.equal(collapsed.length, 2);
	assert.match(collapsed[0], /^herdr-watch w1 \(docs\) · pane pane-j · reply · exit 0 · \d+s$/);
	assert.equal(collapsed[1], "Done: three files");
	const expanded = render(true).join("\n");
	assert.match(expanded, /<herdr-task-notification>/);
	assert.match(expanded, /second line/);
	assert.equal(firstReplyLine("no notification"), "");
});

test("/herdr-watch prints the list, and formatElapsed reads like a clock", async t => {
	const f = fixture(t);
	await f.commands.get("herdr-watch").handler("", f.ctx);
	await f.commands.get("herdr-watch").handler("w3", f.ctx);
	assert.deepEqual(f.notices, ["No herdr watches in this session.", "No watch with id w3.\nNo herdr watches in this session."]);
	assert.deepEqual([formatElapsed(0), formatElapsed(59_400), formatElapsed(133_000), formatElapsed(3_725_000)], ["0s", "59s", "2m 13s", "1h 2m"]);
});
