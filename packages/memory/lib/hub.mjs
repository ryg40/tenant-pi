// The hub holds the adapters and answers the global questions: the state and
// size of each source, the newest entries of all sources, and one search over
// several sources. Each call to a source has a deadline. A failed source gives
// its error in its own slot and does not fail the others.

import * as agentcore from './adapters/agentcore.mjs';
import { SOURCE_TYPES } from './adapters/base.mjs';
import * as hermes from './adapters/hermes.mjs';
import * as llmwiki from './adapters/llmwiki.mjs';
import * as okknow from './adapters/okknow.mjs';
import * as openviking from './adapters/openviking.mjs';
import * as sample from './adapters/sample.mjs';
import { readSecret } from './config.mjs';
import { publicError, SourceError, withTimeout } from './model.mjs';

const LIVE = { openviking, okknow, llmwiki, hermes, agentcore };

function checkedStatus(status) {
  if (!status || typeof status !== 'object' || Array.isArray(status) || !['ok', 'error'].includes(status.state)) {
    throw new SourceError('bad_reply');
  }
  return status;
}

function checkedSearch(result) {
  if (!Array.isArray(result?.items)) throw new SourceError('bad_reply');
  if (result.errors === undefined) return result;
  if (!Array.isArray(result.errors) || result.errors.some((error) =>
    !error || ['path', 'code', 'message'].some((field) => typeof error[field] !== 'string'))) {
    throw new SourceError('bad_reply');
  }
  return { ...result, errors: result.errors.map(({ path, code }) => ({ path, ...publicError(new SourceError(code)) })) };
}

export class Hub {
  // `secrets` reads one credential file; the local module gives a reader that refuses a file of another mode.
  constructor(config, { timeoutMs = 12_000, overviewTtlMs = 30_000, factories = {}, log = () => {}, secrets = readSecret } = {}) {
    this.timeoutMs = timeoutMs;
    this.overviewTtlMs = overviewTtlMs;
    this.log = log;
    this.entries = [];
    this.cache = new Map();
    for (const cfg of config.sources) {
      if (cfg.mode === 'off') continue;
      const entry = { cfg, adapter: null, error: null };
      try {
        const mod = cfg.mode === 'sample' ? sample : factories[cfg.type] ?? LIVE[cfg.type];
        entry.adapter = mod.create(cfg, { readSecret: secrets });
      } catch {
        entry.error = publicError(new SourceError('config'));
        log(`source ${cfg.id}: configuration error`);
      }
      this.entries.push(entry);
    }
  }

  get mode() {
    const modes = new Set(this.entries.map((e) => e.cfg.mode));
    return modes.size === 1 ? [...modes][0] : 'mixed';
  }

  describe(entry) {
    const a = entry.adapter;
    const t = SOURCE_TYPES[entry.cfg.type];
    return {
      id: entry.cfg.id,
      type: entry.cfg.type,
      name: a?.name ?? entry.cfg.name ?? t.name,
      unit: a?.unit ?? t.unit,
      mode: entry.cfg.mode,
      lazy: Boolean(a?.lazy),
      review: typeof a?.review === 'function',
      description: a?.description ?? '',
      configError: entry.error,
    };
  }

  sources() {
    return this.entries.map((e) => this.describe(e));
  }

  entry(id) {
    const e = this.entries.find((x) => x.cfg.id === id);
    if (!e) throw new SourceError('unknown_source', 'No source has this id.', 404);
    if (!e.adapter) throw new SourceError('config', e.error?.message ?? 'The source is not configured.', 503);
    return e;
  }

  async run(entry, what, fn) {
    const started = Date.now();
    try {
      const value = await withTimeout(fn(), this.timeoutMs, `${entry.cfg.id} ${what}`);
      return { ok: true, value, tookMs: Date.now() - started };
    } catch (err) {
      const pub = publicError(err);
      this.log(`source ${entry.cfg.id}: ${what} failed: ${pub.code}`);
      const status = err instanceof SourceError && Number.isInteger(err.status) && err.status >= 400 && err.status <= 599
        ? err.status : undefined;
      return { ok: false, error: pub, status, tookMs: Date.now() - started };
    }
  }

  // The state and the size of each source. A lazy source reports only what it
  // has loaded; the hub does not start a remote read for it here.
  async overview({ refresh = false } = {}) {
    return Promise.all(this.entries.map(async (e) => {
      const base = this.describe(e);
      if (!e.adapter) return { ...base, state: 'error', error: e.error };
      const key = `overview:${e.cfg.id}`;
      const hit = this.cache.get(key);
      if (!refresh && hit && Date.now() - hit.at < this.overviewTtlMs) return hit.value;
      this.cache.delete(key);
      const r = await this.run(e, 'overview', async () => {
        let status, ov;
        if (!e.adapter.lazy && e.adapter.overviewWithStatus) {
          const result = await e.adapter.overviewWithStatus();
          status = checkedStatus(result?.status);
          ov = result.ov;
        } else {
          status = checkedStatus(e.adapter.lazy ? { state: 'ok', detail: '' } : await e.adapter.status());
          ov = await e.adapter.overview();
        }
        if (!ov || typeof ov !== 'object' || Array.isArray(ov)) throw new SourceError('bad_reply');
        return { status, ov };
      });
      const value = r.ok
        ? {
          ...base, ...r.value.ov, state: r.value.status.state === 'error' ? 'stale' : 'ok',
          detail: r.value.status.detail, tookMs: r.tookMs,
          ...(r.value.status.state === 'error'
            ? { error: publicError(new SourceError(r.value.status.error?.code)) } : {}),
        }
        : { ...base, state: 'error', error: r.error, tookMs: r.tookMs };
      if (value.state === 'ok' && !e.adapter.lazy) this.cache.set(key, { at: Date.now(), value });
      return value;
    }));
  }

  async recent(limit = 30) {
    const per = Math.max(5, Math.min(limit, 50));
    const results = await Promise.all(this.entries.filter((e) => e.adapter).map(async (e) => {
      const r = await this.run(e, 'recent', () => e.adapter.recent(per));
      return r.ok ? r.value : [];
    }));
    return results.flat().filter((i) => i.date).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, limit);
  }

  // One search over the chosen sources. A lazy source joins only when the
  // request names it. The scores of different sources are not comparable, so
  // each source keeps its own list.
  async search(query, { sources, limit = 10 } = {}) {
    const wanted = sources?.length ? new Set(sources) : null;
    const chosen = this.entries.filter((e) => (wanted ? wanted.has(e.cfg.id) : !e.adapter?.lazy));
    return Promise.all(chosen.map(async (e) => {
      const base = { id: e.cfg.id, name: this.describe(e).name, type: e.cfg.type, mode: e.cfg.mode };
      if (!e.adapter) return { ...base, state: 'error', error: e.error, items: [], total: 0 };
      const r = await this.run(e, 'search', async () => checkedSearch(await e.adapter.search(query, { limit })));
      return r.ok
        ? {
          ...base, state: 'ok', items: r.value.items, total: r.value.total ?? r.value.items.length,
          note: r.value.note ?? '', tookMs: r.tookMs,
          ...(r.value.more !== undefined ? { more: r.value.more } : {}),
          ...(r.value.partial !== undefined ? { partial: r.value.partial } : {}),
          ...(r.value.notes !== undefined ? { notes: r.value.notes } : {}),
          ...(r.value.errors !== undefined ? { errors: r.value.errors } : {}),
        }
        : { ...base, state: 'error', error: r.error, items: [], total: 0, tookMs: r.tookMs };
    }));
  }

  async browse(id, opts) {
    const e = this.entry(id);
    return this.unwrap(await this.run(e, 'browse', () => e.adapter.browse(opts)));
  }

  async searchOne(id, query, opts) {
    const e = this.entry(id);
    return this.unwrap(await this.run(e, 'search', async () => checkedSearch(await e.adapter.search(query, opts))));
  }

  async item(id, itemId) {
    const e = this.entry(id);
    const value = this.unwrap(await this.run(e, 'item', () => e.adapter.get(itemId)));
    if (!value) throw new SourceError('not_found', 'The source has no item with this id.', 404);
    return value;
  }

  // The one write of the app. Only a source with an explicit review setting has it.
  async review(id, itemId, decision) {
    const e = this.entry(id);
    if (typeof e.adapter.review !== 'function') throw new SourceError('review_off', '', 403);
    const value = this.unwrap(await this.run(e, 'review', () => e.adapter.review(itemId, decision)));
    this.cache.delete(`overview:${e.cfg.id}`);
    return value;
  }

  unwrap(r) {
    if (r.ok) return r.value;
    const status = r.status ?? (r.error.code === 'timeout' ? 504 : 502);
    throw new SourceError(r.error.code, r.error.message, status);
  }

  // Start the local indexes in the background, so that the first page does
  // not wait for a large source. A failure here is logged; the next request
  // tries again.
  warm() {
    this.warming ??= Promise.all(this.entries.filter((e) => e.adapter?.warm).map(async (e) => {
      const result = await this.run(e, 'warm-up', () => e.adapter.warm());
      if (result.ok) this.log(`source ${e.cfg.id}: index ready in ${result.tookMs} ms`);
    }));
    return this.warming;
  }

  clear() {
    const n = this.cache.size;
    this.cache.clear();
    return n;
  }
}
