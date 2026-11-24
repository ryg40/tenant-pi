// hermes-memory: the memory of the pi-hermes-memory extension, read from
// read-only mounts.
//
// - `path`: the hermes root with MEMORY.md, USER.md, failures.md and sessions.db.
// - `projectsPath` (optional): the projects root with <project>/MEMORY.md.
//
// The table `memories` of sessions.db is the full store (target memory, user or
// failure, with category, project and dates). The Markdown files are the active
// files that the extension loads into a session. The index holds both, in two
// folders, because they answer different questions. The app reads no session
// transcript: the tables `sessions` and `messages` stay closed.
//
// SQLite opens the file read-only. Existing WAL sidecars can allow a WAL read.
// If SQLite cannot read the WAL index, the connection tries `immutable=1`.
// An immutable read sees only the checkpointed database, not pending WAL rows.

import { statSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { LocalIndex } from '../localindex.mjs';
import { exists, FileCache, isUnavailable, MAX_FILES } from '../files.mjs';
import { SourceError, titleFrom } from '../model.mjs';
import { indexAdapter } from './base.mjs';

const FILES = [
  ['MEMORY.md', 'memory', 'Memory'],
  ['USER.md', 'user', 'User profile'],
  ['failures.md', 'failure', 'Failures'],
];

const LABELS = {
  store: 'Store (sessions.db)',
  'store/memory': 'Memory',
  'store/user': 'User profile',
  'store/failure': 'Failures',
  active: 'Active files',
  'active/memory': 'MEMORY.md',
  'active/user': 'USER.md',
  'active/failure': 'failures.md',
  projects: 'Project files',
};

export function create(cfg) {
  const state = { files: new FileCache() };
  const index = new LocalIndex({
    source: cfg.id,
    ttlMs: (cfg.refreshSeconds ?? 60) * 1000,
    folderLabels: LABELS,
    load: () => loadHermes(cfg, state),
  });
  const adapter = indexAdapter({
    id: cfg.id,
    type: 'hermes',
    name: cfg.name,
    mode: 'live',
    description: cfg.description ?? 'Memory, user profile and failure entries of pi-hermes-memory.',
    index,
    facetDepth: 1,
  });
  adapter.status = () => index.status();
  return adapter;
}

export async function loadHermes(cfg, state = { files: new FileCache() }) {
  if (!(await exists(cfg.path))) {
    throw new SourceError('not_mounted', 'The hermes-memory directory is not mounted.');
  }
  const files = [];
  const skipped = { files: 0, directories: 0 };
  async function add(file) {
    try {
      if (await exists(path.join(file.root, file.relative))) files.push(file);
    } catch (error) {
      if (!isUnavailable(error)) throw error;
      skipped.files += 1;
    }
  }
  for (const [relative, target, label] of FILES) {
    await add({ root: cfg.path, relative, target, label });
  }
  if (cfg.projectsPath) {
    const projects = await readdir(cfg.projectsPath, { withFileTypes: true });
    projects.sort((a, b) => a.name.localeCompare(b.name));
    for (const p of projects) {
      if (files.length + skipped.files >= MAX_FILES) break;
      if (!p.isDirectory() || p.name.startsWith('.')) continue;
      const relative = path.join(p.name, 'MEMORY.md');
      await add({ root: cfg.projectsPath, relative, project: p.name });
    }
  }
  const file = path.join(cfg.path, 'sessions.db');
  const signature = await storeSignature(file);
  const store = state.signature === signature ? state.store : readStore(file);
  const { docs: active } = await state.files.load(files, ({ text, mtime, size, tooLarge }, f) => {
    const entries = tooLarge
      ? [{ text: `(The file has ${size} bytes. The app shows files up to 2 MB.)` }]
      : splitEntries(text);
    return entries.map((entry, i) => entryDoc(entry, {
      id: f.project ? `project:${f.project}#${i + 1}` : `file:${f.relative}#${i + 1}`,
      folder: f.project ? ['projects', f.project] : ['active', f.target],
      scope: f.project ? `Project ${f.project}` : `${f.label} (${f.relative})`,
      kind: f.project ? 'project memory' : f.target,
      fileTime: mtime,
      native: `${f.project ? 'projects/' : ''}${f.relative}, entry ${i + 1}`,
    }));
  }, skipped);
  const matches = new Map();
  for (const doc of store) {
    const rows = matches.get(doc.body) ?? [];
    rows.push(['Row', `memories.id = ${doc.id.slice(3)}`]);
    matches.set(doc.body, rows);
  }
  const docs = [...store, ...active.map((doc) => ({
    ...doc,
    meta: [...doc.meta, ...(matches.get(doc.body) ?? [])],
  }))];
  if (!docs.length && (skipped.files || skipped.directories)) throw new Error('No documents loaded.');
  // Publish the store fingerprint only after the whole load succeeds.
  state.signature = signature;
  state.store = store;
  return { docs, skipped };
}

async function storeSignature(file) {
  // A new WAL index can make rows visible after an immutable fallback.
  const parts = await Promise.all(['', '-wal', '-shm'].map(async (suffix) => {
    try {
      const info = await stat(file + suffix);
      return [info.mtimeMs, info.size, info.dev, info.ino];
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }));
  return JSON.stringify(parts);
}

// The entries of a hermes Markdown file: blocks separated by a line "§".
// An entry can end with <!-- created=YYYY-MM-DD, last=YYYY-MM-DD -->.
export function splitEntries(text) {
  return String(text ?? '')
    .split(/^§\s*$/m)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const m = block.match(/<!--\s*created=([0-9-]+)(?:,\s*last=([0-9-]+))?\s*-->\s*$/);
      return {
        text: m ? block.slice(0, m.index).trim() : block,
        created: m?.[1] ?? null,
        last: m?.[2] ?? null,
      };
    });
}

function entryDoc(entry, { id, folder, scope, kind, fileTime, native }) {
  return {
    id,
    folder,
    title: titleFrom(entry.text),
    body: entry.text,
    date: entry.last ?? entry.created ?? fileTime?.toISOString() ?? null,
    dateLabel: entry.last ? 'last referenced' : entry.created ? 'created' : 'file time',
    kind,
    scope,
    tags: [],
    format: 'markdown',
    meta: [
      ['Source', native],
      ['Created', entry.created ?? 'not recorded'],
      ['Last referenced', entry.last ?? 'not recorded'],
    ],
    native,
  };
}

// A missing store is optional. An unreadable or corrupt store fails the reload.
export function readStore(file) {
  let db;
  try {
    db = openReadOnly(file);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  try {
    const cols = new Set(db.prepare('PRAGMA table_info(memories)').all().map((c) => c.name));
    if (!cols.has('content')) throw new Error('The memories table has no content column.');
    const pick = (c) => (cols.has(c) ? c : `NULL AS ${c}`);
    const rows = db.prepare(`SELECT id, project, target, category, content,
        ${pick('failure_reason')}, ${pick('tool_state')}, ${pick('corrected_to')},
        created, last_referenced, ${pick('hit_count')}, ${pick('last_hit_at')}
      FROM memories ORDER BY id`).all();
    return rows.map((r) => {
      const meta = [
        ['Row', `memories.id = ${r.id}`],
        ['Target', r.target],
        ['Category', r.category ?? 'none'],
        ['Project', r.project ?? 'global'],
        ['Created', r.created],
        ['Last referenced', r.last_referenced],
      ];
      if (r.hit_count !== null) meta.push(['Hits', String(r.hit_count)]);
      if (r.last_hit_at) meta.push(['Last hit', r.last_hit_at]);
      if (r.failure_reason) meta.push(['Failure reason', r.failure_reason]);
      if (r.corrected_to) meta.push(['Corrected to', r.corrected_to]);
      if (r.tool_state) meta.push(['Tool state', r.tool_state]);
      return {
        id: `db:${r.id}`,
        folder: ['store', r.target],
        title: titleFrom(r.content),
        body: r.content,
        searchText: [r.content, r.failure_reason, r.corrected_to, r.project].filter(Boolean).join('\n'),
        date: r.last_referenced ?? r.created,
        dateLabel: r.last_referenced ? 'last referenced' : 'created',
        kind: r.category ?? r.target,
        scope: r.project ? `Project ${r.project}` : 'Global',
        tags: [r.target, r.category, r.project].filter(Boolean),
        format: 'markdown',
        meta,
        native: `sessions.db memories.id ${r.id}`,
      };
    });
  } finally {
    db.close();
  }
}

export function openReadOnly(file) {
  if (!statSync(file).isFile()) throw new Error('The store is not a file.');
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    db.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get();
    return db;
  } catch (error) {
    db?.close();
    // Retry only access failures. A corrupt database must remain an error.
    if (![8, 14].includes(error.errcode & 0xff)) throw error;
    const url = pathToFileURL(file);
    url.searchParams.set('mode', 'ro');
    url.searchParams.set('immutable', '1');
    let fallback;
    try {
      fallback = new DatabaseSync(url, { readOnly: true });
      fallback.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get();
      return fallback;
    } catch (failure) {
      fallback?.close();
      throw failure;
    }
  }
}
