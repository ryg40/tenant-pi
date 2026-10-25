import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { renderFakeCursor } from "@earendil-works/pi-tui";
import { createNextPrompt, type Dependencies } from "../extensions/next-prompt/index.ts";
import { acceptedText, parseReport, suggestFromBranch, suggestFromReport } from "../extensions/next-prompt/report.ts";
import { SETTINGS_EVENT } from "../src/next-prompt-settings.ts";

const REPORT = [
  "**REPORT 3** The local check failed",
  "",
  "- **[1]** Done: The footer fix is committed locally.",
  "- **[2]** Failed: The local check failed.",
  "",
  "**Next:**",
  "- **[a]** Agent: Read the log of the failed check.",
  "",
  "A new run uses the same local branch.",
].join("\n");
const SUGGESTION = acceptedText({ label: "a", actor: "Agent", text: "Read the log of the failed check." });
const user = (text: string) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const assistant = (text: string, stopReason = "stop") => ({ type: "message", message: { role: "assistant", stopReason, content: [{ type: "text", text }] } });
const replace = (from: string, to: string) => REPORT.replace(from, to);

test("the parser suggests only an unambiguous agent action of the final report", () => {
  const fence = ["Example:", "```markdown", REPORT, "```"].join("\n");
  const quoted = REPORT.split("\n").map(line => `> ${line}`).join("\n");
  const cases: [string, unknown[], string][] = [
    ["valid report", [user("go"), assistant(REPORT)], SUGGESTION],
    ...["2", "9", "10", "19", "20", "100"].map(count => [
      `report after ${count} grouped turns`, [user("go"), assistant(replace("REPORT 3", `REPORT 3 (${count} turns)`))], SUGGESTION,
    ] as [string, unknown[], string]),
    ...["0", "1", "00", "02", "010"].map(count => [
      `invalid grouped-turn count ${count}`, [user("go"), assistant(replace("REPORT 3", `REPORT 3 (${count} turns)`))], "missing",
    ] as [string, unknown[], string]),
    ["no report", [user("go"), assistant("The work is done.")], "missing"],
    ["second Next line in the block", [user("go"), assistant(replace("**Next:**\n", "**Next:**\n- **[a]** Agent: Read the log.\n**Next:**\n"))], "ambiguous"],
    ["Next line in the prose after the block", [user("go"), assistant(`${REPORT}\n\n**Next:**\n- **[a]** Agent: Read the log.`)], SUGGESTION],
    ["action line with a trailing space", [user("go"), assistant(replace("failed check.\n", "failed check. \n"))], "ambiguous"],
    ["action labels must start at a", [user("go"), assistant(replace("- **[a]** Agent:", "- **[b]** Agent:"))], "ambiguous"],
    ["Next with no action", [user("go"), assistant(REPORT.replace(/(\*\*Next:\*\*\n)[\s\S]*?\n\n/, "$1\n"))], "ambiguous"],
    ["owner decision first", [user("go"), assistant(replace("- **[a]** Agent:", "- **[a]** Owner decides:"))], "owner"],
    ["owner action first", [user("go"), assistant(replace("- **[a]** Agent:", "- **[a]** Owner:"))], "owner"],
    ["pending approval on the first numeric subject", [user("go"), assistant(replace("[1]** Done:", "[1]** Needs approval:"))], "approval"],
    ["unrelated approval on the second numeric subject", [user("go"), assistant(replace("[2]** Failed:", "[2]** Needs approval:"))], "approval"],
    ["agent action with a condition", [user("go"), assistant(replace("- **[a]** Agent:", "- **[a]** Agent, after the owner approves:"))], "conditional"],
    ["no safe next action", [user("go"), assistant(REPORT.replace(/\*\*Next:\*\*\n[\s\S]*?\n\n/, "**Next:** None. The owner must choose the release.\n\n"))], "no-next"],
    ["zero-width character in the action", [user("go"), assistant(replace("Read the log", "Read the\u200blog"))], "unsafe"],
    ["overlong action", [user("go"), assistant(replace("Read the log of the failed check.", `Read the log at https://git.example.org/${"x".repeat(80)}.`))], "overlong"],
    ["report in a code fence", [user("go"), assistant(fence)], "missing"],
    ["quoted report", [user("go"), assistant(quoted)], "missing"],
    ["report in a tool result", [user("go"), { type: "message", message: { role: "toolResult", content: [{ type: "text", text: REPORT }] } }, assistant("Done.")], "missing"],
    ["tool result after the report", [user("go"), assistant(REPORT), { type: "message", message: { role: "toolResult", content: [{ type: "text", text: REPORT }] } }], "no-final-message"],
    ["older report, newer user message", [assistant(REPORT), user("wait")], "no-final-message"],
    ["aborted reply", [user("go"), assistant(REPORT, "aborted")], "no-final-message"],
  ];
  for (const [name, branch, expected] of cases) {
    const result = suggestFromBranch(branch);
    assert.equal(result.kind === "suggestion" ? result.text : result.reason, expected, name);
  }
});

test("independent labels progress beyond old caps and z, and restart for each report and outcome", () => {
  // Build labels independently of the parser's string-carry implementation.
  const label = (ordinal: number): string => {
    let out = "";
    for (let n = ordinal; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(97 + (n - 1) % 26) + out;
    return out;
  };
  const items = Array.from({ length: 8 }, (_, i) => `- **[${i + 1}]** Done: Check ${i + 1} passed.`).join("\n");
  const actions = Array.from({ length: 703 }, (_, i) => `- **[${label(i + 1)}]** Agent: Read local log ${i + 1}.`).join("\n");
  const large = `**REPORT 8** Local checks passed\n\n${items}\n\n**Next:**\n${actions}`;
  const parsed = parseReport(large);
  assert.equal(parsed.status, "next");
  if (parsed.status !== "next") return;
  assert.equal(parsed.actions[25].label, "z");
  assert.equal(parsed.actions[26].label, "aa");
  assert.equal(parsed.actions[51].label, "az");
  assert.equal(parsed.actions[52].label, "ba");
  assert.equal(parsed.actions[701].label, "zz");
  assert.equal(parsed.actions[702].label, "aaa");
  assert.deepEqual(suggestFromReport(parsed), { kind: "suggestion", action: "a", text: "Continue action a: Read local log 1." });
  for (const head of ["**REPORT 9** A different subject", "**OUTCOME** The checks passed"]) {
    const fresh = REPORT.replace(/^.+/, head);
    assert.deepEqual(suggestFromReport(parseReport(fresh)), { kind: "suggestion", action: "a", text: SUGGESTION });
  }
  // One numeric subject can have many actions. Actions never need matching subjects.
  assert.equal(suggestFromReport(parseReport(large.replace(items, "- **[1]** Failed: The check failed."))).kind, "suggestion");
  for (const broken of [
    large.replace("[aa]** Agent", "[ab]** Agent"),
    large.replace("[aaa]** Agent", "[aaaa]** Agent"),
    REPORT.replace("[2]** Failed", "[1]** Failed"),
    REPORT.replace("[2]** Failed", "[3]** Failed"),
    REPORT.replace("[1]** Done", "[01]** Done"),
    REPORT.replace(/^- \*\*\[[12]\]\*\*.*\n/gm, ""),
    REPORT.replace("[a]** Agent", "[A]** Agent"),
    REPORT.replace("[1]** Done", "[A]** Done").replace("[2]** Failed", "[B]** Failed").replace("[a]** Agent", "[B]** Agent"),
    `${REPORT}\n${REPORT}`,
  ]) assert.equal(parseReport(broken).status, "ambiguous");
});

test("report-wide restrictions refuse unlinked work without guessing by position or skipping actions", () => {
  const appendAction = (line: string) => REPORT.replace("check.\n\n", `check.\n${line}\n\n`);
  const cases: [string, string][] = [
    [appendAction("- **[b]** Owner decides: Approve the release or keep it local."), "owner"],
    [appendAction("- **[b]** Owner: Run the privileged check."), "owner"],
    [appendAction("- **[b]** Agent, after the check passes: Read the summary."), "conditional"],
    [replace("**Next:**", "**Warning:** The release waits for approval.\n\n**Next:**"), "unlinked"],
    [replace("[2]** Failed:", "[2]** Retired:"), "unlinked"],
    [replace("[1]** Done:", "[1]** Proposal:"), "unlinked"],
    [replace("[2]** Failed:", "[2]** Blocked:"), "unlinked"],
    [replace("locally.", "local\u200bly."), "unsafe"],
    [appendAction("- **[b]** Agent: Read the\u202elog."), "unsafe"],
    [replace("local check failed", "local\u001b check failed"), "unsafe"],
  ];
  for (const [text, reason] of cases) assert.deepEqual(suggestFromReport(parseReport(text)), { kind: "none", reason });
  for (const state of ["Done", "Failed", "Unverified", "Running"]) {
    assert.equal(suggestFromReport(parseReport(replace("[2]** Failed:", `[2]** ${state}:`))).kind, "suggestion");
  }
  const ownerFirst = appendAction("- **[b]** Agent: Read another log.").replace("[a]** Agent:", "[a]** Owner decides:");
  assert.deepEqual(suggestFromReport(parseReport(ownerFirst)), { kind: "none", reason: "owner" });
});

test("the shipped report and outcome examples parse as valid next actions or no next action", () => {
  for (const name of ["REPORT.md", "LOG.md"]) {
    const doc = readFileSync(new URL(`../skills/coordinator-skills/dummies/${name}`, import.meta.url), "utf8");
    const examples = [...doc.matchAll(/```markdown\n([\s\S]*?)\n```/g)];
    assert.ok(examples.length > 0, name);
    for (const [, example] of examples) {
      const parsed = parseReport(example);
      assert.ok(parsed.status === "next" || parsed.status === "none", `${name}: ${parsed.status}`);
    }
  }
});

// A fake previous editor factory: its empty line has the form of the pi-tui editor.
function baseFactory() {
  const built: FakeEditor[] = [];
  const factory = () => { const editor = new FakeEditor(); built.push(editor); return editor; };
  return { factory, built };
}
class FakeEditor {
  text = "";
  inputs: string[] = [];
  submitted: string[] = [];
  getText() { return this.text; }
  setText(text: string) { this.text = text; }
  render(width: number) {
    const line = this.text ? this.text.padEnd(width) : ` ${renderFakeCursor(" ")}${" ".repeat(width - 2)}`;
    return ["-".repeat(width), line, "-".repeat(width)];
  }
  handleInput(data: string) {
    this.inputs.push(data);
    if (data === "\r") { this.submitted.push(this.text); this.text = ""; }
    else if (data !== "\t" && data !== "\x1b") this.text += data;
  }
  invalidate() {}
}
// An editor whose empty line has another form: a placeholder text after the cursor.
class PlaceholderEditor extends FakeEditor {
  override render(width: number) {
    const lines = super.render(width);
    return this.text ? lines : [lines[0], ` ${renderFakeCursor(" ")} Type a message${" ".repeat(width - 16)}`, lines[2]];
  }
}

function harness(options: { deps?: Partial<Dependencies>; prior?: ReturnType<typeof baseFactory> } = {}) {
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const listeners = new Map<string, (value: unknown) => void>();
  const calls: string[] = [];
  const pi = {
    on(name: string, handler: any) { handlers.set(name, handler); return () => {}; },
    events: { on(name: string, handler: any) { listeners.set(name, handler); return () => {}; }, emit() {} },
    sendUserMessage() { calls.push("sendUserMessage"); },
    sendMessage() { calls.push("sendMessage"); },
    appendEntry() { calls.push("appendEntry"); },
  } as unknown as ExtensionAPI;
  const prior = options.prior ?? baseFactory();
  const state = { idle: true, pending: false, branch: [user("go"), assistant(REPORT)] as unknown[] };
  let factory: any = prior.factory;
  let editor: any = prior.factory();
  const ctx = {
    mode: "tui",
    isIdle: () => state.idle,
    hasPendingMessages: () => state.pending,
    sessionManager: { getBranch: () => state.branch },
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      notify() {},
      getEditorText: () => editor.getText(),
      getEditorComponent: () => factory,
      // As the interactive mode does: build the editor from the factory and keep its text.
      setEditorComponent(next: any) {
        const text = editor.getText();
        factory = next;
        editor = next ? next({ requestRender() {} }, {}, {}) : prior.factory();
        editor.setText(text);
      },
    },
  } as unknown as ExtensionContext;
  createNextPrompt(pi, {
    loadSettings: () => ({ settings: { enabled: true } }),
    dummiesOn: () => true,
    herdrRole: async () => "coordinator",
    ...options.deps,
  });
  const fire = (name: string, event: object = {}) => handlers.get(name)?.(event, ctx);
  return {
    state, calls, prior, ctx, fire, emit: (name: string, value: unknown) => listeners.get(name)?.(value),
    get editor() { return editor; }, get factory() { return factory; },
    ghost: () => editor.getText() === "" && editor.render(80)[1].replace(/\x1b\[[0-9;]*m/g, "").includes(SUGGESTION),
    start: async () => { await fire("session_start", { reason: "startup" }); },
    settle: async (aborted = false) => { await fire("agent_settled", { aborted }); },
  };
}

test("Tab takes the suggestion into the empty editor and sends nothing, with no model or network call", async (t) => {
  const fetches: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (...args: unknown[]) => { fetches.push(args); throw new Error("no network"); });
  const h = harness();
  await h.start();
  await h.settle();
  assert.ok(h.ghost(), "faint text after settle");
  assert.equal(h.editor.getText(), "");
  h.editor.handleInput("\t");
  assert.equal(h.editor.getText(), SUGGESTION);
  assert.ok(!h.editor.inputs.includes("\t"), "Tab is taken, not passed on");
  assert.deepEqual(h.editor.submitted, []);
  assert.ok(!h.ghost());
  h.editor.handleInput("\r");
  assert.deepEqual(h.editor.submitted, [SUGGESTION], "Enter sends the draft through the editor");
  assert.deepEqual(h.calls, []);
  assert.deepEqual(fetches, []);
});

test("busy, queued, typed, aborted, dummies-off and task sessions get no suggestion", async () => {
  const cases: [string, (h: ReturnType<typeof harness>) => void, Partial<Dependencies>?][] = [
    ["busy", h => { h.state.idle = false; }],
    ["queued", h => { h.state.pending = true; }],
    ["typed", h => { h.editor.setText("my draft"); }],
    ["dummies off", () => {}, { dummiesOn: () => false }],
    ["task session", () => {}, { herdrRole: async () => "worker" }],
    ["setting off", () => {}, { loadSettings: () => ({ settings: { enabled: false } }) }],
  ];
  for (const [name, setup, deps] of cases) {
    const h = harness({ deps });
    await h.start();
    setup(h);
    await h.settle();
    assert.ok(!h.ghost(), name);
    assert.equal(h.factory, h.prior.factory, `${name}: the editor factory is unchanged`);
    if (name === "typed") assert.equal(h.editor.getText(), "my draft");
  }
  const aborted = harness();
  await aborted.start();
  await aborted.settle(true);
  assert.ok(!aborted.ghost(), "aborted");
  // Work that is queued after the suggestion appeared hides it, and Tab then reaches the editor.
  const late = harness();
  await late.start();
  await late.settle();
  late.state.pending = true;
  assert.ok(!late.ghost());
  late.editor.handleInput("\t");
  assert.equal(late.editor.getText(), "");
  assert.ok(late.editor.inputs.includes("\t"));
  // An empty line of another form shows no faint text, and Tab reaches the editor.
  const built: FakeEditor[] = [];
  const shaped = harness({ prior: { factory: () => { const one = new PlaceholderEditor(); built.push(one); return one; }, built } });
  await shaped.start();
  await shaped.settle();
  assert.ok(!shaped.ghost(), "line of another form");
  shaped.editor.handleInput("\t");
  assert.equal(shaped.editor.getText(), "");
  assert.ok(shaped.editor.inputs.includes("\t"));
});

test("typing, agent start, session switch, tree navigation, shutdown and disable clear the suggestion", async () => {
  const clears: [string, (h: ReturnType<typeof harness>) => unknown][] = [
    ["typing", h => h.editor.handleInput("x")],
    ["agent start", h => h.fire("agent_start")],
    ["session switch", h => h.fire("session_start", { reason: "resume" })],
    ["tree navigation", h => h.fire("session_tree", { newLeafId: "a", oldLeafId: "b" })],
    ["shutdown", h => h.fire("session_shutdown", { reason: "quit" })],
    ["disable", h => h.emit(SETTINGS_EVENT, { enabled: false })],
  ];
  for (const [name, action] of clears) {
    const h = harness();
    await h.start();
    await h.settle();
    assert.ok(h.ghost(), `${name}: shown before`);
    await action(h);
    h.editor.setText(""); // also after typing: the text is gone, and the suggestion stays gone
    assert.ok(!h.ghost(), `${name}: cleared`);
    h.editor.handleInput("\t");
    assert.equal(h.editor.getText(), "", `${name}: Tab inserts nothing`);
    if (name === "disable") assert.equal(h.factory, h.prior.factory, "disable gives the editor back to the previous factory");
  }
  // A role lookup that ends after a session switch does not show the report of the old session.
  const waiting: ((role: string) => void)[] = [];
  const slow = harness({ deps: { herdrRole: () => new Promise(resolve => { waiting.push(resolve); }) } });
  await slow.start();
  const settled = slow.settle();
  await slow.fire("session_start", { reason: "new" });
  for (const release of waiting) release("coordinator");
  await settled;
  assert.ok(!slow.ghost());
});

test("repeated initialization keeps the previous factory and does not stack wrappers", async () => {
  const prior = baseFactory();
  const h = harness({ prior });
  for (let i = 0; i < 3; i++) {
    await h.start();
    await h.settle();
    await h.settle();
  }
  // A second load of the extension, as after a reload that kept the factory.
  createNextPrompt({
    on(name: string, handler: any) { if (name === "agent_settled") void handler({ aborted: false }, h.ctx); return () => {}; },
    events: { on() { return () => {}; } },
  } as unknown as ExtensionAPI, { loadSettings: () => ({ settings: { enabled: true } }), dummiesOn: () => true, herdrRole: async () => undefined });
  await new Promise(resolve => setImmediate(resolve));
  const marked = h.factory[Symbol.for("tenantext.next-prompt.factory")];
  assert.equal(marked.base, prior.factory, "the own factory wraps the previous factory, never itself");
  const line = h.editor.render(80)[1];
  assert.equal(line.split(SUGGESTION).length - 1, 1, "one faint text");
  h.editor.handleInput("\t");
  assert.equal(h.editor.getText(), SUGGESTION);
  assert.ok(!h.editor.inputs.includes("\t"));
});
