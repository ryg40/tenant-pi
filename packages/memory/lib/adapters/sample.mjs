// Sample mode: synthetic records for one source type, from sample/<type>.json.
// No credential, no file outside the app and no network call. Every item id
// starts with "sample-", and every API reply of the hub says mode "sample".

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LocalIndex } from '../localindex.mjs';
import { SourceError } from '../model.mjs';
import { indexAdapter, SOURCE_TYPES } from './base.mjs';

const SAMPLE_DIR = new URL('../../sample/', import.meta.url);

export function create(cfg) {
  const filename = cfg.fixture ?? `${cfg.type}.json`;
  if (typeof filename !== 'string' || !/^[a-z0-9][a-z0-9-]*\.json$/.test(filename)) {
    throw new SourceError('config', 'The sample fixture must be a JSON basename.');
  }
  const file = fileURLToPath(new URL(filename, SAMPLE_DIR));
  const fixture = JSON.parse(readFileSync(file, 'utf8'));
  for (const d of fixture.docs) {
    if (!String(d.id).startsWith('sample-')) throw new SourceError('config', 'Sample ids must start with sample-.');
  }
  const index = new LocalIndex({
    source: cfg.id,
    ttlMs: Number.POSITIVE_INFINITY,
    folderLabels: fixture.folderLabels ?? {},
    load: async () => fixture.docs.map((d) => ({ tags: [], meta: [], format: 'markdown', ...d })),
  });
  const adapter = indexAdapter({
    id: cfg.id,
    type: cfg.type,
    name: cfg.name ?? SOURCE_TYPES[cfg.type].name,
    mode: 'sample',
    description: fixture.description,
    index,
    facetDepth: fixture.facetDepth ?? 1,
  });
  return cfg.type === 'agentcore' ? lazySample(adapter, cfg, fixture) : adapter;
}

function lazySample(adapter, cfg, fixture) {
  const namespaces = new Map(Object.entries(fixture.folderLabels ?? {}).map(([namespace, label]) => [namespace, {
    label,
    index: new LocalIndex({
      source: cfg.id,
      ttlMs: Number.POSITIVE_INFINITY,
      load: async () => fixture.docs.filter((d) => d.folder[0] === namespace)
        .map((d) => ({ tags: [], meta: [], format: 'text', ...d, folder: [] })),
    }),
  }]));
  const getNamespace = (namespace) => {
    const entry = namespaces.get(namespace);
    if (!entry) throw new SourceError('unknown_namespace', '', 400);
    return entry;
  };
  const facets = () => Array.from(namespaces, ([path, { label, index }]) => ({
    path, label, count: index.docs?.length,
    state: index.docs === null ? 'unloaded' : index.docs.length ? 'loaded' : 'empty',
  }));
  const note = 'Synthetic records load when you open a namespace. No AWS request is sent.';
  return {
    ...adapter,
    lazy: true,
    warm: async () => {},
    status: async () => ({ state: 'ok', detail: note }),
    async overview() {
      const loaded = Array.from(namespaces.values()).filter(({ index }) => index.docs !== null);
      const summaries = await Promise.all(loaded.map(({ index }) => index.overview()));
      return {
        total: loaded.length === namespaces.size ? summaries.reduce((sum, s) => sum + s.total, 0) : null,
        newest: summaries.map((s) => s.newest).filter(Boolean).sort().at(-1) ?? null,
        facets: facets(),
        note,
      };
    },
    async browse({ path = '', offset = 0 } = {}) {
      if (!path) return { path, crumbs: [{ path: '', label: 'All' }], folders: facets(), items: [], total: 0, offset: 0, more: false, note };
      const { index, label } = getNamespace(path);
      const page = await index.browse({ offset });
      return { ...page, path, crumbs: [{ path: '', label: 'All' }, { path, label }], state: page.total ? 'loaded' : 'empty', note };
    },
    async search(query, { limit = 20, path = '' } = {}) {
      const targets = path ? [getNamespace(path)] : Array.from(namespaces.values());
      const results = await Promise.all(targets.map(({ index }) => index.search(query, { limit })));
      const items = results.flatMap((r) => r.items).sort((a, b) => b.score - a.score);
      const total = results.reduce((sum, r) => sum + r.total, 0);
      return { items: items.slice(0, limit), total, more: total > limit, note };
    },
    async recent(limit = 10) {
      const loaded = Array.from(namespaces.values()).filter(({ index }) => index.docs !== null);
      const results = await Promise.all(loaded.map(({ index }) => index.recent(limit)));
      return results.flat().sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, limit);
    },
    async get(id) {
      const doc = fixture.docs.find((d) => d.id === id);
      return doc ? getNamespace(doc.folder[0]).index.get(id) : null;
    },
  };
}
