import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { buildInventory, readFiles, type Dirs, type ResourceItem } from "../extensions/resources/inventory.ts";
import { runResources, type ResourcesContext } from "../extensions/resources/menu.ts";
import { columnsFor, formatRow, groupItems } from "../extensions/resources/view.ts";

function put(file: string, content: string | object = "") {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
}

/** A package entry with an explicit `extensions` allowlist, as the kit profile writes it. */
function fixture(): Dirs & { root: string; settings: string } {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "resources-view-")));
	const agentDir = join(root, "agent"), kit = join(root, "kit");
	put(join(kit, "package.json"), { pi: { extensions: ["./extensions/a/index.ts", "./extensions/next-prompt/index.ts"], skills: ["./skills"] } });
	for (const file of ["extensions/a/index.ts", "extensions/next-prompt/index.ts", "skills/herdr/SKILL.md"]) put(join(kit, file));
	put(join(agentDir, "prompts/review.md"));
	const settings = join(agentDir, "settings.json");
	put(settings, { extensions: ["-builtin:mcp"], packages: [{ source: kit, extensions: ["extensions/a/index.ts"], prompts: [], skills: ["skills/herdr"], themes: [] }] });
	put(join(agentDir, "mcp.json"), { mcpServers: { live: { command: "a" } } });
	return { root, agentDir, projectDir: join(root, "project/.pi"), homeDir: join(root, "home"), settings };
}

const DOWN = "\x1b[B", ESC = "\x1b";

test("in the TUI a toggle is saved with s, the footer names the key and the count, and esc asks before it drops changes", async () => {
	const dirs = fixture();
	try {
		const sessions = [[DOWN, DOWN, " ", ESC], ["s"]];
		const frames: string[][] = [], notices: string[] = [], confirms = [false];
		let reloads = 0;
		const ctx: ResourcesContext = {
			hasUI: true, mode: "tui", reload: async () => { reloads++; },
			ui: {
				select: async () => assert.fail("no select in the TUI browser"),
				input: async () => undefined,
				confirm: async (_title: string, message: string) => { notices.push(message); return confirms.shift() ?? assert.fail("unexpected confirm"); },
				notify: (text: string) => { notices.push(text); },
				custom: (async (factory: any) => new Promise(resolve => {
					const tui = { terminal: { rows: 30, columns: 100 }, requestRender() {} };
					const view = factory(tui, { fg: (_c: string, text: string) => text, bold: (text: string) => text }, {}, resolve);
					frames.push(view.render(100));
					for (const key of sessions.shift()!) { view.handleInput(key); frames.push(view.render(100)); }
				})) as any,
			},
		};
		await runResources("", ctx, { dirs });
		assert.ok(frames[3]!.some(line => /> .*\[x\] next-prompt .*changed/.test(line)), frames[3]!.join("\n"));
		assert.ok(frames[3]!.some(line => /s save 1 change\(s\)/.test(line)), frames[3]!.join("\n"));
		assert.match(notices[0]!, /^Discard 1 unsaved change\(s\)\? Press s/);
		const pkg = JSON.parse(readFileSync(dirs.settings, "utf8")).packages[0];
		assert.deepEqual(pkg.extensions, ["extensions/a/index.ts", "extensions/next-prompt/index.ts"]);
		assert.equal(notices[1], `Saved 1 change(s) to ${dirs.settings}.`);
		assert.equal(reloads, 1);
	} finally { rmSync(dirs.root, { recursive: true, force: true }); }
});

test("the items fall into groups in a fixed order, and built-ins are not extensions", () => {
	const dirs = fixture();
	try {
		const groups = groupItems(buildInventory(dirs, readFiles(dirs)));
		assert.deepEqual(groups.map(group => group.title), ["Extensions", "Skills", "Prompts", "MCP servers", "Built-ins"]);
		assert.ok(!groups[0]!.items.some(item => item.id.startsWith("builtin:")));
	} finally { rmSync(dirs.root, { recursive: true, force: true }); }
});

test("a row is one line with the short name and the short source in aligned columns", () => {
	const item = (id: string, packageSource?: string): ResourceItem => ({
		kind: "extension", scope: "user", source: packageSource ? "package" : "local", id, label: id.split("/").at(-2) ?? id, enabled: true, ...packageSource ? { packageSource } : {},
	});
	const items = [
		item("extensions/next-prompt/index.ts", "/opt/very/long/path/to/the/checkout/packages/tenantext"),
		item("extensions/an-extension-with-a-name-that-is-much-longer-than-the-column/index.ts", "npm:@scope/pi-package@2.13.9"),
		item("builtin:mcp"),
	];
	items[2]!.label = "mcp";
	for (const width of [80, 120]) {
		// The ellipsis of a cut name carries ANSI resets. The columns are compared on the visible text.
		const rows = items.map(row => stripTerminalSequences(formatRow(row, columnsFor(items, width), ["changed"], width)));
		for (const row of rows) assert.ok(!row.includes("\n") && visibleWidth(row) <= width, row);
		assert.equal(new Set(rows.map(row => row.search(/tenantext|npm:|builtin/))).size, 1, rows.join("\n"));
	}
});
