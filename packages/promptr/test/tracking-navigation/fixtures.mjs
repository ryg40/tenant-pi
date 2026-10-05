// Shared fixtures for the tracking-navigation tests.
//
// The catalog port here is a *test double* of the catalog contract: it exists so
// these tests can prove the picker/preview/packet path without importing the
// real catalog. Its role table is deliberately trivial and must never be read
// as the product's workflow matrix.

export const REPO = { host: 'https://gitea.example.test', owner: 'owner', repo: 'promptr' };

/** Control/bidi bytes assembled at runtime so this file holds none of them. */
export const hostile = (label) =>
  `${String.fromCharCode(0x1b)}[31m${label}${String.fromCharCode(0x202e)}drowssap${String.fromCharCode(0x7f)}`;

export function issue(number, overrides = {}) {
  return {
    number,
    title: `Issue ${number} title`,
    state: 'open',
    milestone: { title: 'S3 — Projects' },
    labels: [{ name: 'enhancement' }],
    body: `body of ${number}`,
    updated_at: '2026-09-01T10:00:00Z',
    html_url: `https://evil.example/redirect/${number}`,
    ...overrides,
  };
}

/** Minimal Response-alike; `fetchJson` only uses ok/status/json. */
function reply(payload, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => payload };
}

/**
 * Recording fetch double. `routes` maps a substring of the path to a payload
 * or a function of (url, callIndex). Every call's URL and headers are kept so
 * tests can assert method-shape and that a token never leaks into output.
 */
export function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), headers: { ...(init?.headers ?? {}) } });
    for (const [needle, value] of Object.entries(routes)) {
      if (String(url).includes(needle)) {
        const payload = typeof value === 'function' ? value(String(url), calls.length - 1) : value;
        if (payload && payload.__error) throw new Error(payload.__error);
        if (payload && payload.__status) return reply(null, { ok: false, status: payload.__status });
        return reply(payload);
      }
    }
    return reply([]);
  };
  fn.calls = calls;
  return fn;
}

export function dependencyRead(overrides = {}) {
  return { status: 'complete', items: [], blockers: 0, reason: '', ...overrides };
}

export function detail(number, overrides = {}) {
  return {
    key: `${REPO.host}|${REPO.owner}|${REPO.repo}|#${number}`,
    repo: { ...REPO },
    number,
    url: `${REPO.host}/${REPO.owner}/${REPO.repo}/issues/${number}`,
    title: `Issue ${number} title`,
    body: `line one\nline two\n\nline four`,
    bodyTruncated: false,
    state: 'open',
    labels: ['enhancement'],
    milestone: 'S3 — Projects',
    updatedAt: '2026-09-01T10:00:00Z',
    fetchedAt: '2026-09-07T12:00:00Z',
    dependencies: dependencyRead(),
    ...overrides,
  };
}

export function tracked(number, overrides = {}) {
  return {
    number,
    title: `Issue ${number} title`,
    state: 'open',
    milestone: 'S3 — Projects',
    labels: [],
    url: '',
    ...overrides,
  };
}

export function page(items, overrides = {}) {
  return {
    repo: { ...REPO },
    page: 1,
    perPage: 25,
    items,
    hasMore: false,
    fetchedAt: '2026-09-07T12:00:00Z',
    ...overrides,
  };
}

/** Test-double catalog port matching the structural contract of the catalog. */
export function fixtureCatalog(overrides = {}) {
  return {
    listWorkflows: () => [
      { id: 'fixture-a', label: 'Fixture workflow A', description: 'test double, not a product workflow' },
      { id: 'fixture-b', label: 'Fixture workflow B', description: 'test double, not a product workflow' },
    ],
    listProviders: () => [
      { id: 'fixture-provider-1', label: 'Fixture provider 1', description: 'test double' },
      { id: 'fixture-provider-2', label: 'Fixture provider 2', description: 'test double' },
    ],
    expandWorkflow: (input) => ({
      ...(input.execution === undefined ? {} : { echoExecution: input.execution }),
      ok: true,
      value: {
        version: 1,
        template: input.template,
        provider: input.provider,
        roles: [
          { role: 'worker', provider: input.provider, model: 'fixture-model', thinking: 'medium', route: 'pi' },
          { role: 'coordinator', provider: input.provider, model: 'fixture-model', thinking: 'high', route: 'pi' },
        ],
        instructions: ['fixture instruction'],
        warnings: input.readiness === 'unknown' ? ['task readiness must be confirmed before execution'] : [],
      },
    }),
    ...overrides,
  };
}

/** Controller ports backed by plain values or functions, with call counts. */
export function fixturePorts({ pages = [], details = {}, catalog, now = () => '2026-09-07T12:34:56Z' } = {}) {
  const state = { listCalls: 0, detailCalls: 0 };
  const ports = {
    listPage: async (repo, pageNumber) => {
      state.listCalls += 1;
      const entry = typeof pages === 'function' ? pages(pageNumber, state.listCalls) : pages[pageNumber - 1];
      if (entry instanceof Error) throw entry;
      return entry ?? page([], { page: pageNumber });
    },
    loadDetail: async (repo, number) => {
      state.detailCalls += 1;
      const entry = typeof details === 'function' ? details(number, state.detailCalls) : details[number];
      if (entry instanceof Error) throw entry;
      return entry;
    },
    now,
    catalog,
  };
  ports.state = state;
  return ports;
}
