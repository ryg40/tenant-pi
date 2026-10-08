// Sanitized doctor report: facts in, levels out, never a secret.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeSatisfies, renderDoctor, runDoctor } from '../../dist/src/doctor/doctor.mjs';

function probe(overrides = {}) {
 const files = {
  '/pkg/skills/promptr-generate-task-prompt/SKILL.md': '# skill',
  '/agent/extensions/promptr/package.json': '{"version":"0.1.0"}',
  '/agent/extensions/promptr/dist/src/extension/index.mjs': '',
  '/agent/extensions/promptr/dist/src/companion/spike.mjs': '',
  '/agent/extensions/promptr/node_modules/@earendil-works/pi-tui/package.json': '{}',
  '/agent/promptr/capabilities.json': JSON.stringify({ version: 1, writtenAt: '2026-09-08T09:00:00Z', source: 'pi', capabilities: [{ provider: 'p', model: 'm', thinking: ['low'], route: 'pi' }] }),
  '/proj/.promptr/briefing.json': JSON.stringify({ target: { origin: 'https://wiki.example', docName: 'projects/demo/brief' }, status: 'synced' }),
  ...(overrides.files ?? {}),
 };
 for (const key of Object.keys(files)) if (files[key] === undefined) delete files[key];
 const dirs = { '/agent/promptr': { mode: 0o40700, uid: 1000 }, '/agent/promptr/projects/demo-1': { mode: 0o40700, uid: 1000 }, ...(overrides.dirs ?? {}) };
 return {
  env: { PI_CODING_AGENT_DIR: '/agent', OPENKNOWLEDGE_USERNAME: 'u', OPENKNOWLEDGE_PASSWORD: 'p-secret', GITEA_TOKEN: 'tok-secret', ...(overrides.env ?? {}) },
  cwd: '/proj', nowMs: Date.parse('2026-09-08T10:00:00Z'),
  nodeVersion: '24.21.0', nodeEngines: '>=24.0.0 <25', packageVersion: '0.1.0', packageRoot: '/pkg',
  agentDir: '/agent', stateRoot: '/agent/promptr', projectDir: '/agent/promptr/projects/demo-1', uid: 1000,
  exists: (f) => f in files || f in dirs,
  readFile: (f) => files[f],
  stat: (f) => (f in dirs ? { exists: true, isDir: true, mode: dirs[f].mode, uid: dirs[f].uid, mtimeMs: 0 } : f in files ? { exists: true, isDir: false, mode: 0o100600, uid: 1000, mtimeMs: Date.parse('2026-09-08T09:30:00Z') } : undefined),
  version: (bin) => ({ pi: '1.1.0', herdr: '0.9.0' })[bin],
  promptLog: { entries: 12, pending: 0 },
  ...overrides.probe,
 };
}

const byId = (report, id) => report.checks.find((c) => c.id === id);

test('nodeSatisfies handles the engines range', () => {
 assert.equal(nodeSatisfies('v24.21.0', '>=24.0.0 <25'), true);
 assert.equal(nodeSatisfies('22.22.3', '>=24.0.0 <25'), false);
 assert.equal(nodeSatisfies('25.0.0', '>=24.0.0 <25'), false);
 assert.equal(nodeSatisfies('nope', '>=24.0.0 <25'), false);
});

test('a healthy machine reports ok/info only and the render never contains a credential', () => {
 const report = runDoctor(probe());
 assert.equal(report.ok, true);
 assert.ok(report.checks.every((c) => c.level !== 'fail'), JSON.stringify(report.checks.filter((c) => c.level === 'fail')));
 assert.equal(byId(report, 'node').level, 'ok');
 assert.equal(byId(report, 'pi').level, 'ok');
 assert.equal(byId(report, 'install').level, 'ok');
 assert.equal(byId(report, 'skill:promptr-generate-task-prompt').level, 'ok');
 assert.equal(byId(report, 'capabilities').level, 'ok');
 assert.match(byId(report, 'capabilities').summary, /1 provider\/model rows, written 30m ago/);
 assert.equal(byId(report, 'openknowledge:auth').level, 'ok');
 assert.match(byId(report, 'openknowledge:binding').summary, /projects\/demo\/brief/);
 assert.equal(byId(report, 'tracker').level, 'ok');
 assert.match(byId(report, 'tracker').detail, /GITEA_TOKEN present \(value not shown\)/);
 assert.equal(byId(report, 'state:root').level, 'ok');
 assert.equal(byId(report, 'prompt-log').level, 'ok');
 const text = renderDoctor(report);
 assert.doesNotMatch(text, /p-secret|tok-secret/);
 assert.match(text, /No tokens, note text or prompt text/);
});

test('missing pieces are visible: no install, no skill, bad node, missing credentials, missing probe, unconfigured tracker, loose permissions', () => {
 const report = runDoctor(probe({
  files: {
   '/agent/extensions/promptr/package.json': undefined,
   '/pkg/skills/promptr-generate-task-prompt/SKILL.md': undefined,
   '/agent/promptr/capabilities.json': undefined,
   '/proj/.promptr/briefing.json': undefined,
  },
  dirs: { '/agent/promptr': { mode: 0o40755, uid: 1000 } },
  env: { OPENKNOWLEDGE_USERNAME: 'u', OPENKNOWLEDGE_PASSWORD: '', GITEA_TOKEN: '', PROMPTR_TRACKER: 'github' },
  probe: { nodeVersion: '20.0.0', version: () => undefined, promptLog: { entries: 3, pending: 2 } },
 }));
 assert.equal(report.ok, false);
 assert.equal(byId(report, 'node').level, 'fail');
 assert.equal(byId(report, 'pi').level, 'warn');
 assert.equal(byId(report, 'herdr').level, 'warn');
 assert.equal(byId(report, 'install').level, 'warn');
 assert.equal(byId(report, 'skill:promptr-generate-task-prompt').level, 'fail');
 assert.equal(byId(report, 'capabilities').level, 'warn');
 assert.equal(byId(report, 'workflows').level, 'warn');
 assert.match(byId(report, 'workflows').detail, /do not launch; run promptr-workflows-init \(for example `--example copilot` or `--provider <id>`\)/);
 assert.equal(byId(report, 'openknowledge:auth').level, 'warn');
 assert.match(byId(report, 'openknowledge:auth').summary, /password missing/);
 assert.equal(byId(report, 'openknowledge:binding').level, 'info');
 assert.equal(byId(report, 'tracker').level, 'warn');
 assert.match(byId(report, 'tracker').detail, /GITHUB_OWNER and GITHUB_REPO/);
 assert.equal(byId(report, 'state:root').level, 'warn');
 assert.match(byId(report, 'state:root').detail, /mode 755/);
 assert.equal(byId(report, 'prompt-log').level, 'warn');
});

test('an invalid workflow override or capability probe is a failure with the reason', () => {
 const report = runDoctor(probe({
  files: {
   '/agent/promptr/workflows.json': '{"version":1,"providers":[]}',
   '/agent/promptr/capabilities.json': '{"version":9}',
  },
 }));
 assert.equal(byId(report, 'workflows').level, 'fail');
 assert.match(byId(report, 'workflows').detail, /providers' is empty/);
 assert.equal(byId(report, 'capabilities').level, 'fail');
 assert.match(byId(report, 'capabilities').detail, /version must be 1/);
 const valid = runDoctor(probe({ files: { '/agent/promptr/workflows.json': '{"version":1,"providers":["github-copilot"]}' } }));
 assert.equal(byId(valid, 'workflows').level, 'ok');
 assert.match(byId(valid, 'workflows').detail, /providers github-copilot/);
});

// ---- tracker binding ----
import { resolveTrackerBinding, serializeTrackerBinding } from '../../dist/src/tracking/binding.mjs';
import { initTrackerStep, DOCTOR_HELP } from '../../dist/src/doctor/cli.mjs';

const GH_BINDING = serializeTrackerBinding({ version: 1, provider: 'github', host: 'https://github.com', owner: 'example-owner', repo: 'promptr', boundAt: '2026-09-08T09:00:00.000Z' });

test('doctor tracker check carries the binding source and hints when not bound explicitly', () => {
 const env = { PI_CODING_AGENT_DIR: '/agent', GITEA_TOKEN: 'tok-secret' };
 const project = runDoctor(probe({ env, probe: { trackerBinding: resolveTrackerBinding(env, { project: GH_BINDING }) } }));
 assert.match(byId(project, 'tracker').summary, /^Tracker github https:\/\/github\.com example-owner\/promptr · source project$/);
 assert.match(byId(project, 'tracker').detail, /GITHUB_TOKEN not set/);
 assert.equal(byId(project, 'tracker:binding'), undefined, 'no hint for an explicit binding');

 const fallback = runDoctor(probe({ env, probe: { trackerBinding: resolveTrackerBinding(env, {}, undefined, '/work/example-repo') } }));
 assert.match(byId(fallback, 'tracker').summary, /unconfigured · source unbound$/);
 assert.equal(byId(fallback, 'tracker:binding').level, 'warn');
 assert.match(byId(fallback, 'tracker:binding').summary, /\/promptr-tracker init · shell: promptr-tracker-init --provider gitea\|github/);

 const remote = runDoctor(probe({ env, probe: { trackerBinding: resolveTrackerBinding(env, {}, 'git@github.com:o/r.git') } }));
 assert.match(byId(remote, 'tracker').summary, /source remote$/);
 assert.equal(byId(remote, 'tracker:binding').level, 'info');

 const corrupt = runDoctor(probe({ env, probe: { trackerBinding: resolveTrackerBinding(env, { project: '{bad' }) } }));
 assert.equal(byId(corrupt, 'tracker:binding-file').level, 'warn');
 assert.match(byId(corrupt, 'tracker:binding-file').summary, /project tracker\.json ignored/);

 const broken = runDoctor(probe({ env: { ...env, PROMPTR_TRACKER: 'github' }, probe: { trackerBinding: resolveTrackerBinding({ ...env, PROMPTR_TRACKER: 'github' }, {}) } }));
 assert.equal(byId(broken, 'tracker').level, 'warn');
 assert.match(byId(broken, 'tracker').summary, /source env$/);
 assert.equal(byId(broken, 'tracker:binding').level, 'warn');
 assert.ok(!renderDoctor(broken).includes('tok-secret'));
});

test('doctor without a supplied binding keeps the env-only behaviour with source env', () => {
 const report = runDoctor(probe());
 assert.match(byId(report, 'tracker').summary, /source env$/);
});

test('cli: --init-tracker on a non-TTY exits 2; --tracker github runs the init non-interactively', async () => {
 const calls = [];
 const fakeRun = async (argv) => { calls.push(argv); return { ok: true, path: '/proj/.promptr/tracker.json', written: true }; };
 const fakeDeps = () => ({});
 const origWrite = process.stderr.write;
 let stderr = '';
 process.stderr.write = (chunk) => { stderr += String(chunk); return true; };
 try {
  assert.equal(await initTrackerStep('/proj', { interactive: true }, false, fakeRun, fakeDeps), 2);
  assert.match(stderr, /needs a TTY/);
  assert.equal(calls.length, 0);
  assert.equal(await initTrackerStep('/proj', { interactive: false, provider: 'github' }, false, fakeRun, fakeDeps), undefined);
  assert.deepEqual(calls[0], ['--cwd', '/proj', '--provider', 'github']);
  const failing = async () => ({ ok: false, error: 'owner and repository are required' });
  assert.equal(await initTrackerStep('/proj', { interactive: false, provider: 'gitea' }, false, failing, fakeDeps), 1);
 } finally {
  process.stderr.write = origWrite;
 }
 assert.match(DOCTOR_HELP, /--init-tracker/);
 assert.match(DOCTOR_HELP, /--tracker <p>/);
});

test('the Pi check accepts only the tested 1.1 line and names it in the hint', () => {
 for (const [pi, level] of [['1.1.0', 'ok'], ['1.1.2', 'ok'], ['1.1', 'ok'], ['1.01.0', 'warn'], ['not-a-version', 'warn'], ['1.0.4', 'warn'], ['1.0.2', 'warn'], ['1.0.0', 'warn'], ['0.87.1', 'warn'], ['1.10.0', 'warn'], ['1.2.0', 'warn']]) {
  const check = byId(runDoctor(probe({ probe: { version: (bin) => ({ pi, herdr: '0.9.0' })[bin] } })), 'pi');
  assert.equal(check.level, level, pi);
  if (level === 'warn') assert.match(check.detail ?? check.hint ?? JSON.stringify(check), /1\.1\.x/);
 }
});
