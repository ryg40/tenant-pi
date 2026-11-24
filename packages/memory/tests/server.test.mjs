import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const app = fileURLToPath(new URL('../', import.meta.url));
const authHeader = `Basic ${Buffer.from('sample-user:sample-password').toString('base64')}`;

function launch(t, args, env = {}) {
  const child = spawn(process.execPath, ['server.mjs', ...args], {
    cwd: app, env: { TZ: 'UTC', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = once(child, 'close');
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
    clearTimeout(timer);
  });
  return { child, exited, output: () => ({ stdout, stderr }) };
}

async function ready(server) {
  return new Promise((resolve, reject) => {
    function check() {
      const match = server.output().stdout.match(/listening on http:\/\/127\.0\.0\.1:(\d+)\//);
      if (match) {
        server.child.stdout.off('data', check);
        resolve(Number(match[1]));
      }
    }
    server.child.stdout.on('data', check);
    server.exited.then(() => reject(new Error('The sample server exited before readiness.')));
    check();
  });
}

function call(port, target, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: target, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('--no-auth refuses every non-loopback IPv4 bind before listening', async (t) => {
  for (const bind of ['0.0.0.0', '192.0.2.1']) {
    const server = launch(t, ['--sample', '--no-auth', '--bind', bind, '--port', '0']);
    assert.deepEqual(await server.exited, [2, null]);
    assert.match(server.output().stderr, /--no-auth works only on a loopback bind address/);
    assert.doesNotMatch(server.output().stdout, /listening/);
  }
  const server = launch(t, ['--sample', '--no-auth', '--port', '0'], { TENANT_MEMORY_BIND: '0.0.0.0' });
  assert.deepEqual(await server.exited, [2, null]);
  assert.match(server.output().stderr, /loopback bind/);
});

test('--no-auth accepts loopback on a random port and flags override environment', async (t) => {
  const server = launch(t, ['--sample', '--no-auth', '--bind', '127.0.0.1', '--port', '0'], {
    TENANT_MEMORY_BIND: '0.0.0.0', TENANT_MEMORY_PORT: 'invalid',
  });
  const port = await ready(server);
  assert.ok(port > 0);
  assert.equal((await call(port, '/healthz')).status, 200);
  assert.equal((await call(port, '/api/sources')).status, 200);
  server.child.kill('SIGTERM');
  assert.deepEqual(await server.exited, [0, null]);
});

test('public hosts require TENANT_MEMORY_ALLOWED_HOSTS and still require app Basic authentication', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tenant-memory-auth-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'web-auth');
  await writeFile(file, 'sample-user:sample-password\n', { mode: 0o600 });
  for (const configured of [false, true]) {
    const server = launch(t, ['--sample', '--port', '0'], {
      TENANT_MEMORY_AUTH_FILE: file,
      ...(configured ? { TENANT_MEMORY_ALLOWED_HOSTS: ' memory.example, second.example:443 ' } : {}),
    });
    const port = await ready(server);
    const reply = await call(port, '/api/sources', { Host: 'memory.example', Authorization: authHeader });
    assert.equal(reply.status, configured ? 200 : 421);
    assert.equal(reply.headers['cache-control'], 'no-store');
    const noAuth = await call(port, '/api/sources', { Host: 'memory.example', 'X-Authentik-Username': 'sample-user' });
    assert.equal(noAuth.status, configured ? 401 : 421);
    if (configured) assert.match(noAuth.headers['www-authenticate'], /^Basic /);
    assert.equal((await call(port, '/api/sources', { Host: 'memory.example:443', Authorization: authHeader })).status, 421);
    assert.equal((await call(port, '/api/sources', { Host: 'unlisted.example', 'X-Forwarded-Host': 'memory.example', Authorization: authHeader })).status, 421);
    assert.equal((await call(port, '/healthz')).status, 200);
    server.child.kill('SIGTERM');
    assert.deepEqual(await server.exited, [0, null]);
    assert.doesNotMatch(JSON.stringify(server.output()), /sample-password/);
  }
});

test('invalid arguments, bind addresses and ports fail without echoing input', async (t) => {
  const cases = [
    ['--unknown-sample-secret'], ['--bind'], ['--port', '--sample'],
    ['--port', '-1'], ['--port', '65536'], ['--port', 'sample-secret'],
    ['--bind', '127.999.0.1'], ['--bind', 'localhost'], ['--bind', '127.0.0.1.sample-secret'],
  ];
  for (const args of cases) {
    const server = launch(t, ['--sample', '--no-auth', ...args]);
    assert.deepEqual(await server.exited, [2, null]);
    assert.doesNotMatch(JSON.stringify(server.output()), /sample-secret|listening/);
  }
});

test('missing, empty and malformed authentication files fail closed', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tenant-memory-invalid-auth-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'auth');
  for (const content of [null, '', 'sample-secret', ':sample-secret', 'sample-user:']) {
    if (content !== null) await writeFile(file, content, { mode: 0o600 });
    const server = launch(t, ['--sample', '--port', '0'], { TENANT_MEMORY_AUTH_FILE: file });
    assert.deepEqual(await server.exited, [2, null]);
    assert.match(server.output().stderr, /credential file|authentication file/);
    assert.doesNotMatch(JSON.stringify(server.output()), /sample-secret|listening/);
    assert.ok(!server.output().stderr.includes(dir));
  }
});

test('a listener failure exits with a fixed error instead of an uncaught stack', async (t) => {
  const listener = createServer();
  t.after(() => new Promise((resolve) => listener.close(resolve)));
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const server = launch(t, ['--sample', '--no-auth', '--port', String(listener.address().port)]);
  assert.deepEqual(await server.exited, [2, null]);
  assert.equal(server.output().stderr, 'tenant-memory: the server could not listen\n');
});
