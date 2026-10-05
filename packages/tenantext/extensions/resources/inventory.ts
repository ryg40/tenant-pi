import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type Kind = "extension" | "skill" | "prompt" | "mcp";
export type Scope = "user" | "project";
export type ResourceType = "extensions" | "skills" | "prompts";

export interface ResourceItem {
	kind: Kind;
	scope: Scope;
	source: "local" | "package" | "mcp";
	packageSource?: string;
	id: string;
	label: string;
	enabled: boolean;
	path?: string;
	/** MCP user row whose state the project file decides in a trusted project. `enabled` stays the state of the user file. */
	projectState?: { by: "override" | "server"; enabled: boolean };
	/** MCP project row that is an override of the user server, not a server. `enabled` is the state after the merge. */
	override?: { ignored?: string; setsEnabled: boolean };
}

/** `agentDir` is the user Pi directory, `projectDir` is `<cwd>/.pi`, `homeDir` holds `.agents/skills`. */
export interface Dirs { agentDir: string; projectDir: string; homeDir?: string }

/** Raw file contents. `undefined` means that the file does not exist. */
export interface Files { userSettings?: string; projectSettings?: string; userMcp?: string; projectMcp?: string }

export type Json = Record<string, any>;
export interface Parsed { userSettings: Json; projectSettings: Json; userMcp: Json; projectMcp: Json }

export const FILE_KEYS = ["userSettings", "projectSettings", "userMcp", "projectMcp"] as const;
export const BUILTIN_EXTENSIONS = ["mcp", "llama.cpp", "codemode", "tool-search"];
export const BUILTIN_PREFIX = "builtin:";
export const AGENTS_PREFIX = "~/.agents/";
export const TYPE_OF_KIND: Record<Exclude<Kind, "mcp">, ResourceType> = { extension: "extensions", skill: "skills", prompt: "prompts" };
const KIND_OF_TYPE: Record<ResourceType, Exclude<Kind, "mcp">> = { extensions: "extension", skills: "skill", prompts: "prompt" };
const RESOURCE_TYPES: ResourceType[] = ["extensions", "skills", "prompts"];

/** A settings or mcp file that is not a JSON object. `file` is the path to show to the user. */
export class ResourceFileError extends Error {
	file: string;
	constructor(file: string, detail: string) {
		super(`${file} is not valid: ${detail}. Nothing was written.`);
		this.file = file;
	}
}

export function filePaths(dirs: Dirs): Record<(typeof FILE_KEYS)[number], string> {
	return {
		userSettings: join(dirs.agentDir, "settings.json"),
		projectSettings: join(dirs.projectDir, "settings.json"),
		userMcp: join(dirs.agentDir, "mcp.json"),
		projectMcp: join(dirs.projectDir, "mcp.json"),
	};
}

export function readFiles(dirs: Dirs): Files {
	const files: Files = {};
	const paths = filePaths(dirs);
	for (const key of FILE_KEYS) if (existsSync(paths[key])) files[key] = readFileSync(paths[key], "utf8");
	return files;
}

export function parseFiles(dirs: Dirs, files: Files): Parsed {
	const paths = filePaths(dirs);
	const parsed = {} as Parsed;
	for (const key of FILE_KEYS) {
		const text = files[key];
		if (text === undefined || text.trim() === "") { parsed[key] = {}; continue; }
		let value: unknown;
		try { value = JSON.parse(text.replace(/^﻿/, "")); }
		catch (error) { throw new ResourceFileError(paths[key], (error as Error).message); }
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new ResourceFileError(paths[key], "the top level is not an object");
		parsed[key] = value as Json;
	}
	return parsed;
}

export const itemKey = (item: Pick<ResourceItem, "kind" | "scope" | "source" | "packageSource" | "id">) =>
	[item.kind, item.scope, item.source, item.packageSource ?? "", item.id].join("|");

const posix = (path: string) => path.split(sep).join("/");
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

// ---------------------------------------------------------------------------
// Pattern matching. See the comment at the top of writers.ts for the Pi source.
// ---------------------------------------------------------------------------

/** Subset of minimatch: `*`, `**`, `?`, `[...]`, `{a,b}`. `*` and `?` do not match a leading dot. */
export function globToRegExp(glob: string): RegExp {
	let out = "";
	let braces = 0;
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i]!;
		const segmentStart = i === 0 || glob[i - 1] === "/";
		if (c === "*") {
			if (glob[i + 1] === "*" && segmentStart && (glob[i + 2] === "/" || i + 2 === glob.length)) {
				out += glob[i + 2] === "/" ? "(?:(?!\\.)[^/]+/)*" : "(?:(?!\\.)[^/]+(?:/|$))*";
				i += glob[i + 2] === "/" ? 2 : 1;
			} else {
				while (glob[i + 1] === "*") i++;
				out += `${segmentStart ? "(?!\\.)" : ""}[^/]*`;
			}
		} else if (c === "?") out += `${segmentStart ? "(?!\\.)" : ""}[^/]`;
		else if (c === "[") {
			const end = glob.indexOf("]", i + 2);
			if (end < 0) out += "\\[";
			else {
				const body = glob.slice(i + 1, end).replace(/\\/g, "\\\\").replace(/^!/, "^");
				out += `[${body}]`;
				i = end;
			}
		} else if (c === "{" && glob.indexOf("}", i) > i) { out += "(?:"; braces++; }
		else if (c === "}" && braces > 0) { out += ")"; braces--; }
		else if (c === "," && braces > 0) out += "|";
		else out += c.replace(/[.+^$()|\\{}\]]/g, "\\$&");
	}
	try { return new RegExp(`^${out}$`); } catch { return /^(?!)$/; }
}

export const hasGlobChars = (text: string) => /[*?[\]{}()!+@]/.test(text);

interface Targets { rel: string; name: string; full: string; parentRel?: string; parentName?: string; parentFull?: string }

function targets(filePath: string, baseDir: string): Targets {
	if (filePath.startsWith(BUILTIN_PREFIX)) return { rel: filePath, name: filePath, full: filePath };
	const name = basename(filePath);
	const t: Targets = { rel: posix(relative(baseDir, filePath)), name, full: posix(filePath) };
	if (name === "SKILL.md") {
		const parent = dirname(filePath);
		t.parentRel = posix(relative(baseDir, parent));
		t.parentName = basename(parent);
		t.parentFull = posix(parent);
	}
	return t;
}

/** Glob match on the relative path, the file name or the full path; a SKILL.md also matches through its directory. */
export function matchesAnyPattern(filePath: string, patterns: string[], baseDir: string): boolean {
	const t = targets(filePath, baseDir);
	return patterns.some(pattern => {
		const re = globToRegExp(posix(pattern));
		return [t.rel, t.name, t.full, t.parentRel, t.parentName, t.parentFull].some(value => value !== undefined && re.test(value));
	});
}

export const normalizeExact = (pattern: string) => posix(pattern.startsWith("./") || pattern.startsWith(".\\") ? pattern.slice(2) : pattern);

/** Exact match on the relative path or the full path; a SKILL.md also matches through its directory. */
export function matchesAnyExact(filePath: string, patterns: string[], baseDir: string): boolean {
	const t = targets(filePath, baseDir);
	return patterns.some(pattern => {
		const normalized = normalizeExact(pattern);
		return normalized === t.rel || normalized === t.full || (t.parentRel !== undefined && (normalized === t.parentRel || normalized === t.parentFull));
	});
}

export const isOverride = (entry: string) => entry.startsWith("!") || entry.startsWith("+") || entry.startsWith("-");
const isPattern = (entry: string) => isOverride(entry) || entry.includes("*") || entry.includes("?");

/** Auto-discovered files and built-ins: enabled unless `!glob` matches; `+path` wins over `!`; `-path` wins over both. */
export function isEnabledByOverrides(filePath: string, entries: string[], baseDir: string): boolean {
	const pick = (prefix: string) => entries.filter(entry => entry.startsWith(prefix)).map(entry => entry.slice(1));
	let enabled = !matchesAnyPattern(filePath, pick("!"), baseDir);
	if (matchesAnyExact(filePath, pick("+"), baseDir)) enabled = true;
	if (matchesAnyExact(filePath, pick("-"), baseDir)) enabled = false;
	return enabled;
}

/** Filter lists: plain entries include (none means all), then `!` excludes, `+` adds back, `-` removes. */
export function applyPatterns(allPaths: string[], patterns: string[], baseDir: string): Set<string> {
	const includes = patterns.filter(p => !isOverride(p));
	const pick = (prefix: string) => patterns.filter(p => p.startsWith(prefix)).map(p => p.slice(1));
	let result = includes.length ? allPaths.filter(path => matchesAnyPattern(path, includes, baseDir)) : [...allPaths];
	const excludes = pick("!");
	result = result.filter(path => !matchesAnyPattern(path, excludes, baseDir));
	const forceIncludes = pick("+");
	for (const path of allPaths) if (!result.includes(path) && matchesAnyExact(path, forceIncludes, baseDir)) result.push(path);
	const forceExcludes = pick("-");
	return new Set(result.filter(path => !matchesAnyExact(path, forceExcludes, baseDir)));
}

/** The last matching entry wins. Used for `autoload: false` packages and project overrides of built-ins. */
export function applyDeltaPatterns(allPaths: string[], patterns: string[], baseDir: string): Map<string, boolean> {
	const result = new Map<string, boolean>();
	for (const pattern of patterns) {
		const target = isOverride(pattern) ? pattern.slice(1) : pattern;
		const enabled = !pattern.startsWith("-") && !pattern.startsWith("!");
		const exact = pattern.startsWith("+") || pattern.startsWith("-");
		for (const path of allPaths) {
			if (exact ? matchesAnyExact(path, [target], baseDir) : matchesAnyPattern(path, [target], baseDir)) result.set(path, enabled);
		}
	}
	return result;
}

// ---------------------------------------------------------------------------
// File discovery, as Pi does it. Ignore files (.gitignore, .ignore, .fdignore) are not read.
// ---------------------------------------------------------------------------

interface Entry { name: string; full: string; isDir: boolean; isFile: boolean }

function list(dir: string): Entry[] {
	const out: Entry[] = [];
	let names: string[];
	try { names = readdirSync(dir).sort(); } catch { return out; }
	for (const name of names) {
		const full = join(dir, name);
		try {
			const stats = statSync(full);
			out.push({ name, full, isDir: stats.isDirectory(), isFile: stats.isFile() });
		} catch { /* broken link */ }
	}
	return out;
}

const visible = (entry: Entry) => !entry.name.startsWith(".") && entry.name !== "node_modules";

function manifestOf(packageRoot: string): Partial<Record<ResourceType, string[]>> | null {
	try {
		const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8").replace(/^﻿/, ""));
		if (!pkg || typeof pkg !== "object" || !pkg.pi || typeof pkg.pi !== "object" || Array.isArray(pkg.pi)) return null;
		const manifest: Partial<Record<ResourceType, string[]>> = {};
		for (const type of RESOURCE_TYPES) {
			const entries = pkg.pi[type];
			if (Array.isArray(entries) && entries.every(entry => typeof entry === "string")) manifest[type] = entries;
		}
		return manifest;
	} catch { return null; }
}

function extensionEntries(dir: string): string[] | null {
	const declared = manifestOf(dir)?.extensions?.map(entry => resolve(dir, entry)).filter(existsSync);
	if (declared?.length) return declared;
	for (const name of ["index.ts", "index.js"]) if (existsSync(join(dir, name))) return [join(dir, name)];
	return null;
}

function autoExtensions(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const root = extensionEntries(dir);
	if (root) return root;
	const out: string[] = [];
	for (const entry of list(dir).filter(visible)) {
		if (entry.isFile && /\.(ts|js)$/.test(entry.name)) out.push(entry.full);
		else if (entry.isDir) out.push(...extensionEntries(entry.full) ?? []);
	}
	return out;
}

/** Mode `pi`: Markdown files directly in the root count. Mode `agents`: Markdown files below the root count. */
function skillEntries(dir: string, mode: "pi" | "agents", root = dir): string[] {
	const entries = list(dir);
	const skillFile = entries.find(entry => entry.name === "SKILL.md" && entry.isFile);
	if (skillFile) return [skillFile.full];
	const out: string[] = [];
	for (const entry of entries.filter(visible)) {
		if (entry.isFile && entry.name.endsWith(".md") && (mode === "pi" ? dir === root : dir !== root)) out.push(entry.full);
		else if (entry.isDir) out.push(...skillEntries(entry.full, mode, root));
	}
	return out;
}

function markdownFiles(dir: string, recursive: boolean): string[] {
	const out: string[] = [];
	for (const entry of list(dir).filter(visible)) {
		if (entry.isFile && entry.name.endsWith(".md")) out.push(entry.full);
		else if (entry.isDir && recursive) out.push(...markdownFiles(entry.full, true));
	}
	return out;
}

function resourceFiles(dir: string, type: ResourceType): string[] {
	if (type === "skills") return skillEntries(dir, "pi");
	if (type === "extensions") return autoExtensions(dir);
	return markdownFiles(dir, true);
}

function filesFromPaths(paths: string[], type: ResourceType): string[] {
	const out: string[] = [];
	for (const path of paths) {
		try {
			const stats = statSync(path);
			if (stats.isFile()) out.push(path);
			else if (stats.isDirectory()) out.push(...resourceFiles(path, type));
		} catch { /* missing path */ }
	}
	return out;
}

/** Expand a manifest glob below `root`. Hidden path segments do not match. */
function expandGlob(pattern: string, root: string): string[] {
	const re = globToRegExp(posix(pattern.replace(/^\.\//, "")));
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const entry of list(dir).filter(visible)) {
			if (re.test(posix(relative(root, entry.full)))) out.push(entry.full);
			if (entry.isDir) walk(entry.full);
		}
	};
	walk(root);
	return out.sort();
}

function manifestFiles(entries: string[], root: string, type: ResourceType): string[] {
	const sources = entries.filter(entry => !isOverride(entry));
	return filesFromPaths(sources.flatMap(entry => /[*?]/.test(entry) ? expandGlob(entry, root) : [resolve(root, entry)]), type);
}

/** The files of one type that a package offers, after the package's own manifest patterns. */
function packageFiles(packageRoot: string, type: ResourceType): string[] {
	const entries = manifestOf(packageRoot)?.[type];
	if (entries?.length) {
		const all = manifestFiles(entries, packageRoot, type);
		const own = entries.filter(isOverride);
		return own.length ? [...applyPatterns(all, own, packageRoot)] : all;
	}
	const dir = join(packageRoot, type);
	return existsSync(dir) ? resourceFiles(dir, type) : [];
}

// ---------------------------------------------------------------------------
// Package sources.
// ---------------------------------------------------------------------------

export function resolveFrom(input: string, baseDir: string, homeDir: string): string {
	let path = input.trim();
	if (path.startsWith("file://")) path = decodeURIComponent(path.slice("file://".length));
	if (path === "~") path = homeDir;
	else if (path.startsWith("~/")) path = join(homeDir, path.slice(2));
	return isAbsolute(path) ? resolve(path) : resolve(baseDir, path);
}

const NON_LOCAL = /^(npm:|git:|github:|https?:|ssh:|builtin:)/;

/** Where a package source is installed below the scope directory. `undefined` when the source cannot be read. */
export function packageRoot(source: string, baseDir: string, homeDir: string): { type: "npm" | "git" | "local"; root: string; identity: string } | undefined {
	const trimmed = source.trim();
	if (trimmed.startsWith("npm:")) {
		const spec = trimmed.slice(4).trim();
		const name = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/)?.[1] ?? spec;
		return { type: "npm", root: join(baseDir, "npm", "node_modules", name), identity: `npm:${name}` };
	}
	if (!NON_LOCAL.test(trimmed)) {
		const root = resolveFrom(trimmed, baseDir, homeDir);
		return { type: "local", root, identity: `local:${root}` };
	}
	// Git: `<scope dir>/git/<host>/<user>/<project>`. A ref after `@` or `#` does not change the directory.
	let url = trimmed.replace(/^git:/, "").trim();
	if (url.startsWith("github:")) url = `github.com/${url.slice(7)}`;
	url = url.replace(/^[a-z+]+:\/\//i, "").replace(/^[^@/]+@/, "").replace(/#.*$/, "");
	const match = url.match(/^([^/:]+)(?::\d+)?[/:](.+?)(?:\.git)?(?:@[^/]*)?\/?$/);
	if (!match) return undefined;
	const path = match[2]!.replace(/\.git$/, "");
	return { type: "git", root: join(baseDir, "git", match[1]!, path), identity: `git:${match[1]}/${path}` };
}

export type PackageEntry = string | Json;
export const packageSourceOf = (pkg: PackageEntry): string | undefined => typeof pkg === "string" ? pkg : typeof pkg?.source === "string" ? pkg.source : undefined;

// ---------------------------------------------------------------------------
// Inventory.
// ---------------------------------------------------------------------------

/** A SKILL.md is named by its directory. Pi matches `-path` and `!glob` through the directory too. */
const idPath = (filePath: string) => basename(filePath) === "SKILL.md" ? dirname(filePath) : filePath;

function labelOf(filePath: string): string {
	const name = basename(idPath(filePath));
	return /^index\.(ts|js)$/.test(name) ? basename(dirname(filePath)) : name.replace(/\.(ts|js|md)$/, "");
}

export function buildInventory(dirs: Dirs, files: Files): ResourceItem[] {
	return inventoryFromParsed(dirs, parseFiles(dirs, files));
}

export function inventoryFromParsed(dirs: Dirs, parsed: Parsed): ResourceItem[] {
	const homeDir = dirs.homeDir ?? homedir();
	const baseOf = (scope: Scope) => scope === "user" ? dirs.agentDir : dirs.projectDir;
	const settingsOf = (scope: Scope) => scope === "user" ? parsed.userSettings : parsed.projectSettings;
	const items: ResourceItem[] = [];
	// Pi keeps the first entry for a path, per resource type.
	const seen = new Set<string>();
	const add = (type: ResourceType, path: string, item: Omit<ResourceItem, "kind" | "label" | "path">) => {
		if (seen.has(`${type}|${path}`)) return;
		seen.add(`${type}|${path}`);
		const builtin = path.startsWith(BUILTIN_PREFIX);
		items.push({ kind: KIND_OF_TYPE[type], ...item, label: builtin ? path.slice(BUILTIN_PREFIX.length) : labelOf(path), ...(builtin ? {} : { path }) });
	};

	// 1. Packages. Project entries come first, and a project entry replaces a user entry with the same identity.
	const packages: { pkg: PackageEntry; scope: Scope; root: string; type: string; identity: string }[] = [];
	for (const scope of ["project", "user"] as Scope[]) {
		const entries = settingsOf(scope).packages;
		for (const pkg of Array.isArray(entries) ? entries as PackageEntry[] : []) {
			const source = packageSourceOf(pkg);
			const where = source === undefined ? undefined : packageRoot(source, baseOf(scope), homeDir);
			if (!where) continue;
			const earlier = packages.find(other => other.identity === where.identity);
			const delta = earlier && typeof earlier.pkg === "object" && earlier.pkg.autoload === false;
			if (earlier && !(earlier.scope === "project" && scope === "user" && delta)) continue;
			packages.push({ pkg, scope, ...where });
		}
	}
	for (const entry of packages) {
		const { pkg, scope } = entry;
		// A project entry with `autoload: false` is a delta over the user entry and reads the user install.
		const deltaBase = scope === "project" && typeof pkg === "object" && pkg.autoload === false
			? packages.find(other => other.scope === "user" && other.identity === entry.identity) : undefined;
		const root = deltaBase?.root ?? entry.root;
		const source = packageSourceOf(pkg)!;
		const meta = { scope, source: "package" as const, packageSource: source };
		let stats;
		try { stats = statSync(root); } catch { continue; }
		if (stats.isFile()) { add("extensions", root, { ...meta, id: basename(root), enabled: true }); continue; }
		const filter = typeof pkg === "object" ? pkg : undefined;
		let any = false;
		const manifest = manifestOf(root);
		for (const type of RESOURCE_TYPES) {
			// With no filter object, a manifest that omits a type offers nothing of that type.
			const all = !filter && manifest && !manifest[type] ? [] : packageFiles(root, type);
			const idOf = (path: string) => posix(relative(root, idPath(path)));
			const patterns = filter && Array.isArray(filter[type]) ? strings(filter[type]) : undefined;
			if (filter?.autoload === false) {
				for (const [path, enabled] of applyDeltaPatterns(all, patterns ?? [], root)) add(type, path, { ...meta, id: idOf(path), enabled });
				any = true;
			} else {
				const enabled = patterns === undefined ? new Set(all) : patterns.length === 0 ? new Set<string>() : applyPatterns(all, patterns, root);
				for (const path of all) add(type, path, { ...meta, id: idOf(path), enabled: enabled.has(path) });
				any ||= all.length > 0 || filter !== undefined || existsSync(join(root, type));
			}
		}
		// A directory with no resources loads as one extension. Pi has no filter for it.
		if (!any && !manifest) add("extensions", root, { ...meta, id: ".", enabled: true });
	}

	// 2. Explicit entries of the resource arrays, project first.
	for (const type of RESOURCE_TYPES) {
		for (const scope of ["project", "user"] as Scope[]) {
			const entries = strings(settingsOf(scope)[type]);
			const base = baseOf(scope);
			const plain = entries.filter(entry => !isPattern(entry)).map(entry => resolveFrom(entry, base, homeDir));
			const all = filesFromPaths(plain, type);
			const enabled = applyPatterns(all, entries.filter(isPattern), base);
			for (const path of all) add(type, path, { scope, source: "local", id: posix(relative(base, idPath(path))), enabled: enabled.has(path) });
		}
	}

	// 3. Conventional directories, project first. `~/.agents/skills` belongs to the user scope with its own base.
	const auto = (type: ResourceType, scope: Scope, paths: string[], base: string, prefix = "") => {
		const overrides = strings(settingsOf(scope)[type]);
		for (const path of paths) add(type, path, { scope, source: "local", id: prefix + posix(relative(base, idPath(path))), enabled: isEnabledByOverrides(path, overrides, base) });
	};
	for (const scope of ["project", "user"] as Scope[]) {
		const base = baseOf(scope);
		auto("extensions", scope, autoExtensions(join(base, "extensions")), base);
		auto("skills", scope, skillEntries(join(base, "skills"), "pi"), base);
		if (scope === "user") {
			const agents = join(homeDir, ".agents");
			auto("skills", scope, skillEntries(join(agents, "skills"), "agents"), agents, AGENTS_PREFIX);
		}
		auto("prompts", scope, markdownFiles(join(base, "prompts"), false), base);
	}

	// 4. Built-in extensions. A matching project entry wins over the user setting.
	let nativeMcp = true;
	for (const name of BUILTIN_EXTENSIONS) {
		const path = BUILTIN_PREFIX + name;
		const project = applyDeltaPatterns([path], strings(parsed.projectSettings.extensions).filter(isOverride), dirs.projectDir).get(path);
		const enabled = project ?? isEnabledByOverrides(path, strings(parsed.userSettings.extensions), dirs.agentDir);
		if (name === "mcp") nativeMcp = enabled;
		add("extensions", path, { scope: project === undefined ? "user" : "project", source: "local", id: path, enabled });
	}

	// 5. MCP servers. `disabledMcpServers` is the old pi-mcp-adapter convention.
	// Where `builtin:mcp` is on, Pi merges the project file over the user file (dist/extensions/mcp/config.js 64-99).
	// With `builtin:mcp` off, each file gives its rows alone.
	const serversOf = (mcp: Json): Json => isObject(mcp.mcpServers) ? mcp.mcpServers : {};
	const userServers = serversOf(parsed.userMcp), projectServers = serversOf(parsed.projectMcp);
	for (const scope of ["user", "project"] as Scope[]) {
		const mcp = scope === "user" ? parsed.userMcp : parsed.projectMcp;
		const active = scope === "user" ? userServers : projectServers;
		const disabled = isObject(mcp.disabledMcpServers) ? mcp.disabledMcpServers : {};
		for (const [name, entry] of Object.entries(active)) {
			const item: ResourceItem = { kind: "mcp", scope, source: "mcp", id: name, label: name, enabled: !(isObject(entry) && entry.enabled === false) };
			if (nativeMcp && scope === "user" && definesMcpServer(entry)) {
				const project = Object.hasOwn(projectServers, name) ? projectServers[name] : undefined;
				if (definesMcpServer(project) && !(typeof project.url === "string" && project.auth)) item.projectState = { by: "server", enabled: false };
				else if (isMcpOverride(project) && !overrideFault(project, entry) && typeof project.enabled === "boolean") item.projectState = { by: "override", enabled: project.enabled };
			}
			if (nativeMcp && scope === "project" && isMcpOverride(entry)) {
				const base = Object.hasOwn(userServers, name) ? userServers[name] : undefined;
				const ignored = overrideFault(entry, base);
				item.override = { ...(ignored ? { ignored } : {}), setsEnabled: typeof entry.enabled === "boolean" };
				item.enabled = !ignored && { ...base, ...entry }.enabled !== false;
			}
			items.push(item);
		}
		for (const name of Object.keys(disabled)) if (!(name in active)) items.push({ kind: "mcp", scope, source: "mcp", id: name, label: name, enabled: false });
	}
	return items;
}

export const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);

const MCP_OVERRIDE_KEYS = ["enabled", "exposure", "toolExposure"];

/** A project entry without `command`, `url` and `type` overrides the user server with the same name (Pi 1.0.1 and later). */
export const isMcpOverride = (entry: unknown): entry is Json => isObject(entry) && entry.command === undefined && entry.url === undefined && entry.type === undefined;

/** Short form of the Pi check: an entry needs a `command` or a `url` to define a server. Other faults of an entry are not found here. */
const definesMcpServer = (entry: unknown): entry is Json => isObject(entry) && (typeof entry.command === "string" || typeof entry.url === "string");

/** Why Pi ignores an override, or `undefined` when Pi merges it over `base` (dist/extensions/mcp/config.js 64-82). */
function overrideFault(override: Json, base: unknown): string | undefined {
	if (!definesMcpServer(base)) return "no user server has this name";
	if (Object.keys(override).some(key => !MCP_OVERRIDE_KEYS.includes(key))) return `an override can set only ${MCP_OVERRIDE_KEYS.join(", ")}`;
	if (override.enabled !== undefined && typeof override.enabled !== "boolean") return "enabled is not true or false";
	return undefined;
}

const GROUPS: Kind[] = ["extension", "mcp", "skill", "prompt"];

/** Extensions, MCP servers, skills, prompts. The order inside a group is the inventory order. */
export function sortItems<T extends ResourceItem>(items: T[]): T[] {
	return GROUPS.flatMap(kind => items.filter(item => item.kind === kind));
}

/** A URL without its `user[:password]@` part, so a credential is never shown or stored. Other text is unchanged. */
export function stripCredentials(source: string): string {
	return source.replace(/^((?:[a-z]+:)?[a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, "$1");
}

const onOff = (on: boolean) => on ? "on" : "off";

/** The source column. An MCP override shows `override`; its `source` stays `mcp`, so the key of the item does not change. */
export const sourceLabel = (item: Pick<ResourceItem, "source" | "override">) => item.override ? "override" : item.source;

/** The text after an MCP row that the project file changes. The component does not read the trust state of the project. */
function mcpNote(item: ResourceItem): string {
	if (item.projectState?.by === "override") return ` (project override: ${onOff(item.projectState.enabled)} in a trusted project; user file: ${onOff(item.enabled)})`;
	if (item.projectState) return ` (replaced by the project server in a trusted project; user file: ${onOff(item.enabled)})`;
	if (!item.override) return "";
	if (item.override.ignored) return ` (Pi ignores this override: ${item.override.ignored})`;
	return ` (override of the user server${item.override.setsEnabled ? "" : "; the user file sets the state"})`;
}

/**
 * `[x] <kind> <scope> <source> <id>`; a package item also names its package, without credentials.
 * An MCP user row shows the state for this project when the project file decides it, and names that file state.
 */
export function formatItem(item: ResourceItem): string {
	const shown = item.projectState?.enabled ?? item.enabled;
	return `[${shown ? "x" : " "}] ${item.kind} ${item.scope} ${sourceLabel(item)} ${item.id}${item.packageSource ? ` (${stripCredentials(item.packageSource)})` : ""}${mcpNote(item)}`;
}
