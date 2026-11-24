#!/usr/bin/env node
// tenant-memory: a read-only web app for several agent memory systems.
// One opt-in write exists: the review of an AgentCore source (docs/sources/agentcore.md).
//
//   node server.mjs [--sample] [--config <file>] [--port <n>] [--bind <ipv4>] [--no-auth]
//   node server.mjs --child [--config <file>] [--port <n>]
//
// --child: the app runs as a module of the local server of packages/artifacts (the section /memory).
//   - It binds 127.0.0.1 only and has no Basic sign-in.
//   - The parent writes one line with a secret of this start to standard input. Each request, /healthz
//     too, must carry that secret in the header X-Tenant-Artifacts-Parent.
//   - --config names the settings file of the user. It must have mode 0600, and each credential in it
//     is the path of a file with mode 0600. Without that file the app shows the sample data.
//   - Standard output gets one JSON line: {"ready": true, "port": <n>, "mode": "<mode>"} when the server
//     listens, or {"ready": false, "error": "<one sentence>"} before exit code 2. The log goes to
//     standard error.
//   - The server ends when standard input closes: the parent is gone.
//
// Environment (each flag wins over its variable):
//   TENANT_MEMORY_CONFIG         the source configuration (default /config/sources.json)
//   TENANT_MEMORY_PORT           the port (default 8792)
//   TENANT_MEMORY_BIND           the bind address (default 127.0.0.1)
//   TENANT_MEMORY_AUTH_FILE      a file with "user:password" for HTTP Basic authentication
//   TENANT_MEMORY_ALLOWED_HOSTS  extra exact Host values, separated by commas
//
// Without a configuration file the app runs all sources in sample mode.
// --no-auth works only on a loopback bind address. Port 0 selects a free port.
//
// Public access uses two sign-ins. Authentik signs the reader in at the proxy.
// The app then asks for its own Basic credential from TENANT_MEMORY_AUTH_FILE.
// The proxy must keep the reader's Authorization header, not replace it.
// Put the public Host value in TENANT_MEMORY_ALLOWED_HOSTS. Forwarded hosts
// and identity headers never grant access or replace the Basic sign-in.

import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { isIPv4 } from 'node:net';
import { loadConfig, loadSettings, readPrivateSecret, readSecret, sampleConfig } from './lib/config.mjs';
import { Hub } from './lib/hub.mjs';
import { createHandler } from './lib/web.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--sample') out.sample = true;
    else if (a === '--no-auth') out.noAuth = true;
    else if (a === '--child') out.child = true;
    else if (['--config', '--port', '--bind'].includes(a)) {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`a value is required for ${a}`);
      out[a.slice(2)] = value;
      i += 1;
    } else throw new Error('unknown argument');
  }
  return out;
}

// The log: standard output, or standard error in child mode (standard output then holds only the ready line).
let logToError = false;
const log = (msg) => {
  const line = `${new Date().toISOString()} ${msg}\n`;
  if (logToError) process.stderr.write(line);
  else process.stdout.write(line);
};

// The secret of the parent: the first line of standard input, 64 hex characters. A parent that sends none in
// 10 seconds, or another text, stops the start.
function readParentSecret() {
  return new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error('the parent sent no secret')), 10_000);
    const done = (fn, value) => { clearTimeout(timer); process.stdin.off('data', onData); fn(value); };
    function onData(chunk) {
      text += chunk;
      const end = text.indexOf('\n');
      if (end < 0 && text.length <= 256) return;
      const line = end < 0 ? text : text.slice(0, end);
      if (/^[a-f0-9]{64}$/.test(line)) done(resolve, line);
      else done(reject, new Error('the parent secret is not valid'));
    }
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
    process.stdin.once('end', () => done(reject, new Error('the parent closed before it sent a secret')));
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = process.env;
  const child = Boolean(args.child);
  if (child) logToError = true;
  const port = Number(args.port ?? (child ? 0 : env.TENANT_MEMORY_PORT ?? 8792));
  const bind = child ? '127.0.0.1' : args.bind ?? env.TENANT_MEMORY_BIND ?? '127.0.0.1';
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('the port must be 0 to 65535');
  if (!isIPv4(bind)) throw new Error('the bind address must be an IPv4 address');
  if (child && (args.bind || args.noAuth || args.sample)) throw new Error('--child takes only --config and --port');
  if (args.noAuth && !bind.startsWith('127.')) throw new Error('--no-auth works only on a loopback bind address');

  // Child mode reads no variable: the parent gives the settings file as an argument.
  const configFile = args.config ?? (child ? null : env.TENANT_MEMORY_CONFIG ?? '/config/sources.json');
  let config;
  if (args.sample) {
    config = sampleConfig();
    log('sample mode: synthetic records only');
  } else if (configFile && existsSync(configFile)) {
    config = child ? loadSettings(configFile) : loadConfig(configFile);
    log(`configuration: ${config.sources.length} source(s)`);
  } else {
    config = sampleConfig();
    log('no configuration file: sample mode with synthetic records only');
  }

  let auth = null;
  let parentSecret = null;
  if (child) {
    parentSecret = await readParentSecret();
    log('child mode: each request needs the secret of the parent server');
  } else if (args.noAuth) {
    log('authentication is off (loopback only)');
  } else {
    const file = env.TENANT_MEMORY_AUTH_FILE ?? '/run/secrets/web_auth';
    const pair = readSecret(file);
    const at = pair.indexOf(':');
    if (at < 1 || at === pair.length - 1) throw new Error('the authentication file must hold user:password');
    auth = { user: pair.slice(0, at), password: pair.slice(at + 1) };
  }

  const hub = new Hub(config, { log, ...(child ? { secrets: readPrivateSecret } : {}) });
  const allowedHosts = child ? [] : (env.TENANT_MEMORY_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean);
  const server = createServer(createHandler({ hub, auth, parentSecret, allowedHosts, log }));
  server.requestTimeout = 60_000;
  server.headersTimeout = 15_000;
  server.on('error', () => {
    if (child) process.stdout.write(`${JSON.stringify({ ready: false, error: 'The memory server could not listen.' })}\n`);
    process.stderr.write('tenant-memory: the server could not listen\n');
    process.exit(2);
  });
  server.listen(port, bind, () => {
    log(`listening on http://${bind}:${server.address().port}/ (${hub.mode}; sources: ${hub.sources().map((s) => `${s.id}=${s.mode}`).join(', ')})`);
    if (child) process.stdout.write(`${JSON.stringify({ ready: true, port: server.address().port, mode: hub.mode })}\n`);
    hub.warm();
  });
  const stop = () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  if (child) {
    // The parent holds the other end of standard input. Its end means that the parent is gone.
    process.stdin.on('end', stop);
    process.stdin.on('close', stop);
    process.stdin.resume();
  }
}

main().catch((err) => {
  // The message of a start error is one fixed sentence: it holds no path and no file content.
  if (process.argv.includes('--child')) process.stdout.write(`${JSON.stringify({ ready: false, error: `The memory viewer did not start: ${String(err.message).replace(/^config: /, '')}.` })}\n`);
  process.stderr.write(`tenant-memory: ${err.message}\n`);
  process.exit(2);
});
