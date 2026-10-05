import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { buildInventory, formatItem, itemKey, readFiles, sortItems, sourceLabel, stripCredentials, type Dirs, type ResourceItem } from "./inventory.ts";
import { NAME_RULE, deleteProfile, listProfiles, loadProfile, matchProfile, profileExists, saveProfile, validProfileName } from "./profiles.ts";
import { commitWrites, planWrites, type DesiredItem, type PlanOptions } from "./writers.ts";

export type ResourcesContext = Pick<ExtensionCommandContext, "hasUI" | "reload"> & { ui: Pick<ExtensionCommandContext["ui"], "select" | "input" | "confirm" | "notify"> };
export interface ResourcesOptions extends PlanOptions { dirs: Dirs }

export const SET_DEFAULT = "Set as default (write settings and reload)";
export const SAVE_PROFILE = "Save as profile...";
export const APPLY_PROFILE = "Apply profile...";
export const DISCARD = "Discard changes";
export const SUBCOMMANDS = ["list", "save", "apply", "profiles", "delete"];

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Read the files and build the list. A malformed file gives a notify message and `undefined`. */
function inventory(ctx: ResourcesContext, dirs: Dirs): ResourceItem[] | undefined {
	try { return sortItems(buildInventory(dirs, readFiles(dirs))); }
	catch (error) { ctx.ui.notify(message(error), "error"); return undefined; }
}

export function formatList(items: ResourceItem[]): string {
	return items.length ? sortItems(items).map(formatItem).join("\n") : "No resources found.";
}

const formatChange = (item: ResourceItem) => `${item.enabled ? "on " : "off"}  ${item.kind} ${item.scope} ${sourceLabel(item)} ${item.id}${item.packageSource ? ` (${stripCredentials(item.packageSource)})` : ""}`;

/** Write a desired state and reload. Returns false when nothing was written. */
async function write(ctx: ResourcesContext, options: ResourcesOptions, desired: DesiredItem[], confirmTitle?: string, extra: string[] = []): Promise<boolean> {
	let plan;
	try { plan = planWrites(options.dirs, readFiles(options.dirs), desired, options); }
	catch (error) { ctx.ui.notify(message(error), "error"); return false; }
	const lines = [...plan.changes.map(formatChange), ...plan.notes, ...extra];
	if (plan.writes.length === 0) {
		ctx.ui.notify(["No changes to write.", ...plan.notes, ...extra].join("\n"), "info");
		return false;
	}
	if (confirmTitle && !await ctx.ui.confirm(confirmTitle, lines.join("\n"))) return false;
	try { commitWrites(plan.writes); }
	catch (error) { ctx.ui.notify(`Write failed: ${message(error)}`, "error"); return false; }
	// Reload replaces the extension runtime. Report first, then reload, then return.
	ctx.ui.notify([`Wrote ${plan.changes.length} change(s) to ${plan.writes.map(item => item.file).join(", ")}.`, ...plan.notes].join("\n"), "info");
	await ctx.reload();
	return true;
}

export async function saveCommand(ctx: ResourcesContext, options: ResourcesOptions, name: string, items?: ResourceItem[]): Promise<boolean> {
	if (!validProfileName(name)) { ctx.ui.notify(`"${name}" is not a valid profile name. ${NAME_RULE}`, "error"); return false; }
	const state = items ?? inventory(ctx, options.dirs);
	if (!state) return false;
	if (ctx.hasUI && profileExists(options.dirs.agentDir, name) && !await ctx.ui.confirm("Replace profile", `Profile "${name}" exists. Replace it?`)) return false;
	try { saveProfile(options.dirs, name, state); }
	catch (error) { ctx.ui.notify(`Save failed: ${message(error)}`, "error"); return false; }
	ctx.ui.notify(`Saved profile "${name}" with ${state.length} item(s).`, "info");
	return true;
}

export async function applyCommand(ctx: ResourcesContext, options: ResourcesOptions, name: string): Promise<boolean> {
	const current = inventory(ctx, options.dirs);
	if (!current) return false;
	let match;
	try { match = matchProfile(options.dirs, loadProfile(options.dirs.agentDir, name), current); }
	catch (error) { ctx.ui.notify(message(error), "error"); return false; }
	const extra = [
		...match.missing.map(item => `Not in this inventory: ${item.kind} ${item.scope} ${item.source} ${item.id}`),
		...(match.unmentioned.length ? [`${match.unmentioned.length} item(s) are not in the profile and stay unchanged.`] : []),
	];
	if (!ctx.hasUI) { ctx.ui.notify("/resources apply needs the confirm dialog of the TUI.", "warning"); return false; }
	return write(ctx, options, match.desired, `Apply profile "${name}"`, extra);
}

export function profilesCommand(ctx: ResourcesContext, options: ResourcesOptions): void {
	const profiles = listProfiles(options.dirs.agentDir);
	ctx.ui.notify(profiles.length ? profiles.map(profile => `${profile.name}  ${profile.savedAt}`).join("\n") : "No profiles saved.", "info");
}

export async function deleteCommand(ctx: ResourcesContext, options: ResourcesOptions, name: string): Promise<boolean> {
	try {
		if (!profileExists(options.dirs.agentDir, name)) { ctx.ui.notify(`Profile "${name}" does not exist.`, "warning"); return false; }
		if (!ctx.hasUI) { ctx.ui.notify("/resources delete needs the confirm dialog of the TUI.", "warning"); return false; }
		if (!await ctx.ui.confirm("Delete profile", `Delete profile "${name}"?`)) return false;
		deleteProfile(options.dirs.agentDir, name);
	} catch (error) { ctx.ui.notify(message(error), "error"); return false; }
	ctx.ui.notify(`Deleted profile "${name}".`, "info");
	return true;
}

export function listCommand(ctx: ResourcesContext, options: ResourcesOptions): void {
	const items = inventory(ctx, options.dirs);
	if (items) ctx.ui.notify(formatList(items), "info");
}

/** The `ctx.ui.select` loop. Changes stay in memory until `Set as default`. */
export async function resourcesMenu(ctx: ResourcesContext, options: ResourcesOptions): Promise<void> {
	if (!ctx.hasUI) return listCommand(ctx, options);
	const start = inventory(ctx, options.dirs);
	if (!start) return;
	const working = start.map(item => ({ ...item }));
	const original = new Map(start.map(item => [itemKey(item), item.enabled]));
	const readOnly = (item: ResourceItem) => item.scope === "project" && !options.writeProject;
	for (;;) {
		const rows = working.map(item => `${formatItem(item)}${readOnly(item) ? " (read-only)" : ""}${original.get(itemKey(item)) !== item.enabled ? " (changed)" : ""}`);
		const changed = working.filter(item => original.get(itemKey(item)) !== item.enabled).length;
		const choice = await ctx.ui.select(`Resources: ${working.length} item(s), ${changed} changed`, [...rows, SET_DEFAULT, SAVE_PROFILE, APPLY_PROFILE, DISCARD]);
		if (choice === undefined || choice === DISCARD) return;
		if (choice === SET_DEFAULT) {
			if (await write(ctx, options, working)) return;
			continue;
		}
		if (choice === SAVE_PROFILE) {
			const name = (await ctx.ui.input("Profile name", "a-z, 0-9, dot, underscore, hyphen"))?.trim();
			if (name) await saveCommand(ctx, options, name, working);
			continue;
		}
		if (choice === APPLY_PROFILE) {
			const names = listProfiles(options.dirs.agentDir).map(profile => profile.name);
			if (names.length === 0) { ctx.ui.notify("No profiles saved.", "info"); continue; }
			const name = await ctx.ui.select("Apply profile", names);
			if (name && await applyCommand(ctx, options, name)) return;
			continue;
		}
		const item = working[rows.indexOf(choice)];
		if (!item) continue;
		if (readOnly(item)) ctx.ui.notify("Project items are read-only. Change the project files by hand.", "info");
		else item.enabled = !item.enabled;
	}
}

/** `/resources [list | save <name> | apply <name> | profiles | delete <name>]` */
export async function runResources(args: string, ctx: ResourcesContext, options: ResourcesOptions): Promise<void> {
	const [command, name, ...rest] = args.trim().split(/\s+/).filter(Boolean);
	if (command === undefined) return resourcesMenu(ctx, options);
	const needsName = command === "save" || command === "apply" || command === "delete";
	if (!SUBCOMMANDS.includes(command) || rest.length > 0 || needsName !== (name !== undefined)) {
		ctx.ui.notify("Usage: /resources [list | save <name> | apply <name> | profiles | delete <name>]", "warning");
		return;
	}
	if (command === "list") listCommand(ctx, options);
	else if (command === "profiles") profilesCommand(ctx, options);
	else if (command === "save") await saveCommand(ctx, options, name!);
	else if (command === "apply") await applyCommand(ctx, options, name!);
	else await deleteCommand(ctx, options, name!);
}
