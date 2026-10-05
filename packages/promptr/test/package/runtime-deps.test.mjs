// Runtime dependency contract for the installed copy. install.mjs runs
// `npm install --omit=dev`, so a package the built code imports must be a real
// production dependency, or Pi RPC, the standalone companion and doctor fail.
// Dev dependencies mask the defect in repository tests; these checks do not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = path.join(root, 'dist', 'src');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
// Pi's extension loader aliases these bare specifiers to its own copies. Deep
// subpaths such as `@earendil-works/pi-tui/dist/layout.js` are not aliased.
const PI_HOST = ['@earendil-works/pi-coding-agent', '@earendil-works/pi-agent-core', '@earendil-works/pi-ai', '@earendil-works/pi-tui', 'typebox'];

const packageName = (spec) => spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];

/** Bare (non-relative, non-builtin) import specifiers reachable from one built entry. */
function reachableImports(entry) {
  const seen = new Set();
  const specs = new Map();
  const stack = [path.join(dist, entry)];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const m of readFileSync(file, 'utf8').matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
      const spec = m[1] ?? m[2];
      if (spec.startsWith('.')) stack.push(path.resolve(path.dirname(file), spec));
      else if (!spec.startsWith('node:')) specs.set(spec, path.relative(dist, file));
    }
  }
  return specs;
}

const binEntries = Object.values(pkg.bin).map((p) => path.relative('dist/src', p.replace(/^\.\//, '')));

test('standalone bins import only production dependencies', () => {
  for (const entry of binEntries) {
    for (const [spec, from] of reachableImports(entry)) {
      assert.ok(pkg.dependencies?.[packageName(spec)], `${entry} reaches ${spec} (in ${from}); it must be in package.json dependencies, not only dev/peer`);
    }
  }
});

test('Pi extension imports resolve without dev dependencies', () => {
  for (const [spec, from] of reachableImports('extension/index.mjs')) {
    const name = packageName(spec);
    const aliased = PI_HOST.includes(spec);
    assert.ok(aliased || pkg.dependencies?.[name], `extension reaches ${spec} (in ${from}); Pi does not alias it, so ${name} must be a production dependency`);
  }
});

test('pi-tui is a pinned production dependency matching the Pi host line', () => {
  const pinned = pkg.dependencies?.['@earendil-works/pi-tui'];
  assert.match(pinned ?? '', /^\d+\.\d+\.\d+$/, 'pi-tui must be an exact runtime pin');
  assert.equal(pkg.devDependencies?.['@earendil-works/pi-tui'], undefined, 'pi-tui belongs in dependencies only');
  assert.equal(pkg.peerDependencies?.['@earendil-works/pi-tui'], undefined, 'a peer entry would let npm treat the runtime copy as host-provided');
  const hostPin = pkg.devDependencies?.['@earendil-works/pi-coding-agent'];
  assert.equal(pinned.split('.').slice(0, 2).join('.'), hostPin.split('.').slice(0, 2).join('.'), 'pi-tui minor must match the Pi coding-agent used for typecheck');
});

test('package-lock installs pi-tui under --omit=dev and ships no coding-agent runtime', () => {
  assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies, 'lock root dependencies are stale; run npm install');
  const tui = lock.packages['node_modules/@earendil-works/pi-tui'];
  assert.equal(tui?.version, pkg.dependencies['@earendil-works/pi-tui']);
  assert.notEqual(tui.dev, true, 'lock marks pi-tui dev-only, so npm install --omit=dev drops it');
  assert.equal(pkg.dependencies['@earendil-works/pi-coding-agent'], undefined, 'Pi provides pi-coding-agent; do not ship a second runtime');
  const prod = Object.entries(lock.packages).filter(([k, v]) => k.startsWith('node_modules/') && !v.dev && !v.optional && !v.peer);
  assert.ok(!prod.some(([k]) => k.endsWith('node_modules/@earendil-works/pi-coding-agent')), 'pi-coding-agent must stay out of the production tree');
});

test('packed files include the built entry points and the pi-atelier notice', () => {
  assert.ok(pkg.files.includes('dist/src/**/*') && pkg.files.includes('docs/**/*'));
  assert.ok(readdirSync(path.join(root, 'docs')).includes('PI-ATELIER-LICENSE.txt'));
  for (const entry of [...binEntries, 'extension/index.mjs']) assert.ok(readFileSync(path.join(dist, entry)), entry);
});
