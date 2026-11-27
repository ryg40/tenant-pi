#!/usr/bin/env node
/**
 * The checks and the mirror of claude1 and claude2. `claude-slot.sh` runs it and then starts `claude` with `exec`.
 * See packages/tenantext/docs/claude-accounts.md.
 *
 * Usage: node claude-slot.mjs <name> <slot>
 *
 * It makes every check first. On a refusal it writes a message to stderr, exits with 1 and changes no file. Then:
 * - for the active slot it prints `live`: the caller starts plain `claude` with no CLAUDE_CONFIG_DIR;
 * - for the other slot it links each entry of ~/.claude into the slot folder, writes <slot folder>/.claude.json and
 *   prints the slot folder: the caller starts `claude` with CLAUDE_CONFIG_DIR=<slot folder>.
 *
 * The launcher always uses ~/.claude and ~/.claude.json as the live files. A CLAUDE_CONFIG_DIR of the caller does
 * not apply: the active command removes it.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { accountsRoot, isSlot, readLogin, readState, SLOTS, sameAccount, slotDir, writeAtomic } from "../scripts/claude-accounts.mjs";

class Refusal extends Error {}

const [name = "claude-slot", slot] = process.argv.slice(2);
const SWITCH = "Nothing was changed. Check the accounts with: claude-account status. Finish or redo the switch with: claude-account use <slot>.";
/** Entries of ~/.claude that the slot does not share: the login and its backups. */
const own = entry => entry === ".credentials.json" || entry.startsWith(".credentials.json.") || entry === ".claude.json" || entry === "backups";
const record = value => value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;

/** A JSON file that must exist and parse. */
function readJson(path, label) {
	let text;
	try { text = readFileSync(path, "utf8"); } catch { throw new Refusal(`${label} is missing or cannot be read. ${SWITCH}`); }
	try { return JSON.parse(text); } catch { throw new Refusal(`${label} does not parse. ${SWITCH}`); }
}
const realPath = path => { try { return realpathSync(path); } catch { return undefined; } };

/** Every check of the launcher. Returns what to start. Writes nothing. */
function check() {
	if (!isSlot(slot)) throw new Refusal("usage: claude1|claude2 [claude arguments]");
	const home = process.env.HOME;
	if (!home) throw new Refusal("HOME is not set.");
	const env = { ...process.env };
	delete env.CLAUDE_CONFIG_DIR;
	const root = accountsRoot(env, home);
	const main = join(home, ".claude");
	const liveCredentials = join(main, ".credentials.json"), liveClaudeJson = join(home, ".claude.json");

	// The state file names the active slot.
	readJson(join(root, "state.json"), "The state.json of the account store");
	const state = readState(root);
	if (!state) throw new Refusal(`The state.json of the account store names no slot 1 or 2. ${SWITCH}`);
	const active = state.active, other = SLOTS.find(s => s !== active);

	// The login of the slot: a real file with claudeAiOauth and a refresh token, not the live file.
	const dir = slotDir(root, slot);
	const credentials = join(dir, ".credentials.json");
	let stat;
	try { stat = lstatSync(credentials); } catch { throw new Refusal(`slot ${slot} has no login. Run: claude-account login ${slot}`); }
	if (!stat.isFile()) throw new Refusal(`The .credentials.json of slot ${slot} is not a regular file. Nothing was changed. Check it with: claude-account status.`);
	const oauth = record(record(readJson(credentials, `The .credentials.json of slot ${slot}`))?.claudeAiOauth);
	if (typeof oauth?.refreshToken !== "string") throw new Refusal(`slot ${slot} has no login. Run: claude-account login ${slot}`);
	if (realPath(credentials) === realPath(liveCredentials)) throw new Refusal(`The .credentials.json of slot ${slot} is the live file. Nothing was changed. Check it with: claude-account status.`);

	// The live login is a file login, and it is the account of the active slot.
	const labels = { [liveClaudeJson]: "~/.claude.json", [liveCredentials]: "~/.claude/.credentials.json" };
	const read = path => readJson(path, labels[path] ?? `The store file ${relative(root, path)}`);
	const liveMain = realPath(main);
	if (liveMain && SLOTS.some(s => realPath(slotDir(root, s)) === liveMain)) throw new Refusal(`~/.claude is a slot folder of the account store. ${SWITCH}`);
	if (!existsSync(liveCredentials)) throw new Refusal("~/.claude/.credentials.json is missing. claude1 and claude2 support only the file login, not the macOS keychain. Nothing was changed.");
	const live = readLogin(liveCredentials, liveClaudeJson, read);
	if (!live.oauth) throw new Refusal(`~/.claude/.credentials.json has no claudeAiOauth. claude1 and claude2 support only the file login. ${SWITCH}`);
	if (!live.account) throw new Refusal(`~/.claude.json has no oauthAccount. ${SWITCH}`);
	const activeLogin = readLogin(join(slotDir(root, active), ".credentials.json"), join(slotDir(root, active), ".claude.json"), read);
	if (!sameAccount(live, activeLogin)) throw new Refusal(`The live login is not the account of the active slot ${active} in state.json. ${SWITCH}`);
	const otherOauth = readLogin(join(slotDir(root, other), ".credentials.json"), join(slotDir(root, other), ".claude.json"), path => existsSync(path) ? read(path) : undefined).oauth;
	if (typeof live.oauth.refreshToken === "string" && live.oauth.refreshToken === otherOauth?.refreshToken)
		throw new Refusal(`The live .credentials.json holds the login of slot ${other}, but state.json names slot ${active}. A switch stopped before its end. ${SWITCH}`);

	if (slot === active) return { live: true };

	// The mirror: a real slot folder, and both .claude.json files parse.
	const dirStat = lstatSync(dir);
	if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Refusal(`The folder of slot ${slot} is not a real folder of the account store. Nothing was changed.`);
	let mainIsDir = false;
	try { mainIsDir = statSync(main).isDirectory(); } catch { /* Missing: refused below. */ }
	if (!mainIsDir) throw new Refusal("~/.claude is not a folder. Nothing was changed.");
	const mainJson = record(readJson(liveClaudeJson, "~/.claude.json"));
	if (!mainJson) throw new Refusal("~/.claude.json holds no JSON object. Nothing was changed.");
	const slotJson = record(readJson(join(dir, ".claude.json"), `The .claude.json of slot ${slot}`));
	if (!record(slotJson?.oauthAccount)) throw new Refusal(`The .claude.json of slot ${slot} has no oauthAccount. Nothing was changed. Run: claude-account login ${slot}`);
	return { live: false, dir, main, mainJson, slotJson };
}

/** Link each shared entry of ~/.claude into the slot folder, remove the dead links into ~/.claude, write .claude.json. */
function mirror({ dir, main, mainJson, slotJson }) {
	for (const entry of readdirSync(main)) {
		if (own(entry)) continue;
		const src = join(main, entry), dst = join(dir, entry);
		let stat;
		try { stat = lstatSync(dst); } catch { /* No entry: link it. */ }
		if (stat && !stat.isSymbolicLink()) { console.error(`${name}: ${dst} is a real file, not a link to ${src}. It is not shared.`); continue; }
		if (stat && readlinkSync(dst) === src) continue;
		// A new link under a temp name, then a rename: the entry is never missing.
		const temporary = `${dst}.${process.pid}.link.tmp`;
		rmSync(temporary, { force: true });
		symlinkSync(src, temporary);
		renameSync(temporary, dst);
	}
	for (const entry of readdirSync(dir)) {
		const dst = join(dir, entry);
		if (!lstatSync(dst).isSymbolicLink() || existsSync(dst)) continue;
		if (readlinkSync(dst).startsWith(`${main}/`)) rmSync(dst, { force: true });
	}
	writeAtomic(join(dir, ".claude.json"), { ...slotJson, ...mainJson, oauthAccount: slotJson.oauthAccount });
}

try {
	const decision = check();
	if (decision.live) process.stdout.write("live\n");
	else { mirror(decision); process.stdout.write(`${decision.dir}\n`); }
} catch (error) {
	console.error(error instanceof Refusal ? `${name}: ${error.message}` : `${name}: ${error.message}. The start stopped.`);
	process.exitCode = 1;
}
