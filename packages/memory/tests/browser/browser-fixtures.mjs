// Browser-only response fixtures. The application never imports this module.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { LocalIndex } from '../../lib/localindex.mjs';

export async function browserFixtures() {
  const scenarios = JSON.parse(await readFile(new URL('./scenarios.json', import.meta.url), 'utf8'));
  const sources = scenarios.sources.map(({ fixture, ...source }) => source);
  const overview = [];
  const recent = [];
  const searches = {};
  const browse = {};
  const entries = {};
  for (const cfg of scenarios.sources) {
    const fixture = JSON.parse(await readFile(new URL(`../../sample/${cfg.fixture ?? `${cfg.type}.json`}`, import.meta.url), 'utf8'));
    const docs = fixture.docs.map((doc) => ({ tags: [], meta: [], format: 'markdown', ...doc }));
    const index = new LocalIndex({ source: cfg.id, load: async () => docs, folderLabels: fixture.folderLabels });
    const source = sources.find((entry) => entry.id === cfg.id);
    source.description = fixture.description;
    const namespaces = source.lazy ? scenarios.namespaces : [];
    overview.push({ ...source, state: 'ok', ...await index.overview(fixture.facetDepth),
      ...(source.lazy ? { facets: namespaces } : {}), ...scenarios.overview[cfg.id] });
    if (!source.lazy && scenarios.overview[cfg.id]?.state !== 'error') recent.push(...await index.recent(25));
    searches[cfg.id] = { ...source, state: 'ok', ...await index.search('gateway', { limit: 10 }), ...scenarios.search[cfg.id] };
    entries[cfg.id] = {};
    for (const doc of docs) entries[cfg.id][doc.id] = await index.get(doc.id);
    browse[cfg.id] = {};
    const paths = new Set(['', scenarios.emptyFolder, ...namespaces.map((folder) => folder.path)]);
    for (const doc of docs) {
      for (let depth = 1; depth <= doc.folder.length; depth += 1) paths.add(doc.folder.slice(0, depth).join('/'));
    }
    for (const path of paths) {
      let result = await index.browse({ path });
      if (source.lazy) {
        result = {
          path,
          crumbs: [{ path: '', label: 'All' }, ...(path ? [{ path, label: namespaces.find((folder) => folder.path === path)?.label ?? path }] : [])],
          folders: path ? [] : namespaces,
          items: path ? docs.filter((doc) => doc.folder[0] === path).map((doc) => index.item(doc)) : [],
          ...(path ? namespaces.find((folder) => folder.path === path) : {}),
          offset: 0, more: false,
        };
        result.total = result.items.length;
      }
      if (!path && !source.lazy) result.folders.push({ path: scenarios.emptyFolder, label: 'Empty sample folder', count: 0 });
      browse[cfg.id][path] = { ...result, ...scenarios.browse[`${cfg.id}/${path}`] };
    }
  }
  recent.sort((a, b) => b.date.localeCompare(a.date));
  return { scenarios, sources, overview, recent, searches, browse, entries };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(JSON.stringify(await browserFixtures()));
}
