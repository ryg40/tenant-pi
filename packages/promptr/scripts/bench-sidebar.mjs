#!/usr/bin/env node
// Sidebar render benchmark. Offline: temporary state, fake Pi, no TTY, no Git.
//
//   npm run build && node scripts/bench-sidebar.mjs [renders]
//
// Mounts the real controller with a realistic session (trusted Git pulse, usage, TODOs, a settled run with
// three tools, a three-item queue, draft and notebook) in a 241-column terminal at 32 and 65 rows, then
// prints milliseconds per render for:
//   component idle    sidebar component, unchanged inputs (every idle frame Pi asks for)
//   component stream  sidebar component, one streamed-token telemetry change before each frame
//   component cold    sidebar component, width alternates so every frame is a full rebuild
//   frame regular     one full Pi main-screen frame (transcript, dock, sidebar overlay)
//   frame fullscreen  one full Pi alternate-screen frame (layout, paint, sidebar column)
// BENCH_SHOW=1 also prints the rendered sidebar.
import path from "node:path";
import { attachSidebarTelemetry } from "../dist/src/sidebar/telemetry.mjs";
import { registerSidebar } from "../dist/src/sidebar/controller.mjs";
import { controllerHarness, tick } from "../test/sidebar/controller-harness.mjs";

const renders = Math.max(1, Number(process.argv[2] ?? 2000));
const WIDTH = 241;
const SIDEBAR = 44;
const afters = [];
const t = { after: (fn) => afters.push(fn) };

const usage = (i) => ({ input: 12_000 + i * 900, output: 800 + i * 40, cacheRead: 40_000 + i * 2_000, cacheWrite: 1_200,
  totalTokens: 54_000 + i * 3_000, cost: { input: 0.03, output: 0.02, cacheRead: 0.01, cacheWrite: 0.004, total: 0.064 } });
const entries = [
  ...Array.from({ length: 24 }, (_, i) => ({ type: "message", message: { role: "assistant", content: [{ type: "text", text: `Reply ${i}` }],
    provider: "example-provider", model: "example-model", usage: usage(i), stopReason: "stop", timestamp: 1_000 + i } })),
  { type: "message", message: { role: "toolResult", toolName: "todo", isError: false, toolCallId: "todo-1", content: [],
    details: { todos: [{ id: 1, text: "Profile the sidebar render", done: true }, { id: 2, text: "Cache sidebar lines", done: false },
      { id: 3, text: "Guard render requests", done: false }] } } },
];
const git = { kind: "available", root: "/work/promptr", relativeCwd: "extension", branch: "work/example",
  snapshot: { trackedFiles: 7, untrackedFiles: 2, linesAdded: 312, linesRemoved: 41, binaryFiles: 0, submodules: 0, conflicts: 0 } };

async function session(fullscreen, rows) {
  const h = controllerHarness(t, "tui", { fullscreen, trusted: true, proxy: true, register: (pi) => registerSidebar(pi, {
    attempts: new Set(), workspace: async () => {}, review: async () => {}, refresh: async () => [], record: () => {},
    attachTelemetry: (o) => attachSidebarTelemetry({ ...o, autoCompact: true, inspectWorkspace: async () => git }),
  }) });
  Object.assign(h.ctx.sessionManager, { getEntries: () => entries, getBranch: () => entries, getSessionName: () => "example session" });
  h.ctx.getContextUsage = () => ({ tokens: 91_000, contextWindow: 200_000, percent: 45.5 });
  h.pi.getActiveTools = () => ["bash", "edit", "find", "grep", "ls", "read", "todo", "write", "subagent", "web_search"];
  h.pi.getAllTools = () => Array.from({ length: 14 }, (_, i) => ({ name: `tool-${i}` }));
  h.store.saveText("composer", "", "Measure the sidebar render cost at 65 rows\nthen compare with the baseline");
  h.store.saveText("note", "", "Measure each case at two terminal sizes\nCompare every result with the baseline");
  for (let i = 0; i < 3; i++) h.store.queueDraft();
  const renderer = h.renderer();
  renderer.terminal.columns = WIDTH; renderer.terminal.rows = rows;
  renderer.terminal.write = () => {};
  if (fullscreen) renderer.altScreenActive = true;
  // A long, coloured transcript so compositing works on realistic lines.
  Object.assign(h.parts.chat, { rows: 400, line: (i) => `\x1b[38;5;${i % 200}m${`transcript line ${i} `.repeat(12)}\x1b[39m`,
    render(width) { return Array.from({ length: this.rows }, (_, i) => this.line(i).slice(0, width + 20)); } });
  await h.emit("session_start"); await tick(); await tick();
  await h.command("promptr", `width ${SIDEBAR}`);
  const fire = (name, payload = {}) => { for (const fn of [...(h.events.get(name) ?? [])]) fn({ type: name, ...payload }, h.ctx); };
  fire("agent_start");
  for (const [id, toolName, args] of [["t1", "read", { path: "src/sidebar/controller.mts" }], ["t2", "bash", { command: "npm test" }],
    ["t3", "grep", { pattern: "requestRender", path: "src" }]]) {
    fire("tool_execution_start", { toolCallId: id, toolName, args });
    fire("tool_execution_end", { toolCallId: id, toolName, result: {}, isError: false });
  }
  fire("agent_settled");
  for (let i = 0; i < 5; i++) await tick();
  return { h, renderer, fire };
}

const time = (fn) => {
  for (let i = 0; i < Math.min(50, renders); i++) fn(i);
  const start = process.hrtime.bigint();
  for (let i = 0; i < renders; i++) fn(i);
  return Number(process.hrtime.bigint() - start) / 1e6 / renders;
};

const rows = [];
for (const height of [32, 65]) {
  const regular = await session(false, height);
  const sidebar = regular.h.sidebar();
  if (!sidebar) throw new Error("sidebar did not mount");
  const size = `${height}x${WIDTH}`;
  const sidebarRows = sidebar.render(SIDEBAR).length;
  if (process.env.BENCH_SHOW) process.stdout.write(`${sidebar.render(SIDEBAR).join("\n")}\n`);
  rows.push([size, "component idle", time(() => sidebar.render(SIDEBAR)), sidebarRows]);
  regular.fire("agent_start"); regular.fire("before_provider_request");
  let text = "";
  rows.push([size, "component stream", time(() => {
    text += "token ";
    regular.fire("message_update", { message: { role: "assistant", content: [{ type: "text", text }] } });
    sidebar.render(SIDEBAR);
  }), sidebarRows]);
  regular.fire("agent_settled");
  rows.push([size, "component cold", time((i) => sidebar.render(SIDEBAR + (i % 2))), sidebarRows]);
  rows.push([size, "frame regular", time(() => regular.renderer.doRender()), sidebarRows]);
  await regular.h.emit("session_shutdown");
  const full = await session(true, height);
  rows.push([size, "frame fullscreen", time(() => full.renderer.doRender()), sidebarRows]);
  await full.h.emit("session_shutdown");
}
for (const fn of afters.reverse()) await fn();

process.stdout.write(`Promptr sidebar render benchmark: ${renders} renders each, sidebar width ${SIDEBAR}, Node ${process.version}\n`);
process.stdout.write(`${"terminal".padEnd(9)} ${"case".padEnd(17)} ${"ms/render".padStart(9)}  sidebar rows\n`);
for (const [size, name, ms, sidebarRows] of rows)
  process.stdout.write(`${size.padEnd(9)} ${name.padEnd(17)} ${ms.toFixed(4).padStart(9)}  ${sidebarRows}\n`);
process.exit(0);
