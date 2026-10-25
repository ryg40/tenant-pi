import { basename, dirname, extname } from "node:path";
import { decodeKittyPrintable, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { BUILTIN_PREFIX, itemKey, mcpNote, sourceLabel, stripCredentials, type ResourceItem } from "./inventory.ts";

/** What the browser asks the menu loop to do. The loop opens the browser again after each action that does not end it. */
export type BrowserAction = "save" | "profile" | "apply" | "close";

export interface Group { key: string; title: string; items: ResourceItem[] }

const GROUPS: { key: string; title: string; test: (item: ResourceItem) => boolean }[] = [
	{ key: "extension", title: "Extensions", test: item => item.kind === "extension" && !item.id.startsWith(BUILTIN_PREFIX) },
	{ key: "skill", title: "Skills", test: item => item.kind === "skill" },
	{ key: "prompt", title: "Prompts", test: item => item.kind === "prompt" },
	{ key: "mcp", title: "MCP servers", test: item => item.kind === "mcp" },
	{ key: "builtin", title: "Built-ins", test: item => item.id.startsWith(BUILTIN_PREFIX) },
];

/** Extensions, skills, prompts, MCP servers, built-ins. A group with no item is left out. The order inside a group is the inventory order. */
export function groupItems(items: ResourceItem[]): Group[] {
	return GROUPS.map(({ key, title, test }) => ({ key, title, items: items.filter(test) })).filter(group => group.items.length > 0);
}

/** The package name of a package source: `npm:<name>` without the version, `git:<repo>`, or the directory name of a local path. */
export function packageName(source: string): string {
	const clean = stripCredentials(source).trim().replace(/\/+$/, "");
	if (clean.startsWith("npm:")) return `npm:${clean.slice(4).match(/^(@?[^@]+)/)?.[1] ?? clean.slice(4)}`;
	if (/^(git:|github:|https?:|ssh:)/.test(clean)) return `git:${basename(clean.replace(/[#@][^/]*$/, "")).replace(/\.git$/, "")}`;
	// A local package can be one file, such as `<dir>/index.ts`. Its directory names it.
	return extname(clean) ? basename(dirname(clean)) : basename(clean);
}

/** The source column: the package name, `builtin`, `local`, `mcp` or `override`. */
export function sourceShort(item: ResourceItem): string {
	if (item.packageSource) return packageName(item.packageSource);
	if (item.id.startsWith(BUILTIN_PREFIX)) return "builtin";
	return item.override ? "override" : item.source;
}

const GENERIC = new Set(["src", "dist", "lib"]);

/** The last path segment without `index.ts` and the extension, or the package name where that segment says nothing (`src/index.ts`, a whole package). */
export function shortName(item: ResourceItem): string {
	if (!item.packageSource || !(item.id === "." || GENERIC.has(item.label))) return item.label;
	return packageName(item.packageSource).replace(/^npm:/, "");
}

export interface Columns { name: number; source: number }

/** The name column fits the longest name up to 32 cells. The source column takes the rest, less room for the flags. */
export function columnsFor(items: ResourceItem[], width: number): Columns {
	const longest = (texts: string[]) => texts.reduce((max, text) => Math.max(max, visibleWidth(text)), 0);
	const name = Math.max(8, Math.min(longest(items.map(shortName)), 32));
	return { name, source: Math.max(8, Math.min(longest(items.map(sourceShort)), width - name - 26)) };
}

const fit = (text: string, size: number) => truncateToWidth(text, size, "…", true);

/** One line, never wrapped: `[x] <name> <source> <flags>`. The flags are `project`, `read-only` and `changed`. */
export function formatRow(item: ResourceItem, columns: Columns, flags: string[], width: number): string {
	const mark = `[${item.projectState?.enabled ?? item.enabled ? "x" : " "}]`;
	return truncateToWidth(`  ${mark} ${fit(shortName(item), columns.name)}  ${fit(sourceShort(item), columns.source)}  ${flags.join(" ")}`.trimEnd(), width, "…");
}

/** The detail line of the selected item: kind, scope, source and the full path or id, with the MCP note of `list`. */
export const detailOf = (item: ResourceItem) => `${item.kind} ${item.scope} ${sourceLabel(item)}  ${item.path ?? item.id}${mcpNote(item)}`;

export interface Theme { fg(color: any, text: string): string; bold(text: string): string }
export interface BrowserState { cursor: string; collapsed: Set<string>; filter: string }
export interface BrowserInput {
	items: ResourceItem[];
	original: Map<string, boolean>;
	readOnly: (item: ResourceItem) => boolean;
	state: BrowserState;
	rows: () => number;
	requestRender: () => void;
	done: (action: BrowserAction) => void;
	/** A message for a key that changes nothing, such as a toggle of a read-only item. */
	say: (text: string) => void;
}

/** Lines of the terminal that the browser leaves for its own head and foot and for the Pi editor below it. */
const RESERVED = 10;

type Row = { group: Group; item?: ResourceItem };
const rowKey = (row: Row) => row.item ? itemKey(row.item) : `group:${row.group.key}`;

/** The resource browser: groups with a header and a count, one line per item, a detail line, and the keys in a footer. */
export function createBrowser(input: BrowserInput, theme: Theme) {
	const { items, original, readOnly, state } = input;
	let filtering = false;
	let offset = 0;
	const changed = (item: ResourceItem) => original.get(itemKey(item)) !== item.enabled;
	const matches = (item: ResourceItem) => {
		const needle = state.filter.toLowerCase();
		return !needle || [shortName(item), sourceShort(item), item.id].some(text => text.toLowerCase().includes(needle));
	};
	const visibleRows = (): Row[] => groupItems(items).flatMap(group => {
		const shown = group.items.filter(matches);
		if (shown.length === 0) return [];
		const open = state.filter !== "" || !state.collapsed.has(group.key);
		return [{ group }, ...(open ? shown.map(item => ({ group, item })) : [])];
	});
	const cursorIndex = (rows: Row[]) => Math.max(0, rows.findIndex(row => rowKey(row) === state.cursor));
	const move = (rows: Row[], to: number) => { const row = rows[Math.max(0, Math.min(rows.length - 1, to))]; if (row) state.cursor = rowKey(row); };

	return {
		render(width: number): string[] {
			if (width <= 0) return [];
			const rows = visibleRows();
			const index = cursorIndex(rows);
			move(rows, index);
			const columns = columnsFor(items, width);
			const count = items.filter(changed).length;
			const height = Math.max(3, input.rows() - RESERVED);
			offset = Math.min(Math.max(offset, index - height + 1), index, Math.max(0, rows.length - height));
			const lines = rows.slice(offset, offset + height).map((row, i) => {
				let text: string;
				if (!row.item) {
					const on = row.group.items.filter(item => item.projectState?.enabled ?? item.enabled).length;
					const open = state.filter !== "" || !state.collapsed.has(row.group.key);
					text = theme.bold(`${open ? "▾" : "▸"} ${row.group.title}  ${on} of ${row.group.items.length} on`);
				} else {
					const flags = [...row.item.scope === "project" ? ["project"] : [], ...readOnly(row.item) ? ["read-only"] : [], ...changed(row.item) ? ["changed"] : []];
					text = formatRow(row.item, columns, flags, width - 2);
				}
				return offset + i === index ? theme.fg("accent", `> ${truncateToWidth(text, width - 2, "…")}`) : `  ${text}`;
			});
			const selected = rows[index]?.item;
			const filterLine = filtering ? `Filter: ${state.filter}_  (enter keeps, esc clears)` : state.filter ? `Filter: ${state.filter}` : "";
			const above = offset > 0 ? `  ↑${offset}` : "", below = offset + height < rows.length ? `  ↓${rows.length - offset - height}` : "";
			return [
				theme.fg("accent", theme.bold(`Resources: ${items.length} item(s), ${count} unsaved change(s)${above}${below}`)),
				...lines,
				theme.fg("muted", selected ? detailOf(selected) : rows.length === 0 ? "No item matches." : "Space or enter opens or closes the group."),
				...filterLine ? [filterLine] : [],
				theme.fg("dim", `space toggle · / filter · s save ${count} change(s)`),
				theme.fg("dim", "↑↓ pgup/pgdn move · enter toggle/fold · p profile · a apply · esc close"),
			].map(line => truncateToWidth(line, width, "…"));
		},
		invalidate() {},
		handleInput(data: string): void {
			const rows = visibleRows();
			const index = cursorIndex(rows);
			const row = rows[index];
			const height = Math.max(3, input.rows() - RESERVED);
			const typed = decodeKittyPrintable(data) ?? (data.length === 1 && data >= " " && data !== "\x7f" ? data : undefined);
			if (filtering) {
				if (matchesKey(data, "escape")) { filtering = false; state.filter = ""; }
				else if (matchesKey(data, "enter")) filtering = false;
				else if (matchesKey(data, "backspace")) state.filter = state.filter.slice(0, -1);
				else if (matchesKey(data, "up") || matchesKey(data, "down")) { filtering = false; return this.handleInput(data); }
				else if (typed) state.filter += typed;
			} else if (matchesKey(data, "up")) move(rows, index - 1);
			else if (matchesKey(data, "down")) move(rows, index + 1);
			else if (matchesKey(data, "pageUp")) move(rows, index - height);
			else if (matchesKey(data, "pageDown")) move(rows, index + height);
			else if (matchesKey(data, "home")) move(rows, 0);
			else if (matchesKey(data, "end")) move(rows, rows.length - 1);
			// Esc clears a kept filter first. A second Esc closes.
			else if (matchesKey(data, "escape")) { if (!state.filter) return input.done("close"); state.filter = ""; }
			else if (row && (matchesKey(data, "space") || matchesKey(data, "enter") || typed === " ")) {
				if (!row.item) { if (!state.collapsed.delete(row.group.key)) state.collapsed.add(row.group.key); }
				else if (readOnly(row.item)) input.say("Project items are read-only. Change the project files by hand.");
				else row.item.enabled = !row.item.enabled;
			} else if (typed === "/") filtering = true;
			else if (typed === "s") return input.done("save");
			else if (typed === "p") return input.done("profile");
			else if (typed === "a") return input.done("apply");
			input.requestRender();
		},
	};
}
