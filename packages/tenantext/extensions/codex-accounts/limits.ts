import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import type { CodexAccountConfig } from "./config.ts";
import { parseCodexUsage, type CodexLimitWindow, type CodexPlan } from "./parse-limits.ts";

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const FETCH_TIMEOUT_MS = 15_000;

export { parseCodexLimits, parseCodexUsage, type CodexLimitWindow, type CodexPlan } from "./parse-limits.ts";
export { readTokenFile } from "./token-file.ts";

export type CodexLimitsResult =
	| { success: true; plan?: CodexPlan; windows: CodexLimitWindow[] }
	| { success: false; error: string };

function storedAccountId(provider: string): string | undefined {
	const credential = readStoredCredential(provider) as { type?: string; accountId?: unknown } | undefined;
	return credential?.type === "oauth" && typeof credential.accountId === "string"
		? credential.accountId
		: undefined;
}

export async function fetchCodexLimits(
	account: CodexAccountConfig,
	accessToken: string | undefined,
	signal?: AbortSignal,
	accountId = storedAccountId(account.provider),
): Promise<CodexLimitsResult> {
	if (!accessToken) return { success: false, error: "OAuth access token not found" };
	if (!accountId) return { success: false, error: "OAuth account id not found" };

	const signals = [AbortSignal.timeout(FETCH_TIMEOUT_MS)];
	if (signal) signals.push(signal);
	try {
		const response = await fetch(CODEX_USAGE_URL, {
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"ChatGPT-Account-Id": accountId,
				Accept: "application/json",
				Origin: "https://chatgpt.com",
				Referer: "https://chatgpt.com/",
				"User-Agent": "Mozilla/5.0",
			},
			signal: AbortSignal.any(signals),
		});
		if (!response.ok) return { success: false, error: `HTTP ${response.status}` };
		return { success: true, ...parseCodexUsage(await response.json()) };
	} catch (error) {
		if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
			return { success: false, error: signal?.aborted ? "Request cancelled" : "Request timed out" };
		}
		return { success: false, error: "Network request failed" };
	}
}
