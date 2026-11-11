import fs from "node:fs";
import path from "node:path";
import { inspect } from "node:util";
import { ensureStateDir, stateDir } from "./paths.js";

const MAX_LOG_BYTES = 1024 * 1024;

/** Private, bounded diagnostics; a failed log write must not replace the original failure. */
export function recordError(code, operation, error) {
  let fd;
  try {
    ensureStateDir();
    const detail = inspect(error, { depth: 4, maxStringLength: 4096, maxArrayLength: 16, customInspect: false, getters: false }).slice(0, 8192);
    const entry = Buffer.from(JSON.stringify({ at: new Date().toISOString(), code, operation, detail }) + "\n");
    fd = fs.openSync(path.join(stateDir(), "errors.log"),
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid()) return;
    fs.fchmodSync(fd, 0o600);
    if (stat.size + entry.length > MAX_LOG_BYTES) fs.ftruncateSync(fd, 0);
    fs.writeFileSync(fd, entry);
  } catch {
    // Disk failures also affect this log. Never send their private details to a client.
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}
