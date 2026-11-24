// AgentCore long-term records. Only an opened namespace or a selected search reads AWS.
// Credentials resolve lazily through the person profile and its credential_process.
import { BedrockAgentCoreClient, ListMemoryRecordsCommand, RetrieveMemoryRecordsCommand } from '@aws-sdk/client-bedrock-agentcore';
import { fromIni } from '@aws-sdk/credential-provider-ini';
import { resolveNamespaces } from '../agentcore-scope.mjs';
import { makeItem, SourceError, titleFrom, toIso, truncate } from '../model.mjs';
import { createReviewer, DECISIONS, SECTION_ORDER, sectionOf, targetOf } from './agentcore-review.mjs';
import { SOURCE_TYPES } from './base.mjs';

const PAGE = 100;
// AWS can list a moved record at its old place for a short time. During this time each
// browse of the two namespaces reads AWS again, and the moved record stays out of its old list.
const SETTLE_MS = 120_000;

export function create(cfg, { clientFactory, reviewClientFactory, now = Date.now } = {}) {
  if (typeof cfg.memoryId !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(cfg.memoryId)
      || typeof cfg.region !== 'string' || cfg.region.length > 32 || !/^[a-z]{2}(?:-[a-z]+)+-[0-9]+$/.test(cfg.region)
      || typeof cfg.profile !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(cfg.profile)) {
    throw new SourceError('config', 'Set memoryId, region and a person profile for AgentCore.', 503);
  }
  const maxPages = cfg.maxPages ?? 10;
  const timeoutMs = cfg.timeoutMs ?? 10_000;
  const refreshSeconds = cfg.refreshSeconds ?? 300;
  const maxSearchNamespaces = cfg.maxSearchNamespaces ?? 8;
  if (![maxPages, timeoutMs, maxSearchNamespaces].every((n) => Number.isSafeInteger(n) && n > 0)
      || timeoutMs > 2_147_483_647 || !Number.isFinite(refreshSeconds) || refreshSeconds < 0) {
    throw new SourceError('config', 'AgentCore read limits must be positive integers; refreshSeconds must be nonnegative.', 503);
  }
  if (cfg.preload !== undefined && typeof cfg.preload !== 'boolean') {
    throw new SourceError('config', 'The preload setting of AgentCore must be true or false.', 503);
  }
  const listed = resolveNamespaces(cfg);
  // A review source puts each namespace into a section: waiting, approved or rejected. A group of the configuration wins.
  const sectioned = cfg.review === undefined ? listed
    : listed.map((n) => (n.group === undefined && sectionOf(n.namespace) ? { ...n, group: sectionOf(n.namespace) } : n));
  // The namespaces of one group stand together: the review sections first and in their order, then each other group, then the rest.
  const groups = [...SECTION_ORDER, ...sectioned.map((n) => n.group).filter((g) => g !== undefined)];
  const rank = (n) => (n.group === undefined ? groups.length : groups.indexOf(n.group));
  const namespaces = sectioned.map((n, i) => ({ n, i })).sort((a, b) => rank(a.n) - rank(b.n) || a.i - b.i).map(({ n }) => n);
  // Only an explicit `review` setting gives the source its one write: the record move.
  const reviewer = cfg.review === undefined ? null : createReviewer(cfg, { clientFactory: reviewClientFactory, now });
  const cache = new Map();
  const searchCache = new Map();
  const queues = new Map();
  const loads = new Map();
  const moves = new Map();
  let client;

  // A list that was read inside the settle time of a move can be late. It is read once more after that time.
  function late(ns, entry) {
    const move = moves.get(ns);
    return Boolean(move && entry && entry.at < move.at + SETTLE_MS);
  }
  function settled(ns, records) {
    const move = moves.get(ns);
    if (!move) return records;
    const kept = move.out.size ? records.filter((r) => !move.out.has(r.memoryRecordId)) : records;
    if (now() >= move.at + SETTLE_MS) moves.delete(ns);
    return kept;
  }
  function markMove(ns, recordId) {
    const move = moves.get(ns) ?? { at: 0, out: new Set() };
    move.at = now();
    if (recordId) move.out.add(recordId);
    moves.set(ns, move);
  }

  function known(ns) { return namespaces.find((n) => n.namespace === ns); }
  function requireNamespace(ns) {
    const entry = known(ns);
    if (!entry) throw new SourceError('unknown_namespace', 'The namespace is not in the configuration.', 400);
    return entry;
  }
  // Zero forces each browse to reload, but keeps its latest records available to the reader.
  const fresh = (entry) => entry && (refreshSeconds === 0 || now() - entry.at < refreshSeconds * 1000);

  // AbortSignal alone cannot bound credential resolution or a client that ignores cancellation.
  async function send(command) {
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new SourceError('timeout', 'The AgentCore read exceeded its deadline.', 504));
        controller.abort();
      }, timeoutMs);
    });
    try {
      return await Promise.race([deadline, Promise.resolve().then(() => {
        if (!client) {
          // The default chain can fall through to host credentials when the named profile fails.
          const options = {
            region: cfg.region, profile: cfg.profile, credentials: fromIni({ profile: cfg.profile }),
            maxAttempts: 1, ignoreConfiguredEndpointUrls: true,
          };
          client = clientFactory ? clientFactory(cfg, options) : new BedrockAgentCoreClient(options);
        }
        return client.send(command, { abortSignal: controller.signal });
      })]);
    } finally {
      clearTimeout(timer);
    }
  }

  function readError(error) {
    if (error instanceof SourceError) return error;
    if (error?.name === 'AccessDeniedException' || error?.$metadata?.httpStatusCode === 403) {
      return new SourceError('denied', 'The service denied the namespace read.', 403);
    }
    if (error?.name === 'CredentialsProviderError') {
      return new SourceError('credentials', 'The person profile has no usable session. Check the explorer sign-in.');
    }
    return new SourceError('aws_failed', 'The AgentCore namespace read failed.');
  }

  function pageRecords(page) {
    const records = page?.memoryRecordSummaries === undefined ? [] : page.memoryRecordSummaries;
    if (!page || typeof page !== 'object' || Array.isArray(page) || !Array.isArray(records) || records.some((r) => !r
        || typeof r.memoryRecordId !== 'string' || !r.memoryRecordId || r.memoryRecordId.startsWith('sample-')
        || (r.content?.text !== undefined && typeof r.content.text !== 'string'))
        || (page.nextToken !== undefined && typeof page.nextToken !== 'string')) {
      throw new SourceError('aws_failed', 'The AgentCore namespace returned an invalid live record page.');
    }
    return records;
  }

  // Serialize reads of one namespace. A late list must not restore records after a search denial.
  function inNamespace(ns, task) {
    const previous = queues.get(ns) ?? Promise.resolve();
    const running = previous.then(task).catch((error) => {
      const safe = readError(error);
      cache.set(ns, { at: now(), records: [], pages: 0, partial: false, error: safe });
      searchCache.delete(ns);
      throw safe;
    });
    const settled = running.then(() => {}, () => {});
    queues.set(ns, settled);
    settled.then(() => { if (queues.get(ns) === settled) queues.delete(ns); });
    return running;
  }

  function load(ns) {
    if (loads.has(ns)) return loads.get(ns);
    const running = inNamespace(ns, async () => {
      const hit = cache.get(ns);
      if (refreshSeconds > 0 && fresh(hit) && !hit.error && !late(ns, hit)) return hit;
      const records = [];
      let token;
      let pages = 0;
      do {
        const out = await send(new ListMemoryRecordsCommand({
          memoryId: cfg.memoryId, namespace: ns, maxResults: PAGE, ...(token ? { nextToken: token } : {}),
        }));
        records.push(...pageRecords(out));
        token = out.nextToken;
        pages += 1;
      } while (token && pages < maxPages);
      const entry = { at: now(), records: settled(ns, records), partial: Boolean(token), pages };
      cache.set(ns, entry);
      searchCache.delete(ns);
      return entry;
    });
    loads.set(ns, running);
    running.then(() => loads.delete(ns), () => loads.delete(ns));
    return running;
  }

  // The decisions that the reader can take for a record of this namespace.
  function actionsOf(ns) {
    if (!reviewer) return [];
    return Object.keys(DECISIONS).filter((decision) => known(targetOf(ns, decision)));
  }

  // A record of a fresh list or search read. An unknown identifier never causes an AWS call.
  function cached(id) {
    const at = String(id).lastIndexOf('#');
    if (at < 1) return null;
    const ns = String(id).slice(0, at);
    const recordId = String(id).slice(at + 1);
    if (!known(ns)) return null;
    const entries = [searchCache.get(ns), cache.get(ns)].filter((entry) => fresh(entry) && !entry.error);
    const r = entries.flatMap((entry) => entry.records).find((record) => record.memoryRecordId === recordId);
    return r ? { r, ns } : null;
  }

  function itemOf(r, ns, score) {
    const text = r.content?.text ?? '';
    return makeItem(cfg.id, {
      id: `${ns}#${r.memoryRecordId}`,
      title: titleFrom(text), snippet: truncate(text, 220), scope: ns,
      kind: r.memoryStrategyId ?? 'record', date: r.timestamp ?? r.createdAt,
      dateLabel: r.timestamp ? 'event time' : 'created', score,
    });
  }

  function folder(n) {
    const entry = cache.get(n.namespace);
    const loaded = fresh(entry) && !entry.error;
    return {
      path: n.namespace, label: n.label, ...(n.group === undefined ? {} : { group: n.group }),
      count: loaded ? entry.records.length : undefined,
      state: entry?.error ? (entry.error.code === 'denied' ? 'denied' : 'failed')
        : loaded ? (entry.partial ? 'partial' : entry.records.length ? 'loaded' : 'empty') : 'unloaded',
      partial: loaded ? entry.partial : false,
      ...(entry?.error ? { error: { code: entry.error.code, message: entry.error.message } } : {}),
    };
  }

  function loadedItems() {
    const all = [];
    for (const [ns, entry] of cache) {
      if (fresh(entry) && !entry.error) for (const r of entry.records) all.push(itemOf(r, ns));
    }
    return all.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  }

  return {
    id: cfg.id, type: 'agentcore', name: cfg.name ?? SOURCE_TYPES.agentcore.name,
    unit: SOURCE_TYPES.agentcore.unit, mode: 'live', lazy: true,
    description: cfg.description ?? 'Long-term memory records of AgentCore. Records load when you open a namespace.',

    async status() {
      return { state: 'ok', detail: `${namespaces.length} namespace(s) configured, ${loadedItems().length} record(s) loaded` };
    },

    async overview() {
      const facets = namespaces.map(folder);
      const loaded = facets.filter((f) => f.count !== undefined);
      const partial = facets.some((f) => f.partial);
      return {
        total: loaded.length === facets.length && !partial ? loaded.reduce((sum, f) => sum + f.count, 0) : null,
        newest: loadedItems().find((item) => item.date)?.date ?? null,
        facets, partial,
        note: `${loaded.length} of ${facets.length} namespaces loaded. Open a namespace to load it.${partial ? ' Counts are partial.' : ''}`,
      };
    },

    async browse({ path = '', offset = 0 } = {}) {
      if (!path) {
        // With `preload`, the source root reads each namespace, so each folder shows its count.
        // A failed namespace keeps its own state and does not fail the root.
        if (cfg.preload === true) await Promise.all(namespaces.map((n) => load(n.namespace).catch(() => {})));
        return {
          path: '', crumbs: [{ path: '', label: 'All' }], folders: namespaces.map(folder),
          items: [], total: 0, offset: 0, more: false,
          note: cfg.preload === true ? 'The source root reads each namespace of the AWS account for its count.'
            : 'Each namespace loads when you open it. A load reads the AWS account.',
        };
      }
      const namespace = requireNamespace(path);
      const entry = await load(path);
      const items = entry.records.map((r) => itemOf(r, path)).sort((a, b) => String(b.date).localeCompare(String(a.date)));
      const start = Math.max(0, Math.floor(Number(offset) || 0));
      return {
        path, crumbs: [{ path: '', label: 'All' }, { path, label: namespace.label }], folders: [],
        items: items.slice(start, start + 200), total: items.length, offset: start, more: start + 200 < items.length,
        partial: entry.partial, pages: entry.pages, state: entry.partial ? 'partial' : items.length ? 'loaded' : 'empty',
        note: entry.partial ? `The read stopped after ${maxPages} pages. More records exist.` : `Loaded ${toIso(entry.at)}.`,
      };
    },

    async search(query, { limit = 20, path = '' } = {}) {
      const targets = path ? [requireNamespace(path)] : namespaces;
      const size = Math.max(1, Math.min(20, Math.floor(Number(limit) || 20)));
      const selected = targets.slice(0, maxSearchNamespaces);
      const results = await Promise.all(selected.map((n) => inNamespace(n.namespace, async () => {
        const out = await send(new RetrieveMemoryRecordsCommand({
          memoryId: cfg.memoryId, namespace: n.namespace,
          searchCriteria: { searchQuery: String(query).slice(0, 1000), topK: size }, maxResults: size,
        }));
        const records = settled(n.namespace, pageRecords(out));
        searchCache.set(n.namespace, { at: now(), records });
        if (cache.get(n.namespace)?.error) cache.delete(n.namespace);
        return { items: records.map((r) => itemOf(r, n.namespace, r.score)), partial: Boolean(out.nextToken) };
      }).catch((error) => ({ items: [], partial: true, error: { path: n.namespace, code: error.code, message: error.message } }))));
      const items = results.flatMap((r) => r.items).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      const errors = results.flatMap((r) => r.error ? [r.error] : []);
      const skipped = targets.length - selected.length;
      const partial = skipped > 0 || results.some((r) => r.partial);
      return {
        total: items.length, items: items.slice(0, size), partial, errors,
        note: `Semantic search (RetrieveMemoryRecords).${skipped ? ` ${skipped} namespace(s) not searched.` : ''}`
          + `${errors.length ? ` ${errors.length} namespace read(s) failed; other results remain available.` : ''}`
          + `${results.some((r) => r.partial && !r.error) ? ' More search results exist.' : ''}`,
      };
    },

    async recent(limit = 10) { return loadedItems().slice(0, limit); },

    // Detail reads use cached list or search records only. An unknown ID never causes an AWS call.
    async get(id) {
      const hit = cached(id);
      if (!hit) return null;
      const { r, ns } = hit;
      const meta = [
        ['Namespace', ns], ['Record id', r.memoryRecordId], ['Strategy', r.memoryStrategyId ?? 'not given'],
        ['Created', toIso(r.createdAt) ?? 'not given'], ['Event time', toIso(r.timestamp) ?? 'not given'],
        ['Namespaces', (r.namespaces ?? []).join(', ')],
      ];
      for (const [k, v] of Object.entries(r.metadata ?? {})) {
        meta.push([`metadata ${k}`, v?.stringValue ?? v?.numberValue ?? toIso(v?.dateTimeValue) ?? JSON.stringify(v)]);
      }
      const actions = actionsOf(ns);
      return {
        item: itemOf(r, ns), body: r.content?.text ?? '', format: 'text', meta, native: `${ns} ${r.memoryRecordId}`,
        ...(actions.length ? { actions } : {}),
      };
    },

    // Present only for a review source. The hub reads it as the review switch.
    ...(reviewer ? {
      async review(id, decision) {
        const hit = cached(id);
        if (!hit) throw new SourceError('not_found', 'The source has no loaded record with this id.', 404);
        if (!actionsOf(hit.ns).includes(decision)) {
          throw new SourceError('review_off', 'This record allows no such decision.', 403);
        }
        const target = targetOf(hit.ns, decision);
        await reviewer.move(hit.r, hit.ns, target);
        // The other loaded proposals stay readable, so the reader can decide the next one at once.
        for (const entries of [cache, searchCache]) {
          const entry = entries.get(hit.ns);
          if (entry?.records) entry.records = entry.records.filter((r) => r.memoryRecordId !== hit.r.memoryRecordId);
        }
        markMove(hit.ns, hit.r.memoryRecordId);
        // The target loads again at its next read.
        cache.delete(target);
        searchCache.delete(target);
        markMove(target);
        return { decision, from: hit.ns, to: target };
      },
    } : {}),
  };
}
