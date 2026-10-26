import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

/**
 * The SQLite store of the interactive inputs. No Pi import: the test drives it in child processes.
 *
 * `inputs` keeps every accepted input. `recall_items` is one row per distinct text with its latest
 * input, and `recall_fts` (FTS5 trigram) indexes it for `/recall`. Writers in parallel are safe:
 * each write is one `BEGIN IMMEDIATE` transaction with a busy timeout.
 */

export const DIRECTORY_VARIABLE = "CROSS_SESSION_RECALL_DIR";
export const DATABASE_NAME = "history.sqlite3";
const LEGACY_NAME = "history.json";

export type HistoryItem = {
  text: string;
  timestamp: number;
  cwd?: string;
  sessionFile?: string;
};

/** The store directory: `CROSS_SESSION_RECALL_DIR`, else `~/.pi/agent/cross-session-recall`, shared by all profiles. */
export function storeDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env[DIRECTORY_VARIABLE] || join(home, ".pi", "agent", "cross-session-recall");
}

export const normalizeText = (text: string): string => text.replace(/\r\n/g, "\n").trim();

/** False for an empty text and for the envelopes that a delegated subagent or a handoff writes. */
export const isRecallableText = (text: string): boolean => {
  if (!text) return false;
  const beginning = text.slice(0, 1000).toLowerCase();
  return !(
    text.startsWith("Task: [Read from:") ||
    beginning.includes("you are a delegated subagent running from a fork of the parent session") ||
    (/^you are\b/.test(beginning) && /\bsubagent\b/.test(beginning)) ||
    (text.includes("FINAL_COMPRESSED_CONTEXT") && text.includes("SUBAGENT_COMPLETE"))
  );
};

const BUSY_TIMEOUT = 5000;
// The connection settings; they take no lock. The WAL switch and the schema come after them.
const PRAGMAS = `
  PRAGMA busy_timeout = ${BUSY_TIMEOUT};
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA secure_delete = ON;
`;
// Runs inside `BEGIN IMMEDIATE`: the busy handler covers that lock, but not a read that turns into a write.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS inputs (
    id INTEGER PRIMARY KEY,
    text TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    cwd TEXT,
    session_file TEXT,
    source TEXT NOT NULL CHECK (source = 'interactive')
  );
  CREATE INDEX IF NOT EXISTS inputs_timestamp_idx ON inputs(timestamp DESC);
  CREATE TABLE IF NOT EXISTS recall_items (
    id INTEGER PRIMARY KEY,
    text_hash TEXT NOT NULL UNIQUE,
    text TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    latest_input_id INTEGER NOT NULL REFERENCES inputs(id) ON DELETE CASCADE,
    cwd TEXT,
    session_file TEXT
  );
  CREATE INDEX IF NOT EXISTS recall_items_latest_idx ON recall_items(latest_input_id DESC);
  CREATE VIRTUAL TABLE IF NOT EXISTS recall_fts USING fts5(
    text, content = 'recall_items', content_rowid = 'id', tokenize = 'trigram'
  );
  CREATE TRIGGER IF NOT EXISTS recall_items_ai AFTER INSERT ON recall_items BEGIN
    INSERT INTO recall_fts(rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER IF NOT EXISTS recall_items_ad AFTER DELETE ON recall_items BEGIN
    INSERT INTO recall_fts(recall_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END;
  CREATE TRIGGER IF NOT EXISTS recall_items_au AFTER UPDATE ON recall_items BEGIN
    INSERT INTO recall_fts(recall_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO recall_fts(rowid, text) VALUES (new.id, new.text);
  END;
`;

const SELECT = "SELECT text, timestamp, cwd, session_file FROM recall_items";

const toItem = (row: Record<string, unknown>): HistoryItem => ({
  text: String(row.text),
  timestamp: Number(row.timestamp),
  cwd: typeof row.cwd === "string" ? row.cwd : undefined,
  sessionFile: typeof row.session_file === "string" ? row.session_file : undefined,
});

const isLegacyItem = (value: unknown): value is HistoryItem & { source: string } => {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.text === "string" && typeof item.timestamp === "number" && Number.isFinite(item.timestamp) &&
    item.timestamp >= 0 && item.timestamp <= 8_640_000_000_000_000 && item.source === "interactive";
};

export class RecallStore {
  readonly dir: string;
  private readonly db: DatabaseSync;
  private readonly insertInput: StatementSync;
  private readonly upsertItem: StatementSync;
  private readonly latest: StatementSync;
  private readonly searchShort: StatementSync;
  private readonly searchFts: StatementSync;

  /** Opens or creates the store in `dir` (directory 0700, file 0600) and imports a legacy `history.json` once. */
  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const file = join(dir, DATABASE_NAME);
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600); // before WAL: the -wal and -shm files take the mode of the main file
    this.db.exec(PRAGMAS);
    this.switchToWal();
    this.transaction(() => this.db.exec(SCHEMA));
    this.insertInput = this.db.prepare(
      "INSERT INTO inputs(text, timestamp, cwd, session_file, source) VALUES (?, ?, ?, ?, 'interactive')",
    );
    this.upsertItem = this.db.prepare(`
      INSERT INTO recall_items(text_hash, text, timestamp, latest_input_id, cwd, session_file)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(text_hash) DO UPDATE SET text = excluded.text, timestamp = excluded.timestamp,
        latest_input_id = excluded.latest_input_id, cwd = excluded.cwd, session_file = excluded.session_file
    `);
    this.latest = this.db.prepare(`${SELECT} ORDER BY latest_input_id DESC LIMIT ?`);
    this.searchShort = this.db.prepare(`${SELECT} WHERE instr(lower(text), lower(?)) > 0 ORDER BY latest_input_id DESC LIMIT ?`);
    this.searchFts = this.db.prepare(`
      SELECT r.text, r.timestamp, r.cwd, r.session_file FROM recall_fts f JOIN recall_items r ON r.id = f.rowid
      WHERE recall_fts MATCH ? AND instr(lower(r.text), lower(?)) > 0 ORDER BY r.latest_input_id DESC LIMIT ?
    `);
  }

  /**
   * Sets WAL mode. Two connections that open a new store at the same time can both get `SQLITE_BUSY`
   * at once, without the busy handler (deadlock avoidance), so this tries again until the busy timeout.
   */
  private switchToWal(): void {
    const deadline = Date.now() + BUSY_TIMEOUT;
    for (;;) {
      try {
        this.db.exec("PRAGMA journal_mode = WAL");
        return;
      } catch (error) {
        if (((error as { errcode?: number }).errcode ?? 0) % 256 !== 5 || Date.now() >= deadline) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5 + Math.random() * 20);
      }
    }
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private insert(item: HistoryItem): void {
    const result = this.insertInput.run(item.text, item.timestamp, item.cwd ?? null, item.sessionFile ?? null);
    const hash = createHash("sha256").update(item.text).digest("hex");
    this.upsertItem.run(hash, item.text, item.timestamp, Number(result.lastInsertRowid), item.cwd ?? null, item.sessionFile ?? null);
  }

  /** Stores one normalized, recallable input. The caller normalizes and filters. */
  add(item: HistoryItem): void {
    this.transaction(() => this.insert(item));
  }

  /** The distinct inputs, newest first; with a query, those that contain it. */
  query(query: string, limit: number): HistoryItem[] {
    const q = normalizeText(query);
    const rows = !q ? this.latest.all(limit)
      : [...q].length < 3 ? this.searchShort.all(q, limit)
      : this.searchFts.all(`"${q.replaceAll('"', '""')}"`, q, limit);
    return (rows as Record<string, unknown>[]).map(toItem);
  }

  /** Deletes every stored input. */
  clear(): void {
    this.transaction(() => {
      this.db.exec("DELETE FROM recall_items; DELETE FROM inputs");
    });
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  /**
   * Imports `history.json` once, inside the write lock, and renames it to `history.json.migrated`.
   * The metadata marker keeps a second launch, or a failed rename, from importing it again.
   */
  migrateLegacy(): number {
    const legacy = join(this.dir, LEGACY_NAME);
    if (!existsSync(legacy)) return 0;
    let values: unknown;
    try { values = JSON.parse(readFileSync(legacy, "utf8")); } catch { values = []; }
    const imported = this.transaction(() => {
      if (this.db.prepare("SELECT value FROM metadata WHERE key = 'legacy_json_migrated'").get()) return -1;
      let count = 0;
      for (const value of Array.isArray(values) ? values : []) {
        if (!isLegacyItem(value)) continue;
        const text = normalizeText(value.text);
        if (!isRecallableText(text)) continue;
        this.insert({ text, timestamp: value.timestamp, cwd: value.cwd, sessionFile: value.sessionFile });
        count++;
      }
      this.db.prepare("INSERT INTO metadata(key, value) VALUES ('legacy_json_migrated', ?)").run(String(Date.now()));
      return count;
    });
    if (imported < 0) return 0;
    try {
      chmodSync(legacy, 0o600);
      renameSync(legacy, `${legacy}.migrated`);
    } catch { /* the marker keeps the import one-time when the rename fails */ }
    return imported;
  }

  close(): void {
    this.db.close();
  }
}
