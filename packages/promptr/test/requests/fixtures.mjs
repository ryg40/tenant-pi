// Shared fixtures for the requests tests: a fake packet and a fake fs.
import { REPO, dependencyRead } from '../tracking-navigation/fixtures.mjs';

export const DIR = '/fake/requests';

export function packet(number, overrides = {}) {
  return {
    version: 1,
    kind: 'generate-prompt-request',
    task: {
      repo: { ...REPO },
      number,
      url: `${REPO.host}/${REPO.owner}/${REPO.repo}/issues/${number}`,
      title: `Issue ${number} title`,
      body: 'body',
      bodyTruncated: false,
      state: 'open',
      labels: [],
      updatedAt: '2026-09-01T10:00:00Z',
      fetchedAt: '2026-09-07T12:00:00Z',
      dependencies: dependencyRead(),
    },
    workflow: { version: 1, template: 'fixture-a', provider: 'fixture-provider-1', roles: [], instructions: [], warnings: [] },
    createdAt: '2026-09-07T12:34:56Z',
    ...overrides,
  };
}

/** Fake fs: `files` maps basename → text (or undefined for unreadable). */
export function fakeFs(files, { missing = false } = {}) {
  return {
    list: (dir) => (missing || dir !== DIR ? [] : Object.keys(files)),
    read: (file) => {
      const name = file.slice(DIR.length + 1);
      return Object.hasOwn(files, name) ? files[name] : undefined;
    },
  };
}
