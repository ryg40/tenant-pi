import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as catalog from '../../dist/src/workflow/catalog.mjs';

const BUILT = new URL('../../dist/src/workflow/catalog.mjs', import.meta.url);
const SOURCE = new URL('../../src/workflow/catalog.mts', import.meta.url);

test('the catalog exports only the frozen structural surface', () => {
 assert.deepEqual(Object.keys(catalog).sort(), [
  // Pure text helpers for the pre-authorized quota fallback are part of
  // the inert surface: they read a provider list and return a string.
  'QUOTA_FALLBACK_PREFIX',
  'catalogPort', 'expandWorkflow', 'isQuotaFallbackInstruction', 'listProviders', 'listWorkflows',
  'quotaFallbackInstruction', 'quotaFallbackProvider',
  'serializeWorkflow', 'validateWorkflowCapabilities',
 ]);
});

test('the built module imports nothing: no Pi APIs and no cross-module coupling', () => {
 const built = readFileSync(BUILT, 'utf8');
 assert.doesNotMatch(built, /(^|\n)\s*import\s/);
 assert.doesNotMatch(built, /\brequire\s*\(/);
 assert.doesNotMatch(built, /\bimport\s*\(/);
});

// A preview must be inert. Anything below would let selecting a workflow
// touch the machine, the network, or a live session.
test('the catalog has no execution, filesystem, network or environment surface', () => {
 for (const url of [SOURCE, BUILT]) {
  const text = readFileSync(url, 'utf8')
   .replace(/\/\*[\s\S]*?\*\//g, '')
   .replace(/^\s*\/\/.*$/gm, '')
   .replace(/^\s*\*.*$/gm, '');
  for (const forbidden of [
   /\bprocess\b/, /\bglobalThis\b/, /\bfetch\s*\(/, /\bnode:/, /\bchild_process\b/,
   /\bspawn\w*\s*\(/, /\bexec\w*\s*\(/, /\breadFile/, /\bwriteFile/, /\bnew\s+Function\b/,
   /\beval\s*\(/, /\bsetTimeout\b/, /\bsetInterval\b/, /\bXMLHttpRequest\b/, /\bWebSocket\b/,
  ]) {
   assert.doesNotMatch(text, forbidden, `${url.pathname} must not contain ${forbidden}`);
  }
 }
});

test('expanding a workflow is pure: no clock, no randomness, no I/O side effect', () => {
 const now = Date.now;
 const random = Math.random;
 let touched = 0;
 Date.now = () => { touched += 1; return 0; };
 Math.random = () => { touched += 1; return 0; };
 try {
  const value = catalog.expandWorkflow({
   template: 'worker-high', provider: 'default-provider', readiness: 'ready',
  }).value;
  catalog.serializeWorkflow(value);
  catalog.validateWorkflowCapabilities(value, []);
  catalog.listWorkflows();
  catalog.listProviders();
 } finally {
  Date.now = now;
  Math.random = random;
 }
 assert.equal(touched, 0);
});

test('the catalog never names a launch, send, queue or credential surface', () => {
 const value = catalog.expandWorkflow({
  template: 'reviewer', provider: 'default-provider', readiness: 'ready',
 }).value;
 const text = JSON.stringify(value);
 for (const forbidden of [/token/i, /credential/i, /secret/i, /api[_-]?key/i, /cookie/i]) {
  assert.doesNotMatch(text, forbidden);
 }
 // Launch/send are mentioned only to forbid them, never as an action this module takes.
 assert.match(value.instructions.join(' '), /Generation is not execution/);
 assert.match(value.instructions.join(' '), /needs an explicit send/);
});
