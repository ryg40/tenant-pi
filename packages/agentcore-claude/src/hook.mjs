// The UserPromptSubmit recall hook. `main` takes the parsed hook input and
// returns the hook output object. It returns `{}` on every skip and on every
// error, so a failure of the memory never blocks a prompt. It writes no file.
import { errorCode, killSwitch, loadCoreModule, stderrLog } from "./shared.mjs";

export const HOOK_EVENT = "UserPromptSubmit";
/** The whole recall must end before the hook timeout of 15 seconds in `hooks/hooks.json`. */
export const RECALL_DEADLINE_MS = 12000;
const CLOSE_DEADLINE_MS = 1000;

/** The skip rules of the hook. A skipped prompt sends no query. */
export function skipPrompt(prompt) {
	if (typeof prompt !== "string") return true;
	const text = prompt.trim();
	return text.length < 3 || text.startsWith("/");
}

function withDeadline(promise, ms) {
	let timer;
	const deadline = new Promise((_, reject) => {
		timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "timeout" })), ms);
	});
	return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Run the hook once.
 * @param {{prompt?: unknown, session_id?: unknown, cwd?: unknown}} input the JSON of standard input
 * @param {{env?: Record<string, string|undefined>, loadCore?: () => Promise<any>, log?: (line: string) => void,
 *   cwd?: string, deadlineMs?: number}} deps
 */
export async function main(input, deps = {}) {
	const env = deps.env ?? process.env;
	const log = deps.log ?? stderrLog("agentcore-memory recall");
	if (killSwitch(env)) return {};
	const prompt = input && typeof input === "object" ? input.prompt : undefined;
	if (skipPrompt(prompt)) return {};
	const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : (deps.cwd ?? process.cwd());
	const deadlineMs = deps.deadlineMs ?? RECALL_DEADLINE_MS;

	let core = null;
	try {
		const module = await (deps.loadCore ?? loadCoreModule)();
		const config = module.loadConfig(env);
		if (!config) return {};
		core = module.createCore(config, { log });
		const signal = AbortSignal.timeout(deadlineMs);
		const block = await withDeadline((async () => {
			const resolution = await core.resolveProject({ cwd, env });
			const result = await core.recall({ query: prompt, projectId: resolution.projectId ?? null, signal });
			return core.formatContext(result);
		})(), deadlineMs);
		if (typeof block !== "string" || !block) return {};
		return { hookSpecificOutput: { hookEventName: HOOK_EVENT, additionalContext: block } };
	} catch (error) {
		log(`skipped (${errorCode(error)})`);
		return {};
	} finally {
		if (core) await withDeadline(Promise.resolve().then(() => core.close()), CLOSE_DEADLINE_MS).catch(() => {});
	}
}

/** Parse the hook input. A broken input is an empty object, so `main` skips it. */
export function parseInput(raw) {
	try {
		const value = JSON.parse(raw);
		return value && typeof value === "object" && !Array.isArray(value) ? value : {};
	} catch {
		return {};
	}
}
