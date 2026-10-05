import { readFileSync } from "node:fs";

/**
 * Reads an access token from a LiteLLM (`access_token`, `account_id`) or Codex CLI (`tokens.*`) auth file.
 * Read-only: the owning client refreshes and rewrites that file.
 */
export function readTokenFile(path: string, now = Date.now()): { access: string; accountId: string } | undefined {
	try {
		const root = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		const data = (root.tokens && typeof root.tokens === "object" ? root.tokens : root) as Record<string, unknown>;
		const { access_token: access, account_id: accountId, expires_at: expiresAt } = data;
		if (typeof access !== "string" || !access || typeof accountId !== "string" || !accountId) return undefined;
		if (typeof expiresAt === "number" && expiresAt * 1000 <= now) return undefined;
		return { access, accountId };
	} catch { return undefined; }
}

/**
 * True when the file is valid JSON but holds no usable `access_token` and `account_id`: nobody logged in.
 * False for a missing or malformed file and for an expired token. Those cases keep the unreadable-or-expired error.
 */
export function tokenFileNoLogin(path: string): boolean {
	try {
		const root = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (root === null || typeof root !== "object" || Array.isArray(root)) return false;
		const tokens = (root as Record<string, unknown>).tokens;
		const data = (tokens && typeof tokens === "object" ? tokens : root) as Record<string, unknown>;
		const usable = (value: unknown) => typeof value === "string" && value.length > 0;
		return !usable(data.access_token) || !usable(data.account_id);
	} catch { return false; }
}
