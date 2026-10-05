import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { itemKey, stripCredentials, type Dirs, type Kind, type ResourceItem, type Scope } from "./inventory.ts";

export const PROFILE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const NAME_RULE = "A profile name starts with a lowercase letter or a digit. It then holds up to 63 lowercase letters, digits, dots, underscores or hyphens.";

export interface ProfileItem { kind: Kind; scope: Scope; source: ResourceItem["source"]; packageSource?: string; id: string; enabled: boolean }
export interface Profile { schemaVersion: 1; name: string; savedAt: string; items: ProfileItem[] }
export interface ProfileMatch {
	/** The inventory with the profile state applied. */
	desired: ResourceItem[];
	/** Inventory items that change, with the new state. */
	changes: ResourceItem[];
	/** Profile items that the inventory does not have. */
	missing: ProfileItem[];
	/** Inventory items that the profile does not mention. They keep their state. */
	unmentioned: ResourceItem[];
}

export const validProfileName = (name: string) => PROFILE_NAME.test(name);
export const profilesDir = (agentDir: string) => join(agentDir, "resource-profiles");

function profilePath(agentDir: string, name: string): string {
	if (!validProfileName(name)) throw new Error(`"${name}" is not a valid profile name. ${NAME_RULE}`);
	return join(profilesDir(agentDir), `${name}.json`);
}

/**
 * The form of a package source that a profile stores. A URL loses its `user[:password]@` part, so no credential
 * is stored. An absolute path becomes `~/...` or a path relative to the agent directory.
 */
export function portableSource(source: string, dirs: Dirs): string {
	if (/^(?:[a-z]+:)?[a-z][a-z0-9+.-]*:\/\//i.test(source)) return stripCredentials(source);
	if (!isAbsolute(source)) return source;
	const home = dirs.homeDir ?? homedir();
	const inHome = relative(home, source);
	if (inHome && !inHome.startsWith("..") && !isAbsolute(inHome)) return `~/${inHome.split(sep).join("/")}`;
	return relative(dirs.agentDir, source).split(sep).join("/") || ".";
}

const profileKey = (item: ProfileItem | ResourceItem, dirs: Dirs) =>
	itemKey({ ...item, packageSource: item.packageSource === undefined ? undefined : portableSource(item.packageSource, dirs) });

export function toProfile(dirs: Dirs, name: string, items: ResourceItem[], now = new Date()): Profile {
	return {
		schemaVersion: 1,
		name,
		savedAt: now.toISOString(),
		items: items.map(item => ({
			kind: item.kind, scope: item.scope, source: item.source,
			...(item.packageSource === undefined ? {} : { packageSource: portableSource(item.packageSource, dirs) }),
			id: item.id, enabled: item.enabled,
		})),
	};
}

export function profileExists(agentDir: string, name: string): boolean {
	return existsSync(profilePath(agentDir, name));
}

export function saveProfile(dirs: Dirs, name: string, items: ResourceItem[], now = new Date()): string {
	const file = profilePath(dirs.agentDir, name);
	mkdirSync(profilesDir(dirs.agentDir), { recursive: true });
	writeFileSync(file, `${JSON.stringify(toProfile(dirs, name, items, now), null, 2)}\n`);
	return file;
}

export function loadProfile(agentDir: string, name: string): Profile {
	const file = profilePath(agentDir, name);
	if (!existsSync(file)) throw new Error(`Profile "${name}" does not exist.`);
	let data: any;
	try { data = JSON.parse(readFileSync(file, "utf8")); } catch (error) { throw new Error(`${file} is not valid JSON: ${(error as Error).message}`); }
	if (data?.schemaVersion !== 1 || !Array.isArray(data.items)) throw new Error(`${file} is not a schemaVersion 1 resource profile.`);
	const items = (data.items as any[]).filter(item => item && typeof item.kind === "string" && typeof item.scope === "string"
		&& typeof item.source === "string" && typeof item.id === "string" && typeof item.enabled === "boolean");
	return { schemaVersion: 1, name, savedAt: typeof data.savedAt === "string" ? data.savedAt : "", items };
}

/** Names with saved dates, sorted by name. A file that is not a profile is skipped. */
export function listProfiles(agentDir: string): { name: string; savedAt: string }[] {
	let names: string[];
	try { names = readdirSync(profilesDir(agentDir)); } catch { return []; }
	const out: { name: string; savedAt: string }[] = [];
	for (const file of names.sort()) {
		const name = file.endsWith(".json") ? file.slice(0, -".json".length) : "";
		if (!validProfileName(name)) continue;
		try { out.push({ name, savedAt: loadProfile(agentDir, name).savedAt }); } catch { /* not a profile */ }
	}
	return out;
}

export function deleteProfile(agentDir: string, name: string): boolean {
	const file = profilePath(agentDir, name);
	if (!existsSync(file)) return false;
	rmSync(file);
	return true;
}

/** Match a profile to the current inventory. Nothing is written here. */
export function matchProfile(dirs: Dirs, profile: Profile, inventory: ResourceItem[]): ProfileMatch {
	const saved = new Map(profile.items.map(item => [profileKey(item, dirs), item]));
	const present = new Set(inventory.map(item => profileKey(item, dirs)));
	const desired = inventory.map(item => ({ ...item, enabled: saved.get(profileKey(item, dirs))?.enabled ?? item.enabled }));
	return {
		desired,
		changes: desired.filter((item, index) => item.enabled !== inventory[index]!.enabled),
		missing: profile.items.filter(item => !present.has(profileKey(item, dirs))),
		unmentioned: inventory.filter(item => !saved.has(profileKey(item, dirs))),
	};
}
