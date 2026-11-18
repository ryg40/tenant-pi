import { accountsRoot, claimRenew, renewSlot, slotSources, type SlotSource } from "../../claude-code/scripts/claude-accounts.mjs";
import { claudeCredentialsPath, detectAnthropicCredentials, type DetectOptions } from "./detect.ts";
import { fileSharedStore, sharedCacheDir, sharedReadingPath, type SharedStore } from "./shared.ts";
import { ANTHROPIC_STATUS_EVENT, CACHED_READING_MS, createAnthropicStatus, type AnthropicAccountSnapshot, type AnthropicStatusOptions, type AnthropicStatusSnapshot } from "./status.ts";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

/**
 * The Anthropic meter with an optional account store (`claude-account`). With no store it is the one meter of
 * status.ts, unchanged. With a store it runs one meter per slot: the live slot reads the live Claude Code login, the
 * other slot reads its slot folder. Each slot has its own shared reading and its own last good reading, so the
 * reading of one account never shows on the row of the other. The meter never refreshes a token: for a slot that is
 * not live, it starts the official `claude auth status` in the slot folder, at most once per `RENEW_PERIOD_MS` for all
 * clients, and does not wait for it: the next refresh reads the new token.
 */
export interface AnthropicMeterOptions extends AnthropicStatusOptions {
	/** The slots and where each login lives now. Undefined: no store. */
	accounts?: () => SlotSource[] | undefined;
	/** The shared reading of one slot. */
	sharedFor?: (slot: string) => SharedStore;
	/** Claim the one renewal try of a slot in this renewal period. False: another client has the claim. */
	claimRenew?: (slot: string, now: number) => boolean;
	/** Run the official client in the slot folder. */
	renew?: (configDir: string) => Promise<unknown>;
}
type Meter = ReturnType<typeof createAnthropicStatus>;

function readJson(path: string): unknown {
	try { return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined; } catch { return undefined; }
}

export function createAnthropicMeter(options: AnthropicMeterOptions) {
	const clock = options.clock ?? Date.now;
	const env = () => options.detect().env ?? process.env, home = () => options.detect().home ?? homedir();
	const accounts = options.accounts ?? (() => slotSources(accountsRoot(env(), home()), env(), home()));
	// The shared reading of a slot carries the hash of its account id, so a reading of an earlier account of the slot is not used.
	const keys = new Map<string, string | undefined>();
	const sharedFor = options.sharedFor ?? ((slot: string) => fileSharedStore(sharedReadingPath(env(), home(), slot), () => keys.get(slot)));
	const claim = options.claimRenew ?? ((slot: string, now: number) => claimRenew(sharedCacheDir(env(), home()), slot, now));
	const renew = options.renew ?? ((configDir: string) => renewSlot(configDir, { env: env() }));
	const single = createAnthropicStatus(options);
	const dirs = new Map<string, string>();
	const meters = new Map<string, { meter: Meter; shared: SharedStore }>();
	let store = false, stopped = false;
	let combined: AnthropicStatusSnapshot = { checkedAt: 0, staleAfter: 300_000, state: "absent", windows: [] };
	const slotDetect = (slot: string): DetectOptions => ({ ...options.detect(), env: { ...env(), CLAUDE_CONFIG_DIR: dirs.get(slot) } });
	const meterOf = (slot: string) => {
		let entry = meters.get(slot);
		if (!entry) {
			const shared = sharedFor(slot);
			entry = { shared, meter: createAnthropicStatus({ ...options, emit: () => {}, shared,
				settings: () => ({ ...options.settings(), sources: ["claude-code"] }), detect: () => slotDetect(slot) }) };
			meters.set(slot, entry);
		}
		return entry;
	};
	/** A slot with no active token shows its last shared reading as `unknown`, until a window resets or the reading is a day old. */
	const account = (source: SlotSource, snapshot: AnthropicStatusSnapshot, shared: SharedStore, now: number): AnthropicAccountSnapshot => {
		const base = { slot: source.slot, active: source.active, ...(snapshot.plan ? { plan: snapshot.plan } : {}) };
		if (snapshot.state !== "absent") return { ...base, state: snapshot.state, windows: snapshot.windows, checkedAt: snapshot.checkedAt, staleAfter: snapshot.staleAfter };
		const reading = shared.read();
		const reset = reading.windows.some(w => w.resetsAt !== undefined && Date.parse(w.resetsAt) <= now);
		if (reading.at !== undefined && reading.windows.length && !reset && now - reading.at < CACHED_READING_MS)
			return { ...base, state: "unknown", windows: reading.windows, checkedAt: reading.at, staleAfter: snapshot.staleAfter };
		return { ...base, state: snapshot.state, windows: [], checkedAt: snapshot.checkedAt, staleAfter: snapshot.staleAfter };
	};
	const publish = () => { if (!stopped) options.emit(ANTHROPIC_STATUS_EVENT, structuredClone(combined)); };
	const refresh = async (force = false, minimumMs?: number): Promise<AnthropicStatusSnapshot> => {
		const settings = options.settings();
		let sources: SlotSource[] | undefined;
		try { sources = settings.mode !== "off" && settings.sources.includes("claude-code") ? accounts() : undefined; } catch { sources = undefined; }
		store = Boolean(sources?.length);
		if (!sources?.length || stopped) return single.refresh(force, minimumMs);
		const now = clock(), pollMs = settings.pollSeconds * 1000;
		for (const source of sources) { dirs.set(source.slot, source.configDir); keys.set(source.slot, source.accountKey); }
		// Only a slot that is not live is renewed, and only by the official client. A slot with an active token needs nothing.
		// The renewal runs in the background: the rows never wait for it, and the next refresh reads the new token.
		for (const source of sources.filter(s => s.renewable)) {
			const file = (options.detect().readClaudeFile ?? readJson)(claudeCredentialsPath({ CLAUDE_CONFIG_DIR: source.configDir }));
			const saved = file !== null && typeof file === "object" && "claudeAiOauth" in file;
			if (!saved || detectAnthropicCredentials({ ...slotDetect(source.slot), sources: ["claude-code"], now }).length) continue;
			if (claim(source.slot, now)) { try { void Promise.resolve(renew(source.configDir)).catch(() => {}); } catch { /* The row shows the last reading. */ } }
		}
		const readings = await Promise.all(sources.map(async source => {
			const { meter, shared } = meterOf(source.slot);
			return account(source, await meter.refresh(force, source.active ? minimumMs : undefined), shared, clock());
		}));
		if (stopped) return combined;
		const live = readings.find(a => a.active);
		const shown = readings.filter(a => a.windows.length || a.state === "error");
		// The group takes the oldest reading, so an old row marks the group stale.
		const oldest = shown.reduce<AnthropicAccountSnapshot | undefined>((o, a) => !o || a.checkedAt < o.checkedAt ? a : o, undefined);
		combined = {
			checkedAt: oldest?.checkedAt ?? clock(), staleAfter: oldest?.staleAfter ?? pollMs * 2,
			state: shown.length ? (shown.some(a => a.state === "ok") ? "ok" : shown.some(a => a.state === "unknown") ? "unknown" : "error") : "absent",
			...(live ? { source: "claude-code" as const, ...(live.plan ? { plan: live.plan } : {}) } : {}),
			windows: live?.windows ?? [], accounts: readings,
		};
		publish();
		return combined;
	};
	return {
		refresh,
		snapshot: () => store ? combined : single.snapshot(),
		stop() { stopped = true; single.stop(); for (const { meter } of meters.values()) meter.stop(); },
		report(): string {
			if (!store) return single.report();
			const lines = ["## Anthropic usage", "", "- Account store: one row per slot. The active slot holds the live Claude Code login."];
			for (const a of combined.accounts ?? []) {
				const body = meters.get(a.slot)?.meter.report().split("\n").slice(2).join("\n") ?? "";
				lines.push("", `### Slot ${a.slot}${a.active ? " (active)" : ""}`, "", `- State: ${a.state}.${a.state === "unknown" ? ` Last reading ${new Date(a.checkedAt).toISOString()}.` : ""}`, body);
			}
			return lines.join("\n");
		},
	};
}
