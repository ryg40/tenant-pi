import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FIXED_DECISION_OPTIONS, makeOptions, type OwnerRow, type RowOption } from "./rows.ts";

/**
 * Isolated writer (Pi luna medium) for `Owner decides` rows that the strict splitter refused.
 * Runs Pi in print/json streaming mode in a clean temp folder with a fresh empty PI_CODING_AGENT_DIR.
 * Enforces hard output (4,000 chars) and wall-clock (10 s) caps because Pi exposes no output-token cap flag.
 */

export const WRITER_MODEL = "litellm-codex/codex-auto/luna";
export const WRITER_THINKING = "medium";
export const WRITER_LIMITS = Object.freeze({
	maxChars: 4000,
	timeoutMs: 10_000,
	maxOptionsPerRow: 5,
	minOptionChars: 2,
	maxOptionChars: 120,
});

export const WRITER_SYSTEM_PROMPT =
	"You write short concrete decision options for owner tasks. Output only JSON Lines: one {\"label\":\"...\",\"options\":[\"...\"]} object per line, no prose, no code fences.";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CODEX_EXTENSION = resolve(HERE, "../extensions/codex-accounts/index.ts");

const WRITER_ENV_KEYS = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TZ",
	"TMPDIR",
	"TEMP",
	"TMP",
	"XDG_CONFIG_HOME",
	"XDG_STATE_HOME",
	"XDG_CACHE_HOME",
	"XDG_DATA_HOME",
	"XDG_RUNTIME_DIR",
	"NODE_EXTRA_CA_CERTS",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"TENANTEXT_LITELLM_BASE_URL",
	"TENANTEXT_LITELLM_API_KEY",
] as const;

/** Build a minimal child environment for isolated `pi`: never forwards unrelated credentials or HC_* vars. */
export function buildWriterEnv(source: NodeJS.ProcessEnv, agentDir: string): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	for (const key of WRITER_ENV_KEYS) {
		if (source[key] !== undefined) out[key] = source[key];
	}
	out.PI_CODING_AGENT_DIR = agentDir;
	return out;
}

export interface WriterConfig {
	piBin?: string;
	codexExtensionPath?: string;
	model?: string;
	thinking?: string;
	maxChars?: number;
	timeoutMs?: number;
	env?: NodeJS.ProcessEnv;
}

export interface WriterTimings {
	firstOutputMs: number | null;
	firstRowMs: number | null;
	totalMs: number;
	charsRead: number;
	stoppedByCap: boolean;
	timedOut: boolean;
	exitCode: number | null;
}

export interface WriterResult {
	suggestions: Map<string, RowOption[]>;
	timings: WriterTimings;
}

/** Build the writer prompt sent on stdin (never on argv). Contains excerpt and open rows only. */
export function buildWriterPrompt(excerpt: string, openRows: readonly Pick<OwnerRow, "label" | "text">[]): string {
	const lines = [
		"You are a task session; reply only with the JSON lines asked for.",
		"For each task below, write 3 short concrete owner answers (2 to 120 chars each).",
		"Reply with one JSON object per line: {\"label\":\"<LABEL>\",\"options\":[\"<option 1>\",\"<option 2>\",\"<option 3>\"]}.",
	];
	if (excerpt.trim()) {
		lines.push("", "Context excerpt:", excerpt.trim());
	}
	lines.push("", "Open tasks:");
	for (const row of openRows) {
		lines.push(`- [${row.label}] ${row.text}`);
	}
	return `${lines.join("\n")}\n`;
}

/** Combine writer options with the two fixed answers (capped at 5 candidates for the decider). */
export function mergeWriterOptions(rawOptions: readonly string[]): RowOption[] | null {
	const cleaned: string[] = [];
	const seen = new Set<string>();
	for (const item of rawOptions) {
		if (typeof item !== "string") continue;
		const text = item.replace(/\s+/g, " ").trim();
		if (text.length < WRITER_LIMITS.minOptionChars || text.length > WRITER_LIMITS.maxOptionChars) continue;
		const key = text.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		cleaned.push(text);
		if (cleaned.length >= 3) break;
	}
	if (cleaned.length === 0) return null;
	for (const fixed of FIXED_DECISION_OPTIONS) {
		if (cleaned.length >= WRITER_LIMITS.maxOptionsPerRow) break;
		if (!seen.has(fixed.toLowerCase())) {
			seen.add(fixed.toLowerCase());
			cleaned.push(fixed);
		}
	}
	return makeOptions(cleaned);
}

/** Extract assistant text delta from one Pi `--mode json` event line. */
function extractDeltaFromJsonEvent(line: string): { delta: string; fallbackFullText?: string } {
	const trimmed = line.trim();
	if (!trimmed) return { delta: "" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return { delta: "" };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { delta: "" };
	const obj = parsed as Record<string, unknown>;

	// Pi `--mode json` streaming event: message_update -> assistantMessageEvent.text_delta
	if (obj.type === "message_update" && obj.assistantMessageEvent && typeof obj.assistantMessageEvent === "object") {
		const inner = obj.assistantMessageEvent as Record<string, unknown>;
		if (inner.type === "text_delta" && typeof inner.delta === "string") {
			return { delta: inner.delta };
		}
	}
	// Direct text_delta event (convenience for test fakes)
	if (obj.type === "text_delta" && typeof obj.delta === "string") {
		return { delta: obj.delta };
	}
	// Final assistant message fallback if no text_delta events were emitted
	if (obj.type === "message_end" && obj.message && typeof obj.message === "object") {
		const msg = obj.message as Record<string, unknown>;
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			const text = msg.content
				.filter((p): p is { type: "text"; text: string } =>
					Boolean(p) && typeof p === "object" && (p as Record<string, unknown>).type === "text" && typeof (p as Record<string, unknown>).text === "string",
				)
				.map((p) => p.text)
				.join("\n");
			if (text) return { delta: "", fallbackFullText: text };
		}
	}
	// Raw row object printed directly (for simple stubs)
	if (typeof obj.label === "string" && Array.isArray(obj.options)) {
		return { delta: `${trimmed}\n` };
	}
	return { delta: "" };
}

/**
 * Stateful line parser for streamed writer output.
 * Handles split chunks, doubled labels (keeps first valid), broken lines, and garbage gracefully.
 */
export function createWriterLineParser(
	allowedLabels: ReadonlySet<string>,
	onRow: (label: string, options: RowOption[]) => void,
) {
	let textBuffer = "";
	const emitted = new Set<string>();

	function parseLine(rawLine: string): void {
		const line = rawLine.trim();
		if (!line || line.startsWith("```") || !line.startsWith("{")) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			return;
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
		const obj = parsed as Record<string, unknown>;
		if (typeof obj.label !== "string" || !allowedLabels.has(obj.label)) return;
		if (emitted.has(obj.label)) return;
		if (!Array.isArray(obj.options)) return;
		const merged = mergeWriterOptions(obj.options.filter((v): v is string => typeof v === "string"));
		if (!merged) return;
		emitted.add(obj.label);
		onRow(obj.label, merged);
	}

	return {
		pushText(chunk: string): void {
			if (!chunk) return;
			textBuffer += chunk;
			let newlineAt = textBuffer.indexOf("\n");
			while (newlineAt >= 0) {
				const line = textBuffer.slice(0, newlineAt);
				textBuffer = textBuffer.slice(newlineAt + 1);
				parseLine(line);
				newlineAt = textBuffer.indexOf("\n");
			}
		},
		flush(): void {
			if (textBuffer.trim()) {
				parseLine(textBuffer);
			}
			textBuffer = "";
		},
		hasEmitted(label: string): boolean {
			return emitted.has(label);
		},
	};
}

/**
 * Run isolated Pi in print/json mode for rows that the splitter refused.
 * Emits each completed row via `onRow` as soon as its line completes.
 */
export async function runWriter(
	excerpt: string,
	openRows: readonly Pick<OwnerRow, "label" | "text">[],
	config: WriterConfig = {},
	onRow?: (label: string, candidates: RowOption[]) => void,
): Promise<WriterResult> {
	const suggestions = new Map<string, RowOption[]>();
	if (openRows.length === 0) {
		return {
			suggestions,
			timings: {
				firstOutputMs: null,
				firstRowMs: null,
				totalMs: 0,
				charsRead: 0,
				stoppedByCap: false,
				timedOut: false,
				exitCode: 0,
			},
		};
	}

	const maxChars = config.maxChars ?? WRITER_LIMITS.maxChars;
	const timeoutMs = config.timeoutMs ?? WRITER_LIMITS.timeoutMs;
	const piBin = config.piBin ?? "pi";
	const codexExt = config.codexExtensionPath ?? DEFAULT_CODEX_EXTENSION;
	const model = config.model ?? WRITER_MODEL;
	const thinking = config.thinking ?? WRITER_THINKING;
	const allowedLabels = new Set(openRows.map((r) => r.label));
	const prompt = buildWriterPrompt(excerpt, openRows);

	const workDir = mkdtempSync(join(tmpdir(), "owner-popup-writer-cwd-"));
	const agentDir = mkdtempSync(join(tmpdir(), "owner-popup-writer-agent-"));

	const args = [
		"-p",
		"--mode",
		"json",
		"--no-session",
		"-ne",
		"-e",
		codexExt,
		"-ns",
		"-np",
		"-nc",
		"-nt",
		"--no-mcp",
		"--no-themes",
		"--offline",
		"--no-approve",
		"--model",
		model,
		"--thinking",
		thinking,
		"--system-prompt",
		WRITER_SYSTEM_PROMPT,
	];

	const t0 = performance.now();
	const track: {
		firstOutputMs: number | null;
		firstRowMs: number | null;
		charsRead: number;
		stoppedByCap: boolean;
		timedOut: boolean;
		sawTextDelta: boolean;
		fallbackText: string;
	} = {
		firstOutputMs: null,
		firstRowMs: null,
		charsRead: 0,
		stoppedByCap: false,
		timedOut: false,
		sawTextDelta: false,
		fallbackText: "",
	};

	const parser = createWriterLineParser(allowedLabels, (label, options) => {
		if (track.firstRowMs === null) track.firstRowMs = performance.now() - t0;
		suggestions.set(label, options);
		onRow?.(label, options);
	});

	try {
		const exitCode = await new Promise<number | null>((resolveDone) => {
			let settled = false;
			let killEscalation: NodeJS.Timeout | undefined;
			const child = spawn(piBin, args, {
				cwd: workDir,
				env: buildWriterEnv(config.env ?? process.env, agentDir),
				stdio: ["pipe", "pipe", "ignore"],
			});

			const terminate = () => {
				if (child.killed || child.exitCode !== null) return;
				try {
					child.kill("SIGTERM");
				} catch {
					// ignore
				}
				killEscalation = setTimeout(() => {
					if (child.exitCode === null) {
						try {
							child.kill("SIGKILL");
						} catch {
							// ignore
						}
					}
				}, 250);
				killEscalation.unref();
			};

			const timer = setTimeout(() => {
				track.timedOut = true;
				terminate();
			}, timeoutMs);
			timer.unref();

			const finish = (code: number | null) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (killEscalation) clearTimeout(killEscalation);
				if (!track.sawTextDelta && track.fallbackText) {
					const allowed = track.fallbackText.slice(0, Math.max(0, maxChars - track.charsRead));
					track.charsRead += allowed.length;
					parser.pushText(allowed);
				}
				parser.flush();
				resolveDone(code);
			};

			let stdoutLineBuf = "";
			const processEventLine = (eventLine: string) => {
				if (track.stoppedByCap) return;
				const { delta, fallbackFullText } = extractDeltaFromJsonEvent(eventLine);
				if (fallbackFullText) track.fallbackText = fallbackFullText;
				if (!delta) return;
				track.sawTextDelta = true;
				if (track.firstOutputMs === null) track.firstOutputMs = performance.now() - t0;
				const remaining = maxChars - track.charsRead;
				if (delta.length >= remaining) {
					const slice = delta.slice(0, Math.max(0, remaining));
					track.charsRead += slice.length;
					parser.pushText(slice);
					track.stoppedByCap = true;
					terminate();
					return;
				}
				track.charsRead += delta.length;
				parser.pushText(delta);
			};

			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				if (track.stoppedByCap) return;
				stdoutLineBuf += chunk;
				let nl = stdoutLineBuf.indexOf("\n");
				while (nl >= 0) {
					const line = stdoutLineBuf.slice(0, nl);
					stdoutLineBuf = stdoutLineBuf.slice(nl + 1);
					processEventLine(line);
					if (track.stoppedByCap) return;
					nl = stdoutLineBuf.indexOf("\n");
				}
			});

			child.stdout.on("end", () => {
				if (!track.stoppedByCap && stdoutLineBuf.trim()) {
					processEventLine(stdoutLineBuf);
				}
			});

			child.on("error", () => finish(null));
			child.on("close", (code) => finish(code));

			child.stdin.on("error", () => {
				// Child may close stdin early on error.
			});
			child.stdin.end(prompt);
		});

		return {
			suggestions,
			timings: {
				firstOutputMs: track.firstOutputMs === null ? null : Number(track.firstOutputMs.toFixed(1)),
				firstRowMs: track.firstRowMs === null ? null : Number(track.firstRowMs.toFixed(1)),
				totalMs: Number((performance.now() - t0).toFixed(1)),
				charsRead: track.charsRead,
				stoppedByCap: track.stoppedByCap,
				timedOut: track.timedOut,
				exitCode,
			},
		};
	} finally {
		rmSync(workDir, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	}
}
