import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

// Remote mode of walkr-compare (docs/compare.md, "Remote mode"). The key `remote` of the artifacts config file names
// an SSH host; a command then runs there as `walkr-compare --here <words>` through one ssh call. The rules follow
// `remote_call` of the artifacts CLI (packages/artifacts/skills/artifacts/scripts/artifacts).

// A test seam, not a setting: the artifacts CLI reads the same name. A command line (shlex form) that replaces ssh.
export const SSH_ENV = "ARTIFACTS_SSH_COMMAND";
export const SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-T", "-a", "-x"];
// A remote command that is not `wait` gets this many seconds; `wait` gets its own timeout and this much more.
export const REMOTE_TIMEOUT_S = 60;
// After ssh ends, the pipes get this long to close; a child of ssh can hold them open (runRemote).
export const REMOTE_GRACE_MS = 2000;
const REMOTE_MISSING = 127;
// The remote shell gives the words to this script as "$@": walkr-compare of the remote PATH, else
// ~/.local/bin/walkr-compare, else exit 127. Without HERDR_ENV, a remote create or open makes no Sheprd link.
export const REMOTE_SCRIPT = "unset HERDR_ENV; "
  + 'if command -v walkr-compare >/dev/null 2>&1; then exec walkr-compare "$@"; fi; '
  + 'if [ -x "$HOME/.local/bin/walkr-compare" ]; then exec "$HOME/.local/bin/walkr-compare" "$@"; fi; '
  + "exit 127";
// The value rule of the key `remote` in artifacts_store.py (REMOTE): no value starts with "-" or holds a shell character.
const REMOTE = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,31}@)?[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;
// The refusal of a walkr-compare older than remote mode: it reads `--here` as an unknown command.
const OLD_REFUSAL = "Invalid Compare arguments.";

const stop = (message, exitCode = 1) => { throw Object.assign(new Error(message), { exitCode }); };

/** The config file of the artifacts CLI: $XDG_CONFIG_HOME (an absolute value only) or ~/.config. */
export function configPath(env = process.env) {
  const base = path.isAbsolute(env.XDG_CONFIG_HOME || "") ? env.XDG_CONFIG_HOME : path.join(os.homedir(), ".config");
  return path.join(base, "tenant-artifacts", "config.json");
}

/** The SSH host of the key `remote`, or null for this computer. A file that cannot be read is an error, not local. */
export function remoteHost(env = process.env) {
  const file = configPath(env);
  let data;
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    stop(`Cannot read ${file} (${error.code || error.name}). Fix the file, or run walkr-compare --here <command> on this computer.`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) stop(`${file} does not hold a JSON object.`);
  const value = data.remote;
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !REMOTE.test(value)) stop(`remote in ${file} is not a plain SSH destination.`);
  return value;
}

/** shlex.quote of Python: a word of safe characters stays, each other word goes in single quotes. */
export function quote(word) {
  if (word === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replaceAll("'", "'\"'\"'")}'`;
}

/** The command line for the remote shell; each word reaches walkr-compare as text. */
export function remoteCommand(words) {
  return ["sh", "-c", REMOTE_SCRIPT, "walkr-compare", "--here", ...words].map(quote).join(" ");
}

/** shlex.split of Python (POSIX mode), for the test seam only. */
function split(line) {
  const words = [];
  let word = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) stop(`${SSH_ENV} has no closing quote.`);
      word = (word ?? "") + line.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      word = word ?? "";
      for (i += 1; i < line.length && line[i] !== '"'; i += 1) {
        if (line[i] === "\\" && '"\\'.includes(line[i + 1] ?? "")) i += 1;
        word += line[i];
      }
      if (i >= line.length) stop(`${SSH_ENV} has no closing quote.`);
    } else if (c === "\\") {
      i += 1;
      word = (word ?? "") + (line[i] ?? "");
    } else if (/\s/.test(c)) {
      if (word !== null) words.push(word);
      word = null;
    } else {
      word = (word ?? "") + c;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

function sshProgram(env) {
  const line = env[SSH_ENV];
  if (!line) return ["ssh"];
  process.stderr.write(`warning: ${SSH_ENV} is set (a test seam); the program ssh does not run\n`);
  const words = split(line);
  if (!words.length) stop(`${SSH_ENV} names no program.`);
  return words;
}

const write = (stream, data) => new Promise((resolve) => { if (!data.length) resolve(); else stream.write(data, resolve); });

// What a lost call of each command means, and what to do next.
function advice(command, host, reached) {
  if (command === "wait") return "Run wait again; it is safe to repeat.";
  if (reached && (command === "create" || command === "outcome")) {
    return `The request may have reached ${host}. A retry with the exact same file and action ID is safe.`;
  }
  if (command === "received") return "Run received again; it is safe to repeat.";
  return "Run the command again.";
}

/**
 * The note for a page address of create or open: a loopback address works on the host only. With the key
 * walkrPublicOrigin on the host, create prints the public address in `url` and the loopback address in `localUrl`.
 */
function addressNote(command, host, out) {
  let url = out.trim();
  if (command === "create") {
    try {
      const made = JSON.parse(url);
      if (typeof made.localUrl === "string") return `walkr-compare: localUrl is valid on the host ${host} only; url is the public address.\n`;
      url = made.url;
    } catch { url = ""; }
  }
  let name = "";
  try { name = new URL(url).hostname; } catch {}
  if (name && !["127.0.0.1", "localhost", "[::1]"].includes(name)) return "";
  return `walkr-compare: the page address is valid on the host ${host} only.\n`;
}

/**
 * Run `walkr-compare --here WORDS` on `host` with one ssh call, `input` on its standard input. The remote standard
 * output, standard error and exit code pass through. A call that did not reach a remote walkr-compare, or that ended
 * without its answer, is exit 3: it never falls back to this computer.
 */
export async function runRemote(host, command, words, { input = Buffer.alloc(0), seconds = REMOTE_TIMEOUT_S, env = process.env } = {}) {
  const program = sshProgram(env);
  const args = [...program.slice(1), ...SSH_OPTIONS, "--", host, remoteCommand(words)];
  const done = await new Promise((resolve) => {
    const out = [];
    const err = [];
    let timedOut = false;
    let settled = false;
    let grace;
    let child;
    try { child = spawn(program[0], args, { stdio: ["pipe", "pipe", "pipe"], shell: false }); }
    catch (error) { resolve({ error }); return; }
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      resolve(result);
    };
    const collected = (code, signal) => ({ code, signal, timedOut, stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
    const release = () => { child.stdout.destroy(); child.stderr.destroy(); };
    // The limit ends a live ssh. When ssh has already ended, its exit handler below decides.
    const timer = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      timedOut = true;
      child.kill("SIGKILL");
    }, seconds * 1000);
    // A child of ssh can keep the pipes open after ssh ends: after a short grace period, the output that arrived and the
    // real exit code are the answer. So a call never lasts longer than the limit plus the grace period.
    child.once("exit", (code, signal) => {
      if (timedOut) { release(); finish({ timedOut, stderr: Buffer.concat(err) }); return; }
      grace = setTimeout(() => { release(); finish(collected(code, signal)); }, REMOTE_GRACE_MS);
    });
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.stdin.on("error", () => {});
    child.once("error", (error) => finish({ error }));
    child.once("close", (code, signal) => finish(collected(code, signal)));
    child.stdin.end(input);
  });
  const late = `, unless the connection ended after ${host} finished the command`;
  let why;
  // No ssh program, or no remote walkr-compare: the request did not reach a walkr-compare.
  const reached = !done.error && done.code !== REMOTE_MISSING;
  if (done.error) why = `the ssh program did not run (${done.error.code || done.error.name})`;
  else if (done.timedOut) why = `no answer from ${host} in ${seconds} s; the call is stopped${late}`;
  else if (done.code === 255) why = `ssh lost or did not get the connection to ${host} (exit 255)${late}`;
  else if (done.signal) why = `a signal ended the ssh program (${done.signal})${late}`;
  else if (done.code === REMOTE_MISSING) why = `${host} has no walkr-compare on its PATH or in ~/.local/bin`;
  if (why) {
    if (done.stderr?.length) await write(process.stderr, done.stderr);
    stop(`walkr-compare: ${why}. Nothing was written on this computer. ${advice(command, host, reached)} `
      + "To use this computer, run walkr-compare --here <command>.", 3);
  }
  await write(process.stdout, done.stdout);
  await write(process.stderr, done.stderr);
  const text = done.stderr.toString("utf8");
  if (done.code === 1 && text.startsWith(OLD_REFUSAL)) {
    process.stderr.write(`walkr-compare: ${host} has a walkr-compare without remote mode. Install this version or a newer one there.\n`);
  }
  if (done.code === 0 && (command === "create" || command === "open")) {
    process.stderr.write(addressNote(command, host, done.stdout.toString("utf8")));
  }
  process.exitCode = done.code;
}
