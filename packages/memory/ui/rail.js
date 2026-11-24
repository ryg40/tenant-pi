// The provider rail. Each provider has one entry. Every source of a grouped
// kind shares the entry of its provider and gets one submenu item.
// The entries come from the source list of the API (type and name), so a new
// agent user appears without a change here.

export const PROVIDERS = {
  openviking: { label: 'OpenViking', logo: 'logo-openviking.svg', grouped: true },
  okknow: { label: 'okknow', logo: 'logo-okknow.svg' },
  llmwiki: { label: 'llm-wiki', logo: 'logo-llmwiki.svg' },
  hermes: { label: 'hermes-memory', logo: 'logo-hermes.svg' },
  agentcore: { label: 'AgentCore memory', logo: 'logo-agentcore.svg' },
};

// "OpenViking · Alice" names the agent user after the provider. A name
// without that form stays whole, so no source loses its label.
export function memberLabel(source, providerLabel) {
  const name = String(source.name ?? '').trim();
  const lead = name.slice(0, providerLabel.length).toLowerCase() === providerLabel.toLowerCase()
    ? name.slice(providerLabel.length).match(/^\s*[·:|/–—-]\s*(\S.*)$/) : null;
  return lead?.[1] ?? (name || source.id);
}

export function railEntries(sources) {
  const entries = [];
  const groups = new Map();
  for (const source of sources) {
    const provider = PROVIDERS[source.type];
    if (!provider?.grouped) {
      entries.push({ kind: 'source', type: source.type, label: source.name || source.id, logo: provider?.logo ?? null, source });
      continue;
    }
    if (!groups.has(source.type)) {
      groups.set(source.type, { kind: 'group', type: source.type, label: provider.label, logo: provider.logo, members: [] });
      entries.push(groups.get(source.type));
    }
    groups.get(source.type).members.push({ id: source.id, label: memberLabel(source, provider.label), source });
  }
  return entries;
}

// ----- folders in the rail -----
// The folder tree of a source sits under its rail entry. One node holds the
// reply of one browse request. No part of this section touches the DOM, so
// the choice of requests and the links can be tested.

export function folderHref(sourceId, path = '') {
  const base = `#/source/${encodeURIComponent(sourceId)}`;
  return path ? `${base}?${new URLSearchParams({ path })}` : base;
}

// The parts of the path bar. The source stands for the root. Each part keeps
// the path of its own folder. A current path that the crumbs do not end with
// (a refused namespace, a scoped search) becomes the last part.
export function pathParts(source, crumbs, path = '', labelOf = () => null) {
  const parts = [{ path: '', label: source.name || source.id }];
  for (const crumb of crumbs ?? []) if (crumb.path) parts.push({ path: crumb.path, label: crumb.label || crumb.path });
  if (path && parts.at(-1).path !== path) parts.push({ path, label: labelOf(path) ?? path });
  return parts;
}

// The most reads above the current folder for one view. The deepest path measured in a real
// tree has 9 levels above it; 12 covers it with a margin. A deeper path gets the next levels on
// the next view of it, because the levels that the tree holds cost no read.
export const ANCESTOR_READS = 12;

export class FolderTree {
  #sources = new Map();

  #of(id) {
    if (!this.#sources.has(id)) this.#sources.set(id, { open: null, nodes: new Map(), openPaths: new Set() });
    return this.#sources.get(id);
  }

  node(id, path = '') {
    const nodes = this.#of(id).nodes;
    if (!nodes.has(path)) nodes.set(path, { state: 'idle', folders: [], error: null, seq: 0 });
    return nodes.get(path);
  }

  isOpen(id) { return Boolean(this.#of(id).open); }
  // A level that waits for its first read shows closed: no read is on the way that could fill it.
  isPathOpen(id, path) { return this.#of(id).openPaths.has(path) && this.node(id, path).state !== 'idle'; }
  needsRead(id, path = '') { return ['idle', 'error'].includes(this.node(id, path).state); }

  // The route opens the tree of its source. A tree that an earlier route
  // opened closes; a tree that the reader opened stays.
  enter(id) {
    for (const [other, entry] of this.#sources) if (other !== id && entry.open === 'route') this.close(other);
    this.#of(id).open ??= 'route';
  }

  // The reader opens a tree with its control. Such a tree stays until the reader closes it.
  pin(id) { this.#of(id).open = 'reader'; }

  close(id) {
    const entry = this.#of(id);
    entry.open = null;
    for (const node of entry.nodes.values()) cancel(node);
  }

  expand(id, path) { this.#of(id).openPaths.add(path); }

  collapse(id, path) {
    this.#of(id).openPaths.delete(path);
    const seen = new Set();
    const below = (at) => {
      if (seen.has(at)) return;
      seen.add(at);
      const node = this.#of(id).nodes.get(at);
      if (!node) return;
      cancel(node);
      for (const folder of node.folders) below(folder.path);
    };
    below(path);
  }

  reveal(id, crumbs = []) {
    for (const crumb of crumbs) if (crumb.path) this.expand(id, crumb.path);
  }

  // A lazy source reads its root only. The root lists namespaces without a
  // read of AWS; a namespace loads only when the reader follows its link.
  mayRead(source, path = '') { return !source.lazy || path === ''; }

  // Returns the ticket of a new read, or null when the tree must not read.
  begin(source, path = '') {
    if (!this.mayRead(source, path)) return null;
    const node = this.node(source.id, path);
    node.state = 'loading';
    return ++node.seq;
  }

  // A reply counts only for the newest read of a node that is still shown.
  settle(id, path, ticket, reply) {
    if (this.node(id, path).seq !== ticket) return false;
    this.feed(id, path, reply);
    return true;
  }

  // One read of one node. `fetch` sends the request after the node shows as loading.
  // Returns true when the reply went into the tree.
  async read(source, path, fetch) {
    const ticket = this.begin(source, path);
    if (ticket === null) return false;
    let reply;
    try { reply = await fetch(path); } catch (error) { reply = { error }; }
    return this.settle(source.id, path, ticket, reply);
  }

  // A failed read keeps the folders of the last good read beside its message.
  feed(id, path, reply) {
    const node = this.node(id, path);
    node.seq += 1;
    node.error = reply.error ?? null;
    node.state = reply.error ? 'error' : 'ok';
    if (!reply.error) node.folders = reply.folders ?? [];
  }

  // The reads after the reply for the current folder: the root, then each folder above the
  // current one, from the top down and one after the other. `read` fills one node. The walk stops
  // at a level that does not list the next one as a folder (a path that does not exist gives no
  // read below its first missing part), at a failed read, at a closed tree, when `live` says that
  // the view is gone, and after ANCESTOR_READS reads. A level that the tree holds costs no read.
  async walk(source, crumbs = [], current = '', read, live = () => true) {
    if (!current) return 0;
    const chain = [...new Set(['', ...crumbs.map((crumb) => crumb.path).filter((path) => path && path !== current)])];
    let reads = 0;
    for (const [index, path] of chain.entries()) {
      if (!live() || !this.isOpen(source.id) || !this.mayRead(source, path)) break;
      const node = this.node(source.id, path);
      if (node.state !== 'ok') {
        if (reads === ANCESTOR_READS) break;
        reads += 1;
        await read(path);
      }
      const next = chain[index + 1] ?? current;
      if (node.state !== 'ok' || !node.folders.some((folder) => folder.path === next)) break;
    }
    return reads;
  }

  label(id, path) {
    for (const node of this.#of(id).nodes.values()) {
      const folder = node.folders.find((entry) => entry.path === path);
      if (folder) return folder.label;
    }
    return null;
  }
}

function cancel(node) {
  if (node.state !== 'loading') return;
  node.seq += 1;
  node.state = 'idle';
}
