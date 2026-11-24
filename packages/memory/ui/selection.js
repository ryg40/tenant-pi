// Request choices stay separate from the DOM so implicit reads can be tested.
export function searchSelection(sources, params) {
  const ids = params.s === undefined ? sources.filter((s) => !s.lazy).map((s) => s.id) : params.s.split(',');
  return sources.filter((s) => ids.includes(s.id)).map((s) => s.id);
}

export function searchRequest(sources, params) {
  const text = params.q?.trim() ?? '';
  const selected = searchSelection(sources, params);
  // An empty selection must not invoke the server's default source selection.
  return text && selected.length ? { q: text, sources: selected.join(','), limit: 10 } : null;
}

export function sourceSearchRequest(params) {
  return { q: params.q, path: params.path ?? '', limit: 100 };
}

export function browseRequest(params) {
  // A source root lists namespaces; only an explicit path can load one.
  // A scoped search uses its own request, never a preliminary namespace load.
  return { path: params.q ? '' : params.path ?? '', offset: params.q ? undefined : params.offset };
}

// The one write request of the page: a decision for a proposed record of a review source.
// The custom header and the JSON type are part of the server guard against requests of another site.
export function reviewRequest(sid, itemId, decision) {
  if (!['approve', 'reject'].includes(decision) || !sid || !itemId) return null;
  return {
    path: `api/sources/${encodeURIComponent(sid)}/review`,
    init: {
      method: 'POST', cache: 'no-store', credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Tenant-Memory-Action': 'review' },
      body: JSON.stringify({ id: itemId, decision }),
    },
  };
}
