// okknow: the OpenKnowledge (OK) knowledge base of the host.
//
// Access `http` (preferred): the MCP endpoint and the document API of the
// authenticated origin, with a Basic credential from a secret file.
//   - MCP tool `search` for search.
//   - MCP tool `exec` with exactly `ls -l '<dir>'` or the one counting pipe below.
//     The OK server itself allows only read commands; the adapter sends no other.
//   - GET /api/document?docName=<name> for one page.
// Access `files`: a read-only mount of the content directory, indexed in memory.
//   Use it only when the owner accepts that it bypasses the OK server.
//
// Never the unauthenticated container port: it has no attribution.

import { LocalIndex } from '../localindex.mjs';
import { exists, FileCache, walkMarkdown } from '../files.mjs';
import { readReply } from '../http-client.mjs';
import { makeItem, parseFrontMatter, SourceError, titleFrom, truncate } from '../model.mjs';
import { indexAdapter, SOURCE_TYPES } from './base.mjs';

const UNSAFE_PATH = /[^A-Za-z0-9._\-/ ]/;
const SKIP_DIRS = ['.ok', '.git', 'node_modules', '.pi', '.obsidian', 'assets'];
const COUNT_PIPE = 'find . -type f -name "*.md" | cut -d/ -f2 | sort | uniq -c';

function checkedPath(value, { root = false } = {}) {
  if (typeof value !== 'string' || UNSAFE_PATH.test(value) || value.startsWith('/') || value.startsWith('-')
    || value.split('/').includes('..') || (!root && (!value || value === '.'))) {
    throw new SourceError('bad_path', 'The path has characters that the app does not send.', 400);
  }
  return value.replace(/\/+$/, '');
}

export function create(cfg, ctx) {
  if (cfg.access === 'files') return createFiles(cfg);
  return createHttp(cfg, ctx);
}

// ---------------------------------------------------------------- files mode

function createFiles(cfg) {
  const cache = new FileCache();
  const index = new LocalIndex({
    source: cfg.id,
    ttlMs: (cfg.refreshSeconds ?? 120) * 1000,
    load: async () => {
      const skipped = { files: 0, directories: 0 };
      const files = await walkMarkdown(cfg.path, cfg.path, {
        skipDirs: SKIP_DIRS,
        onSkip: () => { skipped.directories += 1; },
      });
      const result = await cache.load(files.map((relative) => ({ root: cfg.path, relative })),
        ({ text, mtime, size, tooLarge }, { relative }) =>
          pageDoc(relative.replace(/\.mdx?$/i, ''), tooLarge ? '' : text, { mtime, size }), skipped);
      if (!result.docs.length && (skipped.files || skipped.directories)) throw new Error('No documents loaded.');
      return result;
    },
  });
  return indexAdapter({
    id: cfg.id,
    type: 'okknow',
    name: cfg.name,
    mode: 'live',
    description: cfg.description ?? 'Pages of the OpenKnowledge base (read-only file mount).',
    index,
    check: async () => {
      if (!(await exists(cfg.path))) throw new SourceError('not_mounted', 'The OpenKnowledge content is not mounted.');
    },
  });
}

function pageDoc(docName, text, { mtime, size } = {}) {
  const { meta, body } = parseFrontMatter(text);
  const folder = docName.split('/').slice(0, -1);
  const heading = body.match(/^#\s+(.+)$/m)?.[1];
  const date = meta.updated || meta.date || meta.created || mtime;
  return {
    id: docName,
    folder,
    title: meta.title || heading || docName.split('/').pop(),
    body,
    summary: meta.description || titleFrom(body.replace(/^#.*$/m, ''), 220),
    date: date instanceof Date ? date.toISOString() : date ? String(date) : null,
    dateLabel: meta.updated ? 'updated' : meta.created ? 'created' : mtime ? 'file time' : '',
    kind: meta.type || 'page',
    tags: Array.isArray(meta.tags) ? meta.tags : meta.tags ? [meta.tags] : [],
    scope: folder.join('/'),
    meta: [
      ['Document', docName],
      ...Object.entries(meta).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v)]),
      ...(mtime ? [['File time', mtime.toISOString()]] : []),
      ...(size !== undefined ? [['Size', `${size} bytes`]] : []),
    ],
    native: docName,
  };
}

// ----------------------------------------------------------------- http mode

function createHttp(cfg, { readSecret }) {
  let url;
  try { url = new URL(cfg.origin); } catch { /* The check below refuses an invalid origin. */ }
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`source ${cfg.id}: the origin must use https and contain only a host and optional port`);
  }
  const origin = url.origin;
  const timeoutMs = cfg.timeoutMs ?? 15_000;
  let auth;
  const authHeader = () => {
    if (!auth) {
      const pair = readSecret(cfg.credentialFile);
      if (!pair.includes(':')) throw new SourceError('credentials', 'The okknow credential file must hold user:password.');
      auth = 'Basic ' + Buffer.from(pair).toString('base64');
    }
    return auth;
  };

  async function http(method, p, body, headers = {}, read = async () => null) {
    const signal = AbortSignal.timeout(timeoutMs);
    let res;
    try {
      res = await fetch(origin + p, {
        method,
        headers: { Authorization: authHeader(), ...headers },
        body,
        redirect: 'error',
        signal,
      });
      if (res.status === 401 || res.status === 403) throw new SourceError('denied', 'okknow refused the credential.');
      if (!res.ok && !(method === 'GET' && res.status === 404)) {
        throw new SourceError('failed', `okknow: HTTP ${res.status}`);
      }
      return await read(res);
    } catch (err) {
      if (err instanceof SourceError) throw err;
      if (signal.aborted) throw new SourceError('timeout', `okknow took longer than ${timeoutMs} ms`, 504);
      throw new SourceError('unreachable', 'okknow is not reachable', 502);
    } finally {
      if (res?.body && !res.body.locked) await res.body.cancel().catch(() => {});
    }
  }

  async function mcp(tool, args) {
    let sid = null;
    let n = 0;
    const rpc = async (method, params, notify = false) => {
      const msg = { jsonrpc: '2.0', method, ...(params ? { params } : {}), ...(notify ? {} : { id: ++n }) };
      return http('POST', '/mcp', JSON.stringify(msg), {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(sid ? { 'mcp-session-id': sid } : {}),
      }, async (res) => {
        sid = res.headers.get('mcp-session-id') ?? sid;
        if (notify) return null;
        const reply = await rpcReply(res, msg.id);
        if (reply.error) throw new SourceError('failed', `okknow MCP ${method} failed.`);
        if (!reply.result || typeof reply.result !== 'object' || Array.isArray(reply.result)) {
          throw new SourceError('bad_reply', 'okknow MCP returned no result.');
        }
        return reply.result;
      });
    };
    try {
      await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'tenant-memory', version: '0.1.0' } });
      await rpc('notifications/initialized', null, true);
      const res = await rpc('tools/call', { name: tool, arguments: args });
      if (res.isError) throw new SourceError('failed', `okknow ${tool} failed.`);
      return res.structuredContent ?? { text: (res.content ?? []).map((c) => c.text ?? '').join('') };
    } finally {
      // DELETE closes the MCP session. It never deletes a knowledge page.
      if (sid) await http('DELETE', '/mcp', undefined, { 'mcp-session-id': sid }).catch(() => {});
    }
  }

  const ls = (dir) => mcp('exec', { command: `ls -l '${checkedPath(dir, { root: true }) || '.'}'` });

  let counts = null;
  let countsAt = 0;
  async function topCounts() {
    if (counts && Date.now() - countsAt < (cfg.refreshSeconds ?? 120) * 1000) return counts;
    const out = await mcp('exec', { command: COUNT_PIPE });
    counts = [];
    for (const line of String(out.text ?? '').split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\S.*)$/);
      if (m && !m[2].endsWith('.md') && !SKIP_DIRS.includes(m[2])) counts.push({ path: m[2], label: m[2], count: Number(m[1]) });
      else if (m && m[2].endsWith('.md')) counts.push({ path: '', label: 'Top level', count: Number(m[1]), file: true });
    }
    const top = counts.filter((c) => c.file).reduce((a, c) => a + c.count, 0);
    counts = counts.filter((c) => !c.file);
    if (top) counts.push({ path: '', label: 'Top level', count: top });
    counts.sort((a, b) => b.count - a.count);
    countsAt = Date.now();
    return counts;
  }

  function itemOf(docName, fields = {}) {
    const parts = docName.split('/');
    return makeItem(cfg.id, {
      id: docName,
      title: fields.title || parts.at(-1),
      snippet: fields.snippet ?? '',
      scope: parts.slice(0, -1).join('/'),
      kind: fields.kind || 'page',
      date: fields.date,
      dateLabel: fields.date ? fields.dateLabel ?? 'modified' : '',
      tags: fields.tags,
      score: fields.score,
    });
  }

  return {
    id: cfg.id,
    type: 'okknow',
    name: cfg.name ?? SOURCE_TYPES.okknow.name,
    unit: SOURCE_TYPES.okknow.unit,
    mode: 'live',
    lazy: false,
    description: cfg.description ?? 'Pages of the OpenKnowledge base: projects, inbox, research and the wiki mirror.',

    async status() {
      const out = await mcp('exec', { command: "ls -l '.'" });
      return { state: 'ok', detail: `${parseLs(out.text).length} top-level entries` };
    },

    async overview() {
      const facets = await topCounts();
      return { total: facets.reduce((a, f) => a + f.count, 0), newest: null, facets, note: 'okknow gives no single newest date.' };
    },

    async browse({ path: dir = '', offset = 0 } = {}) {
      dir = checkedPath(dir, { root: true });
      if (dir === '.') dir = '';
      const out = await ls(dir);
      const enriched = new Map((out.enrichedPaths ?? []).map((e) => [e.path, e]));
      const entries = parseLs(out.text);
      const prefix = dir ? `${dir.replace(/\/$/, '')}/` : '';
      const folders = entries.filter((e) => e.dir && !SKIP_DIRS.includes(e.name)).map((e) => {
        const p = prefix + e.name;
        const info = enriched.get(p);
        return { path: p, label: e.name, count: info?.recursiveMdCount !== undefined ? Number(info.recursiveMdCount) : undefined };
      });
      const files = entries.filter((e) => !e.dir && /\.mdx?$/.test(e.name)).map((e) => {
        const p = prefix + e.name;
        const info = enriched.get(p) ?? {};
        return itemOf(p.replace(/\.mdx?$/, ''), {
          title: info.title,
          date: e.date,
          kind: info.frontmatter?.type,
          tags: info.tags,
          snippet: info.frontmatter?.description ? truncate(info.frontmatter.description, 220) : '',
        });
      }).sort((a, b) => String(b.date).localeCompare(String(a.date)));
      const start = Math.max(0, Number(offset) || 0);
      const parts = dir ? dir.replace(/\/$/, '').split('/') : [];
      return {
        path: dir,
        crumbs: [{ path: '', label: 'All' }, ...parts.map((p, i) => ({ path: parts.slice(0, i + 1).join('/'), label: p }))],
        folders,
        items: files.slice(start, start + 200),
        total: files.length,
        offset: start,
        more: start + 200 < files.length,
      };
    },

    async search(query, { limit = 20, path = '' } = {}) {
      checkedPath(path, { root: true });
      const out = await mcp('search', { query: String(query), limit: Math.max(1, Math.min(Number(limit) || 20, 100)), scopes: ['page', 'content'] });
      const items = (out.results ?? []).filter((r) => r.docName).map((r) => itemOf(r.docName, {
        title: r.title,
        score: r.score,
        snippet: truncate(r.snippet ?? r.preview ?? '', 220),
      }));
      const note = out.ready === false ? 'The okknow index is still cold. The result can be incomplete.' : '';
      return { total: out.resultCount ?? items.length, items, note };
    },

    async recent(limit = 10) {
      // Each top-level folder names its newest page; the app reads those.
      const out = await ls('.');
      const newest = (out.enrichedPaths ?? []).map((e) => e.mostRecentMd)
        .filter((m) => m?.path && !SKIP_DIRS.includes(m.path.replace(/^\.\//, '').split('/')[0]));
      return newest.map((m) => itemOf(m.path.replace(/\.mdx?$/, ''), {
        title: m.title,
        date: m.updatedAt,
        dateLabel: 'updated',
      })).sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, limit);
    },

    async get(docName) {
      checkedPath(docName);
      const reply = await http('GET', `/api/document?docName=${encodeURIComponent(docName)}`, undefined, { Accept: 'application/json' }, async (res) => {
        if (res.status === 404) return null;
        return readReply(res, 'okknow read');
      });
      if (reply === null) return null;
      const { json } = reply;
      if (!json || json.docName !== docName) throw new SourceError('bad_reply', 'okknow answered for another document.');
      const doc = pageDoc(docName, json.content ?? '');
      return { item: itemOf(docName, { title: doc.title, kind: doc.kind, date: doc.date, tags: doc.tags }), body: doc.body, format: 'markdown', meta: doc.meta, native: docName };
    },
  };
}

function parseRpc(text) {
  try { return JSON.parse(text); } catch {
    throw new SourceError('bad_reply', 'okknow MCP returned invalid JSON.');
  }
}

async function rpcReply(res, id) {
  const matches = (reply) => reply?.jsonrpc === '2.0' && reply.id === id;
  if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const reply = parseRpc(await res.text());
    if (matches(reply)) return reply;
  } else if (res.body) {
    // SSE can stay open and interleave notifications with the requested reply.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        pending += decoder.decode(value, { stream: !done });
        let boundary;
        while ((boundary = /\r?\n\r?\n/.exec(pending))) {
          const event = pending.slice(0, boundary.index);
          pending = pending.slice(boundary.index + boundary[0].length);
          const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).replace(/^ /, '')).join('\n');
          if (!data) continue;
          const reply = parseRpc(data);
          if (matches(reply)) return reply;
        }
        if (done) break;
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  throw new SourceError('bad_reply', 'okknow MCP returned no matching reply.');
}

// Lines of `ls -l`: mode, links, user, group, size, month, day, time or year, name.
// A directory name ends with "/".
export function parseLs(text, now = new Date()) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const m = line.match(/^([d-][rwx-]{9})\s+\d+\s+\S+\s+\S+\s+(\d+)\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{1,2}:\d{2}|\d{4})\s+(.+)$/);
    if (!m) continue;
    const name = m[6].replace(/\/$/, '');
    if (name === '.' || name === '..') continue;
    out.push({ name, dir: m[1].startsWith('d') || m[6].endsWith('/'), size: Number(m[2]), date: lsDate(m[3], m[4], m[5], now) });
  }
  return out;
}

function lsDate(mon, day, timeOrYear, now) {
  const month = 'JanFebMarAprMayJunJulAugSepOctNovDec'.indexOf(mon) / 3;
  if (month < 0) return null;
  if (/^\d{4}$/.test(timeOrYear)) return new Date(Date.UTC(Number(timeOrYear), month, Number(day))).toISOString();
  const [h, min] = timeOrYear.split(':').map(Number);
  let d = new Date(Date.UTC(now.getUTCFullYear(), month, Number(day), h, min));
  if (d > now) d = new Date(Date.UTC(now.getUTCFullYear() - 1, month, Number(day), h, min));
  return d.toISOString();
}

export { pageDoc };
