/**
 * The Claude account store: one saved login per slot, and the swap of the live login of Claude Code.
 *
 * Claude Code keeps one login in its config folder (`~/.claude`, or `CLAUDE_CONFIG_DIR`). The store keeps one minimal
 * Claude config folder per slot under `${XDG_STATE_HOME:-~/.local/state}/claude-accounts/<slot>/`. A slot folder holds
 * only login data: `.credentials.json` with `claudeAiOauth`, and `.claude.json` with `oauthAccount`. So
 * `CLAUDE_CONFIG_DIR=<slot folder> claude auth status` works in it. `state.json` names the active slot.
 *
 * `use` changes only `claudeAiOauth` in the live `.credentials.json` and `oauthAccount` in the live `.claude.json`.
 * It never touches memory, settings, plugins, skills or sessions. This module never sends an OAuth request: the
 * official `claude` program renews a token. The meters import the read helpers; only the owner's command writes.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SLOTS = ["1", "2"];
const STATE_FILE = "state.json";

export class AccountError extends Error {}

/** The store root. `XDG_STATE_HOME` replaces `~/.local/state` when it is set. */
export const accountsRoot = (env = process.env, home = homedir()) =>
	join(env.XDG_STATE_HOME || join(home, ".local", "state"), "claude-accounts");
export const slotDir = (root, slot) => join(root, slot);
/** The live Claude config folder. */
export const liveDir = (env = process.env, home = homedir()) => env.CLAUDE_CONFIG_DIR || join(home, ".claude");
/** Claude Code keeps `.claude.json` in the home folder, or in `CLAUDE_CONFIG_DIR` when that is set. */
export const liveClaudeJson = (env = process.env, home = homedir()) =>
	env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, ".claude.json") : join(home, ".claude.json");
export const isSlot = value => SLOTS.includes(value);

function record(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
function readJson(path) {
	try { return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined; } catch { return undefined; }
}
/** A file that exists but does not parse stops a write: the swap must not replace a file that it cannot read. */
function readJsonStrict(path) {
	if (!existsSync(path)) return undefined;
	try { return JSON.parse(readFileSync(path, "utf8")); } catch { throw new AccountError(`A login file does not parse; nothing was changed. Check ${path.endsWith(".claude.json") ? ".claude.json" : ".credentials.json"}.`); }
}
/** A temp file in the same folder, then a rename: a reader never sees half a file. */
export function writeAtomic(path, value) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
		chmodSync(temporary, 0o600);
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

/**
 * Merge one key into a live file that a running Claude Code session can also write. The file is read again directly
 * before the rename, and the write starts again once when the file changed in between. A write of the session in the
 * short time between the last read and the rename is still lost.
 */
function mergeAtomic(path, key, value) {
	const text = () => { try { return readFileSync(path, "utf8"); } catch { return undefined; } };
	for (let attempt = 0; ; attempt++) {
		const before = text();
		const current = record(readJsonStrict(path)) ?? {};
		const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
		try {
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
			writeFileSync(temporary, `${JSON.stringify({ ...current, [key]: value }, null, 2)}\n`, { mode: 0o600 });
			chmodSync(temporary, 0o600);
			if (attempt === 0 && text() !== before) { rmSync(temporary, { force: true }); continue; }
			renameSync(temporary, path);
			return;
		} catch (error) {
			rmSync(temporary, { force: true });
			throw error;
		}
	}
}

/** `{ active, switchedAt }`, or undefined when there is no store. */
export function readState(root) {
	const state = record(readJson(join(root, STATE_FILE)));
	if (!state || !isSlot(state.active)) return undefined;
	return { active: state.active, switchedAt: typeof state.switchedAt === "number" ? state.switchedAt : 0 };
}
/** The store exists when its state file names an active slot. Without it every meter behaves as with one login. */
export const storeExists = root => readState(root) !== undefined;

/** The login of one config folder: `oauth` from `.credentials.json` and `account` from `.claude.json`. */
export function readLogin(credentialsPath, claudeJsonPath, read = readJson) {
	const oauth = record(record(read(credentialsPath))?.claudeAiOauth);
	const account = record(record(read(claudeJsonPath))?.oauthAccount);
	return { oauth, account };
}
export const slotLogin = (root, slot, read = readJson) =>
	readLogin(join(slotDir(root, slot), ".credentials.json"), join(slotDir(root, slot), ".claude.json"), read);
export const liveLogin = (env = process.env, home = homedir(), read = readJson) =>
	readLogin(join(liveDir(env, home), ".credentials.json"), liveClaudeJson(env, home), read);
const hasLogin = login => typeof login.oauth?.accessToken === "string" || typeof login.oauth?.refreshToken === "string";

/** Two logins are one account when the account ids match, or, with no id on one side, the refresh tokens match. */
export function sameAccount(a, b) {
	const ua = a.account?.accountUuid, ub = b.account?.accountUuid;
	if (typeof ua === "string" && typeof ub === "string") return ua === ub;
	const ra = a.oauth?.refreshToken, rb = b.oauth?.refreshToken;
	return typeof ra === "string" && ra === rb;
}
/** A short hash of an account id. The shared reading of a slot keeps it, so a reading of another account is not used. */
export const accountKey = uuid => typeof uuid === "string" && uuid ? createHash("sha256").update(uuid).digest("hex").slice(0, 12) : undefined;
const sameToken = (a, b) => (typeof a?.refreshToken === "string" && a.refreshToken === b?.refreshToken) || (typeof a?.accessToken === "string" && a.accessToken === b?.accessToken);
/** The slot that holds the account of the live login, or undefined. */
export function slotOfLive(root, env = process.env, home = homedir(), read = readJson) {
	const live = liveLogin(env, home, read);
	if (!hasLogin(live)) return undefined;
	return SLOTS.find(slot => { const saved = slotLogin(root, slot, read); return hasLogin(saved) && sameAccount(live, saved); });
}

/**
 * Where each slot's login lives now, for the meters. The live slot reads the live config folder; another slot reads
 * its slot folder. `renewable` is false for the live slot and for the slot the state names active: renewing a saved
 * copy of the live account would rotate its refresh token and end the live login.
 */
export function slotSources(root, env = process.env, home = homedir(), read = readJson) {
	const state = readState(root);
	if (!state) return undefined;
	const live = slotOfLive(root, env, home, read);
	return SLOTS.map(slot => ({
		slot, active: slot === live, configDir: slot === live ? liveDir(env, home) : slotDir(root, slot),
		renewable: slot !== live && slot !== state.active, accountKey: accountKey(slotLogin(root, slot, read).account?.accountUuid),
	}));
}

function requireSlot(slot) {
	if (!isSlot(slot)) throw new AccountError(`Unknown slot "${String(slot ?? "")}". Use one of: ${SLOTS.join(", ")}.`);
}
function ensureSlotDir(root, slot) {
	mkdirSync(root, { recursive: true, mode: 0o700 });
	chmodSync(root, 0o700);
	mkdirSync(slotDir(root, slot), { recursive: true, mode: 0o700 });
	chmodSync(slotDir(root, slot), 0o700);
}
/**
 * Keep the slot credential file as `.credentials.json.prev` (one generation, mode 0600) before a write replaces its
 * saved login with another refresh token. The owner restores a lost login from it.
 */
function keepPrevious(root, slot, oauth) {
	const credentials = join(slotDir(root, slot), ".credentials.json");
	const saved = record(readJsonStrict(credentials));
	const old = record(saved?.claudeAiOauth);
	if (!old || (typeof old.refreshToken === "string" && old.refreshToken === oauth?.refreshToken)) return;
	writeAtomic(`${credentials}.prev`, saved);
}
/** Save a login into a slot folder: only the two objects. Other keys that `claude` wrote there stay. */
function saveSlot(root, slot, login) {
	ensureSlotDir(root, slot);
	const credentials = join(slotDir(root, slot), ".credentials.json"), claudeJson = join(slotDir(root, slot), ".claude.json");
	keepPrevious(root, slot, login.oauth);
	writeAtomic(credentials, { ...(record(readJsonStrict(credentials)) ?? {}), claudeAiOauth: login.oauth });
	if (login.account) writeAtomic(claudeJson, { ...(record(readJsonStrict(claudeJson)) ?? {}), oauthAccount: login.account });
}
function writeState(root, active, now) {
	mkdirSync(root, { recursive: true, mode: 0o700 });
	writeAtomic(join(root, STATE_FILE), { active, switchedAt: now });
}

/** Copy the live login into the slot and mark it active. */
export function adopt(slot, { env = process.env, home = homedir(), now = Date.now() } = {}) {
	requireSlot(slot);
	const root = accountsRoot(env, home);
	const live = liveLogin(env, home, readJsonStrict);
	if (!hasLogin(live)) throw new AccountError("No live Claude login to adopt. Log in with claude first, or use: claude-account login <slot>.");
	const other = SLOTS.find(s => s !== slot && hasLogin(slotLogin(root, s, readJsonStrict)) && sameAccount(live, slotLogin(root, s, readJsonStrict)));
	if (other) throw new AccountError(`The live login is already saved in slot ${other}. Nothing was changed.`);
	const saved = slotLogin(root, slot, readJsonStrict);
	const ua = saved.account?.accountUuid, ub = live.account?.accountUuid;
	// Also for the active slot: its saved copy can be the only copy of that login.
	if (hasLogin(saved) && typeof ua === "string" && typeof ub === "string" && ua !== ub)
		throw new AccountError(`Slot ${slot} holds the login of another account. Nothing was changed.`);
	saveSlot(root, slot, live);
	writeState(root, slot, now);
	return { slot };
}

/**
 * Make `slot` the live login. Order: every check, then save the live login back to its slot (Claude Code may have
 * renewed it), then write the target login into the live files, then the state file.
 *
 * The credential file has no account id. When its token is the saved token of one slot and `.claude.json` names the
 * account of another slot, the two live files name different accounts, and a save would put one account's login into
 * the other's slot. `use` then refuses, except for the slot whose token the credential file holds: that is a switch
 * that stopped between the two live writes, and `use` finishes it with no write to a slot.
 */
export function use(slot, { env = process.env, home = homedir(), now = Date.now() } = {}) {
	requireSlot(slot);
	const root = accountsRoot(env, home);
	const target = slotLogin(root, slot, readJsonStrict);
	if (!hasLogin(target)) throw new AccountError(`Slot ${slot} has no login. Run: claude-account login ${slot}.`);
	const credentialsPath = join(liveDir(env, home), ".credentials.json"), claudeJsonPath = liveClaudeJson(env, home);
	const liveCredentials = record(readJsonStrict(credentialsPath)) ?? {};
	const liveClaude = record(readJsonStrict(claudeJsonPath)) ?? {};
	const live = { oauth: record(liveCredentials.claudeAiOauth), account: record(liveClaude.oauthAccount) };
	let liveSlot, finish = false;
	if (hasLogin(live)) {
		const saved = Object.fromEntries(SLOTS.map(s => [s, slotLogin(root, s, readJsonStrict)]));
		liveSlot = SLOTS.find(s => hasLogin(saved[s]) && sameAccount(live, saved[s]));
		const tokenSlot = SLOTS.find(s => hasLogin(saved[s]) && sameToken(live.oauth, saved[s].oauth));
		if (tokenSlot && tokenSlot !== liveSlot) {
			finish = tokenSlot === slot;
			if (!finish) throw new AccountError(`The live .credentials.json holds the login of slot ${tokenSlot}, but .claude.json names ${liveSlot ? `the account of slot ${liveSlot}` : "another account"}. Nothing was changed. Finish the earlier switch with: claude-account use ${tokenSlot}.`);
		}
		if (!liveSlot && !finish) throw new AccountError("The live login is saved in no slot. A switch would lose it. Save it first: claude-account adopt <slot>.");
	}
	// A finished switch writes no slot: the live credential file already is the saved login of the target.
	if (liveSlot && !finish) saveSlot(root, liveSlot, live);
	if (liveSlot !== slot) {
		mergeAtomic(credentialsPath, "claudeAiOauth", target.oauth);
		if (target.account) {
			try { mergeAtomic(claudeJsonPath, "oauthAccount", target.account); }
			catch { throw new AccountError(`The live .credentials.json holds the login of slot ${slot} now, but .claude.json could not be written. Run claude-account use ${slot} again.`); }
		}
	}
	writeState(root, slot, now);
	return { slot, previous: finish ? undefined : liveSlot, changed: liveSlot !== slot };
}

/** The official login in the slot folder. The owner does the browser step. The live login is not touched. */
export function login(slot, { env = process.env, home = homedir(), claude = "claude", run = spawnSync } = {}) {
	requireSlot(slot);
	const root = accountsRoot(env, home);
	ensureSlotDir(root, slot);
	// `claude auth login` replaces the saved login of the slot: keep it first.
	keepPrevious(root, slot, undefined);
	const result = run(claude, ["auth", "login"], { stdio: "inherit", env: { ...env, CLAUDE_CONFIG_DIR: slotDir(root, slot) } });
	if (result.error) throw new AccountError(`Could not start ${claude}. Check that it is on PATH.`);
	return { slot, status: result.status ?? 1 };
}

/** The slots without a token: the active mark, the plan, the token expiry. The email only with `email: true`. */
export function status({ env = process.env, home = homedir(), now = Date.now(), email = false } = {}) {
	const root = accountsRoot(env, home);
	const state = readState(root), live = slotOfLive(root, env, home);
	const liveSaved = !hasLogin(liveLogin(env, home)) || live !== undefined;
	const slots = SLOTS.map(slot => {
		const login = slot === live ? liveLogin(env, home) : slotLogin(root, slot);
		const expiresAt = typeof login.oauth?.expiresAt === "number" ? login.oauth.expiresAt : undefined;
		return {
			slot, active: slot === live, login: hasLogin(login),
			plan: typeof login.oauth?.subscriptionType === "string" ? login.oauth.subscriptionType : undefined,
			token: expiresAt === undefined ? "none" : expiresAt > now ? "valid" : "expired", expiresAt,
			...(email && typeof login.account?.emailAddress === "string" ? { email: login.account.emailAddress } : {}),
		};
	});
	return { store: state !== undefined, stateActive: state?.active, liveSaved, slots };
}

/** One renewal try per slot in each period, the same for every client (the Pi meter and the status line). */
export const RENEW_PERIOD_MS = 60 * 60_000;
/**
 * Claim the one renewal try of a slot that is not live in the current period of `RENEW_PERIOD_MS`, for every client.
 * The claim is the exclusive create of `<cacheDir>/renew-<slot>-<period>.json`: when two clients start together, one
 * create fails. A claim file of an earlier period is removed. Not verified: that `claude auth status` renews an
 * expired token.
 */
export function claimRenew(cacheDir, slot, now) {
	const period = Math.floor(now / RENEW_PERIOD_MS), name = `renew-${slot}-${period}.json`;
	try {
		mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
		const fd = openSync(join(cacheDir, name), "wx", 0o600);
		try { writeSync(fd, JSON.stringify({ attemptAt: now })); } finally { closeSync(fd); }
	} catch { return false; }
	try {
		for (const file of readdirSync(cacheDir)) if (file !== name && file.startsWith(`renew-${slot}-`) && file.endsWith(".json")) rmSync(join(cacheDir, file), { force: true });
	} catch { /* An old claim file is harmless. */ }
	return true;
}
/** Run `claude auth status` in the slot folder. SIGTERM after `timeoutMs`, SIGKILL `killMs` later; it always resolves. */
export function renewSlot(configDir, { env = process.env, claude = "claude", timeoutMs = 20_000, killMs = 2_000 } = {}) {
	return new Promise(resolve => {
		let child;
		try { child = spawn(claude, ["auth", "status"], { stdio: "ignore", env: { ...env, CLAUDE_CONFIG_DIR: configDir } }); }
		catch { resolve(false); return; }
		let done = false, kill;
		const end = ok => { if (done) return; done = true; clearTimeout(term); clearTimeout(kill); resolve(ok); };
		const term = setTimeout(() => {
			try { child.kill("SIGTERM"); } catch { /* It has ended. */ }
			kill = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* It has ended. */ } end(false); }, killMs);
		}, timeoutMs);
		child.on("error", () => end(false));
		child.on("exit", code => end(code === 0));
	});
}
