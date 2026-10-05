/**
 * One-shot Promptr state layout.
 *
 * State root: `${PI_CODING_AGENT_DIR:-~/.pi/agent}/promptr/`.
 * Per project: `<root>/projects/<slug>/` where slug is a safe basename plus a
 * short hash of the canonical cwd. Files:
 *
 * - `scratch.md`    TUI note buffer (ASCII+LF contract of the view).
 * - `queue.json`    persistent pending queue + composer (existing codec).
 * - `composer.md`   convenience mirror of the composer (not authoritative).
 * - `progress.json` structured checkpoints.
 * - `autocheck.json` automatic-checkpoint switch/cadence/last-capture state.
 * - `promptr.md`    append-only human log: checkpoints + handoffs.
 * - `handoffs/`     staged continuation prompts, one file each.
 * - `tracking.json` Gitea display cache (read-only; Gitea authoritative).
 * - `catchup/`     Catch-Me-Up digests (`<stamp>.md` + `.json`), `catchup.json` cursor.
 *
 * Single-writer assumption: one Pi session writes a project dir at a time.
 * Writes are atomic (tmp + rename); reads never throw — missing/corrupt state
 * falls back to empty and the UI says so. No locks, no sync, no network.
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import fs from "node:fs";

export function stateRoot(): string {
  const override = process.env.PI_CODING_AGENT_DIR?.trim();
  const base = override && override.length > 0 ? override : path.join(homedir(), ".pi", "agent");
  return path.join(base, "promptr");
}

export function projectSlug(cwd: string): string {
  const canonical = path.resolve(cwd);
  const hash = createHash("sha1").update(canonical).digest("hex").slice(0, 12);
  const base = (path.basename(canonical) || "root").toLowerCase().replace(/[^a-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "root";
  return `${base}-${hash}`;
}

export type ProjectPaths = {
  root: string;
  dir: string;
  slug: string;
  cwd: string;
  scratch: string;
  queue: string;
  composer: string;
  progress: string;
  /** Automatic-checkpoint settings (switch, interval, last capture/sync). */
  autocheck: string;
  log: string;
  handoffsDir: string;
  /** Gitea tracking display cache (read-only snapshot; Gitea authoritative). */
  tracking: string;
  /** Catch-Me-Up digests, one `<stamp>.md` + `<stamp>.json` pair per run. */
  catchupDir: string;
  /** Catch-Me-Up cursor: `{ lastRunAt, lastFile, summary }`. */
  catchup: string;
};

export function projectPaths(cwd: string): ProjectPaths {
  const root = stateRoot();
  const slug = projectSlug(cwd);
  const dir = path.join(root, "projects", slug);
  return {
    root, dir, slug, cwd: path.resolve(cwd),
    scratch: path.join(dir, "scratch.md"),
    queue: path.join(dir, "queue.json"),
    composer: path.join(dir, "composer.md"),
    progress: path.join(dir, "progress.json"),
    autocheck: path.join(dir, "autocheck.json"),
    log: path.join(dir, "promptr.md"),
    handoffsDir: path.join(dir, "handoffs"),
    tracking: path.join(dir, "tracking.json"),
    catchupDir: path.join(dir, "catchup"),
    catchup: path.join(dir, "catchup.json"),
  };
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
}

/** Atomic write: tmp file in same dir + rename. Creates parent dirs. */
export function atomicWrite(file: string, text: string): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
}

export function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

export function appendText(file: string, text: string): void {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, text, { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
}

export function listFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((n) => !n.startsWith(".")).sort();
  } catch {
    return [];
  }
}
