import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { mkdtemp, rm, writeFile, readFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createCodexStatus } from "../extensions/codex-accounts/status.ts";
import { anthropicStatus, codexStatus, copilotStatus, freshness, HealthAdapter, integrationStatus, publicStatuses, safeText, unknown } from "../extensions/ops-footer/adapters.ts";
import { collectSession } from "../extensions/ops-footer/collector.ts";
import { GitAdapter, parseStatus, parseWorktrees } from "../extensions/ops-footer/git.ts";
import { ansiPaint, plainPaint, themePaint } from "../extensions/ops-footer/paint.ts";
import { ALERT_DECAY_MS, dashboardRows, dashboardSections, detailedReport, FooterRenderer } from "../extensions/ops-footer/render.ts";
import { defaultLayout, layoutNames, layouts } from "../extensions/ops-footer/layouts/index.ts";
import { installOpsFooter, quotaLifetimeFloor } from "../extensions/ops-footer/runtime.ts";
import { defaults, ensureSettings, healthUrl, loadLocalSettings, loadSettings, parseSettings, saveSettings, type Settings } from "../extensions/ops-footer/settings.ts";
import { ANTHROPIC_STATUS, CODEX_REFRESH, CODEX_STATUS, COPILOT_STATUS, INTEGRATION_STATUS, OWNERSHIP, OWNERSHIP_QUERY, type ContextService, type DashboardSnapshot, type GitSnapshot } from "../extensions/ops-footer/types.ts";
import { cwdLabel, formatRelative, formatWhen, gitFacts, serviceGroups } from "../extensions/ops-footer/view.ts";
import { quotaChip } from "../extensions/ops-footer/widgets.ts";
import { contextStub, contextUnknown, fixtures, healthy, HOUR, integration, limits, NOW } from "./footer-fixtures.ts";

const widths = [8, 12, 20, 30, 40, 50, 80, 120, 138, 160, 200];
const settings = { ...defaults, healthUrls: {} };
const plain = (rows: string[]) => rows.map(stripTerminalSequences);
const render = (data: DashboardSnapshot, context: ContextService, width: number, paint = plainPaint, extra: Partial<typeof settings> = {}) =>
  dashboardRows(data, context, { ...settings, ...extra }, width, paint, NOW);
/** Layout v2, for assertions about its row positions. */
const v2 = (data: DashboardSnapshot, context: ContextService, width: number, paint = plainPaint, extra: Partial<typeof settings> = {}) =>
  layouts.v2(data, context, { ...settings, ...extra }, width, paint, NOW).below;
/** v3 shows the location row above the bar from 40 columns up. */
const barIndex = (width: number) => width >= 40 ? 1 : 0;

test("every fixture stays inside every width with color on and off, and never wraps", () => {
  for (const fixture of fixtures) for (const paint of [plainPaint, ansiPaint]) for (const width of widths) {
    const rows = render(fixture.data, fixture.context, width, paint);
    assert.ok(rows.length >= 1 && rows.length <= settings.maximumRows, `${fixture.name} ${width}: ${rows.length} rows`);
    assert.equal(visibleWidth(rows[barIndex(width)]), width, `${fixture.name} ${width}: bar is full width`);
    for (const line of rows) {
      assert.ok(visibleWidth(line) <= width, `${fixture.name} ${width} ${paint.color}: ${JSON.stringify(line)}`);
      assert.ok(!line.includes("\n"));
    }
  }
  for (const [name, layout] of Object.entries(layouts)) for (const fixture of fixtures) for (const paint of [plainPaint, ansiPaint]) for (const width of widths) {
    const { above, below } = layout(fixture.data, fixture.context, settings, width, paint, NOW);
    const rows = [...above, ...below];
    assert.ok(rows.length >= 1 && rows.length <= settings.maximumRows, `${name} ${fixture.name} ${width}: ${rows.length} rows`);
    assert.ok(rows.some(row => visibleWidth(row) === width), `${name} ${fixture.name} ${width}: the bar is full width`);
    for (const line of rows) {
      assert.ok(visibleWidth(line) <= width, `${name} ${fixture.name} ${width} ${paint.color}: ${JSON.stringify(line)}`);
      assert.ok(!line.includes("\n"));
    }
  }
});
test("layout v4 is the default name and puts every row below the editor: model, directory, bar, Codex1, Codex2", () => {
  assert.deepEqual(layoutNames, ["v4", "v3", "v2", "a", "b", "c"]); assert.equal(defaultLayout, "v4");
  const { above, below } = layouts.v4(healthy(), contextStub(), settings, 138, plainPaint, NOW);
  assert.deepEqual(above, [], "no row above the editor");
  assert.equal(below.length, 5);
  assert.match(below[0], /^openai-codex\/gpt-5\.6-sol · high\s+↑72\.5k ↓5\.8k R228k \$0\.478$/, "model identity and thinking left, usage and costs right");
  assert.match(below[1], /^tenantext main · pwd \/home\/dev\/tenantext\s+idle · 27m$/, "directory left, agent facts right");
  assert.match(below[2], /72\.5k\/272k 27%$/); assert.equal(visibleWidth(below[2]), 138, "the bar is full width");
  assert.match(below[3], /^Codex1 \[5h 80%\]/); assert.match(below[4], /^Codex2 \[5h 60%\].*  ◂ routed$/);
});
test("layout v4 holds the rows of v3 with the same text at every width, row budget and paint; only the order and the place change", () => {
  for (const fixture of fixtures) for (const paint of [plainPaint, ansiPaint]) for (const width of widths) for (const maximumRows of [3, 4, 6, 8]) {
    const own = { ...settings, maximumRows };
    const v3 = layouts.v3(fixture.data, fixture.context, own, width, paint, NOW), v4 = layouts.v4(fixture.data, fixture.context, own, width, paint, NOW);
    assert.deepEqual(v4.above, [], `${fixture.name} ${width}`);
    // v3: [directory, bar] + [model, rest]. v4: [model, directory, bar, rest]. Narrow: [bar] + [compact] gives [compact, bar].
    assert.deepEqual(v4.below, [...v3.below.slice(0, 1), ...v3.above, ...v3.below.slice(1)], `${fixture.name} ${width} ${maximumRows} ${paint.color}`);
  }
  // minimumRows pads at the end in both layouts.
  const padded = layouts.v4(healthy(), contextStub(), { ...settings, minimumRows: 4 }, 15, plainPaint, NOW);
  assert.deepEqual([padded.above.length, padded.below.length, visibleWidth(padded.below[0]), ...padded.below.slice(1)], [0, 4, 15, "", "", ""]);
});
test("layout v4 row budget: maximumRows 3 keeps the model row, the directory row and the bar; 6 rows with five accounts show three quota rows and +2", () => {
  const five = structuredClone(fixtures.find(f => f.name === "three codex, claude, copilot")!.data);
  const rows = (maximumRows: number) => layouts.v4(five, contextStub(), { ...settings, maximumRows }, 160, plainPaint, NOW).below;
  const three = rows(3);
  assert.equal(three.length, 3);
  assert.match(three[0], /^openai-codex\/gpt-5\.6-sol/); assert.match(three[1], /^tenantext main/); assert.equal(visibleWidth(three[2]), 160);
  const six = rows(6);
  assert.equal(six.length, 6);
  assert.deepEqual(six.slice(3).map(r => r.split(" ")[0]), ["Codex1", "Codex2", "Claude"]);
  assert.match(six[5], /  \+2$/); assert.doesNotMatch(six.slice(0, 5).join("\n"), /\+\d/);
  assert.deepEqual(six.slice(3), layouts.v3(five, contextStub(), { ...settings, maximumRows: 6 }, 160, plainPaint, NOW).below.slice(1), "as in v3");
});
test("layout v4 narrow terminals: width 30 gives the compact row then the bar; width 15 gives the bar only", () => {
  const at = (width: number) => layouts.v4(healthy(), contextStub(), settings, width, plainPaint, NOW);
  const narrow = at(30);
  assert.deepEqual(narrow.above, []); assert.equal(narrow.below.length, 2);
  assert.match(narrow.below[0], /^main · idle$/, "the compact row"); assert.equal(visibleWidth(narrow.below[1]), 30, "then the bar");
  assert.match(narrow.below[1], /27%$/);
  const tiny = at(15);
  assert.deepEqual(tiny.above, []); assert.equal(tiny.below.length, 1); assert.equal(visibleWidth(tiny.below[0]), 15); assert.match(tiny.below[0], /27%$/);
});
test("healthy state: directory and bar above the editor, then model and quota rows below it", () => {
  for (const width of [80, 120, 138, 160, 200]) {
    const rows = render(healthy(), contextStub(), width);
    assert.equal(rows.length, 5, `${width}`);
    const { above, below } = dashboardSections(healthy(), contextStub(), settings, width, plainPaint, NOW);
    assert.deepEqual([above.length, below.length], [2, 3], `${width}: two rows above the editor, three below`);
    const text = rows.join("\n");
    for (const noise of ["-----", "!1", "WARN", "PLAN", "CRIT", "ticks", "prompts:none", "TOOLS", "statuses:", "+0", "ahead:0", "host:", "session:", "QUEUE", "OV ok", "OK ok", "STE", "worktrees:1", "route:"]) {
      assert.ok(!text.includes(noise), `${width}: contains ${noise}`);
    }
    assert.ok(!/\|.*\|/.test(text), "no pipe ruler");
    assert.equal(text.split("/home/dev/tenantext").length - 1, 1, "the start path appears once");
    assert.match(rows[0], /^tenantext main · pwd \/home\/dev\/tenantext\s+idle · 27m$/, "directory left, original agent facts right");
    assert.match(rows[1], /72\.5k\/272k 27%$/);
    assert.match(rows[2], /^openai-codex\/gpt-5\.6-sol · high/);
    assert.match(rows[3], /^Codex1 \[5h 80%\] ↺ 2h 47m +\[7d 80%\]/);
    assert.equal(rows[3].indexOf("[7d"), rows[4].indexOf("[7d"), "second chips line up in a column");
    assert.ok(!rows[3].includes("Codex2") && !rows[3].includes("→"), "one account per row; the route sits on the last quota row");
    assert.match(rows[4], /^Codex2 \[5h 60%\] ↺ 35m +\[7d 60%\].*  ◂ routed$/, "the routed account's row carries the route mark");
    if (width >= 120) assert.match(rows[2], /↑72\.5k ↓5\.8k R228k \$0\.478$/, "usage right-aligned at 120 columns or more");
    else assert.ok(!rows[2].includes("↑"), "no usage below 120 columns");
    const rowsV2 = v2(healthy(), contextStub(), width);
    assert.equal(rowsV2.length, 3);
    assert.match(rowsV2[1], /^tenantext main\s+.*gpt-5\.6-sol · (high · )?idle · 27m$/);
    assert.match(rowsV2[2], /^Codex1 .*Codex2 .*→ codex2$/);
  }
  const wide = v2(healthy(), contextStub(), 138);
  assert.match(wide[1], /↑72\.5k ↓5\.8k R228k \$0\.478  openai-codex\/gpt-5\.6-sol · high · idle · 27m$/);
  const medium = render(healthy(), contextStub(), 100);
  assert.ok(!medium[2].includes("↑") && !medium[2].includes("openai-codex/") === false, "80–119 drops usage but keeps the provider prefix");
  assert.match(render(healthy(), contextStub(), 79)[2], /^gpt-5\.6-sol · high/, "below 80 the model stands alone");
});
test("v3: model below editor, inline alerts only, percent chips, five healthy rows at 138", () => {
  for (const fixture of fixtures) for (const width of [40, 50, 80, 120, 138, 160, 200]) {
    const rows = plain(render(fixture.data, fixture.context, width));
    const { provider, model } = fixture.data.session;
    assert.ok(rows[2].startsWith(width >= 80 ? `${provider}/${model} · high` : `${model} · high`), `${fixture.name} ${width}: row below editor starts with the model`);
    for (const row of rows) assert.ok(!/^(⚠|✗|⌨|⛔|⏳)? ?(QUOTA|INPUT|MODEL|BLOCKED|PROMPTS|ERROR|ROUTE|GIT|FOOTER)\b/.test(row), `${fixture.name} ${width}: no alert word at a row start: ${row}`);
    if (width >= 80) for (const chip of rows.join("\n").match(/\[[^\]]*\]/g) ?? []) assert.ok(chip.includes("%") || chip.includes("n/a"), `${fixture.name} ${width}: chip ${chip} carries its percent`);
  }
  assert.equal(render(healthy(), contextStub(), 138).length, 5);
  const color = render(healthy(), contextStub(), 138, ansiPaint);
  assert.ok(color[2].startsWith("\x1b[38;2;150;162;180mopenai-codex/\x1b[39m\x1b[38;2;205;214;228mgpt-5.6-sol"), "provider muted, model in text weight");
  assert.ok(color[2].includes("\x1b[1m\x1b[38;2;255;196;96mhigh"), "high thinking is bold warning");
  const medium = healthy(); medium.session.thinking = "medium";
  assert.ok(render(medium, contextStub(), 138, ansiPaint)[2].includes("\x1b[1m\x1b[38;2;138;180;255mmedium"), "other levels are bold accent");
  const off = healthy(); off.session.thinking = "off";
  assert.match(render(off, contextStub(), 138)[2], /^openai-codex\/gpt-5\.6-sol\s+↑/);
  for (const [width, rows] of [[138, 5], [120, 5], [80, 5], [40, 5], [30, 2], [12, 1]] as const) assert.equal(render(healthy(), contextStub(), width).length, rows, `${width}`);
  const failed = healthy(); failed.integrations = [integration("OV", { state: "error" })];
  assert.match(render(failed, contextStub(), 138).at(-1)!, /^OV ✗ unavailable$/, "services take the last row only when present");
});
test("swapped left groups retain right-side positions and protect Git alerts from long metadata", () => {
  const data = healthy();
  const section = dashboardSections(data, contextStub(), settings, 160, plainPaint, NOW);
  assert.match(section.above[0], /^tenantext.*idle · 27m$/);
  assert.match(section.below[0], /^openai-codex\/gpt-5\.6-sol · high.*\$0\.478$/);
  assert.equal(visibleWidth(section.above[0]), 160);
  assert.equal(visibleWidth(section.below[0]), 160);
  data.session.remote = true; data.session.hostname = "a-very-long-remote-hostname";
  data.session.session = "a-long-session-name-for-footer-review";
  data.session.cwd = "/home/dev/tenantext/sub";
  Object.assign(data.git, { state: "error", summary: "timeout", staged: 2, unstaged: 4, untracked: 1, ahead: 3, behind: 2 });
  for (const width of [80, 100, 140]) {
    const top = render(data, contextStub(), width)[0];
    assert.match(top, /git ✗ timeout/, `${width}: Git failure survives`);
    assert.match(top, /cwd \.\/sub/, `${width}: changed directory survives`);
    if (width >= 140) assert.match(top, /7 changed|2 staged/, "changes precede dim host/session metadata");
  }
});
test("context stage words and system warning live inside the bar", () => {
  assert.match(render(healthy(), contextStub({ used: 168_000 }), 120)[1], /PLAN 168k\/272k 62%$/);
  assert.match(render(healthy(), contextStub({ used: 212_000 }), 120)[1], /WARN 212k\/272k 78%$/);
  assert.match(render(healthy(), contextStub({ used: 248_000 }), 200)[1], /CRIT 248k\/272k 91%$/);
  assert.match(render(healthy(), contextStub({ used: 248_000 }), 120)[1], /▓CRIT 91%$|·CRIT 91%$/, "totals yield to the stage word when the free block is small");
  const sys = render(healthy(), contextStub({ system: 20_800 }), 160)[1];
  assert.match(sys, /sys!/); assert.match(sys, /· sys 20\.8k!$/);
  assert.ok(!render(healthy(), contextStub(), 160)[1].includes("sys!"));
  const color = render(healthy(), contextStub({ used: 212_000 }), 120, ansiPaint)[1];
  assert.ok(color.includes("\x1b[48;2;88;70;44m"), "free block tints toward the warning hue (band 2 above the 75% marker)");
  assert.ok(!color.includes("\x1b[48;2;27;33;46m"), "no plain slate free block while WARN");
  assert.match(stripTerminalSequences(render(healthy(), contextUnknown(), 120)[1]), /context unknown/);
  const broken: ContextService = { ...contextStub(), state: () => { throw new Error("secret"); } };
  assert.match(plain(render(healthy(), broken, 80)).join("\n"), /context error/);
});
test("threshold markers sit at their columns and stay visible inside used segments", () => {
  const low = [...stripTerminalSequences(render(healthy(), contextStub({ used: 27_200 }), 200)[1])];
  assert.deepEqual([120, 150, 180].map(c => low[c]), ["│", "│", "│"]);
  assert.equal(low.filter(c => c === "│").length, 3);
  const high = [...stripTerminalSequences(render(healthy(), contextStub({ used: 217_600 }), 200)[1])];
  assert.equal(high[120], "│"); assert.equal(high[150], "│");
  assert.equal(high[119], "▓"); assert.equal(high[151], "▓");
  const color = render(healthy(), contextStub({ used: 217_600 }), 200, ansiPaint)[1];
  assert.equal((color.match(/▏/g) ?? []).length, 3);
  assert.match(color, /48;2;202;182;146m\x1b\[38;2;12;20;30m[^\x1b]*▏/, "markers inside the tools block use a dark glyph on the block color");
});
test("bar texture: lighter left edge per used block and stippled bands, invisible without color", () => {
  const color = render(healthy(), contextStub(), 200, ansiPaint)[1];
  assert.ok(color.includes("\x1b[48;2;228;208;172m"), "the tools block starts with a lighter edge cell");
  assert.ok(color.includes("\x1b[48;2;202;182;146m"), "then the block color");
  assert.ok(color.includes("\x1b[48;2;35;41;54m") && color.includes("\x1b[48;2;40;46;59m"), "band 1 alternates its base and a faint step");
  assert.ok(!color.includes("▓") && !color.includes("·"));
  const plainBar = render(healthy(), contextStub(), 200)[1];
  assert.equal(visibleWidth(plainBar), 200); assert.equal(visibleWidth(color), 200);
  const columns = (bar: string, glyph: string) => [...stripTerminalSequences(bar)].flatMap((c, i) => c === glyph ? [i] : []);
  assert.deepEqual(columns(color, "▏"), columns(plainBar, "│"), "marker columns match between color and plain");
  assert.match(plainBar, /^▓sys▓/); assert.match(stripTerminalSequences(color), /72\.5k\/272k 27%$/);
});
test("narrow widths keep the bar, branch, state, and alert glyphs", () => {
  const data = healthy(); data.session.state = "waiting";
  data.integrations.push(integration("work", { prompts: 2 }));
  assert.deepEqual(plain(render(data, contextStub(), 30)), ["▓▓▓▓tl▓▓···free···│···│····27%", "main · ⌨ input needed ⏳"]);
  assert.equal(render(healthy(), contextStub(), 12).length, 1);
  assert.match(render(healthy(), contextStub(), 12)[0], /27%$/);
  assert.deepEqual(render(healthy(), contextStub(), 0), []);
  const budget = render(healthy(), contextStub(), 40, plainPaint, { maximumRows: 4 });
  assert.equal(budget.length, 4, "model row, bar, location, first quota row");
  assert.equal(v2(healthy(), contextStub(), 40, plainPaint, { maximumRows: 4 }).length, 3);
});
test("the directory name leads the location row in bold; branch, worktrees, and path recede", () => {
  const data = healthy(); data.git.worktrees = 8;
  const row = render(data, contextStub(), 160, ansiPaint)[0];
  assert.ok(row.startsWith("\x1b[1m\x1b[38;2;205;214;228mtenantext"), "the name is bold text weight");
  assert.ok(row.includes("\x1b[38;2;104;114;130mmain") && row.includes("\x1b[38;2;104;114;130m8 worktrees"), "branch and worktrees are dim");
  const bare = healthy(); bare.git = { ...unknown(), repo: undefined };
  assert.ok(render(bare, contextStub(), 160, ansiPaint)[0].includes("\x1b[1m\x1b[38;2;205;214;228m/home/dev/tenantext"), "without Git the path leads");
});
test("Git facts use words, hide zeros, and show the cwd and worktrees only when they matter", () => {
  const data = healthy();
  assert.deepEqual(gitFacts(data.git), []);
  Object.assign(data.git, { staged: 2, unstaged: 4, untracked: 1, ahead: 3, behind: 2, worktrees: 3 });
  assert.match(render(data, contextStub(), 160)[0], /^tenantext main · 2 staged · 4 modified · 1 untracked · ahead 3 · behind 2 · 3 worktrees · pwd \/home\/dev\/tenantext/);
  assert.match(render(data, contextStub(), 40)[0], /pwd \/home\/dev\/tenantext/);
  assert.match(v2(data, contextStub(), 40)[1], /^main · 7 changed/);
  const color = render(data, contextStub(), 160, ansiPaint)[0];
  assert.ok(color.includes("\x1b[38;2;138;180;255m2 staged"), "changes paint accent");
  assert.equal(cwdLabel("/home/dev/tenantext", "/home/dev/tenantext", "/home/dev/tenantext"), undefined);
  assert.equal(cwdLabel("/home/dev/tenantext/extensions", "/home/dev/tenantext", "/home/dev/tenantext"), "cwd ./extensions");
  assert.equal(cwdLabel("/home/u/x", "/opt", undefined, "/home/u"), "cwd ~/x");
  data.session.cwd = "/home/dev/tenantext/extensions/ops-footer";
  const row = render(data, contextStub(), 200)[0];
  assert.match(row, /cwd \.\/extensions\/ops-footer/);
  assert.equal(row.split("/home/dev/tenantext").length - 1, 1);
  data.git = { state: "error", summary: "timeout", checkedAt: 1, staleAfter: 1 };
  assert.match(render(data, contextStub(), 120)[0], /git ✗ timeout/);
  const home = healthy(); home.session.remote = true; home.session.session = "review";
  assert.match(render(home, contextStub(), 200)[0], /idle · 27m · review · @devbox$/);
  assert.match(v2(home, contextStub(), 200)[1], /idle · 27m · review · @devbox$/);
});
test("top row shows the opening directory without Git and the current directory after moving", () => {
  const data = healthy();
  data.git = unknown("not-repo");
  data.session.startedIn = "/tmp/notes"; data.session.cwd = "/tmp/notes";
  const initial = render(data, contextStub(), 120);
  assert.equal(initial[0].split(/  +/)[0].trim(), "pwd /tmp/notes");
  assert.match(initial[3], /^Codex1 /, "quotas remain on row four without a repository");
  data.session.cwd = "/tmp/other";
  assert.match(render(data, contextStub(), 120)[0], /^pwd \/tmp\/notes · cwd \/tmp\/other/);
  data.limits = undefined;
  assert.equal(render(data, contextStub(), 120).length, 3, "no empty quota row without a quota source");
  const narrow = render(data, contextStub(), 40)[0];
  assert.match(narrow, /^pwd \/tmp\/notes · cwd \/tmp\/other\s+idle$/, "changed cwd precedes optional duration at narrow widths");
});
test("agent states are words with glyphs; queued shows only when pending", () => {
  const data = healthy();
  for (const [state, text] of [["working", "working"], ["compacting", "compacting"], ["waiting", "⌨ input needed"], ["failed", "✗ model error"], ["idle", "idle"]] as const) {
    data.session.state = state;
    assert.match(render(data, contextStub(), 120)[0], new RegExp(text));
    assert.match(v2(data, contextStub(), 120)[1], new RegExp(text));
  }
  data.session.state = "working"; data.session.pending = true;
  assert.match(render(data, contextStub(), 120)[0], /working · queued/);
  const color = render(data, contextStub(), 120, ansiPaint)[0];
  assert.ok(color.includes("\x1b[38;2;138;180;255mworking"));
});
test("accounts keep identity order; low quota changes styling but never order", () => {
  const snapshot = codexStatus({ checkedAt: NOW, staleAfter: 60000, accounts: [
    { provider: "openai-codex-2", label: "Codex 2", state: "ok", windows: [{ label: "5h", remainingPercent: 0, resetsAt: "2026-09-22T09:46:00Z" }, { label: "week", remainingPercent: 60 }] },
    { provider: "openai-codex", label: "Codex 1", state: "ok", windows: [{ label: "5h", remainingPercent: 99 }] },
  ], routing: { state: "ok", selectedAccount: "codex1" } }, NOW)!;
  assert.deepEqual(snapshot.accounts.map(a => a.label), ["Codex1", "Codex2"]);
  assert.equal(snapshot.state, "warning");
  const data = healthy(); data.limits = snapshot;
  const rows = render(data, contextStub(), 160);
  assert.match(rows[3], /^Codex1 \[5h 99%\]  ◂ routed$/, "the route marks Codex1, not the last row");
  assert.match(rows[4], /^Codex2 \[✗ 5h 0%\] ↺ 2h 46m +\[week 60%\]$/, "a reset under 24 hours stays relative");
  assert.match(v2(data, contextStub(), 160)[2], /Codex2 \[✗ 5h 0%\] ↺ 2h 46m · \w{3} \d{1,2}\/\d{1,2} · \d{2}:\d{2} \S+ \[week 60%\]  → codex1$/);
  const color = v2(data, contextStub(), 160, ansiPaint)[2];
  assert.ok(color.indexOf("Codex1") < color.indexOf("Codex2"));
  const chips = color.split("  ");
  assert.notEqual(chips[0].replace(/\d+%/, ""), chips[1].replace(/\d+%/, ""));
  assert.ok(color.includes("\x1b[38;2;255;122;122m ✗ 5h 0%"), "exhausted text stays bright even with no fill");
  const normal = quotaChip({ name: "5h", percent: 80, level: "normal" }, ansiPaint);
  assert.ok(normal.includes("70;118;136") && !normal.includes("196;64;64"));
  const v3color = render(data, contextStub(), 160, ansiPaint).slice(3, 5).join("\n");
  assert.ok(v3color.indexOf("Codex1") < v3color.indexOf("Codex2"));
  assert.ok(v3color.includes("\x1b[38;2;255;122;122m ✗ 5h 0%"), "exhausted text stays bright on the quota row");
  assert.equal((normal.match(/\x1b\[48;2;70;118;136m/g) ?? []).length, 1);
  assert.equal(quotaChip({ name: "5h", percent: 2, level: "exhausted" }, plainPaint), "[✗ 5h 2%]");
  assert.equal(quotaChip({ name: "7d", level: "unavailable" }, plainPaint), "[7d n/a]");
});
test("reset times are relative or friendly absolute, never ISO, in any timezone", () => {
  assert.equal(formatRelative(35 * 60_000), "35m");
  assert.equal(formatRelative(2 * HOUR + 47 * 60_000), "2h 47m");
  assert.equal(formatRelative(5 * 24 * HOUR + 7 * HOUR), "5d 7h");
  assert.equal(formatRelative(0), "<1m");
  for (const zone of [undefined, "UTC", "America/New_York", "Asia/Tokyo"]) {
    assert.match(formatWhen(NOW + 2 * HOUR, zone), /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2}\/\d{1,2} · \d{2}:\d{2} \S+$/);
  }
  assert.equal(formatWhen(Date.parse("2026-09-22T09:46:00Z"), "UTC"), "Tue 9/22 · 09:46 UTC");
  for (const fixture of fixtures) for (const width of widths) {
    const text = plain(render(fixture.data, fixture.context, width)).join("\n");
    assert.ok(!/\d{2}T\d{2}:\d{2}/.test(text) && !/\d:\d{2}Z/.test(text), `${fixture.name} ${width}: ${text}`);
  }
  const low = healthy(); low.limits!.accounts[1].windows[0].percent = 20;
  assert.match(render(low, contextStub(), 120)[4], /^Codex2 \[⚠ 5h 20%\] ↺ 35m +\[7d 60%\]/, "a low 5h window keeps a relative reset");
  const far = healthy(); far.limits!.accounts[1].windows[1].percent = 20;
  assert.match(render(far, contextStub(), 120)[4], /\[⚠ 7d 20%\] ↺ 5d 7h · \w{3} /, "a low window with a far reset adds the absolute form");
  assert.ok(!render(far, contextStub(), 60)[4].includes(" · "), "the absolute form drops first on a narrow row");
  assert.match(render(healthy(), contextStub(), 80)[3], /\[5h 80%\] ↺ 2h 47m/, "a stacked row has room for normal resets");
  const weekly = healthy(); weekly.limits!.accounts[0].windows = [{ name: "7d", percent: 81, unavailable: false, resetsAt: NOW + 4 * 24 * HOUR + 18 * HOUR }];
  assert.match(render(weekly, contextStub(), 120)[3], /^Codex1 \[7d 81%\] ↺ 4d 18h · \w{3} \d{1,2}\/\d{1,2} · \d{2}:\d{2} \S+/, "a normal window with a far reset adds the absolute form on a stacked row");
  assert.match(render(weekly, contextStub(), 40)[3], /\[7d 81%\] ↺ 4d 18h$/, "a narrow stacked row keeps the relative reset of a normal window");
  assert.ok(!v2(weekly, contextStub(), 200)[2].includes("4d 18h · "), "the one-row v2 quota keeps a normal reset relative");
  const stale = healthy(); stale.limits!.checkedAt = NOW - 10 * 60_000;
  assert.match(render(stale, contextStub(), 120)[4], /◂ routed  stale$/);
  assert.match(v2(stale, contextStub(), 120)[2], /stale$/);
  const error = healthy(); error.limits = limits({ accounts: [{ label: "Codex1", order: 1, state: "error", windows: [] }], route: { state: "error" } });
  assert.match(render(error, contextStub(), 120)[3], /^Codex1 ✗ error  route ✗$/);
  assert.match(v2(error, contextStub(), 120)[2], /^Codex1 ✗ error  route ✗$/);
  const empty = healthy(); empty.limits!.accounts[0] = { label: "Codex1", order: 1, state: "unknown", windows: [] };
  const emptyRows = render(empty, contextStub(), 120);
  assert.ok(!emptyRows.includes(""), "an account without windows or error takes no row");
  assert.match(emptyRows[3], /^Codex2 /);
  const hidden = healthy(); hidden.limits = limits({ route: { state: "unknown" } });
  assert.ok(!render(hidden, contextStub(), 120).join("\n").includes("→"));
});
test("services row shows only actionable groups and hides healthy noise by default", () => {
  assert.equal(render(healthy(), contextStub(), 160).length, 5);
  const data = healthy();
  data.integrations = [
    integration("OV", { state: "error" }), integration("OK", { checkedAt: NOW - HOUR }), integration("MCP", { active: 6, configured: 7, failed: 1, failedNames: ["example-server"] }),
    integration("work", { prompts: 2, blocked: 1, background: 1, review: true, done: 9 }), integration("Wiki", { index: "building" }),
  ];
  data.languageStatus = "STE on guard armed 2 flagged"; data.conflict = true;
  const row = render(data, contextStub(), 200)[5];
  assert.equal(row, "⛔ 1 blocked  OV ✗ unavailable  MCP 6/7 ✗ example-server  ⏳ 2 prompts  ⚠ 1 background  ⚑ REVIEW  OK ⚠ stale  STE 2 flagged  ⚠ footer conflict  Wiki index building");
  assert.ok(!row.includes("done"));
  assert.match(render(data, contextStub(), 80)[5], /^⛔ 1  OV ✗  MCP ✗  ⏳ 2/);
  assert.match(render(data, contextStub(), 50)[5], /^⛔ ✗ ✗ ⏳/);
  const groups = serviceGroups({ ...healthy(), integrations: [integration("MCP", { active: 5, configured: 7, failed: 0 })] }, settings, NOW);
  assert.deepEqual(groups.map(g => g.text), ["MCP 5/7 connecting"]);
  const shown = render(healthy(), contextStub(), 200, plainPaint, { showHealthyServices: true });
  assert.equal(shown[5], "OK ✓  OV ✓  MCP 7/7 ✓");
  const optional = healthy(); optional.integrations = [{ ...unknown(), source: "Hermes" }];
  assert.equal(render(optional, contextStub(), 200, plainPaint, { showUnavailableOptionalSources: true })[5], "Hermes · n/a");
  assert.equal(render(optional, contextStub(), 200).length, 5);
});
test("alerts decay to the muted variant after ten minutes but keep their glyph and word", () => {
  const data = healthy(); data.session.state = "waiting";
  let now = NOW, version = 1;
  const renderer = new FooterRenderer(() => data, contextStub(), () => settings, ansiPaint, () => now);
  const fresh = renderer.renderAbove(120, version)[0];
  assert.ok(fresh.includes("\x1b[38;2;255;196;96m⌨ input needed"));
  now += ALERT_DECAY_MS - 1; version++;
  assert.ok(renderer.renderAbove(120, version)[0].includes("\x1b[38;2;255;196;96m⌨ input needed"));
  now += 2; version++;
  const aged = renderer.renderAbove(120, version)[0];
  assert.ok(aged.includes("\x1b[38;2;150;162;180m⌨ input needed"), aged);
  data.session.state = "idle"; version++; renderer.renderAbove(120, version);
  data.session.state = "waiting"; version++;
  assert.ok(renderer.renderAbove(120, version)[0].includes("\x1b[38;2;255;196;96m⌨ input needed"), "a returning alert is new again");
});
test("row budget keeps model, bar, and location, prefers alert rows, and points at the report when an alert row drops", () => {
  const data = healthy();
  data.limits!.accounts[1].windows[0].percent = 2;
  data.integrations = [integration("OV", { state: "error" })];
  const rows = v2(data, contextStub(), 120, plainPaint, { maximumRows: 3 });
  assert.equal(rows.length, 3);
  assert.match(rows[1], /\/ops-footer report$/); assert.match(rows[2], /^OV ✗ unavailable$/);
  const four = v2(data, contextStub(), 120, plainPaint, { maximumRows: 4 });
  assert.equal(four.length, 4); assert.ok(!four[1].includes("report")); assert.match(four[2], /Codex2/); assert.match(four[3], /^OV/);
  const three = render(data, contextStub(), 120, plainPaint, { maximumRows: 3 });
  assert.equal(three.length, 3);
  assert.match(three[0], /\/ops-footer report$/, "v3 keeps model, bar, and directory; the hint stays on the upper row");
  assert.match(three[0], /pwd \/home\/dev\/tenantext/);
  const v3four = render(data, contextStub(), 120, plainPaint, { maximumRows: 4 });
  assert.equal(v3four.length, 4); assert.match(v3four[0], /\/ops-footer report$/);
  assert.match(v3four[3], /^Codex2 \[✗ 5h 2%\]/, "an alert row outranks the quiet Codex1 row");
  const v3five = render(data, contextStub(), 120, plainPaint, { maximumRows: 5 });
  assert.equal(v3five.length, 5); assert.ok(!v3five[0].includes("report"), "only the quiet Codex1 row drops");
  assert.match(v3five[3], /^Codex2 \[✗ 5h 2%\]/); assert.match(v3five[4], /^OV ✗ unavailable$/, "kept rows stay in display order");
  const v3six = render(data, contextStub(), 120, plainPaint, { maximumRows: 6 });
  assert.equal(v3six.length, 6); assert.ok(!v3six[0].includes("report")); assert.match(v3six[5], /^OV ✗ unavailable$/);
  const padded = render(healthy(), contextStub(), 120, plainPaint, { minimumRows: 6 });
  assert.equal(padded.length, 6); assert.equal(padded[5], "");
  assert.equal(render(healthy(), contextStub(), 120).length, 5, "minimumRows 1 never pads");
});
test("the report keeps every value the footer hides", () => {
  const data = healthy(); data.session.session = "review";
  const report = detailedReport(data, contextStub(), NOW);
  for (const text of ["TOOLS active:45", "published extension statuses:10", "host:devbox", "Session:review", "Started in:/home/dev/tenantext", "Cwd:/home/dev/tenantext",
    "current:/home/dev/tenantext", "worktrees:1", "route:codex2 (unknown)", "Codex1: ok; 5h 80% resets 2026-09-22T09:47:00.000Z", "Codex2: ok; 5h 60% resets", "MCP ok 7/7 failed:0", "QUEUE working:0 blocked:0 done:3 prompts:0", "STE on guard passed", "cache-read:228000", "reported cost:$0.478000"]) {
    assert.ok(report.includes(text), text);
  }
});
test("render cache uses state version and width, and invalidation rebuilds theme", () => {
  let color = 31, calls = 0;
  const paint = { ...ansiPaint, fg: (_: string, text: string) => `\x1b[${color}m${text}\x1b[0m` };
  const renderer = new FooterRenderer(() => { calls++; return healthy(); }, contextStub(), () => settings, paint, () => NOW);
  const one = renderer.render(80, 1);
  assert.equal(renderer.render(80, 1), one); assert.equal(calls, 1);
  renderer.render(8, 1); renderer.render(80, 2); assert.equal(calls, 3);
  color = 32; renderer.invalidate(); assert.match(renderer.render(80, 2)[0], /\x1b\[32m/);
});
test("theme paint honors NO_COLOR and tolerates themes without bold", () => {
  const theme = { fg: (kind: string, text: string) => `<${kind}>${text}</${kind}>` };
  assert.equal(themePaint(theme, true).fg("muted", "x"), "<muted>x</muted>");
  assert.equal(themePaint(theme, true).bold("x"), "x");
  assert.equal(themePaint(theme, false).fg("error", "x"), "x");
  assert.equal(themePaint(theme, false).color, false);
});
test("unavailable, stale, warning and error states remain explicit", () => {
  assert.equal(freshness(unknown()), "unknown");
  assert.equal(freshness({ ...unknown(), checkedAt: 1, staleAfter: 5 }, 10), "stale");
  const data = healthy(); data.limits = undefined; data.integrations = [{ source: "OV", state: "ok", summary: "accessible", checkedAt: 1, staleAfter: 5 }];
  const report = detailedReport(data, contextStub(), NOW);
  assert.match(report, /OV: STALE/); assert.match(report, /LIMITS unavailable/);
  data.session.pending = true;
  assert.match(detailedReport(data, contextStub(), NOW), /count unavailable/);
});
test("bus rejects invalid counts and never accepts arbitrary status text", () => {
  const s = integrationStatus({ source: "MCP", state: "error", active: -1, configured: 7, failed: 1, working: NaN, summary: "Bearer SECRET", details: ["SECRET"], failedNames: ["SECRET"], checkedAt: NOW + 100 }, NOW)!;
  assert.equal(s.active, undefined); assert.equal(s.working, undefined); assert.equal(s.checkedAt, NOW);
  assert.equal(s.summary, "error"); assert.ok(!JSON.stringify(s).includes("SECRET"));
  assert.equal(integrationStatus({ source: "MCP", active: 8, configured: 7 }), undefined);
  assert.equal(integrationStatus({ source: "SECRET" }), undefined);
});
test("known public statuses parse fixed tokens and discard OpenViking session IDs", () => {
  const statuses = new Map([["openviking", "\x1b[32mOV ✓\x1b[0m sessionId=SECRET"], ["hermes-memory", "Bearer SECRET"], ["unknown", "error"]]);
  const result = publicStatuses(statuses, NOW);
  assert.equal(result.length, 1); assert.equal(result[0].state, "ok"); assert.ok(!JSON.stringify(result).includes("SECRET"));
  assert.equal(publicStatuses(new Map([["openviking", "OV ✗ secret"]]))[0].state, "error");
});
test("Codex adapter sanitizes labels, keeps selected account with unknown routing, and parses resets to epochs", () => {
  const snapshot = codexStatus({ checkedAt: NOW, staleAfter: 1000, accounts: [
    { provider: "openai-codex-2", label: "Bearer SECRET", state: "ok", windows: [{ label: "week", remainingPercent: 8, resetsAt: "2026-09-22T12:00:00Z" }, { label: "SECRET", remainingPercent: Infinity }] },
  ], routing: { state: "unknown", selectedAccount: "codex2", summary: "SECRET" } }, NOW)!;
  assert.equal(snapshot.state, "warning"); assert.deepEqual(snapshot.route, { state: "unknown", selected: "codex2" });
  assert.deepEqual(snapshot.accounts[0].windows, [{ name: "week", percent: 8, unavailable: false, resetsAt: Date.parse("2026-09-22T12:00:00Z") }, { name: "window", unavailable: true }]);
  assert.ok(!JSON.stringify(snapshot).includes("SECRET"));
  assert.equal(codexStatus({ accounts: [{ state: "error" }], routing: { state: "error" } })?.state, "error");
  assert.equal(codexStatus({ accounts: [{ provider: "openai-codex-3", state: "ok", windows: [] }] })?.accounts[0].label, "Codex3");
});
test("configured secrets and credential paths never enter rendered rows or reports", () => {
  process.env.OPS_TEST_SECRET = "secret-example-123";
  try {
    assert.equal(safeText("model-secret-example-123"), "[redacted]");
    assert.equal(safeText("/home/user/.pi/agent/auth.json"), "[redacted]");
    const data = healthy(); data.session.model = safeText("secret-example-123");
    data.integrations = publicStatuses(new Map([["openviking", "OV ✗ secret-example-123"]]));
    const report = detailedReport(data, contextStub(), NOW);
    const rows = render(data, contextStub(), 200).join("\n");
    assert.ok(!report.includes("secret-example-123")); assert.ok(!rows.includes("secret-example-123"));
  } finally { delete process.env.OPS_TEST_SECRET; }
});
test("health checks time out even if the fetch implementation ignores abort", async () => {
  const adapter = new HealthAdapter((() => new Promise(() => {})) as typeof fetch);
  const start = Date.now(); const result = await adapter.check("OK", "http://localhost/readyz", 20, 1000);
  assert.ok(Date.now() - start < 1000); assert.equal(result.state, "error");
  adapter.dispose();
});
test("health is read-only, rejects redirects, discards bodies and errors, and aborts on disposal", async () => {
  let options: RequestInit | undefined;
  const adapter = new HealthAdapter((async (_url, init) => { options = init; return new Response("SECRET", { status: 200 }); }) as typeof fetch);
  const result = await adapter.check("OV", "http://localhost/health", 100, 1000);
  assert.equal(result.state, "ok"); assert.equal(options?.method, "GET"); assert.equal(options?.redirect, "error"); assert.equal(options?.headers, undefined);
  assert.ok(!JSON.stringify(result).includes("SECRET")); adapter.dispose();
  const hung = new HealthAdapter((() => new Promise(() => {})) as typeof fetch);
  const pending = hung.check("OK", "http://localhost", 10000, 1000); hung.dispose();
  assert.equal((await pending).state, "error");
});
test("settings clamp row and timeout budgets and do not persist environment endpoints", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "ops-settings-")), "settings.json");
  try {
    assert.equal(defaults.minimumRows, 1); assert.equal(defaults.maximumRows, 8);
    assert.equal(defaults.showHealthyServices, false); assert.equal(defaults.showUnavailableOptionalSources, false);
    const parsed = parseSettings({ minimumRows: 99, maximumRows: 2, healthTimeoutMs: -1, healthPollSeconds: 0 });
    assert.equal(parsed.minimumRows, 3); assert.equal(parsed.maximumRows, 3); assert.equal(parsed.healthTimeoutMs, 100); assert.equal(parsed.healthPollSeconds, 10);
    assert.equal(parseSettings({ minimumRows: 0 }).minimumRows, 1);
    assert.equal(healthUrl("http://user:secret@host/health"), undefined); assert.equal(healthUrl("https://host/health?key=secret"), undefined);
    process.env.OPS_FOOTER_OK_HEALTH_URL = "http://127.0.0.1:4317/readyz";
    const settings = await loadSettings(path); assert.equal(settings.healthUrls.OK, process.env.OPS_FOOTER_OK_HEALTH_URL);
    await saveSettings(settings, path); assert.ok(!(await readFile(path, "utf8")).includes("4317"));
    await writeFile(path, "\n");
    await ensureSettings(path);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), defaults);
    assert.match(await readFile(join(path, "..", "settings.example.jsonc"), "utf8"), /\/\/ healthPollSeconds: 10/);
    await saveSettings({ ...defaults, healthUrls: { OK: "http://localhost/ok" } }, path, true);
    assert.equal((await loadLocalSettings(path)).healthUrls.OK, "http://localhost/ok");
    await ensureSettings(path);
    assert.equal((await loadLocalSettings(path)).healthUrls.OK, "http://localhost/ok", "startup must preserve user settings");
    await saveSettings({ ...defaults, enabled: false, healthUrls: { OK: "http://env.invalid" } }, path);
    assert.equal((await loadLocalSettings(path)).healthUrls.OK, "http://localhost/ok", "ordinary saves preserve local endpoints");
  } finally { delete process.env.OPS_FOOTER_OK_HEALTH_URL; await rm(join(path, ".."), { recursive: true, force: true }); }
});
test("Git parser handles spaces, rename records, conflicts and detached branches", () => {
  const s = parseStatus("# branch.head (detached)\0# branch.ab +2 -3\x002 R. N... 100644 100644 100644 abc def R100 new name\0? misleading old name\0? real name\0u UU data\0");
  assert.equal(s.branch, "(detached)"); assert.equal(s.staged, 2); assert.equal(s.unstaged, 1); assert.equal(s.untracked, 1); assert.equal(s.ahead, 2); assert.equal(s.behind, 3);
  assert.deepEqual(parseWorktrees("worktree /tmp/a space\0HEAD abc\0\0worktree /tmp/a\nnewline\0locked reason\0\0"), [{ path: "/tmp/a space", locked: false }, { path: "/tmp/a\nnewline", locked: true }]);
});
test("Git timeout preserves success freshness and shutdown kills hung collection", async () => {
  const bin = await mkdtemp(join(tmpdir(), "ops-hung-git-"));
  const originalPath = process.env.PATH;
  const adapter = new GitAdapter(25, 1000);
  try {
    await writeFile(join(bin, "git"), "#!/bin/sh\nexec sleep 10\n"); await chmod(join(bin, "git"), 0o700);
    process.env.PATH = `${bin}:${originalPath}`;
    adapter.snapshot = { ...unknown(), state: "ok", repo: "previous", checkedAt: 123, staleAfter: 1000 };
    const result = await adapter.refresh(bin, true);
    assert.equal(result.state, "error"); assert.equal(result.summary, "timeout"); assert.equal(result.checkedAt, 123);
    const hung = new GitAdapter(10000, 1000);
    const pending = hung.refresh(bin, true); const start = Date.now(); hung.dispose(); await pending;
    assert.ok(Date.now() - start < 1000);
  } finally { adapter.dispose(); process.env.PATH = originalPath; await rm(bin, { recursive: true, force: true }); }
});
test("Git collects real unborn, dirty, linked-worktree, detached and not-repo fixtures", async () => {
  const base = await mkdtemp(join(tmpdir(), "ops-git-"));
  const repo = join(base, "repo space"); const linked = join(base, "linked space");
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const adapter = new GitAdapter(2000, 1000);
  try {
    execFileSync("git", ["init", repo], { stdio: "ignore" });
    assert.equal((await adapter.refresh(repo, true)).state, "ok");
    git("config", "user.email", "test@example.invalid"); git("config", "user.name", "Test");
    await writeFile(join(repo, "old name"), "one"); git("add", "old name"); git("commit", "-m", "base");
    git("worktree", "add", "-b", "linked", linked);
    git("mv", "old name", "new name"); await writeFile(join(repo, "new name"), "two"); await writeFile(join(repo, "untracked name"), "three");
    const one = adapter.refresh(repo, true); assert.equal(adapter.refresh(repo, true), one);
    const status = await one; assert.equal(status.worktrees, 2); assert.equal(status.staged, 1); assert.equal(status.unstaged, 1); assert.equal(status.untracked, 1); assert.equal(status.worktree, repo);
    git("checkout", "--detach"); assert.equal((await adapter.refresh(repo, true)).branch, "(detached)");
    const outside = await adapter.refresh(base, true);
    assert.equal(outside.state, "unknown"); assert.equal(outside.repo, undefined, "leaving the worktree clears the old repository");
    const absent = new GitAdapter(); assert.equal((await absent.refresh(base)).state, "unknown"); absent.dispose();
  } finally { adapter.dispose(); await rm(base, { recursive: true, force: true }); }
});

type Handler = (event: any, ctx: any) => unknown;
/** The fake TUI paints the widget above the editor and the footer at the last width on each request, as Pi does on its next frame. */
function harness(gitRefresh: () => Promise<GitSnapshot> = async () => unknown()) {
  const handlers = new Map<string, Set<Handler>>(); const bus = new Map<string, Set<(value: unknown) => void>>();
  const commands = new Map<string, { handler: Handler }>();
  let component: any, top: any, widgetSets = 0, width = 120, lastFooter: unknown, contextDisposed = 0, subscriptions = 0, gitDisposed = 0, healthDisposed = 0, gitRefreshes = 0, refreshes = 0, renders = 0;
  const notices: string[] = []; const ownership: boolean[] = [];
  const extStatuses = new Map<string, string>();
  const ui: any = {
    theme: { fg: (_kind: string, text: string) => text },
    notify: (message: string) => notices.push(message),
    setWidget: (key: string, factory: any, options: any) => {
      assert.equal(key, "ops-footer-top"); assert.equal(options?.placement ?? "aboveEditor", "aboveEditor");
      if (factory) widgetSets++;
      top = factory ? factory({ requestRender: () => {} }, ui.theme) : undefined;
    },
    setFooter: (factory: any) => {
      component?.dispose(); component = undefined; lastFooter = factory;
      if (factory) component = factory({ requestRender: () => { renders++; top?.render(width); component?.render(width); } }, ui.theme, {
        getExtensionStatuses: () => extStatuses,
        onBranchChange: () => { subscriptions++; return () => { subscriptions--; }; },
      });
    },
  };
  const ctx: any = { mode: "tui", hasUI: true, cwd: "/tmp", model: { provider: "p", id: "m" }, thinkingLevel: "high", isIdle: () => true, hasPendingMessages: () => true,
    ui, sessionManager: { getBranch: () => [], getHeader: () => ({ timestamp: "2026-01-01T00:00:00Z" }), getSessionName: () => "test" } };
  const pi: any = {
    on: (name: string, handler: Handler) => { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name)!.add(handler); return () => handlers.get(name)!.delete(handler); },
    events: {
      on: (name: string, handler: (value: unknown) => void) => { if (!bus.has(name)) bus.set(name, new Set()); bus.get(name)!.add(handler); return () => bus.get(name)!.delete(handler); },
      emit: (name: string, value: any) => { if (name === CODEX_REFRESH) refreshes++; if (name === OWNERSHIP) ownership.push(value.active); for (const fn of bus.get(name) ?? []) fn(value); },
    },
    registerCommand: (name: string, options: any) => commands.set(name, options),
    getActiveTools: () => ["mcp", "viking_search", "read"], getCommands: () => [],
  };
  const context = contextStub(); context.dispose = () => { contextDisposed++; };
  const install = (enabled = true, overrides: Partial<Settings> = {}) => installOpsFooter(pi as ExtensionAPI, {
    context: () => context, load: async () => ({ ...defaults, ...overrides, enabled }),
    git: () => ({ snapshot: unknown(), refresh: () => { gitRefreshes++; return gitRefresh(); }, dispose: () => { gitDisposed++; } }) as unknown as GitAdapter,
    health: () => ({ check: async () => unknown(), dispose: () => { healthDisposed++; } }) as unknown as HealthAdapter,
    save: async () => {},
  });
  const emit = async (name: string, event: any = {}) => { for (const fn of [...handlers.get(name) ?? []]) await fn(event, ctx); };
  const command = async (text: string) => { await commands.get("ops-footer")!.handler(text, ctx); };
  /** Rows above the editor, then the footer rows, as the user reads them. */
  const footer = (next: number) => { width = next; return [...(top?.render(width) ?? []), ...component.render(width)].map(stripTerminalSequences).join("\n"); };
  return { pi, ctx, install, emit, command, notices, ownership, extStatuses, footer,
    get component() { return component; }, get top() { return top; }, get widgetSets() { return widgetSets; }, get lastFooter() { return lastFooter; },
    stats: () => ({ contextDisposed, subscriptions, gitDisposed, healthDisposed, gitRefreshes, refreshes, renders, handlers: [...handlers.values()].reduce((n, s) => n + s.size, 0), bus: [...bus.values()].reduce((n, s) => n + s.size, 0) }),
  };
}
test("runtime has no factory work, owns footer after start, and cleans all resources", async () => {
  const h = harness(); h.install();
  assert.equal(h.stats().gitRefreshes, 0); assert.equal(h.stats().refreshes, 0); assert.equal(Boolean(h.component), false);
  await h.emit("session_start"); assert.equal(h.stats().refreshes, 1); assert.equal(h.stats().subscriptions, 1);
  assert.equal(h.ownership.at(-1), true);
  h.pi.events.emit(OWNERSHIP_QUERY); assert.equal(h.ownership.at(-1), true);
  // This test asserts the v3 composition: the directory row and the bar above the editor.
  await h.command("layout v3");
  for (const width of [8, 12, 20, 30, 40, 50, 80, 120, 200, 8, 200]) for (const line of h.component.render(width)) assert.ok(visibleWidth(line) <= width);
  await h.emit("agent_start"); assert.match(h.footer(200), /working/);
  await h.emit("ui_prompt_start"); assert.match(h.footer(200), /⌨ input needed/);
  await h.emit("ui_prompt_end"); assert.match(h.footer(200), /working/);
  const controller = new AbortController();
  await h.emit("session_before_compact", { signal: controller.signal }); assert.match(h.footer(200), /compacting/);
  await h.emit("session_compact");
  await h.emit("message_end", { message: { role: "assistant", stopReason: "error" } }); assert.match(h.footer(200), /✗ model error/);
  await h.emit("agent_start"); await h.emit("agent_settled"); assert.match(h.footer(200), /idle/);
  h.ctx.thinkingLevel = "low"; await h.emit("thinking_level_select"); assert.match(h.footer(200), /^pwd \/tmp\s+idle/); assert.match(h.footer(200), /\np\/m · low/);
  h.ctx.cwd = "/tmp/sub"; await h.emit("tool_execution_end"); assert.match(h.footer(200), /cwd \/tmp\/sub/);
  assert.match(h.top.render(200).join("\n"), /^pwd \/tmp/, "the directory row sits above the editor");
  assert.ok(h.component.render(200).join("\n").includes("p/m"), "the footer below the editor holds the model row");
  await h.command("off"); assert.equal(h.lastFooter, undefined); assert.equal(h.top, undefined, "off removes the widget above the editor");
  assert.equal(h.ownership.at(-1), false); assert.equal(h.stats().subscriptions, 0);
  await h.command("on"); assert.equal(h.ownership.at(-1), true); assert.ok(h.top);
  await h.emit("session_shutdown"); const final = h.stats();
  assert.equal(final.contextDisposed, 1); assert.equal(final.subscriptions, 0); assert.equal(final.handlers, 0); assert.equal(final.bus, 0);
  assert.equal(final.gitDisposed, 2); assert.equal(final.healthDisposed, 2); assert.equal(h.ownership.at(-1), false);
  await new Promise(resolve => setTimeout(resolve, 1050)); assert.equal(h.stats().refreshes, final.refreshes); assert.equal(h.stats().gitRefreshes, final.gitRefreshes);
});
test("runtime: a new session uses layout v4 with no row above the editor; layout v3 and v4 switch the widget; off and on work in v4", async () => {
  const h = harness(); h.install(true, { maximumRows: 4 }); await h.emit("session_start");
  assert.equal(h.top, undefined, "a new session has no widget above the editor");
  assert.equal(h.widgetSets, 0, "v4 sets no ops-footer-top content");
  h.ctx.thinkingLevel = "low"; await h.emit("thinking_level_select");
  const v4 = h.component.render(200).map(stripTerminalSequences);
  assert.match(v4[0], /^p\/m · low/, "model row first"); assert.match(v4[1], /^pwd \/tmp\s+idle/, "directory row second"); assert.equal(visibleWidth(v4[2]), 200, "bar third");
  await h.command("layout"); assert.match(h.notices.at(-1)!, /^Footer layout: v4\. Use \/ops-footer layout v4\|v3\|v2\|a\|b\|c\.$/);
  await h.command("layout v3"); assert.ok(h.top, "v3 shows the widget above the editor"); assert.equal(h.widgetSets, 1);
  // The earlier `assert.equal(h.top, undefined)` narrows the type of the getter; the widget exists now.
  const above = ((h as any).top.render(200) as string[]).map(stripTerminalSequences), below = h.component.render(200).map(stripTerminalSequences);
  assert.deepEqual(above, [v4[1], v4[2]], "v3 puts the directory row and the bar above the editor");
  assert.equal(below[0], v4[0], "v3 keeps the model row first below the editor");
  await h.command("layout v4"); assert.equal(h.top, undefined, "v4 removes the rows above the editor");
  assert.deepEqual(h.component.render(200).map(stripTerminalSequences), v4);
  for (const name of ["v2", "a", "b", "c"]) { await h.command(`layout ${name}`); assert.equal(h.top, undefined, `${name} has no widget above the editor`); }
  await h.command("layout v4"); assert.equal(h.widgetSets, 1, "only v3 sets the widget");
  await h.command("off"); assert.equal(h.lastFooter, undefined); assert.equal(h.top, undefined); assert.equal(h.ownership.at(-1), false);
  await h.command("on"); assert.equal(h.ownership.at(-1), true); assert.equal(h.top, undefined, "on in v4 sets no widget"); assert.equal(h.widgetSets, 1);
  assert.match(h.footer(200), /^p\/m · low.*\npwd \/tmp\s+idle/);
  // A layout choice lasts for the session: v3, off, on gives the widget again.
  await h.command("layout v3"); await h.command("off"); assert.equal(h.top, undefined); await h.command("on"); assert.ok(h.top);
  await h.command("layout v4");
  // The report names the dropped quota rows in v4 as in v3. maximumRows 4 leaves one quota row for two accounts.
  h.pi.events.emit(CODEX_STATUS, { accounts: [{ provider: "openai-codex", state: "ok", windows: [{ label: "week", remainingPercent: 50 }] }, { provider: "openai-codex-2", state: "ok", windows: [{ label: "week", remainingPercent: 40 }] }], routing: { selectedAccount: "codex1", state: "ok" } });
  const rows = h.footer(200).split("\n"); assert.equal(rows.length, 4); assert.match(rows[3], /^Codex1 .*  \+1( |$)/);
  await h.command("report"); assert.match(h.notices.at(-1)!, /^Quota rows not shown: Codex2\. The row budget is maximumRows:4/m);
  await h.command("layout v3"); h.footer(200); await h.command("report"); assert.match(h.notices.at(-1)!, /^Quota rows not shown: Codex2\./m);
  await h.command("layout v2"); h.footer(200); await h.command("report"); assert.doesNotMatch(h.notices.at(-1)!, /Quota rows not shown/);
  await h.command("help"); assert.match(h.notices.at(-1)!, /layout v4\|v3\|v2\|a\|b\|c\|help/);
  await h.emit("session_shutdown"); assert.equal(h.top, undefined);
});
test("runtime report uses only published MCP state and secret-free bus data", async () => {
  const h = harness(); h.install(); await h.emit("session_start");
  await h.command("report"); assert.ok(!h.notices.at(-1)!.includes("MCP ok"));
  h.extStatuses.set("openviking", "OV ✗ sessionId=SECRET");
  h.pi.events.emit(INTEGRATION_STATUS, { source: "MCP", state: "error", active: 6, configured: 7, failed: 1, summary: "SECRET" });
  h.pi.events.emit(CODEX_STATUS, { accounts: [{ provider: "openai-codex-2", state: "ok", windows: [{ label: "week", remainingPercent: 2 }] }], routing: { selectedAccount: "codex2", state: "unknown", summary: "SECRET" } });
  await h.command("report"); const report = h.notices.at(-1)!;
  assert.match(report, /MCP ERR 6\/7 failed:1/); assert.match(report, /route:codex2 \(unknown\)/); assert.match(report, /OV ERR/); assert.ok(!report.includes("SECRET"));
  assert.match(report, /prompts:pending \(count unavailable\)/); assert.match(report, /Codex2: ok; week 2%/);
  assert.match(h.footer(200), /OpenViking ✗ unavailable/); assert.match(h.footer(200), /MCP 6\/7 ✗/); assert.match(h.footer(200), /Codex2 +✗ week 2%/);
  await h.command("settings"); await h.command("save"); await h.command("help"); await h.emit("session_shutdown");
});
test("runtime tracks memory activity, counter refreshes, capture hints and clears session state", async () => {
  mock.timers.enable({ apis: ["setInterval", "Date"], now: idleStart });
  try {
    const h = await idleFooter(async () => cleanRepo());
    h.extStatuses.set("openviking", "OV ✓ · ↩2 · ctx 1 · ~500/8000 · PRIVATE-SESSION");
    h.extStatuses.set("llm-wiki", "🧠 LLM Wiki (13 tools, observe + recall active)");
    h.extStatuses.set("llm-wiki-model", "🧠 wiki model: codex-auto/gpt-6-luna");
    await run(1);
    assert.match(h.footer(160), /OpenViking ✓ connected/);
    assert.match(h.footer(160), /LLM Wiki.*gpt-6-luna/);
    await h.emit("tool_execution_start", { toolCallId: "one", toolName: "viking_search" });
    assert.match(h.footer(160), /search running/);
    await h.emit("tool_execution_end", { toolCallId: "one", toolName: "viking_search", isError: false });
    assert.match(h.footer(160), /search returned/);
    await h.emit("tool_execution_end", { toolCallId: "edit", toolName: "edit", isError: false });
    assert.match(h.footer(160), /suggest wiki_retro/);
    await h.emit("tool_execution_start", { toolCallId: "retro", toolName: "wiki_retro" });
    await h.emit("tool_execution_end", { toolCallId: "retro", toolName: "wiki_retro", isError: false });
    assert.ok(!h.footer(160).includes("suggest wiki_retro"));
    await h.emit("message_end", { message: { role: "custom", customType: "wiki-observe-reminder" } });
    assert.match(h.footer(160), /suggest wiki_retro/);
    await run(60); assert.match(h.footer(160), /OpenViking ⚠ stale/);
    h.extStatuses.set("openviking", "OV ✓ · ↩3 · ctx 2 · ~600/8000 · PRIVATE-SESSION");
    await run(1); assert.match(h.footer(160), /OpenViking ✓ connected/);
    await h.command("report"); assert.ok(!h.notices.at(-1)!.includes("PRIVATE"));
    h.pi.events.emit(INTEGRATION_STATUS, { source: "MCP", state: "error", active: 1, configured: 2, failed: 1 });
    const refreshes = h.stats().refreshes;
    await h.emit("session_start");
    assert.equal(h.stats().refreshes, refreshes + 1, "session start requests fresh external data");
    assert.match(h.footer(160), /MCP 1\/2 ✗/, "session start preserves published integration state");
    assert.ok(!h.footer(160).includes("suggest wiki_retro"));
    assert.ok(!h.footer(160).includes("search returned"));
    h.extStatuses.delete("llm-wiki"); h.extStatuses.delete("llm-wiki-model");
    await run(1); assert.ok(!h.footer(160).includes("LLM Wiki"));
    await h.emit("session_shutdown"); assert.equal(h.stats().handlers, 0);
  } finally { mock.timers.reset(); }
});
test("Powerline package provenance warns and replacement releases ownership", async () => {
  const h = harness();
  h.pi.getCommands = () => [{ source: "extension", sourceInfo: { source: "npm:pi-powerline-footer@1.0.0" } }];
  h.install(); await h.emit("session_start");
  assert.ok(h.notices.some(text => text.includes("Warning: Powerline")));
  assert.match(h.footer(200), /⚠ footer conflict/);
  h.ctx.ui.setFooter(() => ({ render: () => ["other"], invalidate() {} }));
  assert.equal(h.ownership.at(-1), false); assert.equal(h.stats().subscriptions, 0);
  assert.equal(h.stats().gitDisposed, 1); await h.emit("session_shutdown");
});
test("disabled startup does not collect and reports ownership false", async () => {
  const h = harness(); h.install(false); await h.emit("session_start");
  assert.equal(h.stats().refreshes, 0); assert.equal(h.ownership.at(-1), false);
  await h.command("on"); assert.equal(h.stats().refreshes, 1); await h.emit("session_shutdown");
});
test("session collector includes all public usage types without keeping contents", () => {
  const h = harness(); const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 0.5 } };
  h.ctx.sessionManager.getBranch = () => [
    { type: "message", message: { role: "assistant", content: "SECRET", usage } },
    { type: "message", message: { role: "toolResult", usage } },
    { type: "usage", usage }, { type: "compaction", usage }, { type: "branch_summary", usage },
  ];
  const s = collectSession(h.pi as ExtensionAPI, h.ctx as ExtensionContext, "idle", "/start");
  assert.equal(s.input, 5); assert.equal(s.cacheRead, 15); assert.equal(s.cost, 2.5); assert.ok(!JSON.stringify(s).includes("SECRET"));
  assert.equal(s.startedIn, "/start"); assert.equal(typeof s.remote, "boolean");
});

const flush = () => new Promise(resolve => setImmediate(resolve));
/** A clean repository whose check time moves with each collection. The painted rows stay the same. */
const cleanRepo = (extra: Partial<GitSnapshot> = {}): GitSnapshot => ({ state: "ok", summary: "local Git", checkedAt: Date.now(), staleAfter: 18_500, repo: "tmp", branch: "main", worktree: "/tmp", worktrees: 1, staged: 0, unstaged: 0, untracked: 0, ...extra });
/** 27 minutes and 0.5 seconds after the harness session header, so one minute step falls inside a 60-second window. */
const idleStart = Date.parse("2026-01-01T00:27:00.500Z");
async function idleFooter(gitRefresh?: () => Promise<GitSnapshot>) {
  const h = harness(gitRefresh); h.install(); await h.emit("session_start"); await flush();
  assert.match(h.footer(120), /queued · 27m/);
  return h;
}
async function run(seconds: number) { for (let i = 0; i < seconds; i++) { mock.timers.tick(1000); await flush(); } }
test("an idle footer with unchanged data asks for at most two renders and polls Git slowly in 60 seconds", async () => {
  mock.timers.enable({ apis: ["setInterval", "Date"], now: idleStart });
  try {
    const h = await idleFooter(async () => cleanRepo()); const start = h.stats();
    h.pi.events.emit(CODEX_STATUS, { checkedAt: idleStart, accounts: [{ provider: "openai-codex", state: "ok", windows: [{ label: "5h", remainingPercent: 80 }] }] });
    const shown = h.stats().renders;
    h.pi.events.emit(CODEX_STATUS, { checkedAt: idleStart, accounts: [{ provider: "openai-codex", state: "ok", windows: [{ label: "5h", remainingPercent: 80 }] }] });
    assert.equal(h.stats().renders, shown, "a repeated status with the same content paints nothing");
    await run(60);
    const end = h.stats(), renders = end.renders - shown, collections = end.gitRefreshes - start.gitRefreshes;
    assert.ok(renders <= 2, `${renders} render requests in 60 idle seconds`);
    assert.ok(renders >= 1, "the minute step from 27m to 28m still paints");
    assert.match(h.footer(120), /queued · 28m/);
    assert.ok(collections <= Math.ceil(60 / defaults.gitIdlePollSeconds), `${collections} Git collections in 60 idle seconds`);
    await h.emit("session_shutdown");
  } finally { mock.timers.reset(); }
});
test("a quota lifetime has a two-hour cap and the footer's floor; other sources keep the one-hour cap", () => {
  const codex = (staleAfter: number, floor?: number) => codexStatus({ checkedAt: NOW, staleAfter, accounts: [{ provider: "openai-codex", state: "ok", windows: [{ label: "7d", remainingPercent: 50 }] }] }, NOW, floor)!.staleAfter;
  const claude = (staleAfter: number, floor?: number) => anthropicStatus({ checkedAt: NOW, staleAfter, state: "ok", windows: [{ label: "7d", remainingPercent: 50 }] }, NOW, floor)!.staleAfter;
  const copilot = (staleAfter: number, floor?: number) => copilotStatus({ checkedAt: NOW, staleAfter, state: "ok", windows: [{ label: "premium", remainingPercent: 50 }] }, NOW, floor)!.staleAfter;
  for (const source of [codex, claude, copilot]) {
    assert.equal(source(120_000), 120_000, "no floor: the lifetime of the source");
    assert.equal(source(120_000, 153_000), 153_000, "the floor wins over a shorter lifetime");
    assert.equal(source(600_000, 153_000), 600_000, "a longer lifetime stays");
    assert.equal(source(7_200_000), 7_200_000, "two times the longest poll time passes");
    assert.equal(source(9_000_000), 7_200_000, "the cap is two hours");
    assert.equal(source(9_000_000, 7_233_000), 7_233_000, "the floor of the longest footer poll is above the cap");
  }
  assert.equal(integrationStatus({ source: "OV", state: "ok", checkedAt: NOW, staleAfter: 7_200_000 }, NOW)!.staleAfter, 3_600_000, "the other sources keep one hour");
  assert.equal(quotaLifetimeFloor({ healthPollSeconds: 60 }), 153_000, "two polls, 30 seconds for one fetch, 3 seconds of margin");
  assert.equal(quotaLifetimeFloor({ healthPollSeconds: 300 }), 633_000);
  assert.equal(quotaLifetimeFloor({ healthPollSeconds: 3600 }), 7_233_000);
});
/** The real Codex status service on the harness bus. A fetch ends two seconds of mock time after it starts. `stopped` makes each fetch fail. */
function codexSource(h: ReturnType<typeof harness>) {
  const source = { fetches: 0, stopped: false, readAt: 0, pending: undefined as undefined | { at: number; done: () => void } };
  createCodexStatus(h.pi as ExtensionAPI, [{ provider: "openai-codex", label: "Codex 1" }], list => {
    source.fetches++;
    if (source.stopped) return Promise.reject(new Error("fixture: no answer"));
    return new Promise(resolve => {
      source.pending = { at: Date.now(), done: () => { source.readAt = Date.now(); resolve(list.map(account => ({ account, result: { success: true as const, windows: [{ label: "7d", usedPercent: 9, remainingPercent: 91 }] } }))); } };
    });
  });
  return source;
}
/** One-second steps. A pending fetch ends after two seconds. `each` runs after each step. */
async function runQuota(source: ReturnType<typeof codexSource>, seconds: number, each: () => void = () => {}) {
  for (let i = 0; i < seconds; i++) {
    mock.timers.tick(1000); await flush();
    if (source.pending && Date.now() - source.pending.at >= 2000) { const { done } = source.pending; source.pending = undefined; done(); await flush(); }
    each();
  }
}
const codexRow = (h: ReturnType<typeof harness>) => h.footer(160).split("\n").find(row => row.includes("Codex1")) ?? "";
test("an idle footer shows no stale quota while one refresh a poll works, then stale after two polls and one fetch", async () => {
  mock.timers.enable({ apis: ["setInterval", "Date"], now: idleStart });
  try {
    const h = harness(async () => cleanRepo()); const source = codexSource(h);
    h.install(); await h.emit("session_start"); await flush();
    await runQuota(source, 3);
    assert.equal(source.fetches, 1); assert.match(codexRow(h), /Codex1 +7d 91%/);
    const polls = 10;
    await runQuota(source, polls * defaults.healthPollSeconds, () => assert.doesNotMatch(codexRow(h), /stale/, `${Math.round((Date.now() - idleStart) / 1000)} seconds after the start`));
    assert.equal(source.fetches, 1 + polls, "each poll gives one fetch");
    // The refresh stops. The last reading stays fresh for two poll periods and one fetch, then it is stale.
    source.stopped = true;
    const floor = quotaLifetimeFloor(defaults), last = source.readAt;
    while (Date.now() + 1000 - last < floor) await runQuota(source, 1, () => assert.doesNotMatch(codexRow(h), /stale/, `${Date.now() - last} ms after the last reading`));
    await runQuota(source, 1);
    assert.ok(Date.now() - last >= floor && Date.now() - last < floor + 1000);
    assert.match(codexRow(h), /Codex1 +7d 91%.*stale/, "stale in the first second after the floor");
    assert.ok(source.fetches > 1 + polls, "the footer still asks while the source fails");
    await h.emit("session_shutdown");
  } finally { mock.timers.reset(); }
});
test("the footer gives a Claude and a Copilot reading its floor: no stale before two polls and one fetch", async () => {
  for (const [event, label] of [[ANTHROPIC_STATUS, "Claude"], [COPILOT_STATUS, "Copilot"]] as const) {
    mock.timers.enable({ apis: ["setInterval", "Date"], now: idleStart });
    try {
      const h = await idleFooter(async () => cleanRepo());
      // The Codex reading stays fresh for the whole test, so only the other source can mark the quota group.
      h.pi.events.emit(CODEX_STATUS, { checkedAt: idleStart, staleAfter: 7_200_000, accounts: [{ provider: "openai-codex", state: "ok", windows: [{ label: "7d", remainingPercent: 91 }] }] });
      h.pi.events.emit(event, { checkedAt: idleStart, staleAfter: 120_000, state: "ok", windows: [{ label: label === "Claude" ? "7d" : "premium", remainingPercent: 50 }] });
      assert.match(h.footer(160), new RegExp(label), `the ${label} row shows`);
      await run(130);
      assert.doesNotMatch(codexRow(h), /stale/, `${label}: 130 seconds is after the lifetime of the source and before the floor`);
      await run(Math.ceil(quotaLifetimeFloor(defaults) / 1000) - 130);
      assert.match(codexRow(h), /stale/, `${label}: stale at the floor, on the last Codex row`);
      await h.emit("session_shutdown");
    } finally { mock.timers.reset(); }
  }
});
test("a long footer poll shows no stale quota while the refresh works", async () => {
  mock.timers.enable({ apis: ["setInterval", "Date"], now: idleStart });
  try {
    const h = harness(async () => cleanRepo()); const source = codexSource(h);
    h.install(true, { healthPollSeconds: 300 }); await h.emit("session_start"); await flush();
    await runQuota(source, 3);
    assert.match(codexRow(h), /Codex1 +7d 91%/);
    await runQuota(source, 5 * 300, () => assert.doesNotMatch(codexRow(h), /stale/, `${Math.round((Date.now() - idleStart) / 1000)} seconds after the start`));
    assert.equal(source.fetches, 6, "the first reading and one fetch for each of the five polls");
    await h.emit("session_shutdown");
  } finally { mock.timers.reset(); }
});
test("changed data asks for a render within one timer period", async () => {
  mock.timers.enable({ apis: ["setInterval", "Date"], now: idleStart });
  try {
    let staged = 0;
    const h = await idleFooter(async () => cleanRepo({ staged }));
    let before = h.stats().renders;
    h.extStatuses.set("openviking", "OV ✗"); await run(1);
    assert.equal(h.stats().renders, before + 1, "a new extension status paints on the next tick");
    assert.match(h.footer(120), /OpenViking ✗ unavailable/);
    await h.emit("agent_start"); before = h.stats().renders; staged = 2; await run(1);
    assert.equal(h.stats().renders, before + 1, "during a turn a Git change paints on the next tick");
    assert.match(h.footer(120), /tmp main · 2 staged/);
    await h.emit("session_shutdown");
  } finally { mock.timers.reset(); }
});
test("agent_settled refreshes Git at once and bursts coalesce to one running and one queued collection", async () => {
  mock.timers.enable({ apis: ["setInterval", "Date"], now: idleStart });
  try {
    let release: (() => void) | undefined, staged = 0;
    const h = await idleFooter(() => new Promise(resolve => { release = () => resolve(cleanRepo({ staged })); }));
    release!(); await flush();
    const start = h.stats().gitRefreshes;
    await h.emit("agent_start"); await h.emit("agent_settled");
    assert.equal(h.stats().gitRefreshes, start + 1, "agent_settled does not wait for the idle poll");
    for (let i = 0; i < 5; i++) { await h.emit("tool_execution_end"); await h.emit("agent_settled"); }
    await run(3);
    assert.equal(h.stats().gitRefreshes, start + 1, "no second collection while one runs");
    staged = 3; release!(); await flush();
    assert.equal(h.stats().gitRefreshes, start + 2, "one queued follow-up after the running collection");
    release!(); await flush();
    assert.match(h.footer(120), /3 staged/);
    assert.equal(h.stats().gitRefreshes, start + 2);
    await h.emit("session_shutdown");
  } finally { mock.timers.reset(); }
});
test("Git status runs alone between full lookups, and settings keep the idle poll valid", async () => {
  const bin = await mkdtemp(join(tmpdir(), "ops-count-git-")); const log = join(bin, "log");
  const originalPath = process.env.PATH;
  await writeFile(join(bin, "git"), `#!/bin/sh\necho "$3" >> "${log}"\ncase "$3" in\n  status) printf '# branch.head main\\0? new\\0' ;;\n  rev-parse) echo /tmp/repo ;;\n  worktree) printf 'worktree /tmp/repo\\0\\0worktree /tmp/other\\0\\0' ;;\nesac\n`); await chmod(join(bin, "git"), 0o700);
  const adapter = new GitAdapter(2000, 0, 15_000);
  const calls = async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean);
  try {
    process.env.PATH = `${bin}:${originalPath}`;
    const first = await adapter.refresh(bin, true);
    assert.deepEqual((await calls()).sort(), ["rev-parse", "status", "worktree"], "a forced refresh runs all three commands");
    assert.equal(first.worktrees, 2); assert.equal(first.staleAfter, 15_000 + 2000 + 1500, "freshness covers the idle poll");
    const light = await adapter.refresh(bin);
    assert.equal((await calls()).length, 4); assert.equal((await calls()).at(-1), "status");
    assert.equal(light.repo, "repo"); assert.equal(light.worktrees, 2); assert.equal(light.untracked, 1);
    await adapter.refresh(bin, true); assert.equal((await calls()).length, 7, "agent_settled and branch changes force a full lookup");
    await adapter.refresh(join(bin, "..")); assert.equal((await calls()).length, 10, "a new cwd forces a full lookup");
  } finally { adapter.dispose(); process.env.PATH = originalPath; await rm(bin, { recursive: true, force: true }); }
  assert.equal(defaults.gitIdlePollSeconds, 15); assert.equal(defaults.gitCacheMs, 1000);
  assert.equal(parseSettings({ gitIdlePollSeconds: 0 }).gitIdlePollSeconds, 2); assert.equal(parseSettings({ gitIdlePollSeconds: 99999, gitCacheMs: 5000 }).gitIdlePollSeconds, 3600);
  assert.equal(parseSettings({ gitCacheMs: 5000 }).gitCacheMs, 5000, "the old setting name stays valid");
});
test("two weekly-only Pro accounts render one 7d chip each, with no short window or placeholder", () => {
  const reset = new Date(NOW + 6 * 24 * HOUR + 21 * HOUR).toISOString();
  const snapshot = codexStatus({ checkedAt: NOW, staleAfter: 60000, accounts: [
    { provider: "openai-codex", label: "Codex 1", state: "ok", plan: "pro_lite", windows: [{ label: "7d", remainingPercent: 0, resetsAt: reset }] },
    { provider: "openai-codex-2", label: "Codex 2", state: "ok", plan: "pro", windows: [{ label: "7d", remainingPercent: 80, resetsAt: reset }] },
  ], routing: { state: "unknown", selectedAccount: "codex2" } }, NOW)!;
  assert.deepEqual(snapshot.accounts.map(a => [a.label, a.plan, a.windows.map(w => w.name)]), [["Codex1", "pro_lite", ["7d"]], ["Codex2", "pro", ["7d"]]]);
  const data = healthy(); data.limits = snapshot;
  const rows = render(data, contextStub(), 160);
  assert.match(rows[3], /^Codex1 \[✗ 7d 0%\] ↺ .+$/);
  assert.match(rows[4], /^Codex2 \[7d 80%\] ↺ .+  ◂ routed$/);
  for (const width of widths) {
    for (const line of plain(render(data, contextStub(), width))) {
      assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
      assert.doesNotMatch(line, /5h|5d|n\/a|window/);
    }
  }
  const report = detailedReport(data, contextStub(), NOW);
  assert.match(report, /Codex1: ok; 7d 0% resets .*; plan:pro_lite/);
  assert.match(report, /Codex2: ok; 7d 80% resets .*; plan:pro/);
});
test("mixed Plus and Pro accounts keep their own reported windows in identity order", () => {
  const snapshot = codexStatus({ checkedAt: NOW, staleAfter: 60000, accounts: [
    { provider: "openai-codex-2", label: "Codex 2", state: "ok", plan: "plus", windows: [{ label: "5h", remainingPercent: 90 }, { label: "7d", remainingPercent: 70 }] },
    { provider: "openai-codex", label: "Codex 1", state: "ok", plan: "pro", windows: [{ label: "7d", remainingPercent: 50 }] },
  ], routing: { state: "unknown" } }, NOW)!;
  const data = healthy(); data.limits = snapshot;
  const rows = render(data, contextStub(), 160);
  assert.match(rows[3], /^Codex1 \[7d 50%\]$/);
  assert.match(rows[4], /^Codex2 \[5h 90%\] +\[7d 70%\]$/);
});
test("Codex adapter allowlists plans and duration labels; slot names never imply a duration", () => {
  const snapshot = codexStatus({ checkedAt: NOW, staleAfter: 60000, accounts: [
    { provider: "openai-codex", state: "ok", plan: "Bearer sk-SECRET", windows: [{ label: "primary", remainingPercent: 40 }, { label: "secondary", remainingPercent: 30 }] },
    { provider: "openai-codex-2", state: "ok", plan: "__proto__", windows: [{ label: "30d", remainingPercent: 40 }, { label: "90m", remainingPercent: 50 }, { label: "1000d", remainingPercent: 1 }, { label: "0h", remainingPercent: 1 }] },
    { provider: "openai-codex-3", state: "ok", plan: "unknown", windows: [] },
  ] }, NOW)!;
  assert.deepEqual(snapshot.accounts.map(a => a.plan), [undefined, undefined, "unknown"]);
  assert.deepEqual(snapshot.accounts[0].windows.map(w => w.name), ["window", "window"]);
  assert.deepEqual(snapshot.accounts[1].windows.map(w => w.name), ["30d", "90m", "window", "window"]);
  assert.ok(!JSON.stringify(snapshot).includes("SECRET"));
  assert.ok(!("plan" in snapshot.accounts[0]));
});
