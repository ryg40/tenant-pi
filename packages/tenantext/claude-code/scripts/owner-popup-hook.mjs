#!/usr/bin/env node
// Stop and UserPromptSubmit launcher for the opt-in owner-task rail.
// Checks trusted opt-in settings BEFORE reading stdin (bounded to 1 MiB and 2 s).
// Publishes each event file via atomic rename (mode 0600 inside mode 0700 folder).
// Always writes turn-start events when enabled; always spawns the detached producer on stop
// (the producer's loopback TCP bind is the OS-released single-instance lock, exiting 0 on EADDRINUSE).
// Prints nothing and exits 0 on every path so a failure here can never block Claude Code.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { performance } from "node:perf_hooks";

const MAX_SETTINGS_BYTES = 64 * 1024;
const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_STDIN_MS = 2000;
const EVENT_ADDRESS_RE = /^[A-Za-z0-9._-]+$/;

// Event file name forms (shared between owner-popup-hook.mjs and producer.ts):
// - Stop event: `stop-<16-digit ms>-<8 lowercase hex>.json`
// - Turn-start event: `turn-start-<address>.json` (address uses only `[A-Za-z0-9._-]`, never starts with `-`, not `.` or `..`)
// - Taken event (reader-owned, never written by the hook): `reading-<pid>-<12 lowercase hex>.json`

// Minimal environment forwarded to the detached producer daemon (never HC_TERMINAL_ID or unrelated session keys).
const PRODUCER_ENV_KEYS = [
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
	"HC_SOCKET",
	"HC_SCOPE",
	"HC_RUNTIME_DIR",
	"HC_DRAFT_MS",
	"DECISION_API_KEY",
	"TENANTEXT_LITELLM_BASE_URL",
	"TENANTEXT_LITELLM_API_KEY",
];

function resolveSettingsPath() {
	const override = process.env.OWNER_POPUP_SETTINGS;
	if (override && isAbsolute(override)) return override;
	const xdg = process.env.XDG_CONFIG_HOME && isAbsolute(process.env.XDG_CONFIG_HOME)
		? process.env.XDG_CONFIG_HOME
		: join(homedir(), ".config");
	return join(xdg, "owner-popup", "settings.json");
}

function resolveStateDir() {
	const override = process.env.OWNER_POPUP_STATE_DIR;
	if (override && isAbsolute(override)) return override;
	const xdg = process.env.XDG_STATE_HOME && isAbsolute(process.env.XDG_STATE_HOME)
		? process.env.XDG_STATE_HOME
		: join(homedir(), ".local", "state");
	return join(xdg, "owner-popup");
}

function isTrustedEntry(targetPath, kind, allowRoot = false) {
	try {
		const st = lstatSync(targetPath);
		if (st.isSymbolicLink()) return null;
		if (kind === "file" && !st.isFile()) return null;
		if (kind === "dir" && !st.isDirectory()) return null;
		if (typeof process.getuid === "function") {
			const uid = process.getuid();
			if (st.uid !== uid && !(allowRoot && st.uid === 0)) return null;
		}
		if ((st.mode & 0o022) !== 0) return null;
		return st;
	} catch {
		return null;
	}
}

function readTrustedSettings(settingsPath) {
	if (!isTrustedEntry(dirname(settingsPath), "dir")) return null;
	const fileStat = isTrustedEntry(settingsPath, "file");
	if (!fileStat || fileStat.size > MAX_SETTINGS_BYTES) return null;

	try {
		const parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		if (parsed.enabled !== true) return null;
		if (typeof parsed.kitRoot !== "string" || !isAbsolute(parsed.kitRoot)) return null;

		const kitRoot = parsed.kitRoot;
		const relDirs = ["packages", "tenantext", "owner-popup"];
		if (!isTrustedEntry(kitRoot, "dir", true)) return null;
		let cur = kitRoot;
		for (const part of relDirs) {
			cur = join(cur, part);
			if (!isTrustedEntry(cur, "dir", true)) return null;
		}
		const producerPath = join(cur, "producer.ts");
		if (!isTrustedEntry(producerPath, "file", true)) return null;

		return { settings: parsed, producerPath };
	} catch {
		return null;
	}
}

function buildProducerEnv(source) {
	const out = {};
	for (const key of PRODUCER_ENV_KEYS) {
		if (source[key] !== undefined) out[key] = source[key];
	}
	if (source.OWNER_POPUP_STATE_DIR && isAbsolute(source.OWNER_POPUP_STATE_DIR)) {
		out.OWNER_POPUP_STATE_DIR = source.OWNER_POPUP_STATE_DIR;
	}
	return out;
}

function readBoundedStdinJson(maxBytes = MAX_STDIN_BYTES, timeoutMs = MAX_STDIN_MS) {
	return new Promise((resolveDone) => {
		const chunks = [];
		let total = 0;
		let settled = false;

		const finish = (value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			process.stdin.off("data", onData);
			process.stdin.off("end", onEnd);
			process.stdin.off("error", onError);
			process.stdin.pause();
			resolveDone(value);
		};

		const timer = setTimeout(() => finish(null), timeoutMs);
		timer.unref();

		const onData = (chunk) => {
			const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
			total += buf.length;
			if (total > maxBytes) {
				finish(null);
				return;
			}
			chunks.push(buf);
		};
		const onEnd = () => {
			try {
				const text = Buffer.concat(chunks).toString("utf8").trim();
				finish(text ? JSON.parse(text) : {});
			} catch {
				finish(null);
			}
		};
		const onError = () => finish(null);

		process.stdin.on("data", onData);
		process.stdin.on("end", onEnd);
		process.stdin.on("error", onError);
		process.stdin.resume();
	});
}

function writeEventAtomically(eventsDir, finalName, payload) {
	mkdirSync(eventsDir, { recursive: true, mode: 0o700 });
	const dirStat = isTrustedEntry(eventsDir, "dir");
	if (!dirStat) return false;
	chmodSync(eventsDir, 0o700);

	const tmpPath = join(eventsDir, `.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
	const finalPath = join(eventsDir, finalName);
	try {
		writeFileSync(tmpPath, JSON.stringify(payload), { flag: "wx", mode: 0o600 });
		chmodSync(tmpPath, 0o600);
		renameSync(tmpPath, finalPath);
		return true;
	} catch {
		try {
			unlinkSync(tmpPath);
		} catch {
			// ignore
		}
		return false;
	}
}

try {
	const mode = process.argv[2];
	if (mode !== "stop" && mode !== "turn-start") process.exit(0);
	// A `claude -p` or SDK run that a hook or a tool of the coordinator starts inherits HC_TERMINAL_ID; its
	// turns are not turns of the coordinator, and its Stop would end the receipt of a delivered answer.
	if (/^sdk-/.test(String(process.env.CLAUDE_CODE_ENTRYPOINT ?? ""))) process.exit(0);

	const address = String(process.env.HC_TERMINAL_ID ?? "").trim();
	if (!address || address.startsWith("-") || address === "." || address === ".." || !EVENT_ADDRESS_RE.test(address)) {
		process.exit(0);
	}

	// Check opt-in settings and trusted ownership/permissions BEFORE touching stdin.
	const trusted = readTrustedSettings(resolveSettingsPath());
	if (!trusted) process.exit(0);

	const { settings, producerPath } = trusted;
	const stateDir = resolveStateDir();
	const eventsDir = join(stateDir, "events");

	const ensurePrivateStateDir = () => {
		mkdirSync(stateDir, { recursive: true, mode: 0o700 });
		return Boolean(isTrustedEntry(stateDir, "dir"));
	};

	if (mode === "turn-start") {
		if (!ensurePrivateStateDir()) process.exit(0);
		const timeMs = performance.timeOrigin + performance.now();
		writeEventAtomically(eventsDir, `turn-start-${address}.json`, {
			type: "turn_start",
			address,
			timeMs,
			at: new Date(timeMs).toISOString(),
		});
		process.exit(0);
	}

	const input = await readBoundedStdinJson();
	if (!input || typeof input !== "object" || Array.isArray(input)) process.exit(0);
	if (input.stop_hook_active === true) process.exit(0);

	const reportText = typeof input.last_assistant_message === "string" ? input.last_assistant_message : "";
	if (!reportText.trim()) process.exit(0);

	if (!ensurePrivateStateDir()) process.exit(0);
	const timeMs = performance.timeOrigin + performance.now();
	const stopName = `stop-${String(Math.floor(timeMs)).padStart(16, "0")}-${randomBytes(4).toString("hex")}.json`;
	const wrote = writeEventAtomically(eventsDir, stopName, {
		type: "stop",
		address,
		reportText,
		timeMs,
		at: new Date(timeMs).toISOString(),
	});
	if (!wrote) process.exit(0);

	const args = [producerPath, "--events-dir", eventsDir, "--state-dir", stateDir];
	if (Number.isInteger(settings.port) && settings.port > 0 && settings.port <= 65535) {
		args.push("--port", String(settings.port));
	}
	if (typeof settings.lockFile === "string" && isAbsolute(settings.lockFile)) {
		args.push("--lock-file", settings.lockFile);
	}
	const child = spawn(process.execPath, args, {
		detached: true,
		stdio: "ignore",
		env: buildProducerEnv(process.env),
	});
	child.unref();
} catch {
	// Never fail or emit noise into Claude Code hooks.
}
process.exit(0);
