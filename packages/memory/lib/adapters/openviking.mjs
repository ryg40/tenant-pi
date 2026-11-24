// OpenViking: the memory files of one or more roots, for example
// viking://user/<user>/memories/, read over the HTTP API with an API key.
//
// Read routes only: GET /api/v1/fs/ls, GET /api/v1/fs/stat,
// GET /api/v1/content/read, POST /api/v1/search/find, POST /api/v1/search/grep.
// A path outside the configured roots is refused before any request.
//
// Search is semantic (`find`). When `find` fails, the adapter runs a keyword
// search (`grep`) and says so in the result note.

import { requestJson } from '../http-client.mjs';
import { makeItem, SourceError, scoreText, titleFrom, truncate } from '../model.mjs';
import { SOURCE_TYPES } from './base.mjs';

const PRIVACY = /\{\{ov_privacy:[^}]*\}\}/g;
const HIDDEN = /(^|\/)\./;
const PAGE_SIZE = 1000;
const RECURSIVE_DEPTH = 3;
export const MAX_TREE_CALLS = 200;
const FALLBACK_ERRORS = new Set(['failed', 'unreachable', 'bad_reply', 'timeout']);

export function create(cfg, { readSecret }) {
  const base = String(cfg.baseUrl).replace(/\/+$/, '');
  const roots = (cfg.roots ?? []).map((r) => (typeof r === 'string' ? { uri: r, label: r } : r))
    .map((r) => {
      if (!canonicalUri(r?.uri) || HIDDEN.test(r.uri)) {
        throw new Error(`source ${cfg.id}: use a canonical, visible Viking root`);
      }
      return { ...r, label: r.label ?? r.uri, uri: r.uri.endsWith('/') ? r.uri : `${r.uri}/` };
    }).sort((a, b) => b.uri.length - a.uri.length);
  if (roots.length === 0) throw new Error(`source ${cfg.id}: set at least one root`);
  const timeoutMs = cfg.timeoutMs ?? 10_000;
  let key;
  const headers = () => {
    key ??= readSecret(cfg.apiKeyFile);
    return { 'X-API-Key': key };
  };
  async function call(path, opts = {}) {
    try {
      const { json } = await requestJson(base + path, { headers: headers(), timeoutMs, ...opts });
      if (!json || typeof json !== 'object' || Array.isArray(json) || typeof json.status !== 'string') {
        throw new SourceError('bad_reply', `${opts.what ?? 'OpenViking'}: the reply has no valid status.`);
      }
      if (json.status !== 'ok') {
        const denied = /^(UNAUTHENTICATED|UNAUTHORIZED|PERMISSION_DENIED|FORBIDDEN)$/i.test(json.error?.code ?? '');
        throw new SourceError(denied ? 'denied' : 'failed', `${opts.what ?? 'OpenViking'}: the service refused the request.`);
      }
      return json;
    } catch (err) {
      if (err?.code === 'denied') key = undefined;
      // The shared client also applies its deadline while reading the body.
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw new SourceError('timeout', `${opts.what ?? 'OpenViking'}: the request timed out.`, 504);
      }
      throw err;
    }
  }

  function inRoots(uri) {
    return canonicalUri(uri) && roots.some((r) => under(uri, r.uri));
  }

  function visible(uri, target) {
    return inRoots(uri) && !HIDDEN.test(uri) && (!target || under(uri, target));
  }

  function memoryFile(entry, target) {
    return visible(entry?.uri, target) && !entry.isDir && /\.md$/.test(entry.uri);
  }

  function checkPath(uri) {
    if (!visible(uri)) throw new SourceError('outside_roots', 'The path is outside the visible configured roots.', 400);
  }

  async function list(uri, recursive = false, budget = null) {
    const entries = new Map();
    const deadline = Date.now() + timeoutMs;
    let offset = 0;
    while (true) {
      if (budget && budget.remaining === 0) {
        budget.partial = true;
        break;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new SourceError('timeout', 'OpenViking list: the request timed out.', 504);
      const q = new URLSearchParams({
        uri, recursive: String(recursive), output: 'original', limit: String(PAGE_SIZE),
        offset: String(offset), sort_by: 'name', sort_order: 'asc', include_abstract: String(!recursive),
      });
      if (budget) budget.remaining -= 1;
      const json = await call(`/api/v1/fs/ls?${q}`, { what: 'OpenViking list', timeoutMs: remaining });
      if (!Array.isArray(json.result)) throw new SourceError('bad_reply', 'OpenViking list: the reply has no entry array.');
      const before = entries.size;
      for (const entry of json.result) {
        if (typeof entry?.uri === 'string') entries.set(entry.uri, entry);
      }
      if (!json.has_more) break;
      if (entries.size === before) throw new SourceError('bad_reply', 'OpenViking list: paging made no progress.');
      // The server offset counts all entries, including directories and hidden files.
      offset += json.result.length;
    }
    return [...entries.values()].filter((entry) => visible(entry.uri, uri));
  }

  function rootOf(uri) {
    return roots.find((r) => under(uri, r.uri)) ?? roots[0];
  }

  function relative(uri) {
    const r = rootOf(uri);
    return uri.startsWith(r.uri) ? uri.slice(r.uri.length) : uri;
  }

  function fileItem(entry, extra = {}) {
    const rel = relative(entry.uri);
    const parts = rel.split('/');
    const name = parts.pop().replace(/\.md$/, '');
    return makeItem(cfg.id, {
      id: entry.uri,
      title: humanize(name),
      snippet: truncate(unprivate(extra.snippet ?? cleanAbstract(entry.abstract)), 220),
      scope: parts.join(' / ') || rootOf(entry.uri).label,
      kind: parts[0] ?? 'memory',
      date: entry.modTime,
      dateLabel: entry.modTime ? 'modified' : '',
      score: extra.score,
    });
  }

  let tree = null;
  let treeAt = 0;
  let treePending = null;
  async function listAll() {
    if (tree && Date.now() - treeAt < (cfg.refreshSeconds ?? 60) * 1000) return tree;
    treePending ??= walkTree().finally(() => { treePending = null; });
    return treePending;
  }

  async function walkTree() {
    const files = new Map();
    const rootUris = new Set(roots.map((root) => root.uri));
    const scheduled = new Set(rootUris);
    const pending = [...scheduled];
    const budget = { remaining: MAX_TREE_CALLS, partial: false };
    for (let i = 0; i < pending.length; i += 1) {
      if (budget.remaining === 0) {
        budget.partial = true;
        break;
      }
      const uri = pending[i];
      let entries;
      try {
        entries = await list(uri, true, budget);
      } catch (err) {
        if (err?.code === 'not_found' && !rootUris.has(uri)) continue;
        throw err;
      }
      let deepest = 0;
      const directories = [];
      for (const entry of entries) {
        if (memoryFile(entry)) files.set(entry.uri, entry);
        if (!entry.isDir) continue;
        const path = entry.uri.replace(/\/$/, '') + '/';
        if (path === uri) continue;
        const depth = path.slice(uri.length).split('/').length - 1;
        deepest = Math.max(deepest, depth);
        directories.push({ path, depth });
      }
      if (budget.partial) break;
      // Shallower directories are complete; only the server's depth cap can hide children.
      if (deepest < RECURSIVE_DEPTH) continue;
      for (const { path, depth } of directories) {
        if (depth !== deepest || scheduled.has(path)) continue;
        scheduled.add(path);
        pending.push(path);
      }
    }
    tree = {
      files: [...files.values()],
      note: budget.partial ? `Partial count: the refresh stopped after ${MAX_TREE_CALLS} list calls. More files may exist.` : '',
    };
    treeAt = Date.now();
    return tree;
  }

  return {
    id: cfg.id,
    type: 'openviking',
    name: cfg.name ?? SOURCE_TYPES.openviking.name,
    unit: SOURCE_TYPES.openviking.unit,
    mode: 'live',
    lazy: false,
    description: cfg.description ?? 'Memory files of OpenViking: profile, preferences, entities, events and cases.',

    async status() {
      for (const root of roots) {
        await call(`/api/v1/fs/stat?${new URLSearchParams({ uri: root.uri })}`, { what: 'OpenViking stat' });
      }
      return { state: 'ok', detail: `${roots.length} root(s)` };
    },

    async overview() {
      const { files, note } = await listAll();
      const counts = new Map();
      let newest = null;
      for (const f of files) {
        const r = rootOf(f.uri);
        const first = relative(f.uri).split('/');
        const key = first.length > 1 ? `${r.uri}${first[0]}/` : r.uri;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        if (f.modTime && (!newest || f.modTime > newest)) newest = f.modTime;
      }
      return {
        total: files.length,
        newest,
        note,
        facets: Array.from(counts, ([path, count]) => ({ path, label: labelOf(path, roots), count }))
          .sort((a, b) => b.count - a.count),
      };
    },

    async browse({ path = '', offset = 0 } = {}) {
      if (!path) {
        return {
          path: '',
          crumbs: [{ path: '', label: 'All' }],
          folders: roots.map((r) => ({ path: r.uri, label: r.label })),
          items: [],
          total: 0,
          offset: 0,
          more: false,
        };
      }
      checkPath(path);
      const uri = path.endsWith('/') ? path : `${path}/`;
      const entries = await list(uri);
      const folders = entries.filter((e) => e.isDir)
        .map((e) => ({ path: e.uri.endsWith('/') ? e.uri : `${e.uri}/`, label: e.name ?? relative(e.uri) }))
        .sort((a, b) => a.label.localeCompare(b.label));
      const files = entries.filter((e) => memoryFile(e))
        .sort((a, b) => String(b.modTime).localeCompare(String(a.modTime)));
      const start = Number.isFinite(Number(offset)) ? Math.max(0, Math.floor(Number(offset))) : 0;
      return {
        path: uri,
        crumbs: crumbsOf(uri, roots),
        folders,
        items: files.slice(start, start + 200).map((e) => fileItem(e)),
        total: files.length,
        offset: start,
        more: start + 200 < files.length,
      };
    },

    async search(query, { limit = 20, path = '' } = {}) {
      if (path) checkPath(path);
      const targets = path ? [path.endsWith('/') ? path : `${path}/`] : roots.map((root) => root.uri);
      const items = new Map();
      let note = '';
      try {
        for (const target of targets) {
          const json = await call('/api/v1/search/find', {
            method: 'POST',
            what: 'OpenViking find',
            body: { query, target_uri: target, limit, context_type: 'memory', level: [2] },
          });
          const r = json.result;
          if (!Array.isArray(r?.memories) || ['resources', 'skills'].some((key) => key in r && !Array.isArray(r[key]))) {
            throw new SourceError('bad_reply', 'OpenViking find: the reply has no valid result arrays.');
          }
          for (const hit of [...r.memories, ...(r.resources ?? []), ...(r.skills ?? [])]) {
            if (!memoryFile(hit, target)) continue;
            const item = fileItem(hit, { score: hit.score, snippet: cleanAbstract(hit.abstract) });
            if (!items.has(hit.uri) || item.score > items.get(hit.uri).score) items.set(hit.uri, item);
          }
        }
        note = 'Semantic search (OpenViking find).';
      } catch (err) {
        if (!FALLBACK_ERRORS.has(err.code)) throw err;
        note = 'Semantic search failed. These results come from the keyword fallback (OpenViking grep).';
        items.clear();
        const times = new Map((tree?.files ?? []).map((f) => [f.uri, f.modTime]));
        const pattern = escapeRegex(String(query).trim().slice(0, 200));
        for (const target of targets) {
          const json = await call('/api/v1/search/grep', {
            method: 'POST',
            what: 'OpenViking grep',
            body: { pattern, uri: target, case_insensitive: true, node_limit: 5000 },
          });
          if (!Array.isArray(json.result?.matches)) {
            throw new SourceError('bad_reply', 'OpenViking grep: the reply has no match array.');
          }
          const byUri = new Map();
          for (const m of json.result.matches) {
            if (!memoryFile(m, target)) continue;
            const hit = byUri.get(m.uri) ?? { uri: m.uri, lines: [] };
            hit.lines.push(m.content);
            byUri.set(m.uri, hit);
          }
          for (const hit of byUri.values()) {
            const text = hit.lines.join(' ');
            items.set(hit.uri, fileItem({ uri: hit.uri, modTime: times.get(hit.uri) }, {
              score: scoreText(query, hit.uri, text) || hit.lines.length,
              snippet: text,
            }));
          }
        }
      }
      const ranked = [...items.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      return { total: ranked.length, items: ranked.slice(0, limit), note };
    },

    async recent(limit = 10) {
      const { files } = await listAll();
      return files.slice().sort((a, b) => String(b.modTime).localeCompare(String(a.modTime)))
        .slice(0, limit).map((e) => fileItem(e));
    },

    async get(uri) {
      if (!memoryFile({ uri })) return null;
      const q = new URLSearchParams({ uri });
      const [stat, content] = await Promise.all([
        call(`/api/v1/fs/stat?${q}`, { what: 'OpenViking stat' }),
        call(`/api/v1/content/read?${q}`, { what: 'OpenViking read' }),
      ]);
      const s = stat.result ?? {};
      const body = typeof content.result === 'string' ? content.result : JSON.stringify(content.result, null, 2);
      const item = fileItem({ uri, modTime: s.modTime }, { snippet: titleFrom(unprivate(body), 220) });
      return {
        item,
        body,
        format: 'markdown',
        meta: [
          ['URI', uri],
          ['Modified', s.modTime ?? 'not known'],
          ['Size', s.size !== undefined ? `${s.size} bytes` : 'not known'],
          ['Record id', s.id ?? 'not known'],
          ['Privacy placeholders', String((body.match(PRIVACY) ?? []).length)],
        ],
        native: uri,
      };
    },
  };
}

function unprivate(text) {
  return String(text ?? '').replace(PRIVACY, '‹private›');
}

function cleanAbstract(text) {
  const t = unprivate(text);
  if (/abstract is not ready/i.test(t)) return '';
  return truncate(t.replace(/^#\s+viking:\/\/\S+\s*/, ''), 220);
}

function humanize(name) {
  return name.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() || name;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function canonicalUri(uri) {
  if (typeof uri !== 'string' || !/^viking:\/\/(user|agent|resources)\//.test(uri)) return false;
  if (/[\\%?#{}\x00-\x1f\x7f]/.test(uri)) return false;
  const parts = uri.slice('viking://'.length).replace(/\/$/, '').split('/');
  return parts.every((part) => part && part !== '.' && part !== '..');
}

function under(uri, root) {
  return uri === root.replace(/\/$/, '') || uri.startsWith(root.endsWith('/') ? root : `${root}/`);
}

function labelOf(path, roots) {
  const root = roots.find((r) => path.startsWith(r.uri));
  if (!root) return path;
  const rest = path.slice(root.uri.length).replace(/\/$/, '');
  return rest ? (roots.length > 1 ? `${root.label} / ${rest}` : rest) : `${root.label} (top level)`;
}

function crumbsOf(uri, roots) {
  const root = roots.find((r) => uri.startsWith(r.uri));
  const out = [{ path: '', label: 'All' }];
  if (!root) return out;
  out.push({ path: root.uri, label: root.label });
  let acc = root.uri;
  for (const part of uri.slice(root.uri.length).split('/').filter(Boolean)) {
    acc += `${part}/`;
    out.push({ path: acc, label: part });
  }
  return out;
}
