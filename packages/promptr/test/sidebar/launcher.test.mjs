import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('../../scripts/preview-sidebar.sh', import.meta.url));
test('preview uses fullscreen without changing global settings; explicit mode override remains possible', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptr-preview-launch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'pi'), '#!/bin/sh\nprintf "%s\\n" "$PI_CODING_AGENT_DIR" "$@"\n', { mode: 0o700 });
  const agent = path.join(root, 'preview'); fs.mkdirSync(agent);
  const settings = '{"theme":"light","tuiMode":"regular"}\n';
  fs.writeFileSync(path.join(agent, 'settings.json'), settings);
  const footer = path.join(root, 'existing-footer.ts'); fs.writeFileSync(footer, '// fixture');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PROMPTR_PREVIEW_AGENT_DIR: agent, PROMPTR_PREVIEW_FOOTER: footer };
  for (const extra of [[], ['--tui-mode', 'regular']]) {
    const args = execFileSync('bash', [script, ...extra], { env, encoding: 'utf8' }).trim().split('\n');
    assert.equal(args[0], agent);
    assert.deepEqual(args.slice(1, 3), ['--tui-mode', 'fullscreen']);
    assert.ok(args.includes(footer));
    if (extra.length) assert.deepEqual(args.slice(-2), extra);
    assert.equal(fs.readFileSync(path.join(agent, 'settings.json'), 'utf8'), settings);
  }
  const stock = execFileSync('bash', [script], { env: { ...env, PROMPTR_PREVIEW_FOOTER: 'none' }, encoding: 'utf8' });
  assert.ok(!stock.includes(footer));
  // A mistyped footer path must not silently become a stock-footer trial.
  const missing = spawnSync('bash', [script], { env: { ...env, PROMPTR_PREVIEW_FOOTER: path.join(root, 'missing.ts') }, encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /Footer not found/);
  const named = spawnSync('bash', [script], { env, encoding: 'utf8' });
  assert.match(named.stderr, new RegExp(`preview footer: ${footer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});
