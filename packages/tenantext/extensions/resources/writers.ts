/*
 * How the reviewed Pi source matches resource arrays and package filter lists.
 * Source: @earendil-works/pi-coding-agent 1.0.3, dist/core/package-manager.js (line numbers of that file).
 * The cited files are byte-equal to those of Pi 1.0.2, so the line numbers are the same.
 * This is historical source evidence, not a qualification of the current kit pin.
 *
 * - Entry classes (132-140): an entry that starts with `!`, `+` or `-` is an override. A plain entry with `*` or `?`
 *   is an include glob. Any other plain entry is a path.
 * - `!glob` (matchesAnyPattern, 473-495): minimatch on the path relative to the base directory, on the file name
 *   and on the full path. For a `SKILL.md` it also matches the skill directory (relative, name, full).
 * - `+path` and `-path` (normalizeExactPattern and matchesAnyExactPattern, 496-519): string equality after a leading `./` is removed, on the
 *   relative path or the full path. For a `SKILL.md` the skill directory matches too. No glob.
 * - Conventional directories and built-ins (isEnabledByOverrides, 523-539; callers 737-743 and 2028-2066): enabled,
 *   then `!` turns off, then `+` turns on, then `-` turns off. The base directory is the agent directory (user) or
 *   `.pi` (project). `~/.agents/skills` uses `~/.agents` as its base (2058-2064). A built-in is the literal path
 *   `builtin:<name>`, so `-builtin:mcp` turns it off (737-743).
 * - Explicit array entries (resolveLocalEntries, 1972-1985) and package filter lists (applyPackageFilter, 1903-1918)
 *   use applyPatterns (548-592): plain entries include, and NO plain entry means ALL files; then `!` excludes;
 *   then `+` adds back; then `-` removes.
 * - A list that holds only negative patterns therefore means "all files except these". It does not mean "none".
 *   So a package item goes off with one `!<id>` entry and no positive list is needed.
 * - `[]` in a package filter means none (1905-1911). A missing key means all (1859-1861). So when the last entry
 *   of a filter list goes away, the key must go away too; an empty list would turn every file off.
 * - A list that holds only `+path` entries also means all files, because `+` is not an include. To turn one file
 *   on in a `[]` list, the plain path is the correct entry.
 * - `autoload: false` on a package entry (1853-1855, 1919-1928, 593-606) changes the list to a delta: only matching
 *   files are listed, and the last matching entry wins.
 * - The first entry for a path wins (addResource, 2102-2108). The order is packages, explicit entries, conventional
 *   directories, built-ins; project before user (704-745).
 * - MCP (docs/mcp.md lines 32, 69, 90): `enabled: false` on a `mcpServers.<name>` entry keeps the entry without a
 *   connection. Pi writes the state to the file that defines the server. From Pi 1.0.1 a project entry without
 *   `command`, `url` or `type` is an override of the user server (docs/mcp.md line 34;
 *   dist/extensions/mcp/config.js 36-40 and 64-82). Pi merges it over the user entry and keeps an explicit
 *   `enabled` value on it (123-138). inventory.ts models the merge where `builtin:mcp` is on. Pi reads the project
 *   file only for a trusted project (105-117); the component does not read the trust state.
 *
 * Status: read in the source and verified. The functions in inventory.ts repeat these rules, with a small glob
 * matcher in place of minimatch. test/resources-inventory.test.ts compares the inventory with the result of
 * `DefaultPackageManager.resolve()` of the installed Pi on four settings files, and the MCP rows with the result of
 * `loadMcpConfig()` of the installed Pi. Not verified against Pi: MCP state in a live session, and globs outside `*`, `**`, `?`, `[...]`, `{a,b}`.
 *
 * File format on write. Pi writes settings.json with `JSON.stringify(x, null, 2)` and no trailing newline
 * (dist/core/settings-manager.js 447 and 146), and mcp.json with the indent of the file and a trailing newline
 * (dist/extensions/mcp/config.js 190-192). The writer here keeps the indent and the trailing-newline state of the text
 * that it read, so off then on gives the same bytes. A new file gets 2 spaces and a trailing newline.
 * Still not byte-equal after off then on, because the text goes through JSON.parse and JSON.stringify:
 * - a number such as `1.0` becomes `1`, and an escape such as `\u00e9` becomes the character;
 * - CRLF line ends become LF, and a file with mixed indent or with objects on one line gets one indent;
 * - an original empty array (`"extensions": []`, or `[]` left after the last entry goes away) and an explicit
 *   `"enabled": true` on an MCP entry are lost on turn-on. The writer always deletes a resource array or a package
 *   filter list when its last entry goes away, and always deletes `enabled` when a server goes on, as the `/mcp`
 *   command of Pi does (dist/extensions/mcp/config.js 133-137, for an entry that defines a server). This is a no-op for Pi: an empty root array and a
 *   missing key mean the same, and so do `enabled: true` and a missing key.
 */
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	AGENTS_PREFIX, FILE_KEYS, TYPE_OF_KIND, filePaths, hasGlobChars, inventoryFromParsed, isObject, itemKey, matchesAnyPattern,
	normalizeExact, packageSourceOf, parseFiles,
	type Dirs, type Files, type Json, type Parsed, type ResourceItem, type ResourceType,
} from "./inventory.ts";

export interface PlanOptions { writeProject?: boolean }
export type DesiredItem = Pick<ResourceItem, "kind" | "scope" | "source" | "packageSource" | "id" | "enabled">;
export interface Write { file: string; content: string }
export interface Plan {
	/** Items that change, with the new state. */
	changes: ResourceItem[];
	writes: Write[];
	notes: string[];
}

/** Keep the indent and the trailing-newline state of the text that was read. A new file gets 2 spaces and a newline. */
export function serialize(value: Json, original?: string): string {
	const indent = (original && /^([ \t]+)\S/m.exec(original)?.[1]) || "  ";
	return JSON.stringify(value, null, indent) + (original === undefined || original.trim() === "" || original.endsWith("\n") ? "\n" : "");
}

/**
 * The items of `desired` whose state differs from the inventory, with the desired state.
 * An MCP override that does not set `enabled` takes its state from the user row. It is not a change
 * when the desired state of the user row already gives its desired state.
 */
export function diffItems(inventory: ResourceItem[], desired: DesiredItem[]): ResourceItem[] {
	const want = new Map(desired.map(item => [itemKey(item), item.enabled]));
	const fromUserRow = (item: ResourceItem) => {
		if (!item.override || item.override.ignored || item.override.setsEnabled) return false;
		const user = inventory.find(other => other.kind === "mcp" && other.scope === "user" && other.id === item.id && !other.override);
		return !!user && (want.get(itemKey(user)) ?? user.enabled) === want.get(itemKey(item));
	};
	return inventory.filter(item => want.has(itemKey(item)) && want.get(itemKey(item)) !== item.enabled && !fromUserRow(item))
		.map(item => ({ ...item, enabled: !item.enabled }));
}

/**
 * Compute the new file contents for a desired state. Nothing is written here.
 * A malformed file throws ResourceFileError. A file with no change is not in `writes`.
 */
export function planWrites(dirs: Dirs, files: Files, desired: DesiredItem[], options: PlanOptions = {}): Plan {
	const parsed = parseFiles(dirs, files);
	const before = Object.fromEntries(FILE_KEYS.map(key => [key, JSON.stringify(parsed[key])]));
	const inventory = inventoryFromParsed(dirs, parsed);
	const notes: string[] = [];
	const attempted: ResourceItem[] = [];
	for (const change of diffItems(inventory, desired)) {
		if (change.scope === "project" && !options.writeProject) {
			notes.push(`Project item left unchanged: ${change.kind} ${change.id}.`);
			continue;
		}
		setItem(dirs, parsed, inventory, change);
		attempted.push(change);
	}
	const afterItems = inventoryFromParsed(dirs, parsed);
	const after = new Map(afterItems.map(item => [itemKey(item), item.enabled]));
	const changes = attempted.filter(change => after.get(itemKey(change)) === change.enabled);
	for (const change of attempted) if (!changes.includes(change)) notes.push(`Pi has no setting that changes this item: ${change.kind} ${change.id}.`);
	const paths = filePaths(dirs);
	// A write to the user file does not change what Pi does in a project whose file decides the state.
	for (const change of attempted) {
		const decided = change.kind === "mcp" && change.scope === "user" ? afterItems.find(item => itemKey(item) === itemKey(change))?.projectState : undefined;
		if (decided?.by === "override") notes.push(`In a trusted project, the project override in ${paths.projectMcp} keeps mcp ${change.id} ${decided.enabled ? "on" : "off"}.`);
		else if (decided) notes.push(`The project server in ${paths.projectMcp} replaces mcp ${change.id} in this project, when the project is trusted.`);
	}
	const writes = FILE_KEYS.filter(key => JSON.stringify(parsed[key]) !== before[key]).map(key => ({ file: paths[key], content: serialize(parsed[key], files[key]) }));
	return { changes, writes, notes };
}

/** Write in place, as Pi does. A symlink stays a symlink and the file keeps its mode. */
export function commitWrites(writes: Write[]): void {
	for (const { file, content } of writes) {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(existsSync(file) ? realpathSync(file) : file, content);
	}
}

function setItem(dirs: Dirs, parsed: Parsed, inventory: ResourceItem[], change: ResourceItem): void {
	const user = change.scope === "user";
	if (change.kind === "mcp") return setMcp(user ? parsed.userMcp : parsed.projectMcp, change);
	const settings = user ? parsed.userSettings : parsed.projectSettings;
	const stillOff = () => inventoryFromParsed(dirs, parsed).find(item => itemKey(item) === itemKey(change))?.enabled === false;
	if (change.source === "package") setPackage(settings, change, stillOff);
	else setLocal(dirs, settings, inventory, change, stillOff);
}

const exact = (entry: string, prefix: string, target: string) => entry.startsWith(prefix) && normalizeExact(entry.slice(1)) === target;

/** Local file or built-in: `-<id>` in the resource array of the item's scope. */
function setLocal(dirs: Dirs, settings: Json, inventory: ResourceItem[], change: ResourceItem, stillOff: () => boolean): void {
	const type: ResourceType = TYPE_OF_KIND[change.kind as keyof typeof TYPE_OF_KIND];
	const agents = change.id.startsWith(AGENTS_PREFIX);
	// Pi matches a `~/.agents/skills` item relative to `~/.agents`.
	const target = agents ? change.id.slice(AGENTS_PREFIX.length) : change.id;
	const base = agents ? join(dirs.homeDir ?? homedir(), ".agents") : change.scope === "user" ? dirs.agentDir : dirs.projectDir;
	let list: unknown[] = Array.isArray(settings[type]) ? settings[type] : [];
	const isEntry = (entry: unknown, prefix: string) => typeof entry === "string" && exact(entry, prefix, target);
	if (!change.enabled) {
		list = list.filter(entry => !isEntry(entry, "+"));
		list.push(`-${target}`);
		settings[type] = list;
		return;
	}
	const siblings = inventory.filter(item => item.source === "local" && item.kind === change.kind && item.scope === change.scope && itemKey(item) !== itemKey(change));
	const onlyThis = (entry: unknown) => typeof entry === "string" && entry.startsWith("!")
		&& matchesAnyPattern(change.path ?? change.id, [entry.slice(1)], base)
		&& !siblings.some(item => matchesAnyPattern(item.path ?? item.id, [entry.slice(1)], base));
	const kept = list.filter(entry => !isEntry(entry, "-") && !onlyThis(entry));
	if (kept.length === 0 && list.length > 0) delete settings[type];
	else settings[type] = kept;
	// A `!glob` that also covers other items stays. `+path` wins over it.
	if (stillOff()) settings[type] = [...kept, `+${target}`];
}

/** Package item: `!<id>` in the per-package filter list of the item's type. */
function setPackage(settings: Json, change: ResourceItem, stillOff: () => boolean): void {
	const packages: unknown[] = Array.isArray(settings.packages) ? settings.packages : [];
	const index = packages.findIndex(pkg => packageSourceOf(pkg as string | Json) === change.packageSource);
	if (index < 0) return;
	const type: ResourceType = TYPE_OF_KIND[change.kind as keyof typeof TYPE_OF_KIND];
	const entry = packages[index];
	const pkg: Json = typeof entry === "string" ? { source: entry } : entry as Json;
	packages[index] = pkg;
	const id = change.id;
	const delta = pkg.autoload === false;
	const list: unknown[] | undefined = Array.isArray(pkg[type]) ? pkg[type] : undefined;
	const without = (...prefixes: string[]) => (list ?? []).filter(item => !(typeof item === "string" && (prefixes.some(prefix => exact(item, prefix, id)) || (prefixes.includes("") && item === id))));
	if (delta) {
		// The list is a delta over the user entry: the last matching entry wins.
		pkg[type] = change.enabled ? [...without("-", "!"), `+${id}`] : [...without("+", ""), `-${id}`];
		return;
	}
	if (!change.enabled) {
		// A glob character in the id would change what `!` matches. `-` is an exact match.
		const off = hasGlobChars(id) ? `-${id}` : `!${id}`;
		pkg[type] = list?.length === 1 && list[0] === id ? [] : [...without("+"), off];
		return;
	}
	const kept = without("-", "!");
	if (kept.length === 0 && (list?.length ?? 0) > 0) delete pkg[type];
	else {
		pkg[type] = kept;
		// `[]` and lists with plain entries need the plain path. A broad `!glob` needs `+path`.
		if (stillOff()) pkg[type] = [...kept, kept.some(item => typeof item === "string" && !/^[!+-]/.test(item)) || kept.length === 0 ? id : `+${id}`];
	}
	if (Object.keys(pkg).length === 1 && typeof pkg.source === "string") packages[index] = pkg.source;
}

/**
 * MCP server: `enabled: false` on the entry. An entry in `disabledMcpServers` moves to `mcpServers` when it goes on.
 * A project override gets an explicit `enabled: true` or `enabled: false`, as Pi writes it: a deleted key would
 * give the state of the user file. An override that Pi ignores stays unchanged.
 */
function setMcp(mcp: Json, change: ResourceItem): void {
	const name = change.id;
	if (change.override) {
		if (!change.override.ignored) mcp.mcpServers[name].enabled = change.enabled;
		return;
	}
	if (isObject(mcp.mcpServers) && isObject(mcp.mcpServers[name])) {
		if (change.enabled) delete mcp.mcpServers[name].enabled;
		else mcp.mcpServers[name].enabled = false;
		return;
	}
	const disabled = mcp.disabledMcpServers;
	if (!change.enabled || !isObject(disabled) || !isObject(disabled[name])) return;
	if (!isObject(mcp.mcpServers)) mcp.mcpServers = {};
	const entry = disabled[name];
	delete entry.enabled;
	mcp.mcpServers[name] = entry;
	delete disabled[name];
	if (Object.keys(disabled).length === 0) delete mcp.disabledMcpServers;
}
