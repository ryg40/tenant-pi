// The adapter interface. Every source of the hub has these members:
//
//   id, type, name, mode ('live' | 'sample'), unit, description, lazy
//   status()            -> { state: 'ok' | 'error', detail, error? }
//   overview()          -> { total, newest, facets: [{ path, label, count }], note }
//   browse({ path, offset }) -> { path, crumbs, folders, items, total, offset, more, note }
//   search(query, { limit, path }) -> { total, items, note }
//   recent(limit)       -> [item]
//   get(id)             -> { item, body, format, meta, native } or null
//   warm()              -> optional: load the local index at start, in the background
//   overviewWithStatus() -> optional: { status, ov } from one index load attempt
//
// `lazy` is true when a read costs money or touches a remote account: the hub
// then does not read it for the global view until the reader asks.


export const SOURCE_TYPES = {
  openviking: { name: 'OpenViking', unit: 'memory file' },
  okknow: { name: 'okknow', unit: 'knowledge page' },
  llmwiki: { name: 'llm-wiki', unit: 'wiki page' },
  hermes: { name: 'hermes-memory', unit: 'memory entry' },
  agentcore: { name: 'AgentCore memory', unit: 'memory record' },
};

// An adapter over a LocalIndex: the sample sources and the file sources.
export function indexAdapter({ id, type, name, mode, description, index, facetDepth = 1, check }) {
  return {
    id,
    type,
    name: name ?? SOURCE_TYPES[type].name,
    unit: SOURCE_TYPES[type].unit,
    mode,
    description,
    lazy: false,
    async status() {
      if (check) await check();
      return index.status();
    },
    async overviewWithStatus() {
      if (check) await check();
      return index.overviewWithStatus(facetDepth);
    },
    overview: () => index.overview(facetDepth),
    browse: (opts) => index.browse(opts),
    search: (q, opts) => index.search(q, opts),
    recent: (n) => index.recent(n),
    get: (itemId) => index.get(itemId),
    warm: () => index.ensure(),
  };
}
