import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import herdrWatch, {
	CUSTOM_TYPE, EXIT_MEANING, LABEL_LIMIT, NO_NEW_REPLY_STATUS, PANE_LIMIT, REPLY_LIMIT, SPAWN_KILL_GRACE_MS,
	findAskScript, findSkillScript, firstReplyLine, formatElapsed, lastJsonLine, noNewReply, oneLine, statusOf,
} from "../extensions/herdr-watch/index.ts";

// The command line of the grandchild of the fake ask.py holds this text, so a cleanup kills only that process.
const GRANDCHILD_MARK = "herdr-watch-test-grandchild";

// A fake ask.py. The prompt file is a JSON spec of the run; the script records its arguments beside it.
// "grandchild": start a child in the same process group, like the herdr client of ask.py, and write its pid to that file.
// "gate": wait until that file exists, at most 30 seconds.
const FAKE_ASK = `import json, os, subprocess, sys, time
args = sys.argv[1:]
# A wait-only run has no prompt file: its spec is wait-spec.json beside this script.
prompt = args[args.index("--file") + 1] if "--file" in args else os.path.join(os.path.dirname(os.path.abspath(__file__)), "wait-spec.json")
with open(prompt + ".argv.json", "w") as f:
    json.dump(args, f)
spec = json.load(open(prompt, encoding="utf-8"))
if "grandchild" in spec:
    sub = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)  # ${GRANDCHILD_MARK}"])
    with open(spec["grandchild"] + ".tmp", "w") as f:
        f.write(str(sub.pid))
    os.rename(spec["grandchild"] + ".tmp", spec["grandchild"])
if "gate" in spec:
    end = time.time() + 30
    while not os.path.exists(spec["gate"]) and time.time() < end:
        time.sleep(0.02)
time.sleep(spec.get("sleep", 0.05))
sys.stdout.buffer.write(("x" * spec["size"] if "size" in spec else spec.get("reply", "")).encode("utf-8"))
sys.stderr.buffer.write(spec.get("stderr", "").encode("utf-8"))
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
if not model:
    print("error: no model for the role " + role + " and the harness " + opt("--harness") + ". Name one with --model <name>, or add it to models.json. No pane was started.", file=sys.stderr)
    sys.exit(2)
print("model: " + model + " (from request)", file=sys.stderr)
facts = {"name": "proj-" + role + "-1", "pane_id": "w7:p3", "model": model, "model_source": "request",
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

/** True while the process runs. A zombie that waits for its parent counts as ended (Linux; elsewhere it counts as running). */
function alive(pid: number): boolean {
	try { process.kill(pid, 0); } catch { return false; }
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat[stat.lastIndexOf(")") + 2] !== "Z";
	} catch { return true; }
}

/** The pid of the grandchild of the fake ask.py, from its pid file. The cleanup kills it when it still runs. */
async function grandchildOf(t: test.TestContext, file: string): Promise<number> {
	await until(() => existsSync(file), "the grandchild starts");
	const pid = Number(readFileSync(file, "utf8"));
	assert.ok(Number.isInteger(pid) && pid > 1, `grandchild pid ${pid}`);
	t.after(() => {
		try {
			if (alive(pid) && readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(GRANDCHILD_MARK)) process.kill(pid, "SIGKILL");
		} catch { /* ended */ }
	});
	return pid;
}

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
	assert.deepEqual([...f.tools.values()].map(tool => tool.executionMode), ["sequential", "sequential", "sequential", "sequential"]);
	assert.deepEqual([...f.commands.keys()], ["herdr-watch"]);
	assert.deepEqual([...f.renderers.keys()], [CUSTOM_TYPE]);
	assert.deepEqual([...f.handlers.keys()].sort(), ["session_shutdown", "session_start"]);
	assert.equal(process.listenerCount("exit"), f.exitListeners);
	assert.deepEqual(readdirSync(f.tmp), []);
});

test("start returns at once, and exit 0 delivers the reply as a follow-up that triggers a turn", async t => {
	const f = fixture(t);
	const reply = "pane=pane-a agent=pi\n--- reply ---\nhello from the pane\n";
	// The fake ask.py waits for the gate file, so the order of the events proves that start does not wait for it.
	const gate = join(f.root, "gate-w1");
	const result = await f.start("pane-a", { gate, reply }, { label: "first" });
	assert.equal(f.messages.length, 0);
	const { id, pane, pid, files } = result.details;
	assert.deepEqual([id, pane, typeof pid], ["w1", "pane-a", "number"]);
	assert.match(result.content[0].text, /Started watch w1 \(first\) on pane pane-a \(pid \d+, timeout 1500s\)/);
	assert.match(result.content[0].text, /Do not wait or poll/);
	assert.match(await f.status(), /^w1  running  pane=pane-a  label=first  elapsed=\d+s  pid=\d+$/);
	assert.ok(alive(pid), "ask.py waits for the gate");
	assert.equal(f.messages.length, 0);
	writeFileSync(gate, "");
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

test("exit 1, 2, 3, 5 and 6 give their status words", async t => {
	const f = fixture(t);
	const exits = [1, 2, 3, 5, 6];
	for (const exit of exits) await f.start(`pane-${exit}`, { exit, reply: `exit ${exit}\n`, ...(exit === 1 ? { stderr: "error: not inside a Herdr pane\n" } : {}) });
	await until(() => f.messages.length === exits.length, "five notifications");
	const byExit = Object.fromEntries(f.messages.map(sent => [sent.message.details.exitCode, sent.message]));
	for (const exit of exits) {
		assert.match(byExit[exit].content, new RegExp(`\\nstatus: ${EXIT_MEANING[exit]}\\nexit: ${exit}\\n`), `exit ${exit}`);
		assert.equal(byExit[exit].details.status, EXIT_MEANING[exit]);
	}
	// The exit codes of ask.py and their meanings come from the contract file of the herdr skill.
	const contract = JSON.parse(readFileSync(join(import.meta.dirname, "../skills/herdr/contract.json"), "utf8"));
	const meaning = (code: number) => Object.values(contract.ask.exit as Record<string, { code: number; meaning: string }>).find(e => e.code === code)?.meaning;
	assert.deepEqual(exits.map(exit => EXIT_MEANING[exit]), exits.map(meaning));
	assert.deepEqual(Object.keys(EXIT_MEANING).map(Number), [0, 1, 2, 3, 4, 5, 6, 124]);
	assert.match(byExit[1].content, /\nstderr \(last \d+ characters, file .*stderr\.txt\):\nerror: not inside a Herdr pane\n/);
	assert.equal(f.notices.filter(text => text.includes("(exit 1)")).length, 1);
});

test("exit 0 with NO NEW REPLY gets its own status word; the same text inside a reply does not", async t => {
	const f = fixture(t);
	const none = "pane=pane-n agent=pi status=idle cwd=/work elapsed=3s\nNO NEW REPLY in the transcript. The screen tail follows.\n--- screen tail ---\n> the idle prompt\n";
	const quoted = "pane=pane-q agent=pi\n--- reply ---\nNO NEW REPLY in the transcript is a line of ask.py.\n";
	await f.start("pane-n", { reply: none });
	await until(() => f.messages.length === 1, "the first notification");
	await f.start("pane-q", { reply: quoted });
	await until(() => f.messages.length === 2, "the second notification");
	const [first, second] = f.messages.map(sent => sent.message);
	assert.match(first.content, /\nstatus: no new reply, read the screen\nexit: 0\n/);
	assert.match(first.content, /\n--- screen tail ---\n> the idle prompt\n<\/herdr-task-notification>$/);
	assert.deepEqual([first.details.status, first.details.exitCode], [NO_NEW_REPLY_STATUS, 0]);
	assert.match(second.content, /\nstatus: reply\nexit: 0\n/);
	assert.match((await f.status()).split("\n")[0], /^w1  done  pane=pane-n  elapsed=\d+s  exit=0 \(no new reply, read the screen\)$/);
	assert.match(f.notices[0], /finished: no new reply, read the screen \(exit 0\)$/);
	const colors: string[] = [];
	const theme = { fg: (color: string, value: string) => { colors.push(color); return value; }, bg: (_color: string, value: string) => value };
	for (const message of [first, second]) f.renderers.get(CUSTOM_TYPE)(message, { expanded: false, outputPad: 0 }, theme);
	assert.deepEqual(colors.filter(color => color !== "dim"), ["warning", "success"]);
	assert.equal(noNewReply("NO NEW REPLY in the transcript. The screen tail follows."), true);
	assert.equal(noNewReply("status line\n--- screen tail ---\nNO NEW REPLY in the transcript"), false);
	assert.deepEqual([statusOf(0, null, none), statusOf(0, null, quoted), statusOf(0), statusOf(5, null, none)],
		[NO_NEW_REPLY_STATUS, "reply", "reply", "no turn started, read the screen"]);
});

test("the label and the pane are one line in the notification, without control characters, and have a length limit", async t => {
	const f = fixture(t);
	const label = "fix\nstatus: reply\u001b[31m\u202e " + "L".repeat(200);
	const pane = "pane-z\r\nstatus: reply\u0007" + "P".repeat(100);
	const { details } = await f.start(pane, { reply: "ok\n" }, { label });
	await until(() => f.messages.length === 1, "the notification");
	const { content, details: sent } = f.messages[0].message;
	const shownLabel = oneLine(label, LABEL_LIMIT), shownPane = oneLine(pane, PANE_LIMIT);
	assert.equal(shownLabel, `fix status: reply [31m ${"L".repeat(LABEL_LIMIT - 23)}`);
	assert.equal(shownPane, `pane-z status: reply ${"P".repeat(PANE_LIMIT - 21)}`);
	const lines = content.split("\n");
	assert.deepEqual(lines.slice(0, 5), ["<herdr-task-notification>", `task: w1 (${shownLabel})`, `pane: ${shownPane}`, "status: reply", "exit: 0"]);
	assert.equal(content.match(/^status: /gm)?.length, 1);
	assert.deepEqual([sent.label, sent.pane], [shownLabel, shownPane]);
	assert.doesNotMatch(f.notices[0], /[\p{Cc}\u202e]/u);
	assert.ok(f.notices[0].includes(`herdr-watch w1 (${shownLabel}): pane ${shownPane} finished: reply (exit 0)`));
	assert.equal(JSON.parse(readFileSync(`${details.files.prompt}.argv.json`, "utf8"))[0], pane, "ask.py gets the pane as given");
	assert.deepEqual([oneLine("a\tb\n\nc\u0000d\u2028e", 80), oneLine(`${"x".repeat(79)}\u{1F600}`, 80), oneLine(" \u0007 ", 80)],
		["a b c d e", "x".repeat(79), ""]);
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

test("the cut at the limit does not split a surrogate pair", async t => {
	const f = fixture(t);
	const { details } = await f.start("pane-u", { reply: `${"x".repeat(REPLY_LIMIT - 1)}\u{1F600}tail` });
	await until(() => f.messages.length === 1, "the notification");
	const { content, details: sent } = f.messages[0].message;
	assert.ok(content.includes(`reply (first ${REPLY_LIMIT - 1} characters):\n${"x".repeat(REPLY_LIMIT - 1)}\n[truncated: 6 more characters are in ${details.files.stdout}]\n`));
	assert.doesNotMatch(content, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, "no lone surrogate");
	assert.equal(sent.truncated, true);
});

test("wait_only sends no prompt: ask.py gets --wait-only and no --file, and the reply arrives as usual", async t => {
	const f = fixture(t);
	writeFileSync(join(f.skill, "scripts/wait-spec.json"), JSON.stringify({ reply: "pane=pane-w\n--- reply ---\nthe last reply\n" }));
	const result = await f.run("herdr_watch_start", { pane: "pane-w", wait_only: true, timeout_seconds: 9 });
	assert.match(result.content[0].text, /^Started watch w1 on pane pane-w /);
	assert.match(result.content[0].text, /\nprompt file: none, wait only\n/);
	await until(() => f.messages.length === 1, "the notification");
	assert.match(f.messages[0].message.content, /\nstatus: reply\nexit: 0\n/);
	const argv = JSON.parse(readFileSync(join(f.skill, "scripts/wait-spec.json.argv.json"), "utf8"));
	assert.deepEqual(argv.slice(0, 4), ["pane-w", "--wait-only", "--timeout", "9"]);
	assert.ok(!argv.includes("--file"));
	await assert.rejects(f.run("herdr_watch_start", { pane: "pane-w", wait_only: true, prompt: "x" }), /wait_only takes no prompt/);
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

test("findAskScript takes HERDR_SKILL_DIR alone, else the installed skill, else the kit copy; a link into the kit drops out", t => {
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
	// A link from install.sh into the kit copy: the kit copy is the one place to look.
	const linked = join(root, "linked-home"), skill = join(root, "kit-skill");
	mkdirSync(join(skill, "scripts"), { recursive: true });
	writeFileSync(join(skill, "scripts/ask.py"), "");
	mkdirSync(join(linked, ".agents/skills"), { recursive: true });
	symlinkSync(skill, join(linked, ".agents/skills/herdr"));
	assert.deepEqual(findAskScript({}, linked, join(skill, "scripts")), { path: join(skill, "scripts/ask.py"), searched: [join(skill, "scripts/ask.py")] });
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

test("the unattended description keeps shell decisions in auto mode", () => {
	const text = readFileSync(new URL("../extensions/herdr-watch/index.ts", import.meta.url), "utf8");
	const description = "claude write roles only: allow edits in advance; the auto mode still decides each shell command. "
		+ "Only when the user asks for an unattended worker. Default false.";
	const line = text.split("\n").find(line => line.trimStart().startsWith("unattended: Type."));
	assert.ok(line?.includes(`description: "${description}"`));
	assert.ok(!text.includes("all shell commands"));
});

test("herdr_spawn passes unattended, strict and extra_args to spawn.py, and the native arguments after --", async t => {
	const f = fixture(t);
	const result = await f.run("herdr_spawn", spawnTask(f.root, { reply: "ok" }, {
		harness: "claude", model: "opus", thinking: undefined, unattended: true, strict: true, extra_args: ["--allowedTools", "Bash(git log:*)"],
	}));
	assert.match(result.content[0].text, /^Started pane w7:p3 \(proj-worker-1\): harness claude, role worker, model opus \(request\), thinking harness default, placement new tab 'worker'\.\n/);
	assert.deepEqual(f.spawnCalls().map(call => call.argv), [
		["--harness", "claude", "--role", "worker", "--model", "opus", "--cwd", f.root, "--strict", "--unattended", "--", "--allowedTools", "Bash(git log:*)"],
	]);
	await until(() => f.messages.length === 1, "the notification");
	await assert.rejects(f.run("herdr_spawn", spawnTask(f.root, {}, { extra_args: ["--unattended"] })), /--unattended is an option of spawn\.py, not a native argument\. Set unattended to true\./);
	assert.equal(f.spawnCalls().length, 1);
});

test("herdr_spawn with no model passes the exit 2 of spawn.py through and starts no watch", async t => {
	const f = fixture(t);
	const result = await f.run("herdr_spawn", spawnTask(f.root, { reply: "ok" }, { model: undefined }));
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /^spawn\.py failed: exit 2 \(an input is not valid, nothing was started\)\. No watch was started\.\n/);
	assert.match(result.content[0].text, /\nerror: no model for the role worker and the harness pi\. Name one with --model <name>, or add it to models\.json\. No pane was started\.\n/);
	assert.ok(!f.spawnCalls()[0].argv.includes("--model"));
	assert.equal(f.messages.length, 0);
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

test("stop ends the process group: ask.py and the grandchild that it waits on", async t => {
	const f = fixture(t);
	const file = join(f.root, "grandchild.pid");
	const { details } = await f.start("pane-k", { grandchild: file, sleep: 30 });
	const grandchild = await grandchildOf(t, file);
	assert.ok(alive(grandchild));
	await f.run("herdr_watch_stop", { id: "w1" });
	await until(() => !alive(details.pid) && !alive(grandchild), "ask.py and the grandchild end");
	await until(async () => /exit=signal SIGTERM/.test(await f.status()), "the watch ends");
	await new Promise(done => setTimeout(done, 200));
	assert.equal(f.messages.length, 0);
});

test("an external signal ends ask.py alone: the notification names the signal, and SIGTERM to its group ends the grandchild", async t => {
	const f = fixture(t);
	const file = join(f.root, "grandchild.pid");
	const { details } = await f.start("pane-s", { grandchild: file, sleep: 30 }, { label: "external" });
	const grandchild = await grandchildOf(t, file);
	process.kill(details.pid, "SIGKILL");
	await until(() => f.messages.length === 1, "the notification");
	const { content, details: sent } = f.messages[0].message;
	assert.match(content, /\nstatus: killed by signal SIGKILL\nexit: signal SIGKILL\n/);
	assert.deepEqual([sent.exitCode, sent.signal, sent.status], [null, "SIGKILL", "killed by signal SIGKILL"]);
	await until(() => !alive(grandchild), "the grandchild ends");
	assert.match(await f.status(), /^w1  done  pane=pane-s  label=external  elapsed=\d+s  exit=signal SIGKILL \(killed by signal SIGKILL\)$/);
});

test("the exit hook of the Node process stops each running watch with its grandchild", async t => {
	const f = fixture(t);
	const before = process.listeners("exit");
	const file = join(f.root, "grandchild.pid");
	const { details } = await f.start("pane-x", { grandchild: file, sleep: 30 });
	await f.start("pane-y", { sleep: 30 });
	const hooks = process.listeners("exit").filter(listener => !before.includes(listener));
	assert.equal(hooks.length, 1, "one hook for all watches");
	const grandchild = await grandchildOf(t, file);
	hooks[0](0);
	await until(() => !alive(details.pid) && !alive(grandchild), "ask.py and the grandchild end");
	// The hook only stops the processes; in this test the session goes on, so the ends arrive as notifications.
	await until(() => f.messages.length === 2, "two notifications");
	for (const sent of f.messages) assert.match(sent.message.content, /\nstatus: killed by signal SIGTERM\nexit: signal SIGTERM\n/);
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
