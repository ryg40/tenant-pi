import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { MemoryTracker, vikingCounters, wikiModel, wikiStatus } from "../extensions/ops-footer/memory.ts";
import { okknowState } from "../extensions/ops-footer/okknow.ts";
import { memoryGroups } from "../extensions/ops-footer/view.ts";
import { ansiPaint, plainPaint } from "../extensions/ops-footer/paint.ts";
import { dashboardSections, detailedReport } from "../extensions/ops-footer/render.ts";
import { defaults } from "../extensions/ops-footer/settings.ts";
import { contextStub, healthy, NOW } from "./footer-fixtures.ts";

const ovStatus = "OV \u2713 \u00b7 \u21a93 \u00b7 ctx 2 \u00b7 ~900/8000 \u00b7 PRIVATE-SESSION";
const modelStatus = "\u{1f9e0} wiki model: codex-auto/gpt-6-luna";
const wikiActive = "\u{1f9e0} LLM Wiki (13 tools, observe + recall active)";
const statuses = () => new Map([["openviking", ovStatus], ["llm-wiki-model", modelStatus], ["llm-wiki", wikiActive]]);

function fixture() {
  const data = healthy();
  data.memory = new MemoryTracker().snapshot(statuses(), []);
  return data;
}

test("memory adapters accept known status fields without copying arbitrary suffixes", () => {
  assert.deepEqual(vikingCounters(ovStatus), { added: 3, pendingTokens: 900, threshold: 8000 });
  assert.deepEqual(vikingCounters("OV \u2713 \u00b7 \u21a94 \u00b7 \u270e 16000 \u00b7 PRIVATE"), { added: 4, pendingTokens: undefined, threshold: 16000 });
  assert.deepEqual(vikingCounters("OV \u2713 secret=42"), {});
  assert.deepEqual(vikingCounters("OV \u2713 \u00b7 \u21a99999999999999999"), {});
  assert.deepEqual(wikiModel(modelStatus), { model: "codex-auto/gpt-6-luna" });
  assert.deepEqual(wikiModel("\x1b[32m" + modelStatus + "\x1b[0m"), { model: "codex-auto/gpt-6-luna" });
  assert.deepEqual(wikiModel("\u{1f9e0} wiki model: session model (old-model)"), { sessionModel: true });
  assert.deepEqual(wikiModel("\u{1f9e0} wiki model: session model (claude-opus-4-5[1m])"), { sessionModel: true });
  assert.deepEqual(wikiModel("\u{1f9e0} wiki model: vertex/model@20260101"), { model: "vertex/model@20260101" });
  for (const value of ["Bearer SECRET", "\u{1f9e0} wiki model: https://private/secret", "\u{1f9e0} wiki model: sk-secret", "\u{1f9e0} wiki model: model\x1b[2J", "session model"]) {
    assert.ok(!wikiModel(value).model);
  }
  assert.deepEqual(wikiStatus(wikiActive), { state: "ok" });
  assert.deepEqual(wikiStatus("\u{1f9e0} LLM Wiki \u2014 recalled 3 pages for this task"), { state: "ok", recalled: 3 });
  assert.deepEqual(wikiStatus("\u{1f9e0} Wiki setup blocked: SECRET"), { state: "error" });
  assert.deepEqual(wikiStatus("arbitrary status"), { state: "unknown" });
  assert.ok(!JSON.stringify(new MemoryTracker().snapshot(statuses(), [])).includes("PRIVATE"));
});

test("activity handles concurrent calls and manual advice without claiming background completion", () => {
  const tracker = new MemoryTracker();
  assert.deepEqual(tracker.snapshot(new Map(), []), {});
  tracker.start("a", "viking_search"); tracker.start("b", "viking_read");
  assert.deepEqual(tracker.snapshot(statuses(), []).ov?.running, ["search", "read"]);
  tracker.end("b", "viking_read", true);
  assert.deepEqual(tracker.snapshot(statuses(), []).ov?.running, ["search"]);
  assert.equal(tracker.snapshot(statuses(), []).ov?.failed, true);
  tracker.end("a", "viking_search", false);
  assert.equal(tracker.snapshot(statuses(), []).ov?.last, "search");
  assert.equal(tracker.snapshot(statuses(), []).ov?.failed, false);
  tracker.end("c", "edit", false);
  assert.equal(tracker.snapshot(statuses(), []).wiki?.suggestCapture, true);
  tracker.start("d", "wiki_retro"); tracker.end("d", "wiki_retro", false, { details: { error: "blocked" } });
  assert.equal(tracker.snapshot(statuses(), []).wiki?.suggestCapture, true);
  assert.equal(tracker.snapshot(statuses(), []).wiki?.failed, true);
  tracker.start("e", "wiki_retro"); tracker.end("e", "wiki_retro", false);
  assert.equal(tracker.snapshot(statuses(), []).wiki?.suggestCapture, false);
  tracker.end("f", "write", true);
  assert.equal(tracker.snapshot(statuses(), []).wiki?.suggestCapture, false);
  tracker.reminder(); assert.equal(tracker.snapshot(statuses(), []).wiki?.suggestCapture, true);
  tracker.start("unfinished", "viking_search"); tracker.settle();
  assert.deepEqual(tracker.snapshot(statuses(), []).ov?.running, []);
  tracker.start("skill", "wiki_recall_skill");
  assert.deepEqual(tracker.snapshot(statuses(), []).wiki?.running, ["recall skill"]);
  tracker.reset(); assert.deepEqual(tracker.snapshot(new Map(), []), {});
});

test("memory stack stays right-aligned below costs beside quota accounts", () => {
  const data = fixture(); data.memory!.wiki!.suggestCapture = true;
  const sections = dashboardSections(data, contextStub(), defaults, 160, plainPaint, NOW);
  assert.match(sections.below[0], /\$/);
  assert.match(sections.below[1], /^Codex1 .+OpenViking .*connected/);
  assert.match(sections.below[2], /^Codex2 .+LLM Wiki .*luna.*suggest wiki_retro/);
  assert.equal(visibleWidth(sections.below[1]), 160);
  assert.equal(visibleWidth(sections.below[2]), 160);
  assert.equal(sections.above.length + sections.below.length, 5);
  const report = detailedReport(data, contextStub(), NOW);
  assert.match(report, /codex-auto\/gpt-6-luna/);
  assert.match(report, /suggest wiki_retro/);
  assert.ok(!report.includes("PRIVATE"));
});

test("memory rows stay visible without quotas and distinguish unknown, stale and failed connectivity", () => {
  const data = fixture(); data.limits = undefined;
  let rows = dashboardSections(data, contextStub(), defaults, 120, plainPaint, NOW).below;
  assert.match(rows[1], /^ +OpenViking .*connected/); assert.match(rows[2], /^ +LLM Wiki/);
  data.integrations = [];
  rows = dashboardSections(data, contextStub(), defaults, 120, plainPaint, NOW).below;
  assert.match(rows[1], /OpenViking.*unknown/);
  data.integrations = [{ source: "OV", state: "ok", summary: "ok", checkedAt: NOW - 120000, staleAfter: 60000 }];
  assert.match(dashboardSections(data, contextStub(), defaults, 120, plainPaint, NOW).below[1], /stale/);
  data.integrations[0].state = "error";
  data.memory!.ov!.running = ["search"];
  assert.match(dashboardSections(data, contextStub(), defaults, 160, plainPaint, NOW).below[1], /unavailable.*search running/);
});

test("memory rows fit every width, row budget and color mode", () => {
  const data = fixture(); data.memory!.wiki!.suggestCapture = true;
  data.memory!.ov!.running = ["search", "read"];
  for (const paint of [plainPaint, ansiPaint]) for (let width = 1; width <= 210; width++) for (const maximumRows of [3, 4, 6, 12]) {
    const sections = dashboardSections(data, contextStub(), { ...defaults, maximumRows }, width, paint, NOW);
    const rows = [...sections.above, ...sections.below];
    assert.ok(rows.length <= maximumRows);
    for (const row of rows) assert.ok(visibleWidth(row) <= width, `${width}: ${row}`);
  }
  const narrow = dashboardSections(data, contextStub(), defaults, 80, plainPaint, NOW).below.join("\n");
  assert.match(narrow, /OpenViking|OV/); assert.match(narrow, /LLM Wiki.*luna.*wiki_retro/);
  assert.match(dashboardSections(data, contextStub(), { ...defaults, maximumRows: 6 }, 90, plainPaint, NOW).above[0], /\/ops-footer report/);
  const tight = dashboardSections(data, contextStub(), { ...defaults, maximumRows: 3 }, 120, plainPaint, NOW);
  assert.match(tight.above[0], /\/ops-footer report/);
});

test("published wiki details keep known health", () => {
  const data = fixture();
  data.integrations = [{ source: "OV", state: "error", summary: "error", checkedAt: NOW, staleAfter: 60000 },
    { source: "Wiki", state: "unknown", summary: "unknown", index: "building", checkedAt: NOW, staleAfter: 60000 }];
  assert.match(detailedReport(data, contextStub(), NOW), /LLM Wiki.*active.*index building/);
});
test("session wiki models follow model selection and absent labels stay unknown", () => {
  const data = fixture();
  data.memory!.wiki!.model = undefined; data.memory!.wiki!.sessionModel = true;
  data.session.model = "new-model";
  assert.match(detailedReport(data, contextStub(), NOW), /LLM Wiki.*new-model/);
  data.memory!.wiki!.sessionModel = false;
  assert.match(detailedReport(data, contextStub(), NOW), /model unknown/);
  const rows = dashboardSections(data, contextStub(), defaults, 140, ansiPaint, NOW).below;
  assert.ok(rows.every(row => !stripVTControlCharacters(row).includes("PRIVATE")));
});

test("okknow doctor states map to the OpenKnowledge row; no origin gives no row; okknow MCP calls mark activity", () => {
  const okRow = (tracker: MemoryTracker, state?: ReturnType<typeof okknowState>) =>
    memoryGroups({ ...healthy(), memory: tracker.snapshot(new Map(), [], state) }, NOW).find(g => g.key.startsWith("memory:ok:"));
  assert.equal(okknowState(4, ""), undefined);
  assert.equal(okknowState(1, JSON.stringify({ state: "not-configured" })), undefined);
  assert.equal(okRow(new MemoryTracker(), undefined), undefined);
  const cases: [string, number, string, boolean][] = [["connected", 0, "accent", false], ["no-credentials", 1, "warning", true],
    ["unreachable", 1, "error", true], ["auth-failed", 1, "error", true], ["other", 1, "error", true]];
  for (const [word, code, kind, alert] of cases) {
    // The check details can name the origin; the row keeps only the state word.
    const row = okRow(new MemoryTracker(), okknowState(code, JSON.stringify({ state: word, checks: [{ detail: "https://ok.example.com" }] })));
    assert.equal(row?.kind, kind, word); assert.equal(row?.alert, alert, word);
    assert.ok(!row!.text.includes("example.com"));
  }
  assert.equal(okknowState(0, "not json"), "error");
  const tracker = new MemoryTracker();
  tracker.start("a", "mcp", { tool: "okknow_search", args: {} }); tracker.start("b", "okknow_exec");
  assert.deepEqual(tracker.snapshot(new Map(), []).ok?.running, ["search", "exec"]);
  tracker.end("a", "mcp", false); tracker.end("b", "okknow_exec", false);
  assert.equal(tracker.snapshot(new Map(), [], "connected").ok?.last, "exec");
});
