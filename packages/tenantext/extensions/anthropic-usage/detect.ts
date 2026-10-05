import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Anthropic subscription credential discovery. Every source is local and read-only. This module never refreshes and
 * never writes a credential. A token leaves this module only as the Authorization header of the usage request.
 * Reports name the source, never the value.
 */
export type AnthropicSourceId = "claude-code" | "pi";
export const SOURCE_ORDER: readonly AnthropicSourceId[] = ["claude-code", "pi"];
export const SOURCE_LABELS: Record<AnthropicSourceId, string> = {
	"claude-code": "Claude Code login",
	pi: "Pi anthropic login",
};
/** Subscription plans that may cross to the footer. Any other value is dropped. */
export const ANTHROPIC_PLANS = ["free", "pro", "max", "team", "enterprise"] as const;
export type AnthropicPlan = typeof ANTHROPIC_PLANS[number];
export interface AnthropicCredential { source: AnthropicSourceId; token: string; plan?: AnthropicPlan; detail: string }
export interface DetectOptions {
	env?: NodeJS.ProcessEnv;
	home?: string;
	/** Reads and parses the Claude Code credential file. Injected so tests read no real file. */
	readClaudeFile?: (path: string) => unknown;
	/** Pi's stored credential for `anthropic`. Injected so tests and the doctor CLI need no Pi runtime. */
	readPiCredential?: () => unknown;
	sources?: readonly AnthropicSourceId[];
	now?: number;
}

/** A bearer value must be printable ASCII with no space, so it cannot break out of the header. */
const TOKEN = /^[\x21-\x7e]{16,4096}$/;
const isToken = (value: unknown): value is string => typeof value === "string" && TOKEN.test(value);
const future = (value: unknown, now: number): boolean => typeof value === "number" && Number.isFinite(value) && value > now;

export function normalizePlan(value: unknown): AnthropicPlan | undefined {
	const plan = typeof value === "string" ? value.toLowerCase() : undefined;
	return (ANTHROPIC_PLANS as readonly string[]).includes(plan ?? "") ? plan as AnthropicPlan : undefined;
}
/** `CLAUDE_CONFIG_DIR` replaces `<home>/.claude` when it is set. */
export function claudeCredentialsPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
	return join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), ".credentials.json");
}
function readJson(path: string): unknown {
	try { return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined; } catch { return undefined; }
}
function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Claude Code keeps the subscription login in `claudeAiOauth`. `expiresAt` is epoch milliseconds. */
function claudeCodeSource(options: DetectOptions, now: number): AnthropicCredential[] {
	let oauth: Record<string, unknown> | undefined;
	try {
		const path = claudeCredentialsPath(options.env ?? process.env, options.home ?? homedir());
		oauth = record(record((options.readClaudeFile ?? readJson)(path))?.claudeAiOauth);
	} catch { return []; }
	if (!oauth || !isToken(oauth.accessToken) || !future(oauth.expiresAt, now)) return [];
	return [{ source: "claude-code", token: oauth.accessToken, plan: normalizePlan(oauth.subscriptionType), detail: ".credentials.json claudeAiOauth" }];
}
/** Only an OAuth login has a subscription quota. An API-key credential is absent here. */
function piSource(options: DetectOptions, now: number): AnthropicCredential[] {
	let credential: Record<string, unknown> | undefined;
	try { credential = record(options.readPiCredential?.()); } catch { return []; }
	if (!credential || credential.type !== "oauth" || !isToken(credential.access) || !future(credential.expires, now)) return [];
	return [{ source: "pi", token: credential.access, detail: "auth.json anthropic" }];
}

/** Every active credential in priority order, de-duplicated by token. A token past its expiry is absent. */
export function detectAnthropicCredentials(options: DetectOptions = {}): AnthropicCredential[] {
	const sources = options.sources ?? SOURCE_ORDER, now = options.now ?? Date.now();
	const found: AnthropicCredential[] = [];
	for (const source of SOURCE_ORDER) {
		if (!sources.includes(source)) continue;
		found.push(...(source === "claude-code" ? claudeCodeSource(options, now) : piSource(options, now)));
	}
	const seen = new Set<string>();
	return found.filter(c => !seen.has(c.token) && Boolean(seen.add(c.token)));
}
