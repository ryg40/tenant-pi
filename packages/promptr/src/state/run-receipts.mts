import fs from "node:fs";
import path from "node:path";
import { ensureDir, stateRoot } from "./paths.mts";

export function runReceiptDir(runId: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(runId)) throw new Error("Invalid run id");
  return path.join(stateRoot(), "herdr-runs", runId);
}

/** Exclusive directory creation fences duplicate starts, including after a crash. */
export function createRunReceiptDir(runId: string): string {
  const dir = runReceiptDir(runId);
  ensureDir(path.dirname(dir));
  fs.mkdirSync(dir, { mode: 0o700 });
  return dir;
}

/** Never overwrite a receipt, and never store prompt text or a raw CLI response. */
export function writeRunReceipt(dir: string, file: string, value: unknown): void {
  if (!/^[a-z0-9-]+\.json$/.test(file)) throw new Error("Invalid receipt file");
  fs.writeFileSync(path.join(dir, file), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}

export function readBoundedFile(file: string, maxBytes: number): { text: string; mtimeMs: number } {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("File exceeds bound or is not regular");
    const bytes = Buffer.alloc(maxBytes + 1);
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (count > maxBytes) throw new Error("File exceeds bound");
    return { text: bytes.subarray(0, count).toString("utf8"), mtimeMs: stat.mtimeMs };
  } finally { fs.closeSync(fd); }
}
