#!/usr/bin/env node
/**
 * The status line of Antigravity CLI (agy): the rows of the tenantext Pi operations footer (ops-footer).
 *
 * agy runs this script as the command of the statusLine key in <gemini>/antigravity-cli/settings.json
 * (scripts/kit_agy.py writes the key) and sends one JSON object on standard input. The script prints the rows of
 * packages/tenantext/extensions/ops-footer:
 *   - the model row (antigravity/<model> and the effort, the token totals and the cost of the session)
 *   - the folder and Git row (cwd, branch, changed files, worktrees, agent state, duration)
 *   - the context bar (sys, prompt, assistant, think, tools, free, the threshold marks)
 *   - the quota rows of the active Pi profile (Codex, Claude, Copilot, Antigravity)
 *   - the memory and service rows (OpenViking, OpenKnowledge through okknow, the artifact server)
 *
 * The script never opens <gemini>/antigravity-cli/settings.json or a login file of agy; antigravitySignInMtime of
 * antigravity.ts only calls statSync on the sign-in file. The transcript must be a regular file, not a link; below
 * ~/.gemini/antigravity-cli/ only brain/<id>/.system_generated/logs/transcript.jsonl is read (see scanTranscript). A run on the foreground waits on no network call: a stale reading starts one detached
 * run with --refresh-quota <meter> or --refresh-usage [slot] under an exclusive flock lock (see withLock). The cache folder
 * <XDG_CACHE_HOME or ~/.cache>/claude-pi-footer/ is shared with the Claude Code status line of the kit.
 * When tenantext or one of its modules cannot load, the script prints one plain line and exits 0.
 *
 * Environment:
 *   PI_FOOTER_TENANTEXT  the tenantext package folder (default: ../../tenantext from the real path of this script)
 *   PI_FOOTER_PROFILE    the Pi profile folder of the quota rows (default: see resolveProfileDir); the global
 *                        settings are always ~/.pi/agent
 *   PI_FOOTER_CODEX_POLL the Codex poll period in seconds (default 300, at least 60)
 *   PI_FOOTER_THEME      light | dark (default: the theme of the input, else dark)
 *   PI_FOOTER_WIDTH      a fixed row width in columns (default: terminal_width of the input, else the tty)
 *   PI_FOOTER_MARGIN     the columns kept free with the tty width (default 4)
 *   PI_FOOTER_SYS_WARN   the sys! threshold in tokens (default 60000)
 *   PI_FOOTER_NO_REFRESH 1: start no background refresh run (for offline tests)
 *   PI_FOOTER_DEBUG      1: print errors to standard error before the plain line
 */
import {
  closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync,
  readlinkSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir, hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = realpathSync(fileURLToPath(import.meta.url));
const HOME = homedir();
const TENANTEXT = process.env.PI_FOOTER_TENANTEXT || resolve(dirname(SELF), "..", "..", "tenantext");
// The global Pi settings: always ~/.pi/agent. PI_CODING_AGENT_DIR selects only the profile (resolveProfileDir).
const PI_AGENT = join(HOME, ".pi", "agent");
const GEMINI_CONFIG = process.env.AGY_CONFIG_DIR || join(HOME, ".gemini", "config");
const AGY_OV_STATE = process.env.AGY_OV_STATE_DIR || join(HOME, ".local", "state", "agy-openviking");
const OV_STATE = join(process.env.OPENVIKING_HOME || join(HOME, ".openviking"), "state");
const CACHE = join(process.env.XDG_CACHE_HOME || join(HOME, ".cache"), "claude-pi-footer");
const CACHE_VERSION = 1;
const NO_REFRESH = process.env.PI_FOOTER_NO_REFRESH === "1";

const readJson = path => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; } };
const num = value => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const safeId = value => String(value || "").replace(/[^A-Za-z0-9._-]/g, "-");
const isDir = path => { try { return statSync(path).isDirectory(); } catch { return false; } };
const isFile = path => { try { return statSync(path).isFile(); } catch { return false; } };
// A module of tenantext, by its path below the package folder.
const load = rel => import(pathToFileURL(join(TENANTEXT, rel)).href);

/**
 * The Pi profile folder of the quota rows: PI_FOOTER_PROFILE; else PI_CODING_AGENT_DIR (agy under a Pi pane);
 * else ~/.pi/profiles/tenant-pi-full; else the first profile in ~/.pi/profiles/ (by name) with
 * ops-footer/settings.json, then the first with settings.json; else ~/.pi/agent.
 */
export function resolveProfileDir(env = process.env, home = HOME) {
  if (env.PI_FOOTER_PROFILE) return env.PI_FOOTER_PROFILE;
  if (env.PI_CODING_AGENT_DIR && isDir(env.PI_CODING_AGENT_DIR)) return env.PI_CODING_AGENT_DIR;
  const profiles = join(home, ".pi", "profiles");
  if (isDir(join(profiles, "tenant-pi-full"))) return join(profiles, "tenant-pi-full");
  let names = [];
  try { names = readdirSync(profiles).sort(); } catch { /* no profiles folder */ }
  for (const marker of [join("ops-footer", "settings.json"), "settings.json"]) {
    const found = names.find(name => isFile(join(profiles, name, marker)));
    if (found) return join(profiles, found);
  }
  return join(home, ".pi", "agent");
}

const PROFILE = resolveProfileDir();

const realOrResolved = path => { try { return realpathSync(path); } catch { return resolve(path); } };
/**
 * The cache names of a profile-scoped meter (codex-usage, copilot-usage): a short SHA-256 key of the real profile path
 * (no secret). The default profile ~/.pi/profiles/tenant-pi-full keeps <base>.json; each other profile gets
 * <base>-<key>.json and its own lock. The key is also stored in the file.
 */
export function profileCache(base, profile = PROFILE, home = HOME) {
  const key = createHash("sha256").update(realOrResolved(profile)).digest("hex").slice(0, 8);
  const isDefault = realOrResolved(profile) === realOrResolved(join(home, ".pi", "profiles", "tenant-pi-full"));
  const name = isDefault ? base : `${base}-${key}`;
  return { key, isDefault, name, file: `${name}.json` };
}
/** A stored reading of a profile-scoped meter, only when it is of that profile; an entry without key only for the default. */
export function profileReading(stored, cache) {
  if (!stored || typeof stored !== "object") return undefined;
  if (stored.profileKey === cache.key) return stored;
  return stored.profileKey === undefined && cache.isDefault ? stored : undefined;
}


function writeJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  try { writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 }); renameSync(temporary, path); }
  catch (error) { try { unlinkSync(temporary); } catch { /* ignore */ } throw error; }
}
function removeOldTemporaries(now) {
  let names = [];
  try { names = readdirSync(CACHE); } catch { return; }
  for (const name of names) {
    if (!/\.json\.\d+\.tmp$/.test(name)) continue;
    try { if (now - statSync(join(CACHE, name)).mtimeMs > 3_600_000) unlinkSync(join(CACHE, name)); } catch { /* ignore */ }
  }
}

// The lock holder: a python3 child that holds a kernel flock(2) lock on the lock file until its stdin ends. The
// kernel drops the lock when the child exits, also on a crash of either process; the lock file is never deleted.
const LOCK_HOLDER = [
  "import fcntl, os, sys",
  "try:",
  "    fd = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), 0o600)",
  "    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)",
  "except OSError:",
  "    sys.exit(1)",
  "sys.stdout.write('1\\n')",
  "sys.stdout.flush()",
  "sys.stdin.read()",
].join("\n");
/**
 * Run task under the lock file <dir>/<name>.lock (mode 0600), or return undefined when another run holds it or the
 * lock cannot be taken (no python3, no folder, a link). The lock is a process-scoped kernel flock lock, so no stale
 * lock stays after a crash, and no run renames or deletes the lock file.
 */
export async function withLock(name, task, dir = CACHE) {
  const path = join(dir, `${name}.lock`);
  let child;
  try { child = spawn("python3", ["-I", "-c", LOCK_HOLDER, path], { stdio: ["pipe", "pipe", "ignore"] }); }
  catch { return undefined; }
  // A missing python3 is an async error event: the run takes no lock and does not end.
  child.on("error", () => {});
  child.stdin.on("error", () => {});
  const exited = new Promise(done => { child.once("close", done); child.once("error", done); });
  const held = await new Promise(done => {
    let text = "";
    child.stdout.on("data", chunk => { text += chunk; if (text.includes("\n")) done(text === "1\n"); });
    exited.then(() => done(false));
  });
  try { return held ? await task() : undefined; }
  finally { child.stdin.end(); await exited; }
}

function terminalColumns() {
  let pid = process.pid;
  for (let depth = 0; depth < 8 && pid > 1; depth++) {
    for (const fd of [2, 1, 0]) {
      let target;
      try { target = readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
      if (!/^\/dev\/(pts\/\d+|tty\w+)$/.test(target)) continue;
      const size = spawnSync("stty", ["-F", target, "size"], { encoding: "utf8", timeout: 500 });
      const columns = Number(String(size.stdout ?? "").trim().split(/\s+/)[1]);
      if (columns > 0) return columns;
    }
    try { pid = Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").pop().split(" ")[1]); } catch { break; }
  }
  const columns = Number(process.env.COLUMNS);
  return columns > 0 ? columns : 120;
}

// --- The agy JSONL transcript scan ------------------------------------------------------------------------------

const textTokens = text => typeof text === "string" ? Math.ceil(text.length / 4) : 0;

export function freshScan(path) {
  return {
    path, offset: 0, dev: null, ino: null, startedAt: null, model: null, lastInputTokens: null,
    totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    estimates: { prompt: 0, assistant: 0, think: 0, tools: 0 },
    sys: null, tools: 0, state: "idle",
  };
}

function parseTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value > 1e12 ? value : value * 1000;
  if (typeof value === "string") { const ms = Date.parse(value); if (Number.isFinite(ms)) return ms; }
  return undefined;
}

export function handleAgyEntry(scan, entry) {
  if (!entry || typeof entry !== "object") return;
  if (scan.startedAt === null) {
    const ts = parseTimestamp(entry.created_at);
    if (ts !== undefined) scan.startedAt = ts;
  }
  const type = entry.type;
  if (type === "USER_INPUT") {
    scan.estimates.prompt += textTokens(entry.content);
    scan.state = "working";
    return;
  }
  if (type === "SYSTEM_MESSAGE") {
    scan.estimates.prompt += textTokens(entry.content);
    return;
  }
  if (type === "GENERIC") {
    scan.estimates.tools += textTokens(typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content ?? ""));
    return;
  }
  if (type === "PLANNER_RESPONSE") {
    if (typeof entry.model === "string" && entry.model) scan.model = entry.model;
    const inp = num(entry.input_tokens) ?? 0;
    const cacheRead = num(entry.cache_read_tokens) ?? 0;
    const out = num(entry.output_tokens) ?? 0;
    if (inp > 0) {
      if (scan.sys === null) scan.sys = Math.max(0, inp - scan.estimates.prompt - scan.estimates.tools);
      scan.lastInputTokens = inp;
      scan.totals.input += inp;
    }
    if (cacheRead > 0) scan.totals.cacheRead += cacheRead;
    if (out > 0) scan.totals.output += out;
    const thinkEst = textTokens(entry.thinking);
    const think = out > 0 ? Math.min(out, thinkEst) : thinkEst;
    scan.estimates.think += think;
    scan.estimates.assistant += out > 0 ? Math.max(0, out - think) : textTokens(entry.content);
    const calls = Array.isArray(entry.tool_calls) ? entry.tool_calls.length : 0;
    scan.tools += calls;
    const status = String(entry.status ?? "").toUpperCase();
    if (status.includes("ERROR") || status.includes("FAIL")) scan.state = "failed";
    else if (calls > 0 || status === "RUNNING" || status === "PENDING") scan.state = "working";
    else scan.state = "idle";
  }
}

const inside = (root, path) => {
  const rel = relative(root, path);
  return !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
};
/**
 * True when the status line may read the transcript path: a .jsonl path whose own entry and real path both pass the
 * boundary of ~/.gemini/antigravity-cli/: below it, only brain/<id>/.system_generated/logs/transcript.jsonl.
 */
export function transcriptAllowed(path, home = HOME) {
  if (typeof path !== "string" || !path || !path.endsWith(".jsonl")) return false;
  const root = join(home, ".gemini", "antigravity-cli");
  const roots = [...new Set([resolve(root), realOrResolved(root)])];
  const ok = candidate => roots.every(r => {
    if (!inside(r, candidate)) return true;
    const parts = relative(r, candidate).split(sep);
    return parts.length === 5 && parts[0] === "brain" && /^[A-Za-z0-9._-]+$/.test(parts[1]) && parts[1] !== ".."
      && parts[1] !== "." && parts[2] === ".system_generated" && parts[3] === "logs" && parts[4] === "transcript.jsonl";
  });
  let real;
  try { real = realpathSync(path); } catch { return false; }
  return ok(resolve(path)) && ok(real);
}

/**
 * Read the new complete lines of the agy transcript. A path that is a link, not a regular file or outside the
 * boundary (transcriptAllowed) is not opened. A new file at the path (another dev or inode) or a shorter file starts
 * a fresh scan.
 */
export function scanTranscript(path, previous, home = HOME) {
  let scan = previous && previous.path === path ? previous : freshScan(path);
  let info;
  try { info = lstatSync(path); } catch { return scan; }
  if (info.isSymbolicLink() || !info.isFile() || !transcriptAllowed(path, home)) return freshScan(path);
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); } catch { return freshScan(path); }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) return freshScan(path);
    const size = opened.size;
    if (scan.dev !== opened.dev || scan.ino !== opened.ino || size < scan.offset) {
      scan = freshScan(path);
      scan.dev = opened.dev; scan.ino = opened.ino;
    }
    if (size === scan.offset) return scan;
    const chunk = Buffer.alloc(Math.min(4 * 1024 * 1024, size - scan.offset));
    let carry = Buffer.alloc(0), position = scan.offset;
    while (position < size) {
      const read = readSync(fd, chunk, 0, Math.min(chunk.length, size - position), position);
      if (read <= 0) break;
      position += read;
      const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, read)]) : chunk.subarray(0, read);
      const end = data.lastIndexOf(0x0a);
      if (end < 0) { carry = Buffer.from(data); continue; }
      for (const line of data.subarray(0, end).toString("utf8").split("\n")) {
        if (!line) continue;
        try { handleAgyEntry(scan, JSON.parse(line)); } catch { /* skip broken line */ }
      }
      carry = Buffer.from(data.subarray(end + 1));
    }
    scan.offset = position - carry.length;
    return scan;
  } finally { closeSync(fd); }
}

export function mapAgentState(rawState, fallback) {
  const s = String(rawState ?? "").trim().toLowerCase();
  if (!s) return fallback;
  if (s === "idle" || s === "done" || s === "ready") return "idle";
  if (s === "working" || s === "thinking" || s === "tool_use" || s === "running" || s === "streaming") return "working";
  if (s === "waiting" || s === "blocked" || s === "input_needed") return "waiting";
  if (s === "compacting") return "compacting";
  if (s === "retrying") return "retrying";
  if (s === "failed" || s === "error") return "failed";
  return fallback;
}

export function inferEffort(input, modelId) {
  const direct = input.model?.effort
    ?? (typeof input.effort === "string" ? input.effort : input.effort?.level)
    ?? input.effort_level;
  if (typeof direct === "string" && direct.trim()) return direct.trim().toLowerCase();
  const match = String(modelId ?? "").match(/-(low|medium|high|xhigh|max)$/i);
  if (match) return match[1].toLowerCase();
  if (input.thinking?.enabled) return "on";
  return "off";
}
// --- Shared quota & health sources (same cache & rules as Pi and Claude Code) -----------------------------------

function spawnScript(args) {
  if (NO_REFRESH) return;
  try {
    const child = spawn(process.execPath, ["--no-warnings", SELF, ...args], { detached: true, stdio: "ignore" });
    // An async spawn error must not end the foreground footer.
    child.on("error", () => {});
    child.unref();
  } catch { /* next run retries */ }
}

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const USAGE_ATTEMPT_MS = 5 * 60_000;
const usagePath = slot => join(CACHE, slot ? `usage-${slot}.json` : "usage.json");
const quotaPath = name => join(CACHE, `${name}.json`);
const quotaDue = (now, stored, pollMs) => {
  const since = now - (num(stored?.attemptAt) ?? -Infinity);
  return !(since >= 0 && since < pollMs);
};
const CODEX_POLL_SECONDS = Math.max(60, Number(process.env.PI_FOOTER_CODEX_POLL) || 300);
const quotaFloor = healthPollSeconds => 2 * healthPollSeconds * 1000 + 30_000 + 3000;
const resetTime = value => typeof value === "string"
  ? Math.round(Date.parse(value.replace(/(\.\d{3})\d+/, "$1")) / 60_000) * 60_000 : NaN;

function profileCredential(provider) {
  try { return JSON.parse(readFileSync(join(PROFILE, "auth.json"), "utf8").replace(/^\uFEFF/, ""))?.[provider]; }
  catch { return undefined; }
}
const profileSettings = name => readJson(join(PROFILE, name, "settings.json"));

function profileExtension(name) {
  const file = `extensions/${name}/index.ts`, settings = readJson(join(PROFILE, "settings.json"));
  const ends = value => typeof value === "string" && (value === file || value.endsWith(`/${file}`));
  if (Array.isArray(settings?.extensions) && settings.extensions.some(ends)) return true;
  return (Array.isArray(settings?.packages) ? settings.packages : []).some(entry => {
    if (entry && typeof entry === "object" && Array.isArray(entry.extensions)) return entry.extensions.some(ends);
    const source = typeof entry === "string" ? entry : entry?.source;
    if (typeof source !== "string" || !source.startsWith("/")) return false;
    try { return statSync(join(source, file)).isFile(); } catch { return false; }
  });
}

async function accountStore() {
  try {
    const store = await load("claude-code/scripts/claude-accounts.mjs");
    const root = store.accountsRoot();
    const sources = store.slotSources(root);
    const live = sources?.find(s => s.active);
    return live ? { store, root, sources, live, switchedAt: store.readState(root)?.switchedAt ?? 0 } : undefined;
  } catch { return undefined; }
}

function ownReading(source) {
  const own = readJson(usagePath(source?.slot));
  return source?.accountKey !== undefined && own?.account !== source.accountKey
    ? (own ? { attemptAt: own.attemptAt } : undefined) : own;
}

const usageDue = (now, at, pollMs, limits, own) =>
  (now - at >= pollMs || limits.some(l => resetTime(l?.resets_at) <= now)) && now - (num(own?.attemptAt) ?? 0) >= USAGE_ATTEMPT_MS;

function slotLimits(source, now, pollMs, active = false) {
  const slot = source?.slot, own = ownReading(source);
  const at = num(own?.at), limits = Array.isArray(own?.limits) ? own.limits : [];
  if (usageDue(now, at ?? -Infinity, pollMs, limits, own)) spawnScript(["--refresh-usage", ...(slot ? [slot] : [])]);
  if (at === undefined || now - at > 24 * 3_600_000) return undefined;
  const windows = limits.map(l => {
    const name = l?.kind === "session" ? "5h" : l?.kind === "weekly_all" ? "7d"
      : l?.kind === "weekly_scoped" && typeof l.scope?.model?.display_name === "string"
        ? l.scope.model.display_name.toLowerCase().replace(/[^a-z0-9 .-]/g, "").trim().slice(0, 12) || "model"
        : undefined;
    const resetsAt = resetTime(l?.resets_at);
    if (!name || num(l.percent) === undefined || resetsAt <= now) return undefined;
    return { name, percent: Math.max(0, Math.min(100, 100 - l.percent)), unavailable: false, ...(Number.isFinite(resetsAt) ? { resetsAt } : {}) };
  }).filter(Boolean);
  if (!windows.length) return undefined;
  const state = now - at > 2 * pollMs + USAGE_ATTEMPT_MS ? "unknown" : "ok";
  const label = slot ? `Claude${slot}${active ? "*" : ""}` : "Claude";
  return { state, checkedAt: at, account: { label, order: slot ? 900 + Number(slot) : 900, state, windows } };
}

async function anthropicRows(now, pollMs) {
  if (!profileExtension("anthropic-usage")) return undefined;
  const accounts = await accountStore();
  if (!accounts) {
    const one = slotLimits(undefined, now, pollMs, false);
    if (!one) return undefined;
    return {
      state: one.state, summary: one.state, checkedAt: one.checkedAt,
      staleAfter: 2 * pollMs + USAGE_ATTEMPT_MS, source: "claude-code", route: { state: "unknown" },
      accounts: [one.account],
    };
  }
  const items = accounts.sources.map(s => slotLimits(s, now, pollMs, s.active)).filter(Boolean);
  if (!items.length) return undefined;
  const rows = items.map(i => i.account).sort((a, b) => a.order - b.order);
  const checkedAt = Math.min(...items.map(i => i.checkedAt));
  const state = rows.some(a => a.state === "ok") ? "ok" : "unknown";
  return {
    state, summary: state, checkedAt, staleAfter: 2 * pollMs + USAGE_ATTEMPT_MS,
    source: "claude-code", route: { state: "unknown" }, accounts: rows,
  };
}

/**
 * The limits of a Claude usage response: the entries of payload.limits, then five_hour and seven_day (utilization)
 * for a kind that limits does not hold. A response with only five_hour and seven_day gives two limits.
 */
export function usageLimits(payload) {
  if (!payload || typeof payload !== "object") return [];
  const limits = (Array.isArray(payload.limits) ? payload.limits : [])
    .map(l => ({ kind: l?.kind, percent: l?.percent, resets_at: l?.resets_at, scope: { model: { display_name: l?.scope?.model?.display_name } } }));
  for (const [key, kind] of [["five_hour", "session"], ["seven_day", "weekly_all"]]) {
    if (!limits.some(l => l.kind === kind) && num(payload[key]?.utilization) !== undefined) {
      limits.push({ kind, percent: payload[key].utilization, resets_at: payload[key].resets_at, scope: { model: {} } });
    }
  }
  return limits;
}

async function refreshUsage(slot) {
  mkdirSync(CACHE, { recursive: true, mode: 0o700 });
  const accounts = slot ? await accountStore() : undefined;
  const source = accounts?.sources.find(s => s.slot === slot);
  if (slot && !source) return;
  await withLock(slot ? `usage-${slot}` : "usage", async () => {
    const previous = ownReading(source) ?? {};
    if (Date.now() - (num(previous.attemptAt) ?? 0) < USAGE_ATTEMPT_MS) return;
    writeJson(usagePath(slot), { ...previous, attemptAt: Date.now() });
    const { detectAnthropicCredentials } = await load("extensions/anthropic-usage/detect.ts");
    const env = source && !source.active ? { ...process.env, CLAUDE_CONFIG_DIR: source.configDir } : process.env;
    let credential = detectAnthropicCredentials({ sources: ["claude-code"], env })[0];
    if (!credential && source?.renewable) {
      if (accounts.store.claimRenew(CACHE, slot, Date.now())) await accounts.store.renewSlot(source.configDir);
      credential = detectAnthropicCredentials({ sources: ["claude-code"], env })[0];
    }
    if (!credential) return;
    const response = await fetch(USAGE_URL, {
      method: "GET",
      headers: { Accept: "application/json", "anthropic-beta": "oauth-2025-04-20", Authorization: `Bearer ${credential.token}` },
      redirect: "error", signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) { void response.body?.cancel().catch(() => {}); return; }
    const limits = usageLimits(await response.json());
    if (!limits.length) return;
    writeJson(usagePath(slot), { attemptAt: Date.now(), at: Date.now(), limits, ...(source?.accountKey !== undefined ? { account: source.accountKey } : {}) });
  });
}

async function codexAccounts() {
  if (!profileExtension("codex-accounts")) return undefined;
  const [{ codexAccountsSettingsPath, loadCodexAccountsSettings }, { tokenFileNoLogin }] = await Promise.all([
    load("extensions/codex-accounts/config.ts"),
    load("extensions/codex-accounts/token-file.ts"),
  ]);
  let settings;
  try { settings = loadCodexAccountsSettings(codexAccountsSettingsPath(PROFILE)); } catch { return undefined; }
  const exists = path => { try { return statSync(path).isFile(); } catch { return false; } };
  const present = settings.accounts.filter(a => a.tokenFile ? exists(a.tokenFile) && !tokenFileNoLogin(a.tokenFile) : profileCredential(a.provider) !== undefined);
  return { settings, present };
}

async function codexRows(now, adapters, footer) {
  const found = await codexAccounts();
  if (!found?.present.length) return undefined;
  const pollMs = Math.max(CODEX_POLL_SECONDS, footer.healthPollSeconds) * 1000;
  const cache = profileCache("codex-usage");
  const stored = profileReading(readJson(quotaPath(cache.name)), cache);
  if (quotaDue(now, stored, pollMs)) spawnScript(["--refresh-quota", "codex"]);
  const snapshot = stored?.snapshot;
  if (!snapshot || !Array.isArray(snapshot.accounts)) return undefined;
  const accounts = snapshot.accounts.filter(a => a?.login !== false && found.present.some(p => p.provider === a?.provider));
  if (!accounts.length) return undefined;
  return adapters.codexStatus({ ...snapshot, accounts }, now, quotaFloor(pollMs / 1000));
}

const CODEX_CREDENTIAL_ERRORS = new Set(["Token file unreadable or expired", "OAuth access token not found", "HTTP 401"]);
async function refreshCodex() {
  const found = await codexAccounts();
  if (!found?.present.length) return;
  const footer = profileSettings("ops-footer") ?? {};
  const pollMs = Math.max(CODEX_POLL_SECONDS, num(footer.healthPollSeconds) ?? 60) * 1000;
  const cache = profileCache("codex-usage");
  await withLock(cache.name, async () => {
    const previous = profileReading(readJson(quotaPath(cache.name)), cache) ?? {};
    if (!quotaDue(Date.now(), previous, pollMs)) return;
    writeJson(quotaPath(cache.name), { ...previous, profileKey: cache.key, attemptAt: Date.now() });
    process.env.PI_CODING_AGENT_DIR = PROFILE;
    const { createCodexStatus, collectLimitsFor, CACHED_LIMITS_MS, CODEX_STATUS_EVENT } = await load("extensions/codex-accounts/status.ts");
    let snapshot;
    const pi = { events: { emit: (event, value) => { if (event === CODEX_STATUS_EVENT) snapshot = value; }, on: () => () => {} }, on: () => {} };
    const status = createCodexStatus(pi, found.settings.accounts, collectLimitsFor(found.settings.explicit === true));
    const results = await status.refresh({});
    if (!snapshot?.checkedAt || !results.length) return;
    const at = Date.now(), goodAt = { ...(previous.goodAt ?? {}) };
    const accounts = snapshot.accounts.map(account => {
      if (account.state === "ok") { goodAt[account.provider] = at; return account; }
      const error = results.find(r => r.account.provider === account.provider)?.result?.error;
      const last = previous.snapshot?.accounts?.find(a => a?.provider === account.provider && a.state !== "error" && a.login !== false);
      const lastAt = num(goodAt[account.provider]);
      const reset = last?.windows?.some(w => w.resetsAt !== undefined && Date.parse(w.resetsAt) <= at);
      return CODEX_CREDENTIAL_ERRORS.has(error) && last && lastAt !== undefined && !reset && at - lastAt < CACHED_LIMITS_MS
        ? { ...last, state: "unknown", ...(account.subscription ? { subscription: account.subscription } : {}) } : account;
    });
    writeJson(quotaPath(cache.name), { profileKey: cache.key, attemptAt: Date.now(), at, goodAt, snapshot: { ...snapshot, accounts } });
  });
}

async function copilotMeter() {
  if (!profileExtension("copilot-usage")) return undefined;
  const [{ copilotSettingsPath, loadCopilotSettings }, { copilotProvider }] = await Promise.all([
    load("extensions/copilot-usage/settings.ts"),
    load("extensions/copilot-usage/detect.ts"),
  ]);
  const settings = loadCopilotSettings(copilotSettingsPath(PROFILE), process.env);
  if (settings.mode === "off") return undefined;
  const detect = {
    env: process.env, sources: settings.sources, domain: settings.domain,
    readPiCredential: () => profileCredential("github-copilot"),
    readPiSettings: () => readJson(join(PROFILE, "settings.json")),
  };
  return copilotProvider(detect) ? { settings, detect } : undefined;
}

async function copilotRows(now, adapters, footer) {
  const meter = await copilotMeter();
  if (!meter) return undefined;
  const cache = profileCache("copilot-usage");
  const stored = profileReading(readJson(quotaPath(cache.name)), cache);
  if (quotaDue(now, stored, meter.settings.pollSeconds * 1000)) spawnScript(["--refresh-quota", "copilot"]);
  return stored?.snapshot ? adapters.copilotStatus(stored.snapshot, now, quotaFloor(footer.healthPollSeconds)) : undefined;
}

async function refreshCopilot() {
  const meter = await copilotMeter();
  if (!meter) return;
  const cache = profileCache("copilot-usage");
  await withLock(cache.name, async () => {
    const previous = profileReading(readJson(quotaPath(cache.name)), cache) ?? {};
    if (!quotaDue(Date.now(), previous, meter.settings.pollSeconds * 1000)) return;
    writeJson(quotaPath(cache.name), { ...previous, profileKey: cache.key, attemptAt: Date.now() });
    const { createCopilotStatus } = await load("extensions/copilot-usage/status.ts");
    const snapshot = await createCopilotStatus({ settings: () => meter.settings, detect: () => meter.detect, emit: () => {} }).refresh(true);
    writeJson(quotaPath(cache.name), { profileKey: cache.key, attemptAt: Date.now(), at: Date.now(), snapshot });
  });
}

async function antigravityRows(now, adapters, footer) {
  if (!profileExtension("ops-footer")) return undefined;
  const ag = await load("extensions/ops-footer/antigravity.ts");
  const setting = profileSettings("ops-footer")?.antigravityUsage;
  const usage = setting === "on" || setting === "off" ? setting : "auto";
  if (usage === "off" || !ag.agyCommand(process.env)) return undefined;
  const signedIn = ag.antigravitySignInMtime(HOME);
  if (usage === "auto" && signedIn === undefined) return undefined;
  const stored = readJson(ag.antigravityReadingPath(process.env)) ?? {};
  const backoffAt = num(stored.backoffAt), backoffUntil = num(stored.backoffUntil);
  if (backoffAt !== undefined && backoffUntil !== undefined && backoffAt <= now && now < backoffUntil
    && backoffUntil - backoffAt <= ag.ANTIGRAVITY_BACKOFF_MS && !(signedIn !== undefined && signedIn > backoffAt)) return undefined;
  if (quotaDue(now, stored, ag.ANTIGRAVITY_POLL_MS + 2000)) spawnScript(["--refresh-quota", "antigravity"]);
  const at = num(stored.at);
  if (at === undefined || at > now) return undefined;
  const windows = list => (Array.isArray(list) ? list.slice(0, 2) : []).flatMap(w => {
    const percent = num(w?.percent);
    return (w?.name === "5h" || w?.name === "7d") && percent !== undefined && percent >= 0 && percent <= 100
      ? [{ name: w.name, percent, unavailable: false, resetsAt: num(w.resetsAt) }] : [];
  });
  const other = (Array.isArray(stored.other) ? stored.other.slice(0, 8) : []).flatMap(g =>
    typeof g?.name === "string" && /^[A-Za-z0-9][A-Za-z0-9 .,&()+-]{0,47}$/.test(g.name) && /(?:^|\s)models$/i.test(g.name)
      ? [{ name: g.name, windows: windows(g.windows) }] : []);
  return adapters.antigravityStatus({ kind: "reading", at, reading: { windows: windows(stored.windows), other } }, quotaFloor(footer.healthPollSeconds));
}

async function refreshAntigravity() {
  if (!profileExtension("ops-footer")) return;
  const ag = await load("extensions/ops-footer/antigravity.ts");
  const setting = profileSettings("ops-footer")?.antigravityUsage;
  if (setting === "off") return;
  await withLock("antigravity-usage", () => ag.checkAntigravity(undefined, { usage: setting === "on" ? "on" : "auto" }));
}

async function okknowRow(now) {
  const { okknowCommand, OKKNOW_CACHE_MS } = await load("extensions/ops-footer/okknow.ts");
  if (!okknowCommand()) return undefined;
  const stored = readJson(quotaPath("okknow"));
  if (quotaDue(now, stored, OKKNOW_CACHE_MS)) spawnScript(["--refresh-quota", "okknow"]);
  return typeof stored?.state === "string" ? { running: [], state: stored.state } : undefined;
}

async function refreshOkknow() {
  const { checkOkknow, OKKNOW_CACHE_MS } = await load("extensions/ops-footer/okknow.ts");
  await withLock("okknow", async () => {
    const previous = readJson(quotaPath("okknow")) ?? {};
    if (!quotaDue(Date.now(), previous, OKKNOW_CACHE_MS)) return;
    writeJson(quotaPath("okknow"), { ...previous, attemptAt: Date.now() });
    const state = await checkOkknow();
    writeJson(quotaPath("okknow"), { attemptAt: Date.now(), at: Date.now(), ...(state ? { state } : {}) });
  });
}

async function artifactsRow(now, showArtifactServer) {
  if (showArtifactServer === false) return undefined;
  const { artifactsCommand, ARTIFACTS_CACHE_MS } = await load("extensions/ops-footer/artifacts.ts");
  if (!artifactsCommand()) return undefined;
  const stored = readJson(quotaPath("artifacts"));
  if (quotaDue(now, stored, ARTIFACTS_CACHE_MS)) spawnScript(["--refresh-quota", "artifacts"]);
  return stored?.server && typeof stored.server.state === "string" ? stored.server : undefined;
}

async function refreshArtifacts() {
  const { checkArtifacts, ARTIFACTS_CACHE_MS } = await load("extensions/ops-footer/artifacts.ts");
  await withLock("artifacts", async () => {
    const previous = readJson(quotaPath("artifacts")) ?? {};
    if (!quotaDue(Date.now(), previous, ARTIFACTS_CACHE_MS)) return;
    writeJson(quotaPath("artifacts"), { ...previous, attemptAt: Date.now() });
    const server = await checkArtifacts();
    writeJson(quotaPath("artifacts"), { attemptAt: Date.now(), at: Date.now(), ...(server ? { server } : {}) });
  });
}

async function refreshQuota(meter) {
  mkdirSync(CACHE, { recursive: true, mode: 0o700 });
  removeOldTemporaries(Date.now());
  if (meter === "codex") await refreshCodex();
  else if (meter === "copilot") await refreshCopilot();
  else if (meter === "antigravity") await refreshAntigravity();
  else if (meter === "okknow") await refreshOkknow();
  else if (meter === "artifacts") await refreshArtifacts();
  else if (meter === "health") await refreshHealth();
}

/** The OK and OV health URLs of the merged footer settings. */
const healthTargets = settings => Object.entries(settings.healthUrls ?? {}).filter(([source, url]) =>
  ["OK", "OV"].includes(source) && typeof url === "string" && /^https?:\/\//.test(url));

/** The health rows from health.json only; a missing or stale reading starts one background refresh. */
function healthChecks(settings, now) {
  const urls = healthTargets(settings);
  if (!urls.length) return [];
  const cached = readJson(join(CACHE, "health.json")) ?? {};
  const period = settings.healthPollSeconds * 1000;
  const fresh = ([source, url]) => cached[source]?.url === url && num(cached[source].at) !== undefined
    && now - cached[source].at < period;
  if (!urls.every(fresh)) spawnScript(["--refresh-quota", "health"]);
  return urls.map(([source, url]) => cached[source]?.url === url && num(cached[source].at) !== undefined
    ? { source, state: cached[source].state, summary: cached[source].summary, checkedAt: cached[source].at,
      staleAfter: 2 * period + 33_000 }
    : { source, state: "unknown", summary: "checking", checkedAt: now, staleAfter: 2 * period + 33_000 });
}

async function refreshHealth() {
  const settings = footerSettings();
  const urls = healthTargets(settings);
  if (!urls.length) return;
  await withLock("health", async () => {
    const path = join(CACHE, "health.json");
    const cached = readJson(path) ?? {};
    const period = settings.healthPollSeconds * 1000, timeout = Math.min(settings.healthTimeoutMs, 1000);
    let changed = false;
    await Promise.all(urls.map(async ([source, url]) => {
      if (cached[source]?.url === url && Date.now() - cached[source].at < period) return;
      let state = "error", summary = "unavailable";
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(timeout), redirect: "error" });
        void response.body?.cancel().catch(() => {});
        if (response.ok) { state = "ok"; summary = "ok"; } else summary = `HTTP ${response.status}`;
      } catch { /* unreachable */ }
      cached[source] = { url, state, summary, at: Date.now() };
      changed = true;
    }));
    if (changed) writeJson(path, cached);
  });
}

function agyOpenVikingEnabled() {
  const hooks = readJson(join(GEMINI_CONFIG, "hooks.json"));
  return Boolean(hooks?.openviking && typeof hooks.openviking === "object");
}

export function openVikingMemory(sessionId, now, agyStateDir = AGY_OV_STATE, ovState = OV_STATE) {
  const memory = { running: [] };
  // No session id: no cursor matches (an empty id would match the cursors of other sessions).
  if (typeof sessionId !== "string" || !sessionId) return memory;
  const events = [];
  const agyStatePath = join(agyStateDir, `${safeId(sessionId)}.json`);
  const agyState = readJson(agyStatePath);
  if (agyState && num(agyState.sentStep) !== undefined) {
    let ts;
    try { ts = statSync(agyStatePath).mtimeMs; } catch { ts = undefined; }
    if (ts !== undefined) events.push({ ts, last: agyState.committedStep === agyState.sentStep ? "commit" : "capture", failed: false });
  }
  const recent = entry => entry && (entry.cc_session_id === sessionId || entry.session_id === `agy-${safeId(sessionId)}`)
    && num(entry.ts) !== undefined && now - entry.ts < 30 * 60_000;
  const capture = readJson(join(ovState, "last-capture.json"));
  const recall = readJson(join(ovState, "last-recall.json"));
  if (recent(recall) && recall.count > 0) events.push({ ts: recall.ts, last: "recall", failed: false });
  if (capture && (capture.cc_session_id === sessionId || capture.session_id === `agy-${safeId(sessionId)}`)) {
    if (num(capture.pending_tokens) !== undefined && num(capture.commit_threshold) !== undefined) {
      memory.pendingTokens = capture.pending_tokens;
      memory.threshold = capture.commit_threshold;
    } else if (num(capture.commit_count) !== undefined) {
      memory.added = capture.commit_count;
    }
    if (recent(capture)) events.push({ ts: capture.ts, last: "capture", failed: capture.turns_failed > 0 });
  }
  const latest = events.sort((a, b) => b.ts - a.ts)[0];
  if (latest) { memory.last = latest.last; memory.failed = latest.failed; }
  return memory;
}

const LIGHT_INKS = { text: "88;94;108", muted: "112;118;132", dim: "140;145;158", accent: "140;84;196", success: "0;138;98", warning: "176;116;0", error: "208;62;52" };
function footerPaint(theme, ansiPaint, plainPaint) {
  if (process.env.NO_COLOR !== undefined || process.env.TERM === "dumb") return plainPaint;
  if (theme !== "light") return ansiPaint;
  return { ...ansiPaint, fg: (kind, text) => `\x1b[38;2;${LIGHT_INKS[kind] ?? LIGHT_INKS.text}m${text}\x1b[39m` };
}

function loadMode(value) {
  const env = process.env.TENANTEXT_ANTHROPIC_USAGE;
  if (env === "auto" || env === "on" || env === "off") return env;
  return value?.mode === "auto" || value?.mode === "on" || value?.mode === "off" ? value.mode : "auto";
}

export function currentWindowUsed(window, scan) {
  const size = num(window.context_window_size);
  const cu = window.current_usage;
  if (cu && typeof cu === "object") {
    const fields = [cu.input_tokens, cu.cache_read_input_tokens, cu.cache_creation_input_tokens].map(num);
    // A measured 0 is a reading; only absent fields fall through.
    if (fields.some(value => value !== undefined)) return fields.reduce((total, value) => total + (value ?? 0), 0);
  }
  if (num(window.used_percentage) !== undefined && size !== undefined && size > 0) {
    return Math.round(window.used_percentage / 100 * size);
  }
  // total_input_tokens is the sum of the session, not the fill of the window: never a fallback here.
  return num(scan.lastInputTokens);
}

/** The healthUrls of ~/.pi/agent/ops-footer/settings.json, with the entries of the profile footer settings on top. */
export function mergeHealthUrls(globalFooter, profileFooter) {
  const urls = value => value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return { ...urls(globalFooter?.healthUrls), ...urls(profileFooter?.healthUrls) };
}

const clamp = (value, low, high, fallback) =>
  num(value) === undefined ? fallback : Math.max(low, Math.min(high, Math.floor(value)));

/** The footer settings of the render and of the health refresh: ~/.pi/agent, then the profile. */
export function footerSettings(profile = PROFILE, home = HOME) {
  const footer = readJson(join(home, ".pi", "agent", "ops-footer", "settings.json")) ?? {};
  const profileFooter = readJson(join(profile, "ops-footer", "settings.json")) ?? {};
  return {
    enabled: true, placement: "belowEditor",
    maximumRows: clamp(profileFooter.maximumRows ?? footer.maximumRows, 3, 12, 8), minimumRows: 1,
    healthPollSeconds: clamp(footer.healthPollSeconds, 10, 3600, 60),
    healthTimeoutMs: clamp(footer.healthTimeoutMs, 100, 10000, 2000),
    gitCacheMs: 1000, gitIdlePollSeconds: 15,
    showHealthyServices: footer.showHealthyServices === true,
    showUnavailableOptionalSources: footer.showUnavailableOptionalSources === true,
    showArtifactServer: profileFooter.showArtifactServer ?? footer.showArtifactServer,
    quotaPollSeconds: clamp(profileFooter.healthPollSeconds, 10, 3600, 60),
    healthUrls: mergeHealthUrls(footer, profileFooter),
  };
}

// --- Compose ----------------------------------------------------------------------------------------------------

async function main(raw) {
  const input = raw.trim() ? JSON.parse(raw) : {};
  const now = Date.now();
  const [
    { layouts, defaultLayout }, { ansiPaint, plainPaint }, { alertKeys, ALERT_DECAY_MS },
    { snapshot, contextState }, { GitAdapter }, adapters,
  ] = await Promise.all([
    load("extensions/ops-footer/layouts/index.ts"),
    load("extensions/ops-footer/paint.ts"),
    load("extensions/ops-footer/render.ts"),
    load("extensions/context-meter/snapshot.ts"),
    load("extensions/ops-footer/git.ts"),
    load("extensions/ops-footer/adapters.ts"),
  ]);
  try { mkdirSync(CACHE, { recursive: true, mode: 0o700 }); } catch { /* a read-only sandbox */ }

  const { showArtifactServer, quotaPollSeconds, ...settings } = footerSettings();
  const quotaFooter = { healthPollSeconds: quotaPollSeconds };
  const meterFile = readJson(join(PROFILE, "context-meter", "settings.json"))
    ?? readJson(join(PI_AGENT, "context-meter", "settings.json")) ?? {};
  const meter = {
    enabled: true,
    preparePercent: num(meterFile.preparePercent) ?? 60,
    transitionPercent: num(meterFile.transitionPercent) ?? 75,
    criticalPercent: num(meterFile.criticalPercent) ?? 90,
    systemPromptWarningTokens: Number(process.env.PI_FOOTER_SYS_WARN) || 60_000,
  };
  const usagePollMs = clamp(
    profileSettings("anthropic-usage")?.pollSeconds ?? readJson(join(PI_AGENT, "anthropic-usage", "settings.json"))?.pollSeconds,
    60, 3600, 3600,
  ) * 1000;

  const sessionId = String(input.session_id ?? input.conversation_id ?? "unknown").replace(/[^A-Za-z0-9_-]/g, "_");
  const cachePath = join(CACHE, `agy-session-${sessionId}.json`);
  const stored = readJson(cachePath);
  const cache = stored?.version === CACHE_VERSION ? stored : { version: CACHE_VERSION, scan: null, alerts: {} };
  cache.scan = typeof input.transcript_path === "string" && input.transcript_path
    ? scanTranscript(input.transcript_path, cache.scan) : freshScan("");
  const scan = cache.scan;

  const cwd = input.workspace?.current_dir || input.cwd || process.cwd();
  const startedIn = input.workspace?.project_dir || cwd;
  const quiet = promise => promise.catch(error => { if (process.env.PI_FOOTER_DEBUG) console.error(error); return undefined; });

  const integrations = healthChecks(settings, now);
  const [git, limits, copilot, antigravity, ok, artifacts] = await Promise.all([
    new GitAdapter(1500, 1000).refresh(cwd, true),
    quiet(codexRows(now, adapters, quotaFooter)),
    quiet(copilotRows(now, adapters, quotaFooter)),
    quiet(antigravityRows(now, adapters, quotaFooter)),
    quiet(okknowRow(now)),
    quiet(artifactsRow(now, showArtifactServer)),
  ]);
  const claudeOff = loadMode(profileSettings("anthropic-usage")) === "off";
  const anthropic = claudeOff ? undefined : await quiet(anthropicRows(now, usagePollMs));

  const window = input.context_window ?? {};
  const used = currentWindowUsed(window, scan);
  const modelId = String(input.model?.id ?? input.model?.display_name ?? scan.model ?? "agy");
  const estimates = { sys: scan.sys ?? 0, ...scan.estimates };
  const state = contextState(
    snapshot(`antigravity/${modelId}`, used, num(window.context_window_size) || undefined, scan.sys ?? undefined, estimates, meter),
    meter,
  );
  const context = { state: () => state, render: () => [], report: () => "", subscribe: () => () => {}, dispose() {} };

  const memory = {};
  if (integrations.some(s => s.source === "OV") || agyOpenVikingEnabled()) {
    memory.ov = openVikingMemory(input.session_id ?? input.conversation_id, now);
  }
  if (ok) memory.ok = ok;
  if (artifacts) memory.artifacts = artifacts;

  const startedAt = num(input.cost?.total_duration_ms) !== undefined
    ? now - num(input.cost.total_duration_ms)
    : (scan.startedAt ?? now);

  const data = {
    session: {
      state: mapAgentState(input.agent_state, scan.state),
      provider: "antigravity",
      model: modelId,
      thinking: inferEffort(input, modelId),
      cwd, startedIn, hostname: hostname(), remote: Boolean(process.env.SSH_CONNECTION),
      session: input.session_name || "unnamed",
      startedAt,
      input: num(window.total_input_tokens) ?? scan.totals.input,
      output: num(window.total_output_tokens) ?? scan.totals.output,
      cacheRead: scan.totals.cacheRead,
      cacheWrite: scan.totals.cacheWrite,
      cost: num(input.cost?.total_cost_usd) ?? num(input.cost?.total_usd) ?? 0,
      tools: scan.tools,
      pending: false,
    },
    git, limits, copilot, antigravity, anthropic,
    integrations, extensionStatuses: 0, conflict: false,
    ...(Object.keys(memory).length ? { memory } : {}),
  };

  const keys = alertKeys(data, context, settings, now);
  cache.alerts = Object.fromEntries(keys.map(key => [key, cache.alerts?.[key] ?? now]));
  const aged = key => now - (cache.alerts[key] ?? now) >= ALERT_DECAY_MS;

  const theme = process.env.PI_FOOTER_THEME || (String(input.theme ?? "dark").startsWith("light") ? "light" : "dark");
  const margin = process.env.PI_FOOTER_MARGIN !== undefined ? Number(process.env.PI_FOOTER_MARGIN) || 0 : 4;
  const width = Number(process.env.PI_FOOTER_WIDTH) > 0
    ? Number(process.env.PI_FOOTER_WIDTH)
    : num(input.terminal_width) > 0
      ? Math.max(20, num(input.terminal_width) - 2)
      : Math.max(20, terminalColumns() - margin);
  const { above, below } = layouts[defaultLayout](data, context, settings, width, footerPaint(theme, ansiPaint, plainPaint), now, aged);
  process.stdout.write([...above, ...below].join("\n"));

  try { writeJson(cachePath, cache); } catch { /* optional */ }
  if (now % 100 === 0) {
    try {
      for (const name of readdirSync(CACHE)) {
        if (!name.startsWith("agy-session-")) continue;
        try { if (now - statSync(join(CACHE, name)).mtimeMs > 14 * 86_400_000) rmSync(join(CACHE, name)); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }
}

/** The plain line when tenantext cannot render: agy, the model, the used context percent and the folder name. */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])|\x9b[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const printable = value => String(value ?? "").replace(ANSI, "").replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, "").trim();
export function fallbackLine(raw, cwd = process.cwd()) {
  try {
    const input = String(raw ?? "").trim() ? JSON.parse(raw) : {};
    const model = printable(input.model?.display_name || input.model?.id) || "agy";
    const pct = num(input.context_window?.used_percentage);
    const dir = printable(basename(String(input.workspace?.current_dir || input.cwd || cwd))) || "?";
    return `agy · ${model}${pct !== undefined ? ` · ${Math.round(pct)}%` : ""} · ${dir}`;
  } catch {
    return "agy";
  }
}

async function cli(argv) {
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, () => process.exit(128 + ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15 })[signal]));
  }
  const at = flag => argv.indexOf(flag);
  if (at("--refresh-quota") >= 0) {
    try { await refreshQuota(argv[at("--refresh-quota") + 1]); } catch (error) { if (process.env.PI_FOOTER_DEBUG) console.error(error); }
    process.exit(0);
  }
  if (at("--refresh-usage") >= 0) {
    const slot = argv[at("--refresh-usage") + 1];
    try { await refreshUsage(slot && /^[0-9]$/.test(slot) ? slot : undefined); }
    catch (error) { if (process.env.PI_FOOTER_DEBUG) console.error(error); }
    process.exit(0);
  }
  let raw = "";
  try { raw = readFileSync(0, "utf8"); } catch { /* no standard input */ }
  try { await main(raw); }
  catch (error) {
    if (process.env.PI_FOOTER_DEBUG) console.error(error);
    process.stdout.write(fallbackLine(raw));
  }
}

// Run only as a command; a test imports the helpers without a run.
const entry = (() => { try { return realpathSync(process.argv[1] ?? ""); } catch { return ""; } })();
if (entry === SELF) await cli(process.argv.slice(2));
