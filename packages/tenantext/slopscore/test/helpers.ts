import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Shared fixtures for the PR block and trailer tests: a temporary repo and fake harness traces. */

export const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
export const gitEnv = {
	...process.env,
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@t",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@t",
};

export function repo(): {
	dir: string;
	git: (...args: string[]) => string;
	commit: (message: string, file: string, body: string, date: string, trailer?: string) => void;
} {
	const dir = mkdtempSync(join(tmpdir(), "slopscore-pr-"));
	const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: gitEnv }).trim();
	git("init", "-q", "-b", "main");
	git("config", "user.name", "t");
	git("config", "user.email", "t@t");
	return {
		dir,
		git,
		commit(message, file, body, date, trailer) {
			mkdirSync(dirname(join(dir, file)), { recursive: true });
			writeFileSync(join(dir, file), body);
			git("add", "-A");
			const full = trailer ? `${message}\n\nCo-Authored-By: ${trailer} <model@example.test>` : message;
			execFileSync("git", ["commit", "-q", "-m", full], {
				cwd: dir,
				env: { ...gitEnv, GIT_AUTHOR_DATE: `${date}T12:00:00Z`, GIT_COMMITTER_DATE: `${date}T12:00:00Z` },
			});
		},
	};
}

export function branchRepo() {
	const r = repo();
	r.commit("main history #1", "src/main.ts", "main", "2026-09-01", "old-model");
	const base = r.git("rev-parse", "HEAD");
	r.git("switch", "-q", "-c", "feature/pr");
	r.commit("Build #3", "src/feature.ts", "one", "2026-09-02", "gpt-5.6-sol");
	r.commit("Fix #4 review", "src/feature.ts", "two", "2026-09-03");
	return { ...r, base };
}

export function run(dir: string, ...args: string[]) {
	return runWithEnv(dir, process.env, ...args);
}

export function runWithEnv(dir: string, env: NodeJS.ProcessEnv, ...args: string[]) {
	return spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", cli, "pr", ...args], {
		cwd: dir,
		encoding: "utf8",
		env,
	});
}

export function setRemoteRef(r: ReturnType<typeof repo>, name: string, hash: string) {
	r.git("update-ref", `refs/remotes/${name}`, hash);
}

export function writePiTrace(agentDir: string, name: string, cwd: string, calls: Array<{ time: string; cost: number | null; model?: string; thinking?: string }>, role = "main") {
	const file = join(agentDir, "sessions", `${name}.jsonl`);
	mkdirSync(dirname(file), { recursive: true });
	const events: unknown[] = [
		{ type: "session", id: name, cwd },
		...(role === "main" ? [] : [{ type: "session_info", name: `subagent-${role}-fixture-1` }]),
	];
	let thinking: string | undefined;
	for (const call of calls) {
		if (call.thinking !== thinking) {
			thinking = call.thinking;
			events.push({ type: "thinking_level_change", thinkingLevel: thinking });
		}
		events.push({ type: "message", timestamp: call.time, message: { role: "assistant", provider: "test", model: call.model ?? "gpt-5.6-sol", stopReason: "stop", usage: { input: 10, output: 2, cost: call.cost === null ? undefined : { total: call.cost } }, content: [] } });
	}
	writeFileSync(file, events.map((event) => JSON.stringify(event)).join("\n"));
	return file;
}

export function withTraceEnv<T>(piDir: string, claudeDir: string, fn: () => T): T {
	const oldPi = process.env.PI_CODING_AGENT_DIR;
	const oldClaude = process.env.CLAUDE_CONFIG_DIR;
	const oldConfig = process.env.SLOPSCORE_CONFIG;
	process.env.PI_CODING_AGENT_DIR = piDir;
	process.env.CLAUDE_CONFIG_DIR = claudeDir;
	process.env.SLOPSCORE_CONFIG = join(piDir, "isolated-config.json");
	try { return fn(); } finally {
		if (oldPi === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldPi;
		if (oldClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = oldClaude;
		if (oldConfig === undefined) delete process.env.SLOPSCORE_CONFIG; else process.env.SLOPSCORE_CONFIG = oldConfig;
	}
}

