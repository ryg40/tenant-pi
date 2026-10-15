// The private review ledger of a maintainer: JSON Lines, append only, mode 0600, outside the Git work trees.
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { failure } from "./errors.mjs";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));

const text = (value) => typeof value === "string" && value.trim() !== "";

/** `$XDG_STATE_HOME/agentcore-memory/review-ledger.jsonl`, else below `~/.local/state`. */
export function defaultLedgerPath(env) {
  const base = text(env.XDG_STATE_HOME) && isAbsolute(env.XDG_STATE_HOME)
    ? env.XDG_STATE_HOME : join(text(env.HOME) ? env.HOME : homedir(), ".local", "state");
  return join(base, "agentcore-memory", "review-ledger.jsonl");
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw failure("ledger");
  }
}

/** The real path of the deepest existing ancestor, joined with the missing rest. */
async function realTarget(path) {
  const missing = [];
  let current = path;
  for (;;) {
    try {
      return join(await realpath(current), ...missing.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT" || dirname(current) === current) throw failure("ledger");
      missing.push(basename(current));
      current = dirname(current);
    }
  }
}

/** The top of the Git work tree that holds a directory, or null. No Git process. */
async function workTree(directory) {
  let current;
  try {
    current = await realpath(directory);
  } catch {
    return null;
  }
  for (;; current = dirname(current)) {
    if (await exists(join(current, ".git"))) return current;
    if (dirname(current) === current) return null;
  }
}

/**
 * The ledger holds record texts and must never be committed. Like scripts/memory_submit.py, refuse a path
 * in the current Git work tree and in the work tree of this package; only the ignored `.local/` below the
 * top of such a tree is allowed.
 */
async function outsideRepositories(file, cwd) {
  for (const top of [await workTree(cwd), await workTree(PACKAGE)]) {
    if (top && file.startsWith(top + sep) && !file.startsWith(join(top, ".local") + sep)) throw failure("ledger");
  }
}

export function createFileLedger(path, { home = homedir(), cwd = process.cwd() } = {}) {
  if (!text(path)) throw failure("ledger");
  const expanded = path === "~" || path.startsWith("~/") ? join(home, path.slice(1)) : path;
  let checked;

  const target = () => checked ??= (async () => {
    const real = await realTarget(resolve(expanded));
    await outsideRepositories(real, cwd);
    try {
      const info = await lstat(real);
      if (!info.isFile()) throw failure("ledger");
    } catch (error) {
      if (error?.code !== "ENOENT") throw failure("ledger");
    }
    return real;
  })().catch((error) => { checked = undefined; throw error; });

  async function append(entry) {
    const file = await target();
    let handle;
    try {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      handle = await open(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      await handle.chmod(0o600);
      await handle.appendFile(`${JSON.stringify(entry)}\n`, "utf8");
      await handle.datasync();
    } catch {
      throw failure("ledger");
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async function entries() {
    const file = await target();
    let raw;
    try {
      raw = await readFile(file, { encoding: "utf8", flag: constants.O_RDONLY | constants.O_NOFOLLOW });
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw failure("ledger");
    }
    return raw.split("\n").filter((line) => line.trim()).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        // A broken line fails closed: approve must not guess whether a record was promoted.
        throw failure("ledger");
      }
    });
  }

  async function entriesFor(proposalRecordId) {
    return (await entries()).filter((entry) => entry?.proposalRecordId === proposalRecordId);
  }

  return { append, entriesFor, path: expanded };
}
