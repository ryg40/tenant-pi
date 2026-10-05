import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { filterSessionRecords } from "./trace-filter.ts";
import type { CallRecord, TraceFilter } from "./types.ts";

export function piSessionsDir(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return join(agentDir, "sessions");
}

/** All pi session files, newest first. */
export function listPiSessionFiles(root = piSessionsDir()): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		let names: string[];
		try { names = readdirSync(dir); } catch { return; }
		for (const n of names) {
			const p = join(dir, n);
			let st;
			try { st = statSync(p); } catch { continue; }
			if (st.isDirectory()) walk(p);
			else if (n.endsWith(".jsonl")) out.push(p);
		}
	};
	walk(root);
	return out.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

/** Role from a pi session: subagent-<role>-<hash>-<n> becomes subagent:<role>. */
export function piRole(sessionName: string | undefined, file: string): string {
	if (sessionName) {
		const m = sessionName.match(/^subagent-([a-z0-9_]+)/i);
		if (m) return `subagent:${m[1]}`;
	}
	if (file.includes(`${"/sessions/subagent/"}`)) return "subagent:unknown";
	return "main";
}

/** Parse one pi session file into call records. */
export function parsePiSession(file: string, text = readFileSync(file, "utf8")): CallRecord[] {
	const records: CallRecord[] = [];
	let sessionId = basename(file);
	let cwd: string | undefined;
	let name: string | undefined;
	let thinking: string | undefined;
	// Pass one: header facts that may appear after the first messages.
	const lines = text.split("\n");
	for (const line of lines) {
		if (!line.trim()) continue;
		let e: any;
		try { e = JSON.parse(line); } catch { continue; }
		if (e.type === "session") { sessionId = e.id ?? sessionId; cwd = e.cwd; }
		else if (e.type === "session_info" && e.name) name = e.name;
	}
	const role = piRole(name, file);
	for (const line of lines) {
		if (!line.trim()) continue;
		let e: any;
		try { e = JSON.parse(line); } catch { continue; }
		if (e.type === "thinking_level_change") { thinking = e.thinkingLevel; continue; }
		if (e.type !== "message" || e.message?.role !== "assistant") continue;
		const m = e.message;
		if (m.stopReason === "aborted" || m.stopReason === "error") continue;
		const u = m.usage ?? {};
		const tools: string[] = [];
		for (const c of m.content ?? []) if (c?.type === "toolCall" && c.name) tools.push(c.name);
		records.push({
			harness: "pi",
			sessionId,
			sessionFile: file,
			cwd,
			role,
			provider: m.provider,
			model: m.model ?? "unknown",
			thinking,
			input: u.input ?? 0,
			output: u.output ?? 0,
			cacheRead: u.cacheRead ?? 0,
			cacheWrite: u.cacheWrite ?? 0,
			cost: typeof u.cost?.total === "number" ? u.cost.total : null,
			tools,
			timestamp: Date.parse(e.timestamp) || m.timestamp || 0,
		});
	}
	return records;
}

/** Collect pi records under a filter. */
export function collectPi(filter: TraceFilter = {}, root = piSessionsDir()): CallRecord[] {
	const files = filter.sessionFiles ?? listPiSessionFiles(root).filter((f) => {
		if (filter.since === undefined || filter.sessionStartedSince !== undefined) return true;
		try { return statSync(f).mtimeMs >= filter.since; } catch { return false; }
	});
	const out: CallRecord[] = [];
	for (const f of files) {
		let recs: CallRecord[];
		try { recs = parsePiSession(f); } catch { continue; }
		out.push(...filterSessionRecords(recs, filter));
	}
	return out;
}

/** Pi encodes a cwd as a directory name. Used to find a project's sessions without parsing every file. */
export function piDirForCwd(cwd: string): string {
	return `--${cwd.replace(/\//g, "-").replace(/^-/, "")}--`;
}

export { dirname as _dirname };
