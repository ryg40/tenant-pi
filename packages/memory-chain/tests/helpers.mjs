// Test helpers: a controlled clock, a fake OpenViking server on loopback and isolated stores.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A clock that moves only on `advance`. Timers fire in time order. */
export function fakeClock(start = 1_700_000_000_000) {
	let now = start;
	const timers = [];
	return {
		now: () => now,
		setTimeout(fn, ms) {
			const timer = { at: now + ms, fn };
			timers.push(timer);
			return timer;
		},
		clearTimeout(timer) {
			const index = timers.indexOf(timer);
			if (index >= 0) timers.splice(index, 1);
		},
		async advance(ms) {
			const target = now + ms;
			for (;;) {
				await flush();
				timers.sort((a, b) => a.at - b.at);
				const next = timers[0];
				if (!next || next.at > target) break;
				timers.shift();
				now = next.at;
				next.fn();
			}
			now = target;
			await flush();
		},
	};
}

/** A ranker with its declared time (`reserveMs`). */
export function ranker(fn, reserveMs = 0) {
	return Object.assign(fn, { reserveMs });
}

/** Wait until `check()` is true, polling, for at most `ms`. */
export async function waitFor(check, ms = 4000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (check()) return true;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return check();
}

/** A store that answers at once. */
export function readyStore(name, hits) {
	return { name, search: async () => ({ status: "ready", hits }) };
}

/** A store that never answers. */
export function stalledStore(name) {
	return { name, search: () => new Promise(() => {}) };
}

/**
 * A fake OpenViking server. `reply(body)` gives `{status, json}`. It records each request body and
 * the actor header; no request data goes into a response header.
 */
export async function fakeOpenViking(t, reply) {
	const requests = [];
	const server = createServer((request, response) => {
		const chunks = [];
		request.on("data", (chunk) => chunks.push(chunk));
		request.on("end", () => {
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
			requests.push({ path: request.url, body, actor: request.headers["x-openviking-actor-peer"] ?? "" });
			const answer = reply(body);
			response.writeHead(answer.status, { "Content-Type": "application/json" });
			response.end(JSON.stringify(answer.json ?? {}));
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	const { port } = server.address();
	return { base: `http://127.0.0.1:${port}`, requests };
}

/**
 * An isolated home with a git project, the switch file and an OpenViking client file that names
 * `base`. Returns the environment and the folders.
 */
export function sandbox(t, { base = "", mode = "shadow", approved = null, cli = {} } = {}) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "memory-chain-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const home = join(root, "home");
	const project = join(root, "work", "alpha");
	mkdirSync(project, { recursive: true });
	mkdirSync(home, { recursive: true });
	spawnSync("git", ["init", "-q", project]);
	const env = {
		HOME: home,
		PATH: process.env.PATH,
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_STATE_HOME: join(home, ".local", "state"),
		PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
		OPENVIKING_CLI_CONFIG_FILE: join(home, "ovcli.json"),
		OPENVIKING_CONFIG_FILE: join(home, "missing-ov.conf"),
	};
	writeFileSync(env.OPENVIKING_CLI_CONFIG_FILE, JSON.stringify({ ...(base ? { url: base } : {}), ...cli }));
	const config = join(env.XDG_CONFIG_HOME, "tenant-pi", "memory-chain");
	mkdirSync(config, { recursive: true });
	if (mode) writeFileSync(join(config, "settings.json"), JSON.stringify({ mode }));
	if (approved) writeFileSync(join(config, "approved-facts.json"), JSON.stringify({ facts: approved }));
	return { env, home, project, state: join(env.XDG_STATE_HOME, "tenant-pi", "memory-chain") };
}
