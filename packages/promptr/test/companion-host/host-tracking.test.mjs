// Host-side workboard glue: pure helpers and the injectable refresher.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createTrackingRefresher, gitHeaderLabel, invalidateTracking, newerSnapshot, parseAgentStatus, piHeaderLabel, requestFileName, pickTrackingRepo } from '../../dist/src/companion/host-tracking.mjs';
import { trackingFetchDisposition } from '../../dist/src/companion/spike.mjs';
import { REPO } from '../tracking-navigation/fixtures.mjs';
import { loadTrackingSnapshotForRepo, sameTrackingRepo } from '../../dist/src/tracking/cache.mjs';

function snap(fetchedAt, numbers = [1]) {
  return {
    version: 1,
    fetchedAt,
    repo: { ...REPO },
    overall: { open: numbers.length, closed: 0, total: numbers.length, progress: 0 },
    groups: [],
    openIssues: numbers.map((number) => ({
      number, title: `Issue ${number}`, state: 'open', milestone: '', labels: [], url: `${REPO.host}/x/${number}`, blockers: 0,
    })),
  };
}

test('cache identity requires exact provider, normalized host, owner and repo', () => {
  assert.equal(sameTrackingRepo({ ...REPO, provider: undefined, host: `${REPO.host}/` }, { ...REPO, provider: 'gitea' }), true);
  assert.equal(sameTrackingRepo({ ...REPO, provider: 'github' }, { ...REPO, provider: 'gitea' }), false);
  assert.equal(sameTrackingRepo({ ...REPO, owner: 'other' }, REPO), false);
  assert.equal(sameTrackingRepo({ ...REPO, repo: 'other' }, REPO), false);
  assert.equal(sameTrackingRepo({ ...REPO, host: 'https://other.example' }, REPO), false);
});

test('mismatched and unbound caches are ignored without changing the user file', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptr-cache-scope-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'tracking.json');
  const raw = JSON.stringify(snap('2026-09-07T10:00:00Z'), null, 2);
  fs.writeFileSync(file, raw);
  assert.equal(loadTrackingSnapshotForRepo(file, { ...REPO, repo: 'example-repo' }), undefined);
  assert.equal(loadTrackingSnapshotForRepo(file, undefined), undefined);
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
  assert.equal(loadTrackingSnapshotForRepo(file, REPO)?.repo.repo, REPO.repo);
});

test('newerSnapshot picks the later parseable stamp, keeps current on ties, drops unparseable', () => {
  const a = snap('2026-09-07T10:00:00Z');
  const b = snap('2026-09-07T11:00:00Z');
  const tie = snap('2026-09-07T10:00:00.000Z');
  const bad = snap('not a date');
  assert.equal(newerSnapshot(a, b), b);
  assert.equal(newerSnapshot(b, a), b);
  assert.equal(newerSnapshot(a, tie), a);
  assert.equal(newerSnapshot(a, bad), a);
  assert.equal(newerSnapshot(bad, a), a);
  assert.equal(newerSnapshot(undefined, a), a);
  assert.equal(newerSnapshot(a, undefined), a);
  assert.equal(newerSnapshot(undefined, bad), undefined);
  assert.equal(newerSnapshot(undefined, undefined), undefined);
});

test('parseAgentStatus reads Herdr pane JSON and falls back to unknown', () => {
  const json = (status) => JSON.stringify({ result: { pane: { agent_status: status } } });
  assert.equal(parseAgentStatus(json('idle')), 'idle');
  assert.equal(parseAgentStatus(json('working')), 'working');
  assert.equal(parseAgentStatus(json('blocked')), 'blocked');
  assert.equal(parseAgentStatus(json('done')), 'idle');
  assert.equal(parseAgentStatus(json('sleeping')), 'unknown');
  assert.equal(parseAgentStatus(json(42)), 'unknown');
  assert.equal(parseAgentStatus(JSON.stringify({ result: {} })), 'unknown');
  assert.equal(parseAgentStatus(JSON.stringify({ result: null })), 'unknown');
  assert.equal(parseAgentStatus('null'), 'unknown');
  assert.equal(parseAgentStatus('"idle"'), 'unknown');
  assert.equal(parseAgentStatus(''), 'unknown');
  assert.equal(parseAgentStatus('{garbage'), 'unknown');
});

test('header labels', () => {
  assert.equal(gitHeaderLabel({ ref: 'main', head: '9fcbee3abcdef', dirty: false }), 'main @9fcbee3');
  assert.equal(gitHeaderLabel({ ref: 'main', head: '9fcbee3abcdef', dirty: true }), 'main @9fcbee3*');
  assert.equal(gitHeaderLabel({ ref: '', head: '9fcbee3abcdef', dirty: false }), '@9fcbee3');
  assert.equal(gitHeaderLabel({ ref: '', head: 'abc', dirty: true }), '@abc*');
  assert.equal(piHeaderLabel('w8:p2', 'idle'), 'Pi w8:p2 idle');
  assert.equal(piHeaderLabel(undefined, 'idle'), 'Pi unbound');
  assert.equal(piHeaderLabel('', 'idle'), 'Pi unbound');
});

test('requestFileName', () => {
  assert.equal(requestFileName(1, '2030-01-01T12:34:56.789Z'), '1-20300101T123456Z.json');
  assert.equal(requestFileName(2, '2030-01-01T14:34:56+02:00'), '2-20300101T123456Z.json');
  assert.match(requestFileName(1, 'garbage'), /^1-[0-9TZ]*\.json$/);
});

function harness({ fetchImpl, cache } = {}) {
  const events = [];
  let stored = cache;
  const refresher = createTrackingRefresher({
    repo: { ...REPO },
    fetch: fetchImpl ?? (async () => snap('2026-09-07T12:00:00Z', [1, 2])),
    readCache: () => stored,
    writeCache: (s) => { stored = s; events.push(['write', s.fetchedAt]); },
    onBoard: (board, note) => events.push(['board', board.fetchedAt, note, board.openCount]),
    onClear: (note) => events.push(['clear', note]),
    onNote: (note) => events.push(['note', note]),
    now: () => 0,
  });
  return { refresher, events, cache: () => stored };
}

test('refresh success writes the cache and emits a board with an empty note', async () => {
  const h = harness();
  await h.refresher.refresh('start');
  assert.deepEqual(h.events, [
    ['note', 'refreshing…'],
    ['write', '2026-09-07T12:00:00Z'],
    ['board', '2026-09-07T12:00:00Z', '', 2],
  ]);
  assert.equal(h.cache().fetchedAt, '2026-09-07T12:00:00Z');
  assert.equal(h.refresher.current().fetchedAt, '2026-09-07T12:00:00Z');
});

test('refresh failure keeps the last board with an offline note', async () => {
  let fail = false;
  const h = harness({
    fetchImpl: async () => {
      if (fail) throw new Error('ECONNREFUSED 127.0.0.1:3000 while reading the issue list and more text than fits');
      return snap('2026-09-07T12:00:00Z', [1]);
    },
  });
  await h.refresher.refresh('start');
  fail = true;
  h.events.length = 0;
  await h.refresher.refresh('timer');
  assert.equal(h.events[0][0], 'note');
  assert.equal(h.events[1][0], 'board');
  assert.equal(h.events[1][1], '2026-09-07T12:00:00Z');
  assert.match(h.events[1][2], /^offline · ECONNREFUSED/);
  assert.ok(h.events[1][2].length <= 'offline · '.length + 60);
  assert.equal(h.events.some((e) => e[0] === 'write'), false);
});

test('refresh failure with nothing shown builds from the cache, else notes only', async () => {
  const cached = snap('2026-09-07T09:00:00Z', [5]);
  const h = harness({ fetchImpl: async () => { throw new Error('offline'); }, cache: cached });
  await h.refresher.refresh('start');
  assert.deepEqual(h.events, [['note', 'refreshing…'], ['board', '2026-09-07T09:00:00Z', 'offline · offline', 1]]);

  const bare = harness({ fetchImpl: async () => { throw new Error('offline'); } });
  await bare.refresher.refresh('start');
  assert.deepEqual(bare.events, [['note', 'refreshing…'], ['note', 'offline · offline']]);
  assert.equal(bare.refresher.current(), undefined);
});

test('binding invalidation clears shown state and disables fetch/cache fallback for timer and manual refreshes', async () => {
  let calls = 0;
  let invalid = false;
  const h = harness({
    cache: snap('2026-09-07T09:00:00Z', [99]),
    fetchImpl: async () => {
      calls += 1;
      return invalid ? invalidateTracking('tracker unbound - run /promptr-tracker init') : snap('2026-09-07T12:00:00Z', [1]);
    },
  });
  await h.refresher.refresh('start');
  invalid = true;
  h.events.length = 0;
  await h.refresher.refresh('timer');
  h.refresher.pollCache();
  await h.refresher.refresh('manual');
  assert.equal(calls, 2, 'disabled refreshes never fetch the old repository again');
  assert.equal(h.refresher.current(), undefined);
  assert.deepEqual(h.events, [
    ['note', 'refreshing…'],
    ['clear', 'tracker unbound - run /promptr-tracker init'],
  ]);
  assert.equal(h.events.some((event) => event[0] === 'board'), false, 'shown/cache board is never restored');
});

test('a successful A board followed by an effective B binding never falls back to A when B is offline', async () => {
  // A refreshed successfully, so `shown` holds A's board and an A
  // cache is on disk. The effective binding then becomes B. The host ends the
  // session terminally rather than switching in place, so B's offline failure
  // can never reach the generic refresher's `shown ?? cache` fallback and
  // repaint A under a B binding.
  let calls = 0;
  let reboundToB = false;
  const h = harness({
    cache: snap('2026-09-07T09:00:00Z', [99]),
    fetchImpl: async () => {
      calls += 1;
      // Once B is the effective binding the host fence refuses, it never
      // reaches the network for B, and B has no cache of its own.
      if (reboundToB) return invalidateTracking('tracker binding changed to owner/example-repo · tracking stopped — close and reopen the companion to track it');
      return snap('2026-09-07T12:00:00Z', [1, 2]);
    },
  });
  await h.refresher.refresh('start');
  assert.equal(h.refresher.current().fetchedAt, '2026-09-07T12:00:00Z', 'A is shown first');
  reboundToB = true;
  h.events.length = 0;
  await h.refresher.refresh('manual');
  assert.equal(h.refresher.current(), undefined, 'A is cleared, not retained as the B fallback');
  assert.equal(h.events.some((e) => e[0] === 'board'), false, 'no A board is emitted under the B binding');
  const [, clear] = h.events.find((e) => e[0] === 'clear') ?? [];
  assert.match(clear, /close and reopen the companion/i, 'reopen guidance is visible');
  // Timer, manual and cache polling all stay silent afterwards; the A cache
  // on disk must not be re-emitted for the new identity.
  h.events.length = 0;
  await h.refresher.refresh('timer');
  h.refresher.pollCache();
  await h.refresher.refresh('manual');
  assert.deepEqual(h.events, [], 'no timer/manual/cache path resurfaces A');
  assert.equal(calls, 2, 'the old repository is never fetched again');
  assert.equal(h.cache().fetchedAt, '2026-09-07T12:00:00Z', 'the cache file is left as it was, not rewritten');
});

test('the post-await disposition re-resolves the binding and refuses a stale A snapshot', () => {
  // Production wiring. The network answers with an ordinary A
  // snapshot; the decision to refuse comes from re-resolving the effective
  // binding after the await, not from the fetch pretending to invalidate.
  // Refreshes coalesce, so the in-memory session state still says A/0/false
  // here — exactly the case the earlier in-memory-only check let through.
  const asked = { repo: { ...REPO }, generation: 0 };
  const live = { generation: 0, dead: false };
  const resolves = (value) => () => value;

  const same = trackingFetchDisposition(asked, live, resolves({ ok: true, repo: { ...REPO }, label: 'A' }));
  assert.deepEqual(same, { accept: true }, 'a same-identity completion is still usable');
  // A legacy/normalized spelling of the same repository is the same identity.
  const normalized = trackingFetchDisposition(asked, live,
    resolves({ ok: true, repo: { ...REPO, provider: undefined, host: `${REPO.host}/` }, label: 'A' }));
  assert.deepEqual(normalized, { accept: true }, 'a same-identity refresh is not a change');

  const toB = trackingFetchDisposition(asked, live,
    resolves({ ok: true, repo: { ...REPO, repo: 'example-repo' }, label: 'owner/example-repo (project)' }));
  assert.equal(toB.accept, false, 'A is refused once the file names B');
  assert.match(toB.reason, /owner\/example-repo/);

  const toUnbound = trackingFetchDisposition(asked, live,
    resolves({ ok: false, reason: 'tracker unbound - run /promptr-tracker init' }));
  assert.equal(toUnbound.accept, false, 'A is refused once unbound');
  assert.match(toUnbound.reason, /tracker unbound/);

  // A session already ended terminally never re-reads the binding at all.
  let resolverCalls = 0;
  const dead = trackingFetchDisposition(asked, { generation: 0, dead: true }, () => {
    resolverCalls += 1;
    return { ok: true, repo: { ...REPO }, label: 'A' };
  });
  assert.equal(dead.accept, false, 'a dead session resumes nothing');
  assert.equal(trackingFetchDisposition(asked, { generation: 1, dead: false }, resolves({ ok: true, repo: { ...REPO }, label: 'A' })).accept, false,
    'a superseded generation is dropped');
  assert.equal(resolverCalls, 0, 'a finished session does not touch the binding again');
});

test('an in-flight A fetch released after the binding changed writes no cache and shows no board', async () => {
  // The same defect end-to-end through the refresher: A's request is held
  // open, the effective binding becomes B (and separately unbound), and only
  // then does the network hand back an ordinary A snapshot. The host's
  // post-await disposition turns that into invalidation, so nothing is
  // written and no A board is emitted.
  const cases = [
    [{ ok: false, reason: 'tracker unbound - run /promptr-tracker init' }, /tracker unbound/],
    [{ ok: true, repo: { ...REPO, repo: 'example-repo' }, label: 'owner/example-repo (project)' }, /owner\/example-repo/],
  ];
  for (const [effective, expected] of cases) {
    let release;
    const gate = new Promise((r) => { release = r; });
    // Session state stays A/0/false for the whole flight: the coalescing
    // refresher gives nothing else a chance to update it.
    const session = { generation: 0, dead: false };
    let changed = false;
    let deadReason = '';
    const h = harness({
      cache: snap('2026-09-07T09:00:00Z', [99]),
      fetchImpl: async () => {
        const asked = { repo: { ...REPO }, generation: session.generation };
        await gate;
        // The network returns an ordinary A snapshot, exactly as reads.fetch does.
        const stale = snap('2026-09-07T12:00:00Z', [1]);
        const disposition = trackingFetchDisposition(asked, session,
          () => (changed ? effective : { ok: true, repo: { ...REPO }, label: 'A' }));
        if (!disposition.accept) {
          // The single terminal path the host runs on refusal.
          session.dead = true;
          session.generation += 1;
          deadReason = `${disposition.reason} · tracking stopped — close and reopen the companion to track it`;
          return invalidateTracking(deadReason);
        }
        return stale;
      },
    });
    const pending = h.refresher.refresh('start');
    changed = true;
    release();
    await pending;
    assert.equal(h.events.some((e) => e[0] === 'write'), false, 'no cache write for the old repository');
    assert.equal(h.events.some((e) => e[0] === 'board'), false, 'no board emission for the old repository');
    assert.deepEqual(h.events, [['note', 'refreshing…'], ['clear', deadReason]]);
    assert.match(deadReason, expected);
    assert.match(deadReason, /close and reopen the companion/i, 'reopen guidance is visible');
    assert.equal(h.refresher.current(), undefined);
    assert.equal(h.cache().fetchedAt, '2026-09-07T09:00:00Z', 'the existing cache file is left as it was');
    // The session is terminal: later timer/manual/cache attempts stay silent.
    h.events.length = 0;
    await h.refresher.refresh('timer');
    h.refresher.pollCache();
    assert.deepEqual(h.events, [], 'a fenced-out session never resumes or falls back');
  }
});

test('concurrent refreshes coalesce into one fetch', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = harness({ fetchImpl: async () => { calls += 1; await gate; return snap('2026-09-07T12:00:00Z'); } });
  const p1 = h.refresher.refresh('start');
  const p2 = h.refresher.refresh('manual');
  assert.equal(p1, p2);
  release();
  await p1;
  assert.equal(calls, 1);
  await h.refresher.refresh('timer');
  assert.equal(calls, 2);
});

test('pollCache applies only newer snapshots', async () => {
  let stored = snap('2026-09-07T12:00:00Z', [1]);
  const events = [];
  const refresher = createTrackingRefresher({
    repo: { ...REPO },
    fetch: async () => snap('2026-09-07T12:00:00Z', [1]),
    readCache: () => stored,
    writeCache: () => {},
    onBoard: (board, note) => events.push([board.fetchedAt, note]),
    onClear: () => {},
    onNote: () => {},
    now: () => 0,
  });
  await refresher.refresh('start');
  events.length = 0;
  refresher.pollCache();
  assert.deepEqual(events, [], 'same stamp is not re-applied');
  stored = snap('2026-09-07T11:00:00Z', [9]);
  refresher.pollCache();
  assert.deepEqual(events, [], 'older cache is ignored');
  stored = snap('bad stamp', [9]);
  refresher.pollCache();
  assert.deepEqual(events, [], 'unparseable cache is ignored');
  stored = snap('2026-09-07T13:00:00Z', [9, 10]);
  refresher.pollCache();
  assert.deepEqual(events, [['2026-09-07T13:00:00Z', '']]);
  stored = undefined;
  refresher.pollCache();
  assert.deepEqual(events.length, 1, 'missing cache changes nothing');
});

test('pollCache seeds an empty refresher from the cache', () => {
  const h = harness({ cache: snap('2026-09-07T08:00:00Z', [3]) });
  h.refresher.pollCache();
  assert.deepEqual(h.events, [['board', '2026-09-07T08:00:00Z', '', 1]]);
});

test('pickTrackingRepo: the environment binding wins, the cached snapshot only fills a gap', () => {
  const env = { host: 'https://git.example.com', owner: 'owner', repo: 'promptr', provider: 'gitea' };
  const cached = { host: 'https://git.example.com', owner: 'owner', repo: 'promptr' };
  assert.deepEqual(pickTrackingRepo(env, cached), env);
  assert.deepEqual(pickTrackingRepo(undefined, cached), cached);
  assert.equal(pickTrackingRepo(undefined, undefined), undefined);
});
