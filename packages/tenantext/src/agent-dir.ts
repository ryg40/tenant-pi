import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The Pi agent directory: `PI_CODING_AGENT_DIR` with a leading `~` or `~/` expanded, else `~/.pi/agent`, as Pi does.
 * No Pi import, so the doctor CLI and every extension use this one function.
 */
export function agentDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
	const dir = env.PI_CODING_AGENT_DIR;
	if (!dir) return join(home, ".pi", "agent");
	if (dir === "~") return home;
	return dir.startsWith("~/") ? join(home, dir.slice(2)) : dir;
}
