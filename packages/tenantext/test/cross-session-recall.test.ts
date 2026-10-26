import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { renderFakeCursor } from "@earendil-works/pi-tui";
import crossSessionRecall from "../extensions/cross-session-recall/index.ts";
import { DATABASE_NAME, DIRECTORY_VARIABLE, RecallStore } from "../extensions/cross-session-recall/store.ts";
import { createNextPrompt } from "../extensions/next-prompt/index.ts";

// A final report with one agent action, so that next-prompt has a draft to show.
const REPORT = ["**REPORT 1** Done", "", "- **[1]** Done: The test ran.", "", "**Next:**", "- **[a]** Agent: Read the log.", ""].join("\n");
const BRANCH = [
  { type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } },
  { type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: REPORT }] } },
];
// An empty agent directory: the host may have a user copy of the extension, before which the kit copy stands down.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "recall-agent-"));
const WRITERS = 4;
const INPUTS = 50;
const storeUrl = new URL("../extensions/cross-session-recall/store.ts", import.meta.url).href;
// One writer process: it stores `w<writer>-<n>` for each n, as fast as it can.
const WRITER = `
  const { RecallStore } = await import(${JSON.stringify(storeUrl)});
  const [dir, writer, count] = process.argv.slice(1);
  const store = new RecallStore(dir);
  for (let n = 0; n < Number(count); n++) store.add({ text: \`w\${writer}-\${n}\`, timestamp: Date.now() });
  store.close();
`;

test("writers in parallel lose no input, and the store is private to the user", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "recall-")), "store");
  const run = promisify(execFile);
  await Promise.all(Array.from({ length: WRITERS }, (_, writer) => run(process.execPath,
    ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", WRITER, dir, String(writer), String(INPUTS)])));
  const store = new RecallStore(dir);
  const texts = store.query("", WRITERS * INPUTS + 1).map((item) => item.text).sort();
  const expected = Array.from({ length: WRITERS }, (_, writer) => Array.from({ length: INPUTS }, (_, n) => `w${writer}-${n}`)).flat().sort();
  assert.deepEqual(texts, expected);
  assert.deepEqual(store.query("w1-4", 100).map((item) => item.text).sort(), ["w1-4", ...Array.from({ length: 10 }, (_, n) => `w1-4${n}`)].sort());
  store.close();
  if (process.platform !== "win32") {
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, DATABASE_NAME)).mode & 0o777, 0o600);
  }
});

// A fake editor with the empty-line form of the pi-tui editor and a native history.
class FakeEditor {
  text = "";
  history: string[] = [];
  getText() { return this.text; }
  setText(text: string) { this.text = text; }
  addToHistory(text: string) { this.history.unshift(text); }
  render(width: number) {
    const line = this.text ? this.text.padEnd(width) : ` ${renderFakeCursor(" ")}${" ".repeat(width - 2)}`;
    return ["-".repeat(width), line, "-".repeat(width)];
  }
  handleInput(data: string) { this.text += data; }
  invalidate() {}
}

/** The two extensions on one fake Pi, started in the given order; the editor is built as the interactive mode does. */
function profile(order: "recall-first" | "next-prompt-first", mode = "tui") {
  const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
  const pi = {
    on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); return () => {}; },
    events: { on() { return () => {}; }, emit() {} },
    registerCommand() {},
  } as unknown as ExtensionAPI;
  // The factory below the extensions, as the first factory of a profile: the fake editor.
  let factory: any = () => new FakeEditor();
  let editor: any = factory();
  const ctx = {
    mode, hasUI: mode === "tui", cwd: "/tmp",
    isIdle: () => true, hasPendingMessages: () => false,
    sessionManager: { getBranch: () => BRANCH, getSessionFile: () => undefined },
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      notify() {}, setStatus() {},
      getEditorText: () => editor.getText(),
      getEditorComponent: () => factory,
      setEditorComponent(next: any) {
        const text = editor.getText();
        factory = next;
        editor = next ? next({ requestRender() {} }, {}, {}) : new FakeEditor();
        editor.setText(text);
      },
    },
  } as unknown as ExtensionContext;
  const nextPrompt = () => createNextPrompt(pi, {
    loadSettings: () => ({ settings: { enabled: true } }), dummiesOn: () => true, herdrRole: async () => "coordinator",
  });
  if (order === "recall-first") { crossSessionRecall(pi); nextPrompt(); } else { nextPrompt(); crossSessionRecall(pi); }
  const fire = async (name: string, event: object = {}) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); };
  return { fire, get editor() { return editor; } };
}

test("cross-session-recall and next-prompt compose in either load order: Up/Down history and the faint draft", async () => {
  // The store starts empty; the first session stores an input which must be in the history of a later editor.
  process.env[DIRECTORY_VARIABLE] = join(mkdtempSync(join(tmpdir(), "recall-")), "store");
  for (const order of ["recall-first", "next-prompt-first"] as const) {
    const p = profile(order);
    await p.fire("session_start", { reason: "startup" });
    await p.fire("input", { type: "input", text: `typed in ${order}`, source: "interactive" });
    await p.fire("agent_settled", { aborted: false });
    assert.ok(p.editor.history.includes(`typed in ${order}`), `${order}: the input of this session is in the Up/Down history`);
    assert.equal(p.editor.getText(), "");
    assert.ok(p.editor.render(80)[1].includes("Read the log."), `${order}: the faint draft of next-prompt shows`);
    await p.fire("session_shutdown");
  }
});

test("a print-mode run stores nothing: Pi sends its prompt with the source interactive", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "recall-")), "store");
  process.env[DIRECTORY_VARIABLE] = dir;
  const p = profile("recall-first", "print");
  await p.fire("session_start", { reason: "startup" });
  await p.fire("input", { type: "input", text: "pi -p prompt with a secret", source: "interactive" });
  await p.fire("session_shutdown");
  assert.equal(existsSync(dir), false, "no store directory after a print-mode input");
});
