import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPersistentTrackingLines, trackingFetchDisposition } from '../../dist/src/companion/spike.mjs';

const PROMPTR_REPO = { provider: 'gitea', host: 'https://git.example.com', owner: 'owner', repo: 'promptr' };
const OTHER_REPO = { ...PROMPTR_REPO, repo: 'example-repo' };
const snapshot = {
  version: 1,
  fetchedAt: '2026-09-14T00:00:00.000Z',
  repo: PROMPTR_REPO,
  overall: { open: 1, closed: 0, total: 1, progress: 0 },
  groups: [],
  openIssues: [{ number: 1, title: 'Promptr-only issue', state: 'open', milestone: '', labels: [], url: 'https://git.example.com/owner/promptr/issues/1', blockers: 0 }],
};

test('persistent unbound startup ignores a mismatched Promptr cache and renders init guidance without rewriting it', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptr-startup-scope-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'tracking.json');
  const raw = JSON.stringify(snapshot, null, 2);
  fs.writeFileSync(file, raw);
  const lines = loadPersistentTrackingLines(file, undefined, 'tracker unbound - run /promptr-tracker init');
  const rendered = lines.join('\n');
  assert.match(rendered, /tracker unbound/i);
  assert.match(rendered, /\/promptr-tracker init/);
  assert.doesNotMatch(rendered, /Promptr-only issue|owner\/promptr|#1/);
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
});

test('a completed tracking read is accepted only for the exact identity the live binding still names', () => {
  // The host re-resolves the effective binding from disk/env after the await;
  // this covers that decision against the identity that was asked for.
  const asked = { repo: PROMPTR_REPO, generation: 3 };
  const live = { generation: 3, dead: false };
  const resolves = (value) => () => value;

  assert.deepEqual(
    trackingFetchDisposition(asked, live, resolves({ ok: true, repo: PROMPTR_REPO, label: 'owner/promptr (project)' })),
    { accept: true },
    'same identity and generation stays usable',
  );
  // A same-identity binding refresh (legacy provider, trailing slash) is still the same session.
  assert.deepEqual(
    trackingFetchDisposition(asked, live,
      resolves({ ok: true, repo: { ...PROMPTR_REPO, provider: undefined, host: `${PROMPTR_REPO.host}/` }, label: 'owner/promptr (project)' })),
    { accept: true },
    'a same-identity refresh remains usable',
  );
  // Repository A's answer never lands under a binding that now names B.
  assert.equal(
    trackingFetchDisposition(asked, live, resolves({ ok: true, repo: OTHER_REPO, label: 'owner/example-repo (project)' })).accept,
    false, 'A is refused once B is bound');
  // The binding disappeared while the request was in flight.
  assert.equal(
    trackingFetchDisposition(asked, live, resolves({ ok: false, reason: 'tracker unbound - run /promptr-tracker init' })).accept,
    false, 'A is refused once unbound');
  // A terminally invalidated session refuses even its own identity.
  assert.equal(
    trackingFetchDisposition(asked, { generation: 3, dead: true }, resolves({ ok: true, repo: PROMPTR_REPO, label: 'A' })).accept,
    false, 'a dead session resumes nothing');
  assert.equal(
    trackingFetchDisposition(asked, { generation: 4, dead: false }, resolves({ ok: true, repo: PROMPTR_REPO, label: 'A' })).accept,
    false, 'a superseded generation is dropped');
});

test('persistent bound startup accepts only an exact repository cache', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptr-startup-bound-'));
  try {
    const file = path.join(dir, 'tracking.json');
    fs.writeFileSync(file, JSON.stringify(snapshot));
    assert.doesNotMatch(loadPersistentTrackingLines(file, OTHER_REPO, 'unused').join('\n'), /Promptr-only issue/);
    assert.match(loadPersistentTrackingLines(file, PROMPTR_REPO, 'unused').join('\n'), /owner\/promptr/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
