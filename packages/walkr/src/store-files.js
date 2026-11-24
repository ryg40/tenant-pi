import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

// The file and request helpers of the Compare store: one error type with a code, plain JSON capture, a canonical
// text of a request for its hash, and reads that refuse a symlink, a hard link and a file that changes during the read.

export const hash = (value) => createHash("sha256").update(value).digest("hex");

export class StoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "StoreError";
    this.code = code;
    Object.assign(this, details);
  }
}

export function fail(code, message, details) {
  throw new StoreError(code, message, details);
}

export function id(value) {
  if (typeof value !== "string" || !value || /[\s\p{C}]/u.test(value)) {
    fail("INVALID_ID", "An ID must be nonempty and contain no whitespace or control characters.");
  }
}

/** The JSON text of a value with sorted object keys: equal requests give equal text. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
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
    return structuredClone(value);
  } catch {
    fail(code, "Supply plain JSON data without omitted fields, accessors, cycles, or special objects.");
  }
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
