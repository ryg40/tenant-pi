// An in-memory index of documents for the sources that the app reads as a whole:
// the sample fixtures, llm-wiki, hermes-memory and okknow in file mode.
//
// A document: { id, folder: [segment...], title, body, date, dateLabel, kind,
//               scope, tags, meta: [[label, value]...], format }
// The loader runs at the first request and again when the index is older than
// `ttlMs`. Later requests use the old index while one reload runs.
// A failed reload keeps the old index. Nothing is written to disk.
// File loaders return { docs, skipped }; other loaders can return docs directly.

import { makeItem, publicError, scoreText, snippetFor, stripMarkup, truncate } from './model.mjs';

export const PAGE_SIZE = 200;

export class LocalIndex {
  constructor({ source, load, ttlMs = 60_000, folderLabels = {} }) {
    this.source = source;
    this.load = load;
    this.ttlMs = ttlMs;
    this.folderLabels = folderLabels;
    this.skipped = { files: 0, directories: 0 };
    this.docs = null;
    this.byId = new Map();
    this.loadedAt = 0;
    this.attemptedAt = null;
    this.pending = null;
    this.error = null;
  }

  async ensure() {
    const fresh = this.attemptedAt !== null && Date.now() - this.attemptedAt < this.ttlMs;
    if (!fresh && !this.pending) {
      // Defer even a synchronous loader until the cached response can finish.
      this.pending = new Promise((resolve) => setImmediate(resolve))
        .then(() => this.load())
        .then((result) => {
          const { docs, skipped = { files: 0, directories: 0 } } = Array.isArray(result) ? { docs: result } : result;
          const byId = new Map(docs.map((d) => [d.id, d]));
          this.docs = docs;
          this.byId = byId;
          this.skipped = skipped;
          this.loadedAt = Date.now();
          this.error = null;
          return docs;
        })
        .catch((error) => {
          this.error = error;
          throw error;
        })
        .finally(() => {
          // Retry a failed refresh at the next interval, not on every request.
          this.attemptedAt = Date.now();
          this.pending = null;
        });
      // Background failures have no caller to consume their rejection.
      this.pending.catch(() => {});
    }
    if (this.docs === null && !this.pending) throw this.error;
    return this.docs ?? this.pending;
  }

  async status() {
    let docs;
    try {
      docs = await this.ensure();
    } catch {
      // The first load has no previous snapshot to serve.
    }
    return this.#status(docs);
  }

  #status(docs) {
    if (this.error) {
      return {
        state: 'error',
        detail: docs ? `Reload failed; serving ${docs.length} previously indexed entries.` : 'The initial load failed.',
        error: publicError(this.error),
      };
    }
    const skipped = this.skipped.files ? `; ${this.skipped.files} files skipped` : '';
    const directories = this.skipped.directories ? `; ${this.skipped.directories} directories skipped (file count unknown)` : '';
    return { state: 'ok', detail: `${docs.length} entries indexed${skipped}${directories}` };
  }

  item(doc, extra = {}) {
    return makeItem(this.source, {
      id: doc.id,
      title: doc.title,
      snippet: extra.snippet ?? truncate(stripMarkup(doc.summary ?? doc.body), 220),
      scope: doc.scope ?? doc.folder.join(' / '),
      kind: doc.kind,
      date: doc.date,
      dateLabel: doc.dateLabel,
      tags: doc.tags,
      score: extra.score,
    });
  }

  async overviewWithStatus(facetDepth = 1) {
    // One load attempt supplies both the state and the snapshot for this call.
    const docs = await this.ensure();
    return { status: this.#status(docs), ov: this.#overview(docs, facetDepth) };
  }

  async overview(facetDepth = 1) {
    return this.#overview(await this.ensure(), facetDepth);
  }

  #overview(docs, facetDepth) {
    const counts = new Map();
    let newest = null;
    for (const d of docs) {
      const key = d.folder.slice(0, facetDepth).join('/');
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (d.date && (!newest || d.date > newest)) newest = d.date;
    }
    const facets = Array.from(counts, ([path, count]) => ({
      path,
      label: this.label(path),
      count,
    })).sort((a, b) => b.count - a.count);
    return { total: docs.length, newest: newest ? new Date(newest).toISOString() : null, facets };
  }

  label(path) {
    return this.folderLabels[path] ?? path.split('/').pop() ?? path;
  }

  async browse({ path = '', offset = 0 } = {}) {
    const docs = await this.ensure();
    const prefix = path ? path.split('/') : [];
    const folders = new Map();
    const items = [];
    for (const d of docs) {
      if (!startsWith(d.folder, prefix)) continue;
      if (d.folder.length === prefix.length) {
        items.push(d);
      } else {
        const next = d.folder[prefix.length];
        folders.set(next, (folders.get(next) ?? 0) + 1);
      }
    }
    items.sort(byDateThenTitle);
    const start = Math.max(0, Number(offset) || 0);
    const page = items.slice(start, start + PAGE_SIZE);
    return {
      path,
      crumbs: crumbs(prefix, (p) => this.label(p)),
      folders: Array.from(folders, ([name, count]) => {
        const p = [...prefix, name].join('/');
        return { path: p, label: this.label(p), count };
      }).sort((a, b) => a.label.localeCompare(b.label)),
      items: page.map((d) => this.item(d)),
      total: items.length,
      offset: start,
      more: start + PAGE_SIZE < items.length,
    };
  }

  async search(query, { limit = 20, path = '' } = {}) {
    const docs = await this.ensure();
    const prefix = path ? path.split('/') : [];
    const hits = [];
    for (const d of docs) {
      if (prefix.length && !startsWith(d.folder, prefix)) continue;
      const score = scoreText(query, d.title, d.searchText ?? d.body);
      if (score > 0) hits.push([score, d]);
    }
    hits.sort((a, b) => b[0] - a[0] || byDateThenTitle(a[1], b[1]));
    return {
      total: hits.length,
      items: hits.slice(0, limit).map(([score, d]) => this.item(d, {
        score,
        snippet: snippetFor(d.body, query),
      })),
    };
  }

  async recent(limit = 10) {
    const docs = await this.ensure();
    return docs.filter((d) => d.date).sort(byDateThenTitle).slice(0, limit).map((d) => this.item(d));
  }

  async get(id) {
    await this.ensure();
    const d = this.byId.get(id);
    if (!d) return null;
    return {
      item: this.item(d),
      body: d.body,
      format: d.format ?? 'markdown',
      meta: d.meta ?? [],
      native: d.native ?? d.id,
    };
  }
}

function startsWith(folder, prefix) {
  if (folder.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) if (folder[i] !== prefix[i]) return false;
  return true;
}

function byDateThenTitle(a, b) {
  const da = a.date ?? '';
  const db = b.date ?? '';
  if (da !== db) return da < db ? 1 : -1;
  return String(a.title).localeCompare(String(b.title));
}

export function crumbs(prefix, label) {
  const out = [{ path: '', label: 'All' }];
  for (let i = 0; i < prefix.length; i += 1) {
    const p = prefix.slice(0, i + 1).join('/');
    out.push({ path: p, label: label(p) });
  }
  return out;
}
