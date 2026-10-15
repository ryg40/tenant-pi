// Shared code of the recall hook and the MCP server. No AWS logic: the core
// package does every AWS call. This file loads the core, reads the kill switch
// and maps an error to a static code.
import { randomUUID } from "node:crypto";

/** The core path, relative to this file. The kit layout keeps both packages under `packages/`. */
export const CORE_URL = new URL("../../agentcore-memory-core/src/index.mjs", import.meta.url);

/** The static codes of `MemoryErrorCode` in the core contract (`src/types.ts`). */
export const MEMORY_ERROR_CODES = new Set([
	"config",
	"disabled",
	"project_none",
	"not_member",
	"not_maintainer",
	"text_empty",
	"text_too_long",
	"not_confirmed",
	"proposal_missing",
	"proposal_outside_project",
	"ledger",
	"aws_denied",
	"aws_failed",
	"timeout",
]);

/** The code of an error that is not a core refusal. It carries no request data. */
export const UNKNOWN_CODE = "failed";

export async function loadCoreModule() {
	return import(CORE_URL.href);
}

export function killSwitch(env) {
	return env.AGENTCORE_MEMORY_DISABLE === "1";
}

/** The static code of an error. Never the message: an SDK message can carry request data. */
export function errorCode(error) {
	const code = error && typeof error === "object" ? error.code : undefined;
	return typeof code === "string" && MEMORY_ERROR_CODES.has(code) ? code : UNKNOWN_CODE;
}

/** An error with a static code, in the shape of the core's `MemoryError`. */
export function memoryError(code) {
	return Object.assign(new Error(code), { code });
}

/** The session id of Claude Code when the environment gives a plain one, else a random id. */
export function sessionId(env) {
	const value = env.CLAUDE_CODE_SESSION_ID;
	return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : randomUUID();
}

/** The origin of every call of this plugin. The core copies it into record metadata. */
export function claudeOrigin(env) {
	return { agent: "claude-code", harness: "claude-code", session: sessionId(env) };
}

/** A static line on standard error. Callers pass fixed text and static codes only. */
export function stderrLog(prefix) {
	return (line) => {
		try {
			process.stderr.write(`${prefix}: ${line}\n`);
		} catch {
			// Standard error is closed; nothing to report to.
		}
	};
}
