import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isCanonicalAbsolute } from "./canonical-path.js";
import { POSIX_ONLY_CODE, posixOnlyRefusal } from "./posix-only.js";

const queues = new Map();
const PREFIXES = ["double", "double-session", "shared-gui", "coinflip-session", "trainer-gui"];

/**
 * The Double archive directory: HUMAN_REVIEW_DOUBLE_ARCHIVE_DIR when it is set, else ~/.local/.walkr/double, beside the
 * Compare and Trainer roots. A set value always wins, also an empty or a relative one: the path checks then refuse it.
 */
export function doubleArchiveRoot(env = process.env, home = os.homedir()) {
  return env.HUMAN_REVIEW_DOUBLE_ARCHIVE_DIR ?? path.join(home, ".local", ".walkr", "double");
}
export const hash = (value) => createHash("sha256").update(value).digest("hex");
const clone = (value) => structuredClone(value);
const equal = isDeepStrictEqual;

export class DoubleStoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "DoubleStoreError";
    this.code = code;
    Object.assign(this, details);
  }
}

export function fail(code, message, details) {
  throw new DoubleStoreError(code, message, details);
}

function object(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    equal(Object.keys(value).sort(), [...keys].sort());
}

export function requireShape(value, keys) {
  if (!object(value, keys)) fail("INVALID_REQUEST", `Expected exactly these fields: ${keys.join(", ")}.`);
}

export function id(value) {
  if (typeof value !== "string" || !value || /[\s\p{C}]/u.test(value)) {
    fail("INVALID_ID", "An ID must be nonempty and contain no whitespace or control characters.");
  }
}

// Reject values JSON would silently discard or change, before capturing a caller-owned request.
export function capture(value, code = "INVALID_REQUEST") {
  function visit(item) {
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item) && !Object.is(item, -0)) return;
    if (typeof item !== "object" || (Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null && !Array.isArray(item))) throw new Error();
    const keys = Reflect.ownKeys(item);
    if (Array.isArray(item) && keys.length !== item.length + 1) throw new Error();
    for (const key of keys) {
      if (Array.isArray(item) && key === "length") continue;
      if (Array.isArray(item) && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length)) throw new Error();
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (typeof key !== "string" || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw new Error();
      visit(descriptor.value);
    }
  }
  try {
    visit(value);
    return clone(value);
  } catch {
    fail(code, "Supply plain JSON data without omitted fields, accessors, cycles, or special objects.");
  }
}

export function absolute(value) {
  if (!isCanonicalAbsolute(value)) {
    fail("UNSAFE_PATH", "Use an explicit canonical absolute archive directory, without traversal or a trailing slash.");
  }
}

export function contains(root, file) {
  return file === root || file.startsWith(`${root}${path.sep}`);
}

function sameVersion(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink;
}

export async function inspect(file, directory = false, privatePath = false) {
  let current = path.parse(file).root;
  const parts = file.slice(current.length).split(path.sep);
  let stat;
  for (const part of parts) {
    current = path.join(current, part);
    stat = await fs.lstat(current, { bigint: true });
    if (stat.isSymbolicLink()) fail("UNSAFE_PATH", "Symlinks, including parent directories, are not permitted.");
    if (current !== file && !stat.isDirectory()) fail("UNSAFE_PATH", "A parent path is not a directory.");
  }
  if (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n) {
    fail("UNSAFE_PATH", "Expected a real directory or a regular file with exactly one hard link.");
  }
  if (privatePath && ((stat.mode & 0o777n) !== (directory ? 0o700n : 0o600n) ||
      stat.uid !== BigInt(process.getuid()))) {
    fail("UNSAFE_PATH", "Archive directories require mode 0700; records require mode 0600 and the current owner.");
  }
  return stat;
}

async function syncDirectory(directory) {
  const before = await inspect(directory, true);
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (before.dev !== opened.dev || before.ino !== opened.ino) fail("UNSAFE_PATH", "The directory changed during access.");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readBytes(file, privatePath = false, durable = false) {
  const before = await inspect(file, false, privatePath);
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!sameVersion(before, await handle.stat({ bigint: true }))) fail("FILE_CHANGED", "A file changed during access.");
    const bytes = await handle.readFile();
    if (durable) await handle.sync();
    if (!sameVersion(before, await handle.stat({ bigint: true })) ||
        !sameVersion(before, await inspect(file, false, privatePath))) fail("FILE_CHANGED", "A file changed during access.");
    return bytes;
  } finally {
    await handle.close();
  }
}

// Shared by the comparison, session, shared-GUI, Coinflip and Trainer GUI records. One process owns this directory.
export class DoubleArchive {
  #archiveDir;
  #prefix;
  #identity;
  #decode;
  #separate;

  // Every Double, Coinflip, shared-GUI and Trainer GUI record goes through here, so Windows refuses at this boundary too.
  constructor({ archiveDir, prefix, identity, decode, separate, platform = process.platform }) {
    const refusal = posixOnlyRefusal(platform);
    if (refusal) fail(POSIX_ONLY_CODE, refusal);
    absolute(archiveDir);
    if (!PREFIXES.includes(prefix)) fail("UNSAFE_PATH", "Unknown Double archive namespace.");
    this.#archiveDir = archiveDir;
    this.#prefix = prefix;
    this.#identity = identity;
    this.#decode = decode;
    this.#separate = separate;
  }

  run(operation) {
    const prior = queues.get(this.#archiveDir) || Promise.resolve();
    const next = prior.catch(() => {}).then(operation);
    queues.set(this.#archiveDir, next);
    const release = () => { if (queues.get(this.#archiveDir) === next) queues.delete(this.#archiveDir); };
    next.then(release, release);
    return next;
  }

  #file(comparisonId) {
    id(comparisonId);
    return path.join(this.#archiveDir, `${this.#prefix}-${hash(comparisonId)}.json`);
  }

  /**
   * The identities of the records of this namespace, for a read-only history. It takes no lock and writes nothing.
   * It reads only the identity field of each record; `load` checks the whole record. A record that is not readable
   * gives an entry with an error code. A missing directory gives no entry.
   * `known` maps a file name to the `stamp` of an earlier call; a record with the same stamp is not read again.
   */
  async identities(known = new Map()) {
    const pattern = new RegExp(`^${this.#prefix}-([a-f0-9]{64})\\.json$`);
    let names;
    try {
      await inspect(this.#archiveDir, true, true);
      names = await fs.readdir(this.#archiveDir);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    const found = [];
    for (const name of names.sort()) {
      const match = pattern.exec(name);
      if (!match) continue;
      const file = path.join(this.#archiveDir, name);
      try {
        const stat = await inspect(file, false, true);
        // A writer replaces a record by rename, so a new version has a new inode, time or size.
        const stamp = `${stat.ino}:${stat.mtimeNs}:${stat.size}`;
        const updatedAt = new Date(Number(stat.mtimeMs)).toISOString();
        const earlier = known.get(name);
        if (earlier?.stamp === stamp && earlier.id) { found.push({ id: earlier.id, file: name, stamp, updatedAt }); continue; }
        const identity = JSON.parse((await readBytes(file, true)).toString("utf8"))?.[this.#identity];
        if (typeof identity !== "string" || hash(identity) !== match[1]) fail("RECOVERY_REQUIRED", "The record does not match its file name.");
        found.push({ id: identity, file: name, stamp, updatedAt });
      } catch (error) {
        found.push({ id: null, file: name, error: error.code || "UNREADABLE" });
      }
    }
    return found;
  }

  async load(comparisonId) {
    const file = this.#file(comparisonId);
    try {
      await inspect(this.#archiveDir, true, true);
      const bytes = await readBytes(file, true, true);
      const doc = this.#decode(bytes, comparisonId);
      this.#separate(doc);
      // A prior replace may have succeeded despite a lost response or failed directory sync.
      await syncDirectory(this.#archiveDir);
      await syncDirectory(path.dirname(this.#archiveDir));
      return { doc, bytes };
    } catch (error) {
      if (error.code === "ENOENT") fail("NOT_FOUND", "The comparison archive does not exist.");
      if (error.code === "RECOVERY_REQUIRED") throw error;
      fail("RECOVERY_REQUIRED", "Cannot safely read and persist the comparison archive. Preserve it before recovery.", { reason: error.code || "UNKNOWN" });
    }
  }

  async #directory() {
    try {
      await inspect(this.#archiveDir, true, true);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(this.#archiveDir);
      await inspect(parent, true);
      await fs.mkdir(this.#archiveDir, { mode: 0o700 });
      await inspect(this.#archiveDir, true, true);
    }
    await syncDirectory(path.dirname(this.#archiveDir));
  }

  async commit(doc, previousBytes = null) {
    const file = this.#file(doc[this.#identity]);
    const temporary = path.join(this.#archiveDir, `.${this.#prefix}-${randomUUID()}.tmp`);
    let ownedTemporary = false;
    let replacing = false;
    let handle;
    try {
      this.#separate(doc);
      await this.#directory();
      handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      ownedTemporary = true;
      const body = JSON.stringify(doc);
      await handle.writeFile(`${JSON.stringify({ ...doc, checksum: hash(body) })}\n`);
      await handle.sync();
      await handle.close();
      handle = null;
      await inspect(temporary, false, true);
      await inspect(this.#archiveDir, true, true);
      let current = null;
      try { current = await readBytes(file, true); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (previousBytes === null ? current !== null : current === null || !current.equals(previousBytes)) {
        fail("RECOVERY_REQUIRED", "The authoritative archive changed outside this writer. Preserve it before recovery.");
      }
      replacing = true;
      await fs.rename(temporary, file);
      await syncDirectory(this.#archiveDir);
    } catch (error) {
      if (replacing) fail("COMMIT_UNCERTAIN", "The replace may have committed. Refresh and retry the exact original request and action ID.", { reason: error.code || "UNKNOWN" });
      if (error instanceof DoubleStoreError) throw error;
      fail("WRITE_FAILED", "The comparison was not replaced. Retry the exact original request.", { fsCode: error.code || "UNKNOWN" });
    } finally {
      if (handle) await handle.close().catch(() => {});
      // Only this call's uncommitted temporary file is eligible for removal. Archives are never pruned.
      if (ownedTemporary) await fs.unlink(temporary).catch(() => {});
    }
  }

}
