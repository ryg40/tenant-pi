// The Claude Code side of the memory chain: one shadow run for a UserPromptSubmit input. It returns
// nothing for the model in every case, so the prompt stays as it is. It never throws.
// It loads `shadow.mjs` only after the switch says `shadow`, so `off` needs no vendored helper.
import { readMode } from "./switch.mjs";

/** Parse the hook input. A broken input is an empty object, which the run skips. */
export function parseInput(raw) {
	try {
		const value = JSON.parse(raw);
		return value && typeof value === "object" && !Array.isArray(value) ? value : {};
	} catch {
		return {};
	}
}

/**
 * Run the hook once. Claude Code gets only the stores of its own session: OpenViking for the project
 * and the approved global facts, no Pi private store. `run` replaces the shadow run in tests.
 */
export async function main(input, { env = process.env, run, startedAt = Date.now() } = {}) {
	try {
		if (readMode(env) !== "shadow") return "";
		const runner = run ?? (await import("./shadow.mjs")).runShadow;
		await runner({
			harness: "claude-code",
			prompt: input?.prompt,
			cwd: typeof input?.cwd === "string" && input.cwd ? input.cwd : process.cwd(),
			sessionId: typeof input?.session_id === "string" ? input.session_id : "",
			env,
			startedAt,
		});
	} catch { /* shadow: a failure never touches the prompt */ }
	return "";
}
