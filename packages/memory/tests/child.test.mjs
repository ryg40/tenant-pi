import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The app as a module of the local server: `server.mjs --child` (the comment at the top of server.mjs).
const app = fileURLToPath(new URL('../', import.meta.url));
const HEADER = 'X-Tenant-Artifacts-Parent';

// Start the child as the parent does: the secret goes to standard input, and the first output line is the answer.
async function launch(t, args, { secret = randomBytes(32).toString('hex') } = {}) {
  const child = spawn(process.execPath, ['server.mjs', '--child', ...args], { cwd: app, env: { TZ: 'UTC' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'close');
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    clearTimeout(timer);
  });
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.write(`${secret}\n`);
  const line = await new Promise((resolve) => {
    const check = () => { if (stdout.includes('\n')) resolve(stdout.split('\n')[0]); };
    child.stdout.on('data', check);
    exited.then(() => resolve(stdout.split('\n')[0]));
    check();
  });
  return { child, exited, secret, ready: JSON.parse(line), output: () => stdout + stderr };
}

function call(port, target, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: target, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, text });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

test('the child refuses each request without the secret of its parent, and ends with its parent', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tenant-memory-child-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const server = await launch(t, ['--config', path.join(dir, 'absent.json')]);
  assert.equal(server.ready.ready, true);
  const port = server.ready.port;
  const wrong = randomBytes(32).toString('hex');
  for (const target of ['/', '/app.js', '/api/sources', '/api/overview', '/healthz']) {
    for (const headers of [{}, { [HEADER]: wrong }, { [HEADER]: '' }, { Authorization: `Bearer ${server.secret}` },
      { Authorization: `Basic ${Buffer.from(`user:${server.secret}`).toString('base64')}` }]) {
      const refused = await call(port, target, headers);
      assert.equal(refused.status, 401, `${target} ${JSON.stringify(Object.keys(headers))}`);
      assert.equal(refused.headers['www-authenticate'], undefined);
      assert.equal(refused.text.includes(server.secret), false);
    }
    assert.equal((await call(port, target, { [HEADER]: server.secret })).status, 200, target);
  }
  // The secret is in no output line of the child.
  assert.equal(server.output().includes(server.secret), false);
  // The parent is gone when standard input closes: the child ends by itself.
  server.child.stdin.end();
  const [code] = await server.exited;
  assert.equal(code, 0);
});

test('with no settings file the child shows the sample data, and it refuses a settings file that is not private', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tenant-memory-child-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sample = await launch(t, ['--config', path.join(dir, 'absent.json')]);
  assert.deepEqual([sample.ready.ready, sample.ready.mode], [true, 'sample']);
  const listed = JSON.parse((await call(sample.ready.port, '/api/sources', { [HEADER]: sample.secret })).text);
  assert.equal(listed.mode, 'sample');
  assert.ok(listed.sources.every((source) => source.mode === 'sample'));
  sample.child.stdin.end();
  await sample.exited;

  // Refuse unsafe settings without printing either the field value or the parent secret.
  const marker = randomBytes(24).toString('hex');
  const settings = path.join(dir, 'memory-sources.json');
  const source = { id: 'notes', type: 'okknow', mode: 'live', access: 'http', origin: 'https://knowledge.example.invalid' };
  for (const [mode, content] of [
    [0o644, { sources: [{ ...source, credentialFile: path.join(dir, 'credential') }] }],
    [0o600, { sources: [{ ...source, password: marker }] }],
    [0o600, { password: marker, sources: [source] }],
  ]) {
    await writeFile(settings, JSON.stringify(content));
    await chmod(settings, mode);
    const refused = await launch(t, ['--config', settings]);
    assert.equal(refused.ready.ready, false);
    assert.notEqual((await refused.exited)[0], 0);
    assert.equal(refused.output().includes(dir), false);
    assert.equal(refused.output().includes(marker), false);
    assert.equal(refused.output().includes(refused.secret), false);
  }

  // A private settings file with a credential file that is not private: the server starts, and that source says so.
  const credential = path.join(dir, 'credential');
  await writeFile(credential, `sample-user:${marker}\n`);
  await chmod(credential, 0o644);
  await writeFile(settings, JSON.stringify({ sources: [{ ...source, credentialFile: credential }] }));
  await chmod(settings, 0o600);
  const live = await launch(t, ['--config', settings]);
  assert.deepEqual([live.ready.ready, live.ready.mode], [true, 'live']);
  const overview = JSON.parse((await call(live.ready.port, '/api/overview', { [HEADER]: live.secret })).text);
  assert.equal(overview.sources[0].error.code, 'credentials');
  assert.equal(JSON.stringify(overview).includes(marker), false);
  live.child.stdin.end();
  await live.exited;
});
