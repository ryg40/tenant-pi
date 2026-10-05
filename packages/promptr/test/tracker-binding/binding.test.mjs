// Tracker binding: precedence, overlay env without tokens, remote inference, parse/serialize.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  bindingEnv, inferBindingFromRemote, parseTrackerBinding, resolveTrackerBinding, serializeTrackerBinding,
  trackerBindingFiles, bindingSourceSuffix, providerDefaultOwner,
} from '../../dist/src/tracking/binding.mjs';
import { loadTrackerBinding, writeTrackerBinding } from '../../dist/src/tracking/binding-io.mjs';

const NOW = '2026-09-08T10:00:00.000Z';
const gh = { version: 1, provider: 'github', host: 'https://github.com', owner: 'example-owner', repo: 'promptr', boundAt: NOW };
const gt = { version: 1, provider: 'gitea', host: 'https://git.example.com', owner: 'owner', repo: 'promptr', boundAt: NOW };
const text = (b) => serializeTrackerBinding(b);
const ENV = { GITEA_TOKEN: 'gitea-secret', GITHUB_TOKEN: 'github-secret' };

test('trackerBindingFiles places the project file under .promptr and the global file under the state root', () => {
  const f = trackerBindingFiles('/proj', '/agent/promptr');
  assert.equal(f.project, '/proj/.promptr/tracker.json');
  assert.equal(f.global, '/agent/promptr/tracker.json');
});

test('precedence: env wins over both files', () => {
  const r = resolveTrackerBinding({ ...ENV, PROMPTR_TRACKER: 'gitea' }, { project: text(gh), global: text(gh) }, 'git@github.com:x/y.git');
  assert.equal(r.source, 'env');
  assert.equal(r.resolution.ok, true);
  assert.equal(r.resolution.config.provider, 'gitea');
});

test('precedence: project file over global file', () => {
  const r = resolveTrackerBinding(ENV, { project: text(gh), global: text(gt) });
  assert.equal(r.source, 'project');
  assert.equal(r.resolution.config.provider, 'github');
  assert.equal(r.resolution.config.repo.owner, 'example-owner');
  assert.equal(r.resolution.config.tokenPresent, true);
  assert.equal(r.effectiveEnv.GITHUB_TOKEN, 'github-secret', 'tokens come from the real env');
});

test('precedence: global file over the remote', () => {
  const r = resolveTrackerBinding(ENV, { global: text(gt) }, 'git@github.com:o/r.git');
  assert.equal(r.source, 'global');
  assert.equal(r.resolution.config.provider, 'gitea');
});

test('recognized remote wins; unrelated cwd is unbound; only a promptr cwd keeps the historical fallback', () => {
  const r = resolveTrackerBinding(ENV, {}, 'https://github.com/o/r', '/work/example-repo');
  assert.equal(r.source, 'remote');
  assert.equal(r.resolution.config.provider, 'github');
  assert.equal(r.resolution.config.repo.owner, 'o');
  const d = resolveTrackerBinding(ENV, {}, 'https://forge.example/o/r.git', '/work/example-repo');
  assert.equal(d.source, 'unbound');
  assert.equal(d.resolution.ok, false);
  assert.match(d.resolution.reason, /tracker unbound/);
  const none = resolveTrackerBinding(ENV, {}, undefined, '/work/example-repo');
  assert.equal(none.source, 'unbound');
  assert.deepEqual(none.problems, []);
  const historical = resolveTrackerBinding(ENV, {}, undefined, '/work/promptr');
  assert.equal(historical.source, 'promptr-fallback');
  assert.equal(historical.resolution.config.repo.repo, 'promptr');
});

test('a corrupt project file falls through to the global file with one problems line', () => {
  const r = resolveTrackerBinding(ENV, { project: '{not json', global: text(gh) });
  assert.equal(r.source, 'global');
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /project tracker\.json ignored: not valid JSON/);
  const bad = resolveTrackerBinding(ENV, { project: JSON.stringify({ ...gh, provider: 'bitbucket' }) }, undefined, '/proj');
  assert.equal(bad.source, 'unbound');
  assert.match(bad.problems[0], /provider must be gitea or github/);
});

test('bindingEnv never carries a token and names the right variables', () => {
  const g = bindingEnv(gh);
  assert.deepEqual(g, { PROMPTR_TRACKER: 'github', GITHUB_HOST: 'https://github.com', GITHUB_OWNER: 'example-owner', GITHUB_REPO: 'promptr' });
  const withApi = bindingEnv({ ...gh, host: 'https://ghe.example/', apiOrigin: 'https://ghe.example/api/v3/' });
  assert.equal(withApi.GITHUB_API, 'https://ghe.example/api/v3');
  const t = bindingEnv(gt);
  assert.deepEqual(t, { PROMPTR_TRACKER: 'gitea', GITEA_HOST: 'https://git.example.com', GITEA_OWNER: 'owner', GITEA_REPO: 'promptr' });
  for (const env of [g, t, withApi]) assert.ok(!Object.keys(env).some((k) => /TOKEN/.test(k)));
});

test('inferBindingFromRemote recognises github.com, GITHUB_HOST, the Gitea host and nothing else', () => {
  assert.deepEqual(pick(inferBindingFromRemote('git@github.com:o/r.git', {}, NOW)), ['github', 'https://github.com', 'o', 'r']);
  assert.deepEqual(pick(inferBindingFromRemote('https://github.com/o/r', {}, NOW)), ['github', 'https://github.com', 'o', 'r']);
  assert.deepEqual(pick(inferBindingFromRemote('https://git.example.com/o/r.git', {}, NOW)), ['gitea', 'https://git.example.com', 'o', 'r']);
  assert.deepEqual(pick(inferBindingFromRemote('git@ghe.example:o/r.git', { GITHUB_HOST: 'https://ghe.example' }, NOW)), ['github', 'https://ghe.example', 'o', 'r']);
  assert.deepEqual(pick(inferBindingFromRemote('https://my-gitea.example/o/r', { GITEA_HOST: 'https://my-gitea.example' }, NOW)), ['gitea', 'https://my-gitea.example', 'o', 'r']);
  assert.equal(inferBindingFromRemote('https://forge.example/o/r', {}, NOW), undefined);
  assert.equal(inferBindingFromRemote(undefined, {}, NOW), undefined);
  assert.equal(inferBindingFromRemote('not a url', {}, NOW), undefined);
  function pick(b) { return b && [b.provider, b.host, b.owner, b.repo]; }
});

test('parse/serialize round trip, key order, and rejection of bad provider/host', () => {
  const s = serializeTrackerBinding({ ...gh, note: 'trial mirror' });
  assert.ok(s.endsWith('\n'));
  assert.deepEqual(Object.keys(JSON.parse(s)), ['version', 'provider', 'host', 'owner', 'repo', 'boundAt', 'note']);
  const back = parseTrackerBinding(s);
  assert.equal(back.ok, true);
  assert.deepEqual(back.binding, { ...gh, note: 'trial mirror' });
  assert.equal(parseTrackerBinding(undefined), undefined, 'missing file');
  assert.match(parseTrackerBinding(JSON.stringify({ ...gh, provider: 'gitlab' })).error, /provider/);
  assert.match(parseTrackerBinding(JSON.stringify({ ...gh, host: 'github.com' })).error, /host must be an http\(s\) origin/);
  assert.match(parseTrackerBinding(JSON.stringify({ ...gh, host: 'ftp://x' })).error, /host/);
  assert.match(parseTrackerBinding(JSON.stringify({ ...gh, version: 2 })).error, /version/);
  assert.match(parseTrackerBinding(JSON.stringify({ ...gh, owner: '../x' })).error, /owner\/repo/);
  assert.match(parseTrackerBinding('[]').error, /object/);
});

test('bindingSourceSuffix labels every non-env source', () => {
  assert.equal(bindingSourceSuffix('env'), '');
  assert.equal(bindingSourceSuffix('project'), '(project file)');
  assert.equal(bindingSourceSuffix('global'), '(global file)');
  assert.equal(bindingSourceSuffix('remote'), '(from origin remote)');
  assert.equal(bindingSourceSuffix('promptr-fallback'), '(Promptr project fallback)');
  assert.equal(bindingSourceSuffix('unbound'), '(unbound)');
});

function fakeDeps(files = {}, remote) {
  return {
    files,
    readFile: (f) => files[f],
    exists: (f) => f in files,
    writeFile: (f, t) => { files[f] = t; },
    gitRemote: () => remote,
    stateRoot: () => '/agent/promptr',
  };
}

test('loadTrackerBinding reads both files and the remote through injected deps', () => {
  const deps = fakeDeps({ '/agent/promptr/tracker.json': text(gt) }, 'git@github.com:o/r.git');
  const r = loadTrackerBinding('/proj', ENV, deps);
  assert.equal(r.source, 'global');
  assert.deepEqual(r.present, { project: false, global: true });
  assert.equal(r.gitRemote, 'git@github.com:o/r.git');
  assert.equal(r.files.project, '/proj/.promptr/tracker.json');
});

test('writeTrackerBinding refuses to clobber without force and writes with force', () => {
  const deps = fakeDeps({ '/proj/.promptr/tracker.json': text(gt) });
  const refused = writeTrackerBinding('/proj/.promptr/tracker.json', gh, { force: false }, deps);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /already exists\. Nothing was written/);
  assert.equal(deps.files['/proj/.promptr/tracker.json'], text(gt));
  const ok = writeTrackerBinding('/proj/.promptr/tracker.json', gh, { force: true }, deps);
  assert.equal(ok.ok, true);
  assert.equal(deps.files['/proj/.promptr/tracker.json'], text(gh));
  assert.ok(!deps.files['/proj/.promptr/tracker.json'].includes('secret'));
});

// ---- workstreams issue adapter follows the bound repository ----
import { buildRoutingIndex, defaultRoutingConfig, issueLocator } from '../../dist/src/project/workstreams.mjs';

test('workstreams issue locator and fallback URL follow the bound repository for both providers', () => {
  const ghRepo = { host: 'https://github.com', owner: 'example-owner', repo: 'promptr', provider: 'github' };
  const gtRepo = { host: 'https://git.example.com', owner: 'owner', repo: 'promptr', provider: 'gitea' };
  const projects = [{ slug: 'promptr-abc123', cwd: '/w/promptr', lastActivity: NOW }];
  const io = { readFile: () => undefined, realpath: (p) => p };
  const build = (repo) => buildRoutingIndex(projects, [
    { kind: 'issue', projectKey: 'promptr-abc123', issue: { number: 1, title: 'Tracker binding', state: 'closed' }, ...(repo ? { repo } : {}) },
  ], io, defaultRoutingConfig(), { nowMs: () => Date.parse(NOW) }).entries[0];
  const g = build(ghRepo);
  assert.ok(g.sources.some((s) => s.locator === 'github#1'));
  assert.ok(g.validation.some((v) => v.command === 'github#1'));
  assert.ok(g.readFirst.some((l) => l.path === 'https://github.com/example-owner/promptr/issues/1'));
  const t = build(gtRepo);
  assert.ok(t.sources.some((s) => s.locator === 'gitea#1'));
  assert.ok(t.readFirst.some((l) => l.path === 'https://git.example.com/owner/promptr/issues/1'));
  assert.ok(build(undefined).sources.some((s) => s.locator === 'gitea#1'), 'no repo keeps the historic gitea default');
  assert.equal(issueLocator(ghRepo, 3), 'github#3');
});

// The "Owner" input of /promptr-tracker init has an override.
test('providerDefaultOwner reads GITEA_OWNER for Gitea and stays empty for GitHub', () => {
  assert.equal(providerDefaultOwner('gitea', {}), 'owner');
  assert.equal(providerDefaultOwner('gitea', { GITEA_OWNER: '  ' }), 'owner');
  assert.equal(providerDefaultOwner('gitea', { GITEA_OWNER: ' team-a ' }), 'team-a');
  assert.equal(providerDefaultOwner('github', { GITEA_OWNER: 'team-a' }), '');
});

test('the /promptr-tracker init flow takes the Owner default from providerDefaultOwner', () => {
  const source = readFileSync(new URL('../../src/extension/index.mts', import.meta.url), 'utf8');
  assert.match(source, /ctx\.ui\.input\("Owner", same \? inferred\.owner : providerDefaultOwner\(provider, process\.env\)\)/);
});
