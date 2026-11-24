// Read-only file access for sources on a mounted directory.
// The walk skips symbolic links. Each file read checks its real path.

import { constants } from 'node:fs';
import { access, open, opendir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_FILES = 25_000;
export const READ_CONCURRENCY = 16;

function inside(root, full) {
  const relative = path.relative(root, full);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw Object.assign(new Error('path outside the root'), { code: 'OUTSIDE_ROOT' });
  }
}

export function isUnavailable(error) {
  return ['EACCES', 'EPERM', 'ENOENT'].includes(error.code);
}

// The Markdown files below `dir`, as paths relative to `root`.
export async function walkMarkdown(root, dir = root, { skipDirs = [], maxFiles = MAX_FILES, onSkip } = {}) {
  const realRoot = await realpath(root);
  const start = await realpath(dir);
  inside(realRoot, start);
  const out = [];
  async function visit(current) {
    if (out.length >= maxFiles) return;
    const offset = out.length;
    try {
      const handle = await opendir(current);
      for await (const entry of handle) {
        if (out.length >= maxFiles) break;
        if (entry.name.startsWith('.')) continue;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (skipDirs.includes(entry.name)) continue;
          await visit(full);
        } else if (entry.isFile() && /\.mdx?$/i.test(entry.name)) {
          out.push(path.relative(realRoot, full));
        }
      }
    } catch (error) {
      if (current === start || !onSkip || !isUnavailable(error)) throw error;
      out.length = offset;
      onSkip();
    }
  }
  await visit(start);
  return out.sort();
}

export async function statInside(root, relative, checkAccess = access) {
  const realRoot = await realpath(root);
  const full = await realpath(path.resolve(realRoot, relative));
  inside(realRoot, full);
  const info = await stat(full);
  if (!info.isFile()) throw Object.assign(new Error('not a file'), { code: 'NOT_FILE' });
  // Recheck access even when cached text and its content fingerprint are unchanged.
  await checkAccess(full, constants.R_OK);
  return { full, mtime: info.mtime, mtimeMs: info.mtimeMs, size: info.size, dev: info.dev, ino: info.ino };
}

// Read at most the limit plus one byte, even if the file grows after stat.
export async function readInside(root, relative) {
  const info = await statInside(root, relative);
  if (info.size > MAX_FILE_BYTES) return { ...info, text: '', tooLarge: true };
  const handle = await open(info.full, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.dev !== info.dev || current.ino !== info.ino) {
      throw new Error('file changed during open');
    }
    const parts = [];
    let bytes = 0;
    while (bytes <= MAX_FILE_BYTES) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_FILE_BYTES + 1 - bytes));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      parts.push(buffer.subarray(0, bytesRead));
      bytes += bytesRead;
    }
    const after = await handle.stat();
    if (after.mtimeMs !== info.mtimeMs || after.size !== info.size) {
      throw new Error('file changed during read');
    }
    const tooLarge = bytes > MAX_FILE_BYTES;
    return { ...info, text: tooLarge ? '' : Buffer.concat(parts).toString('utf8'), tooLarge };
  } finally {
    await handle.close();
  }
}

export async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

// Bound open files and pending reads. Drain workers before reporting a failure.
export async function mapBounded(values, fn) {
  const out = new Array(values.length);
  let next = 0;
  let failed = false;
  let failure;
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, values.length) }, async () => {
    while (!failed && next < values.length) {
      const i = next++;
      try {
        out[i] = await fn(values[i], i);
      } catch (error) {
        failed = true;
        failure ??= error;
      }
    }
  }));
  if (failed) throw failure;
  return out;
}

// Cache parsed documents, not a second copy of every file's text.
export class FileCache {
  constructor({ read = readInside, access: checkAccess = access } = {}) {
    this.read = read;
    this.checkAccess = checkAccess;
    this.entries = new Map();
  }

  async load(files, parse, skipped = { files: 0, directories: 0 }) {
    const next = new Map();
    const documents = await mapBounded(files, async (file) => {
      const { root, relative } = file;
      const key = JSON.stringify([root, relative]);
      const old = this.entries.get(key);
      let read;
      try {
        const info = await statInside(root, relative, this.checkAccess);
        const same = old && ['mtimeMs', 'size', 'full', 'dev', 'ino'].every((key) => old.info[key] === info[key]);
        if (!same) read = await this.read(root, relative);
      } catch (error) {
        if (!isUnavailable(error) && !['OUTSIDE_ROOT', 'NOT_FILE'].includes(error.code)) throw error;
        skipped.files += 1;
        return [];
      }
      const entry = read ? { info: read, docs: parse(read, file) } : old;
      // Keep only the fingerprint and parsed documents in the cache.
      const { mtimeMs, size, full, dev, ino } = entry.info;
      next.set(key, { info: { mtimeMs, size, full, dev, ino }, docs: entry.docs });
      return entry.docs;
    });
    this.entries = next;
    return { docs: documents.flat(), skipped };
  }
}
