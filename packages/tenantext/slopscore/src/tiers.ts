import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Model tiers. Models are a commodity; the tier is the only thing that
 * moves the score. Patterns are lower-case substrings matched against the
 * model id. First tier whose pattern matches wins, so keep specific
 * patterns above general ones.
 */
export interface Tier {
	name: string;
	weight: number;
	patterns: string[];
	note?: string;
}

export const DEFAULT_TIERS: Tier[] = [
	{ name: "T1 frontier top", weight: 1.0, patterns: ["fable-5-1", "fable-5.1", "fable", "mythos"] },
	{ name: "T2 frontier", weight: 0.9, patterns: ["gpt-6-astra", "opus-5", "opus-4-8", "opus-4.8"] },
	{
		name: "T3 frontier commodity",
		weight: 0.8,
		patterns: ["gpt-5.6-sol", "gpt-6.1-sol", "kimi-k3", "glm-5.3", "glm5.3", "muse-spark", "gpt-5.6-luna", "gpt-6-luna", "sonnet-5"],
		note: "Interchangeable. Move a model in tiers.json if you disagree.",
	},
	{
		name: "T4 lesser",
		weight: 0.45,
		patterns: ["gpt-5.6-terra", "gpt-6-terra", "haiku", "sonnet-4", "opus-4", "qwen3.6-35b", "qwen3.6-27b", "qwen3.6", "gemini", "gpt-5-mini", "gpt-5.5", "deepseek", "mistral", "llama"],
	},
	{
		name: "T5 small local",
		weight: 0.3,
		patterns: ["qwen3-8b", "qwen3:8b", "8b", "7b", "4b", "3b", "1.5b"],
		note: "Valid for researcher or reviewer with proper context. Low weight, not zero.",
	},
];

export const UNKNOWN_TIER: Tier = { name: "unknown", weight: 0.4, patterns: [], note: "Add a pattern in tiers.json." };

/** Multiplier for the thinking or effort level recorded with a call. */
export const THINKING_FACTORS: Record<string, number> = {
	max: 1.0, xhigh: 1.0, high: 0.95, medium: 0.85, low: 0.7, minimal: 0.6, off: 0.6, none: 0.6,
};
export const UNKNOWN_THINKING_FACTOR = 0.9;

/** Anthropic list prices, USD per million tokens. Used only when a trace has no cost of its own. */
export interface Price { input: number; output: number; cacheRead: number; cacheWrite: number }
export const DEFAULT_PRICES: Record<string, Price> = {
	"claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
	"claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
	"claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	"claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	"claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
	"claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

export interface SlopscoreConfig { tiers: Tier[]; prices: Record<string, Price>; thinkingFactors: Record<string, number> }

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

/** True when the effective tiers, prices, and thinking factors equal the shipped defaults. */
export function isDefaultConfig(config: SlopscoreConfig): boolean {
	return canonical(config) === canonical({ tiers: DEFAULT_TIERS, prices: DEFAULT_PRICES, thinkingFactors: THINKING_FACTORS });
}

export function configPath(): string {
	if (process.env.SLOPSCORE_CONFIG) return process.env.SLOPSCORE_CONFIG;
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return join(agentDir, "slopscore", "tiers.json");
}

/** Load the config. A user file can add or replace tiers, prices and factors. */
export function loadConfig(path = configPath()): SlopscoreConfig {
	const base: SlopscoreConfig = { tiers: DEFAULT_TIERS, prices: DEFAULT_PRICES, thinkingFactors: THINKING_FACTORS };
	try {
		if (!existsSync(path)) return base;
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<SlopscoreConfig>;
		return {
			tiers: Array.isArray(raw.tiers) && raw.tiers.length ? raw.tiers : base.tiers,
			prices: { ...base.prices, ...(raw.prices ?? {}) },
			thinkingFactors: { ...base.thinkingFactors, ...(raw.thinkingFactors ?? {}) },
		};
	} catch {
		return base;
	}
}

export function tierFor(model: string, tiers: Tier[] = DEFAULT_TIERS): Tier {
	const m = model.toLowerCase();
	for (const t of tiers) for (const p of t.patterns) if (m.includes(p.toLowerCase())) return t;
	return UNKNOWN_TIER;
}

export function thinkingFactor(level: string | undefined, factors: Record<string, number> = THINKING_FACTORS): number {
	if (!level) return UNKNOWN_THINKING_FACTOR;
	return factors[level.toLowerCase()] ?? UNKNOWN_THINKING_FACTOR;
}

/** Price a call from token counts. Returns null when the model has no price. */
export function priceCall(model: string, t: { input: number; output: number; cacheRead: number; cacheWrite: number }, prices: Record<string, Price> = DEFAULT_PRICES): number | null {
	const key = Object.keys(prices).find((k) => model.toLowerCase().startsWith(k));
	if (!key) return null;
	const p = prices[key];
	return (t.input * p.input + t.output * p.output + t.cacheRead * p.cacheRead + t.cacheWrite * p.cacheWrite) / 1_000_000;
}
