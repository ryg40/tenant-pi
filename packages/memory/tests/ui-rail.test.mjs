import assert from 'node:assert/strict';
import test from 'node:test';
import { ANCESTOR_READS, FolderTree, folderHref, memberLabel, pathParts, railEntries } from '../ui/rail.js';

const sources = [
  { id: 'ov-a', type: 'openviking', name: 'OpenViking · Sample One' },
  { id: 'wiki', type: 'llmwiki', name: 'llm-wiki' },
  { id: 'ov-b', type: 'openviking', name: 'OpenViking · Sample Two' },
  { id: 'other', type: 'sample-unknown', name: 'Sample other' },
];

test('OpenViking sources share one rail group; other kinds stay outside it', () => {
  const entries = railEntries(sources);
  const groups = entries.filter((entry) => entry.kind === 'group');
  assert.deepEqual(groups.map((group) => group.type), ['openviking']);
  assert.deepEqual(groups[0].members.map((member) => member.id), ['ov-a', 'ov-b']);
  assert.deepEqual(entries.filter((entry) => entry.kind === 'source').map((entry) => entry.source.id), ['wiki', 'other']);
});

test('a submenu item names the agent user, and a name of another form stays whole', () => {
  const [first, second] = railEntries(sources)[0].members;
  assert.notEqual(first.label, second.label);
  assert.equal(memberLabel({ id: 'ov-c', name: 'Team memory' }, 'OpenViking'), 'Team memory');
  assert.equal(memberLabel({ id: 'ov-d', name: 'OpenViking' }, 'OpenViking'), 'OpenViking');
  assert.equal(memberLabel({ id: 'ov-e' }, 'OpenViking'), 'ov-e');
});

const files = { id: 'sample-files', name: 'Sample files', lazy: false };
const lazy = { id: 'sample-aws', name: 'Sample AWS', lazy: true };
const nested = [{ path: '', label: 'All' }, { path: 'sample://top/', label: 'Root' }, { path: 'sample://top/a b/', label: 'a b' }];

// A source of folders f1/f2/…/f<depth>. `read` answers as the app does: one request fills one node.
function chainOf(depth) {
  const paths = Array.from({ length: depth }, (_, i) => `${Array.from({ length: i + 1 }, (_, j) => `f${j + 1}`).join('/')}/`);
  return { paths, crumbs: [{ path: '', label: 'All' }, ...paths.map((path) => ({ path, label: path }))] };
}

function reader(tree, source, exists) {
  const log = { sent: [], active: 0, most: 0 };
  log.read = (path) => tree.read(source, path, async (asked) => {
    log.sent.push(asked);
    log.most = Math.max(log.most, log.active += 1);
    await new Promise((done) => setImmediate(done));
    log.active -= 1;
    const child = exists.find((entry) => entry.startsWith(asked) && entry !== asked && !entry.slice(asked.length, -1).includes('/'));
    return { folders: child ? [{ path: child, label: child }] : [] };
  });
  return log;
}

test('the rail reads only the root of a lazy source', async () => {
  const tree = new FolderTree();
  tree.enter(lazy.id);
  assert.equal(tree.begin(lazy, '/sample/shared'), null);
  const log = reader(tree, lazy, []);
  assert.equal(await tree.walk(lazy, [{ path: '' }, { path: '/sample/deep' }], '/sample/deep/shared', log.read), 1);
  assert.deepEqual(log.sent, ['']);
});

test('the reads above a folder go from the root down, one at a time, and each level is read once', async () => {
  const tree = new FolderTree();
  tree.enter(files.id);
  const { paths, crumbs } = chainOf(4);
  const log = reader(tree, files, paths);
  await tree.walk(files, crumbs, paths[3], log.read);
  assert.deepEqual(log.sent, ['', ...paths.slice(0, 3)]);
  assert.equal(log.most, 1);
  assert.equal(await tree.walk(files, crumbs, paths[3], log.read), 0);
});

test('a path that does not exist gets no read below its first missing folder, and a long path stops at the cap', async () => {
  const { paths, crumbs } = chainOf(300);
  // The source names a crumb for each part of the path, but only the first two folders exist.
  const made = new FolderTree();
  made.enter(files.id);
  const short = reader(made, files, paths.slice(0, 2));
  await made.walk(files, crumbs, paths[299], short.read);
  assert.deepEqual(short.sent, ['', paths[0], paths[1]]);
  // Every folder exists: the walk still ends.
  const real = new FolderTree();
  real.enter(files.id);
  const long = reader(real, files, paths);
  assert.equal(await real.walk(files, crumbs, paths[299], long.read), ANCESTOR_READS);
  assert.equal(long.sent.length, ANCESTOR_READS);
});

test('a closed tree, a view that is gone and a failed level stop the reads above a folder', async () => {
  const { paths, crumbs } = chainOf(4);
  const closed = new FolderTree();
  const none = reader(closed, files, paths);
  await closed.walk(files, crumbs, paths[3], none.read);
  assert.deepEqual(none.sent, []);
  const gone = new FolderTree();
  gone.enter(files.id);
  const some = reader(gone, files, paths);
  await gone.walk(files, crumbs, paths[3], some.read, () => some.sent.length < 2);
  assert.equal(some.sent.length, 2);
  const failed = new FolderTree();
  failed.enter(files.id);
  const sent = [];
  await failed.walk(files, crumbs, paths[3], (path) => failed.read(files, path, async (asked) => { sent.push(asked); throw new Error('sample failure'); }));
  assert.deepEqual(sent, ['']);
  assert.equal(failed.node(files.id).state, 'error');
});

test('one read fills its node, and the reply of a read that the reader closed is dropped', async () => {
  const tree = new FolderTree();
  tree.pin(files.id);
  assert.equal(await tree.read(files, '', async () => ({ folders: [{ path: 'kept/', label: 'kept' }] })), true);
  assert.equal(tree.label(files.id, 'kept/'), 'kept');
  const late = tree.read(files, '', async () => ({ folders: [{ path: 'late/', label: 'late' }] }));
  tree.close(files.id);
  assert.equal(await late, false);
  assert.equal(tree.label(files.id, 'late/'), null);
  assert.equal(await tree.read(lazy, '/sample/shared', async () => assert.fail('a lazy source reads its root only')), false);
});

test('a folder link and each part of the path bar carry the whole path of their own folder', () => {
  const path = 'sample://top/a b/c&d?e#f/';
  const link = folderHref('sample files', path);
  assert.equal(new URLSearchParams(link.slice(link.indexOf('?') + 1)).get('path'), path);
  assert.equal(decodeURIComponent(link.slice('#/source/'.length, link.indexOf('?'))), 'sample files');
  assert.deepEqual(pathParts(files, nested, 'sample://top/a b/').map((part) => part.path), ['', 'sample://top/', 'sample://top/a b/']);
  // A refused namespace has no crumb of its own. It still becomes the last part, with the label of its folder.
  const parts = pathParts(lazy, [{ path: '', label: 'All' }], '/sample/shared', () => 'Shared');
  assert.deepEqual(parts.at(-1), { path: '/sample/shared', label: 'Shared' });
});

test('a folder reply counts only for the newest read of a tree that is still open', () => {
  const tree = new FolderTree();
  tree.pin(files.id);
  const closed = tree.begin(files, '');
  tree.close(files.id);
  assert.equal(tree.settle(files.id, '', closed, { folders: [{ path: 'late', label: 'late' }] }), false);
  assert.deepEqual(tree.node(files.id).folders, []);
  const first = tree.begin(files, '');
  const second = tree.begin(files, '');
  assert.equal(tree.settle(files.id, '', first, { folders: [{ path: 'old', label: 'old' }] }), false);
  assert.equal(tree.settle(files.id, '', second, { folders: [{ path: 'new', label: 'new' }] }), true);
  assert.equal(tree.label(files.id, 'new'), 'new');
});
