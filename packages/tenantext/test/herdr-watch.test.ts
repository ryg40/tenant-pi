import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import herdrWatch, { CUSTOM_TYPE, REPLY_LIMIT, SPAWN_KILL_GRACE_MS, findAskScript, findSkillScript, firstReplyLine, formatElapsed, lastJsonLine } from "../extensions/herdr-watch/index.ts";

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

// A fake spawn.py. It records each call beside itself and reads its behaviour from spawn-spec.json there.
const FAKE_SPAWN = `import json, os, signal, sys, time
here = os.path.dirname(os.path.abspath(__file__))
spec_file = os.path.join(here, "spawn-spec.json")
spec = json.load(open(spec_file)) if os.path.exists(spec_file) else {}
if spec.get("ignore_term"):
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
args = sys.argv[1:]
with open(os.path.join(here, "spawn-calls.jsonl"), "a") as f:
    f.write(json.dumps({"argv": args, "cwd": os.getcwd()}) + "\\n")
own = args[:args.index("--")] if "--" in args else args
def opt(name):
    return own[own.index(name) + 1] if name in own else None
time.sleep(spec.get("sleep", 0))
thinking = opt("--thinking")
if thinking is not None and thinking not in ("off", "minimal", "low", "medium", "high", "xhigh", "max"):
    print("error: --thinking must be one of: off, minimal, low, medium, high, xhigh, max", file=sys.stderr)
    sys.exit(2)
model, role = opt("--model"), opt("--role")
print("model: " + (model + " (from request)" if model else "harness default"), file=sys.stderr)
facts = {"name": "proj-" + role + "-1", "pane_id": "w7:p3", "model": model, "model_source": "request" if model else "harness default",
         "thinking": thinking, "placement": "new tab '" + role + "'"}
if spec.get("exit") == 1:
    print("error: agent start failed and the new pane was closed: no agent", file=sys.stderr)
    sys.exit(1)
if spec.get("exit") == 4:
    print(json.dumps(dict(facts, status="blocked")))
    print("The agent stopped at a startup question (for example folder trust).", file=sys.stderr)
    sys.exit(4)
print("a line that is not JSON")
print(json.dumps(dict(facts, status="idle")))
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
	writeFileSync(join(skill, "scripts/spawn.py"), FAKE_SPAWN);
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
	const run = (name: string, params: object, signal?: AbortSignal) => tools.get(name).execute("call-1", params, signal, undefined, ctx);
	const start = (pane: string, spec: object, extra: object = {}) => run("herdr_watch_start", { pane, prompt: JSON.stringify(spec), ...extra });
	const status = async (id?: string) => (await run("herdr_watch_status", id === undefined ? {} : { id })).content[0].text as string;
	const calls = join(skill, "scripts/spawn-calls.jsonl");
	const spawnCalls = () => existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
	const spawnSpec = (spec: object) => writeFileSync(join(skill, "scripts/spawn-spec.json"), JSON.stringify(spec));
	return { root, skill, tmp, tools, commands, renderers, handlers, messages, notices, ctx, exitListeners, emit, run, start, status, spawnCalls, spawnSpec };
}

test("the factory registers the tools, the command, the renderer and two handlers, and starts nothing", t => {
	const f = fixture(t);
	assert.deepEqual([...f.tools.keys()], ["herdr_spawn", "herdr_watch_start", "herdr_watch_status", "herdr_watch_stop"]);
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
	assert.deepEqual(findSkillScript("spawn.py", {}, home, kit).searched, [join(home, ".agents/skills/herdr/scripts/spawn.py"), join(kit, "spawn.py")]);
	assert.deepEqual(findSkillScript("spawn.py", { HERDR_SKILL_DIR: own }, home, kit), { path: undefined, searched: [join(own, "scripts/spawn.py")] });
});

const spawnTask = (root: string, reply: object, extra: object = {}) =>
	({ harness: "pi", role: "worker", model: "prov/model-a", thinking: "high", cwd: root, prompt: JSON.stringify(reply), ...extra });

test("herdr_spawn starts the pane with spawn.py, watches it, and returns the spawn facts and the task id", async t => {
	const f = fixture(t);
	const reply = "pane=w7:p3 agent=pi\n--- reply ---\nDone: the change\n";
	const before = Date.now();
	const result = await f.run("herdr_spawn", spawnTask(f.root, { sleep: 0.5, reply }, { label: "fix" }));
	assert.ok(Date.now() - before < 5000);
	assert.equal(result.isError, undefined);
	assert.equal(f.messages.length, 0);
	const close = `python3 ${join(f.skill, "scripts/close.py")} w7:p3`;
	const lines = result.content[0].text.split("\n");
	assert.equal(lines[0], "Started pane w7:p3 (proj-worker-1): harness pi, role worker, model prov/model-a (request), thinking high, placement new tab 'worker'.");
	assert.match(lines[1], /^Started watch w1 \(fix\) on pane w7:p3 \(pid \d+, timeout 1500s\)\.$/);
	assert.ok(lines.includes("Do not wait or poll: continue with other work."));
	assert.ok(lines.includes(`After you verify the result, close the pane: ${close}`));
	const { spawn, id, pane, name, pid, files } = result.details;
	assert.deepEqual([id, pane, name, typeof pid], ["w1", "w7:p3", "proj-worker-1", "number"]);
	assert.deepEqual(spawn, { name: "proj-worker-1", pane_id: "w7:p3", model: "prov/model-a", model_source: "request", thinking: "high", placement: "new tab 'worker'", status: "idle" });
	assert.deepEqual(f.spawnCalls(), [{ argv: ["--harness", "pi", "--role", "worker", "--model", "prov/model-a", "--thinking", "high", "--cwd", f.root], cwd: f.root }]);
	assert.match(await f.status(), /^w1  running  pane=w7:p3  name=proj-worker-1  label=fix  elapsed=\d+s  pid=\d+$/);
	await until(() => f.messages.length === 1, "the notification");
	assert.deepEqual(JSON.parse(readFileSync(`${files.prompt}.argv.json`, "utf8")), ["w7:p3", "--file", files.prompt, "--timeout", "1500", "--max-chars", "1000000"]);
	const { message } = f.messages[0];
	assert.equal(message.content, [
		"<herdr-task-notification>",
		"task: w1 (fix)",
		"pane: w7:p3 (proj-worker-1)",
		"status: reply",
		"exit: 0",
		`output file: ${files.stdout}`,
		`reply (first ${reply.length} characters):`,
		"pane=w7:p3 agent=pi\n--- reply ---\nDone: the change",
		`close: ${close}`,
		"</herdr-task-notification>",
	].join("\n"));
	assert.equal(message.details.name, "proj-worker-1");
	assert.deepEqual(f.notices, ["herdr-watch w1 (fix): pane w7:p3 (proj-worker-1) finished: reply (exit 0)"]);
	const theme = { fg: (_color: string, value: string) => value, bg: (_color: string, value: string) => value };
	const rendered = (f.renderers.get(CUSTOM_TYPE)(message, { expanded: false, outputPad: 0 }, theme).render(120) as string[]).map(line => line.trimEnd()).filter(Boolean);
	assert.match(rendered[0], /^herdr-watch w1 \(fix\) · pane w7:p3 \(proj-worker-1\) · reply · exit 0 · \d+s$/);
	assert.equal(rendered[1], "Done: the change");
});

test("herdr_spawn passes unattended, strict and extra_args to spawn.py, and the native arguments after --", async t => {
	const f = fixture(t);
	const result = await f.run("herdr_spawn", spawnTask(f.root, { reply: "ok" }, {
		harness: "claude", model: undefined, thinking: undefined, unattended: true, strict: true, extra_args: ["--allowedTools", "Bash(git log:*)"],
	}));
	assert.match(result.content[0].text, /^Started pane w7:p3 \(proj-worker-1\): harness claude, role worker, model harness default, thinking harness default, placement new tab 'worker'\.\n/);
	assert.deepEqual(f.spawnCalls().map(call => call.argv), [
		["--harness", "claude", "--role", "worker", "--cwd", f.root, "--strict", "--unattended", "--", "--allowedTools", "Bash(git log:*)"],
	]);
	await until(() => f.messages.length === 1, "the notification");
	await assert.rejects(f.run("herdr_spawn", spawnTask(f.root, {}, { extra_args: ["--unattended"] })), /--unattended is an option of spawn\.py, not a native argument\. Set unattended to true\./);
	assert.equal(f.spawnCalls().length, 1);
});

test("a failed start gives an error result with the exit code and the output tails, and starts no watch", async t => {
	const f = fixture(t);
	const bad = await f.run("herdr_spawn", spawnTask(f.root, { reply: "never" }, { thinking: "huge" }));
	assert.equal(bad.isError, true);
	const text = bad.content[0].text;
	assert.match(text, /^spawn\.py failed: exit 2 \(an input is not valid, nothing was started\)\. No watch was started\.\n/);
	assert.match(text, /\nstderr \(last \d+ characters\):\nerror: --thinking must be one of: off, minimal, low, medium, high, xhigh, max\n/);
	assert.match(text, /\nstdout \(last 0 characters\):\n\(empty\)$/);
	assert.doesNotMatch(text, /close:/);
	assert.deepEqual(bad.details, { spawn: null, exitCode: 2, signal: null, timedOut: false, aborted: false });

	f.spawnSpec({ exit: 1 });
	const failed = await f.run("herdr_spawn", spawnTask(f.root, { reply: "never" }));
	assert.equal(failed.isError, true);
	assert.match(failed.content[0].text, /^spawn\.py failed: exit 1 \(the start failed, spawn\.py closed the new pane again\)\. No watch was started\.\n/);
	assert.match(failed.content[0].text, /\nmodel: prov\/model-a \(from request\)\nerror: agent start failed and the new pane was closed: no agent\n/);

	f.spawnSpec({ exit: 4 });
	const blocked = await f.run("herdr_spawn", spawnTask(f.root, { reply: "never" }));
	const lines = blocked.content[0].text.split("\n");
	assert.equal(blocked.isError, true);
	assert.equal(lines[0], "spawn.py failed: exit 4 (the agent stopped at a startup question, the pane stays open). No watch was started.");
	assert.match(lines[1], /^Read the question with `herdr agent read w7:p3 --source visible`, show it to the user/);
	assert.equal(lines[2], "pane: w7:p3 (proj-worker-1)");
	assert.match(lines[3], /^stderr \(last \d+ characters\):$/);
	assert.doesNotMatch(blocked.content[0].text, /close:/);
	assert.match(blocked.content[0].text, /\nstdout \(last \d+ characters\):\n\{"name": "proj-worker-1", "pane_id": "w7:p3".*"status": "blocked"\}$/);
	assert.equal(blocked.details.spawn.pane_id, "w7:p3");

	assert.equal(f.spawnCalls().length, 3);
	assert.equal(await f.status(), "No herdr watches in this session.");
	assert.deepEqual(readdirSync(f.tmp), []);
	await new Promise(done => setTimeout(done, 200));
	assert.equal(f.messages.length, 0);
});

test("a herdr_spawn notification has no close line after a timeout (124) or a blocked status (4)", async t => {
	const f = fixture(t);
	const exits = [124, 4, 3, 5, 6];
	for (const exit of exits) await f.run("herdr_spawn", spawnTask(f.root, { exit, reply: `exit ${exit}\n` }));
	await until(() => f.messages.length === exits.length, "five notifications");
	const byExit = Object.fromEntries(f.messages.map(sent => [sent.message.details.exitCode, sent.message.content as string]));
	assert.deepEqual(Object.keys(byExit).map(Number).sort((a, b) => a - b), [3, 4, 5, 6, 124]);
	const close = `\nclose: python3 ${join(f.skill, "scripts/close.py")} w7:p3\n</herdr-task-notification>`;
	for (const exit of [124, 4]) {
		assert.match(byExit[exit], /\npane: w7:p3 \(proj-worker-1\)\n/, `exit ${exit}`);
		assert.doesNotMatch(byExit[exit], /\nclose: /, `exit ${exit}`);
	}
	for (const exit of [3, 5, 6]) assert.ok(byExit[exit].endsWith(close), `exit ${exit}`);
});

test("herdr_spawn refuses the coordinator role and bad inputs before any process starts", async t => {
	const f = fixture(t);
	await assert.rejects(f.run("herdr_spawn", spawnTask(f.root, {}, { role: "coordinator" })),
		/^Error: herdr_spawn starts task sessions only\. A coordinator is a primary session, not a task session\. For a coordinator handoff, run spawn\.py/);
	await assert.rejects(f.run("herdr_spawn", spawnTask("relative/dir", {})), /cwd must be an absolute path/);
	await assert.rejects(f.run("herdr_spawn", spawnTask(f.root, {}, { prompt_file: "task.md" })), /exactly one of prompt and prompt_file/);
	await assert.rejects(f.run("herdr_spawn", spawnTask(f.root, {}, { timeout_seconds: 0 })), /timeout_seconds must be a whole number/);
	const empty = join(f.root, "empty-skill");
	mkdirSync(empty);
	process.env.HERDR_SKILL_DIR = empty;
	await assert.rejects(f.run("herdr_spawn", spawnTask(f.root, {})), new RegExp(`spawn\\.py of the herdr skill was not found\\. Searched: ${join(empty, "scripts/spawn.py")}\\.`));
	mkdirSync(join(empty, "scripts"));
	writeFileSync(join(empty, "scripts/spawn.py"), FAKE_SPAWN);
	await assert.rejects(f.run("herdr_spawn", spawnTask(f.root, {})), /ask\.py of the herdr skill was not found beside spawn\.py/);
	assert.deepEqual(f.spawnCalls(), []);
	assert.equal(existsSync(join(empty, "scripts/spawn-calls.jsonl")), false);
	assert.deepEqual(readdirSync(f.tmp), []);
});

test("an abort while spawn.py runs stops it, and no watch starts", async t => {
	const f = fixture(t);
	f.spawnSpec({ sleep: 30 });
	const control = new AbortController();
	const before = Date.now();
	const pending = f.run("herdr_spawn", spawnTask(f.root, { reply: "never" }), control.signal);
	await until(() => f.spawnCalls().length === 1, "spawn.py runs");
	control.abort();
	const result = await pending;
	assert.ok(Date.now() - before < 10000);
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /^The tool call was stopped while spawn\.py ran\. No watch was started\.\nA new pane can be open without a task/);
	assert.equal(result.details.aborted, true);
	assert.equal(await f.status(), "No herdr watches in this session.");
	await assert.rejects(f.run("herdr_spawn", spawnTask(f.root, {}), control.signal), /stopped before spawn\.py started/);
	assert.equal(f.spawnCalls().length, 1);
});

test("a spawn.py that ignores SIGTERM gets SIGKILL after the grace time", async t => {
	const f = fixture(t);
	f.spawnSpec({ sleep: 30, ignore_term: true });
	const control = new AbortController();
	const pending = f.run("herdr_spawn", spawnTask(f.root, { reply: "never" }), control.signal);
	await until(() => f.spawnCalls().length === 1, "spawn.py runs");
	const before = Date.now();
	control.abort();
	const result = await pending;
	const waited = Date.now() - before;
	assert.ok(waited >= SPAWN_KILL_GRACE_MS - 100 && waited < SPAWN_KILL_GRACE_MS + 5000, `waited ${waited} ms`);
	assert.equal(result.isError, true);
	assert.deepEqual([result.details.aborted, result.details.exitCode, result.details.signal], [true, null, "SIGKILL"]);
	assert.equal(await f.status(), "No herdr watches in this session.");
});

test("lastJsonLine takes the last line that is a JSON object", () => {
	assert.deepEqual(lastJsonLine('{"a": 1}\nnoise\n{"b": 2}\n\n'), { b: 2 });
	assert.deepEqual(lastJsonLine('{"a": 1}\n[1, 2]\n{broken\n'), { a: 1 });
	assert.equal(lastJsonLine("no json"), undefined);
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
