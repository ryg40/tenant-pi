import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { priceCall, type Price } from "./tiers.ts";
import { filterSessionRecords } from "./trace-filter.ts";
import type { CallRecord, TraceFilter } from "./types.ts";

export function claudeProjectsDir(): string {
	const cfg = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
	return join(cfg, "projects");
}

/** Main transcripts plus their subagent files, newest first. */
export function listClaudeSessionFiles(root = claudeProjectsDir()): string[] {
	const out: string[] = [];
	let projects: string[];
	try { projects = readdirSync(root); } catch { return out; }
	for (const proj of projects) {
		const pdir = join(root, proj);
		let names: string[];
		try { names = readdirSync(pdir); } catch { continue; }
		for (const n of names) {
			const p = join(pdir, n);
			if (n.endsWith(".jsonl")) out.push(p);
			const sub = join(pdir, n, "subagents");
			if (existsSync(sub)) for (const s of readdirSync(sub)) if (s.endsWith(".jsonl")) out.push(join(sub, s));
		}
	}
	return out.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

interface ParsedClaude { records: CallRecord[]; costState?: Record<string, number>; agentNames: Map<string, string> }

/**
 * Parse one Claude Code transcript. Streaming writes several assistant
 * entries per request, each carrying usage; keep one record per requestId
 * with the largest counts. Cost: computed from list prices, then scaled per
 * model so the session total matches the harness's own cost-state entry.
 */
export function parseClaudeSession(file: string, text = readFileSync(file, "utf8"), prices?: Record<string, Price>, roleHint?: string): ParsedClaude {
	const byRequest = new Map<string, CallRecord>();
	const agentNames = new Map<string, string>();
	const pendingAgentCalls = new Map<string, string>(); // tool_use id -> description
	let costState: Record<string, number> | undefined;
	let sessionId = basename(file, ".jsonl");
	let cwd: string | undefined;
	const isSubagentFile = file.includes("/subagents/");
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let e: any;
		try { e = JSON.parse(line); } catch { continue; }
		if (e.sessionId && !isSubagentFile) sessionId = e.sessionId;
		if (e.cwd) cwd = e.cwd;
		if (e.type === "cost-state" && e.modelUsage) {
			costState = {};
			for (const [model, mu] of Object.entries<any>(e.modelUsage)) costState[model] = mu.costUSD ?? 0;
			continue;
		}
		if (e.type === "user") {
			const content = e.message?.content;
			if (Array.isArray(content)) for (const c of content) {
				if (c?.type === "tool_result" && pendingAgentCalls.has(c.tool_use_id)) {
					const txt = typeof c.content === "string" ? c.content : JSON.stringify(c.content ?? "");
					const m = txt.match(/agentId:\s*([0-9a-f]{8,})/i);
					if (m) agentNames.set(m[1], pendingAgentCalls.get(c.tool_use_id)!);
				}
			}
			continue;
		}
		if (e.type !== "assistant") continue;
		const m = e.message ?? {};
		// Claude Code writes synthetic assistant entries for errors and retries. They carry no real call.
		if (!m.model || m.model === "<synthetic>") continue;
		const u = m.usage ?? {};
		const key = e.requestId ?? e.uuid ?? String(byRequest.size);
		const tools: string[] = [];
		for (const c of m.content ?? []) {
			if (c?.type === "tool_use" && c.name) {
				tools.push(c.name);
				if (c.name === "Agent" || c.name === "Task") pendingAgentCalls.set(c.id, c.input?.description ?? c.input?.subagent_type ?? "agent");
			}
		}
		const role = roleHint ?? (isSubagentFile || e.isSidechain ? "subagent:unknown" : "main");
		const rec: CallRecord = {
			harness: "claude",
			sessionId,
			sessionFile: file,
			cwd,
			role,
			model: m.model ?? "unknown",
			thinking: e.effort,
			input: u.input_tokens ?? 0,
			output: u.output_tokens ?? 0,
			cacheRead: u.cache_read_input_tokens ?? 0,
			cacheWrite: u.cache_creation_input_tokens ?? 0,
			cost: null,
			tools,
			timestamp: Date.parse(e.timestamp) || 0,
		};
		const prev = byRequest.get(key);
		if (!prev) byRequest.set(key, rec);
		else {
			prev.input = Math.max(prev.input, rec.input);
			prev.output = Math.max(prev.output, rec.output);
			prev.cacheRead = Math.max(prev.cacheRead, rec.cacheRead);
			prev.cacheWrite = Math.max(prev.cacheWrite, rec.cacheWrite);
			for (const t of rec.tools) if (!prev.tools.includes(t)) prev.tools.push(t);
		}
	}
	const records = [...byRequest.values()];
	for (const r of records) r.cost = priceCall(r.model, r, prices);
	return { records, costState, agentNames };
}

/** Scale priced costs so each model's total equals the harness cost-state total. */
export function calibrate(records: CallRecord[], costState: Record<string, number> | undefined): void {
	if (!costState) return;
	const totals = new Map<string, number>();
	for (const r of records) if (r.cost !== null) totals.set(r.model, (totals.get(r.model) ?? 0) + r.cost);
	for (const r of records) {
		const actual = costState[r.model];
		const priced = totals.get(r.model);
		if (actual === undefined || !priced || r.cost === null) continue;
		r.cost = (r.cost / priced) * actual;
	}
}

/** Collect Claude Code records. Subagent files are attached to their parent session for cost calibration and naming. */
export function collectClaude(filter: TraceFilter = {}, root = claudeProjectsDir(), prices?: Record<string, Price>): CallRecord[] {
	const files = filter.sessionFiles ?? listClaudeSessionFiles(root).filter((f) => {
		if (filter.since === undefined || filter.sessionStartedSince !== undefined) return true;
		try { return statSync(f).mtimeMs >= filter.since; } catch { return false; }
	});
	const mains = files.filter((f) => !f.includes("/subagents/"));
	const subs = files.filter((f) => f.includes("/subagents/"));
	const out: CallRecord[] = [];
	for (const f of mains) {
		let parsed: ParsedClaude;
		try { parsed = parseClaudeSession(f, undefined, prices); } catch { continue; }
		const sid = basename(f, ".jsonl");
		const mine = subs.filter((s) => dirname(dirname(s)) === join(dirname(f), sid));
		const all = [...parsed.records];
		for (const s of mine) {
			const agentId = basename(s, ".jsonl").replace(/^agent-/, "");
			const name = parsed.agentNames.get(agentId);
			try {
				const sub = parseClaudeSession(s, undefined, prices, `subagent:${name ?? "unknown"}`);
				for (const r of sub.records) { r.sessionId = sid; r.cwd = r.cwd ?? parsed.records[0]?.cwd; }
				all.push(...sub.records);
			} catch { /* skip unreadable subagent file */ }
		}
		calibrate(all, parsed.costState);
		// A record with an unparseable timestamp carries 0; it must not make the session look older than the branch point.
		const parentTimes = parsed.records.map((record) => record.timestamp).filter((time) => time > 0);
		const parentStart = parentTimes.length ? Math.min(...parentTimes) : undefined;
		if (filter.sessionStartedSince !== undefined && (parentStart === undefined || parentStart < filter.sessionStartedSince)) continue;
		if (filter.cwd && all.length && all[0].cwd !== filter.cwd) continue;
		out.push(...filterSessionRecords(all, { ...filter, cwd: undefined, sessionStartedSince: undefined }));
	}
	return out;
}
