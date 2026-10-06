import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { catalogPort } from '../../dist/src/workflow/catalog.mjs';
import { parseWorkflowConfigText } from '../../dist/src/workflow/config.mjs';
import { createConfiguredCatalog } from '../../dist/src/workflow/configured.mjs';

const DEFAULT_EXAMPLE = new URL('../../examples/workflows.example.json', import.meta.url);
const COPILOT_EXAMPLE = new URL('../../examples/workflows.copilot.json', import.meta.url);
const PACKAGE = new URL('../../package.json', import.meta.url);

test('the packaged examples ship with the package files list', () => {
 const pkg = JSON.parse(readFileSync(PACKAGE, 'utf8'));
 assert.ok(pkg.files.includes('examples/**/*'), 'examples must be packaged');
 assert.equal(pkg.bin['promptr-workflows-init'], './dist/src/workflow/init.mjs');
});

test('the default example is valid and applies cleanly to the shipped catalog', () => {
 const parsed = parseWorkflowConfigText(readFileSync(DEFAULT_EXAMPLE, 'utf8'));
 assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.error);
 const built = createConfiguredCatalog(catalogPort, parsed.value, { source: String(DEFAULT_EXAMPLE) });
 assert.equal(built.ok, true, built.ok ? '' : built.error);
 assert.deepEqual(built.catalog.listProviders().map((p) => p.id), ['example-provider', 'second-provider']);
 const worker = built.catalog.expandWorkflow({
  template: 'worker-high', provider: 'second-provider', readiness: 'ready',
 }).value.roles.find((r) => r.role === 'worker');
 assert.deepEqual(worker, {
  role: 'worker', provider: 'second-provider', model: 'gpt-6-astra', thinking: 'medium', route: 'pi',
 });
});

test('the Copilot example is structurally valid and names its sample model IDs', () => {
 const text = readFileSync(COPILOT_EXAMPLE, 'utf8');
 assert.doesNotMatch(text, /<[a-z-]+>/, 'no placeholders remain in the packaged Copilot example');
 assert.match(text, /pi --list-models/);
 const parsed = parseWorkflowConfigText(text);
 assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.error);
 const built = createConfiguredCatalog(catalogPort, parsed.value, { source: 'copilot-example' });
 assert.equal(built.ok, true, built.ok ? '' : built.error);
 assert.deepEqual(built.catalog.listProviders().map((p) => p.id), ['github-copilot']);
 // The sample IDs of the example. This test does not prove registry availability.
 const models = new Set();
 for (const workflow of built.catalog.listWorkflows()) {
  const result = built.catalog.expandWorkflow({
   template: workflow.id, provider: 'github-copilot', readiness: 'ready',
  });
  assert.equal(result.ok, true, `${workflow.id}: ${result.ok ? '' : result.error}`);
  const value = result.value;
  assert.deepEqual([...new Set(value.roles.map((r) => r.route))], ['pi'], `${workflow.id} must be all-Pi`);
  assert.deepEqual([...new Set(value.roles.map((r) => r.provider))], ['github-copilot'], workflow.id);
  assert.deepEqual(value.roles.map((r) => r.role),
   ['coordinator', 'scout', 'researcher', 'worker', 'reviewer', 'generator'], workflow.id);
  for (const role of value.roles) models.add(role.model);
  const joined = `${value.instructions.join(' ')} ${workflow.label}`;
  assert.doesNotMatch(joined, /on the selected provider|Pi roles|default-provider/, `${workflow.id} must not repeat a shipped label or provider`);
  assert.doesNotMatch(value.instructions.join(' '), /Herdr/, `${workflow.id} must not claim a Herdr Claude route`);
 }
 assert.deepEqual([...models].sort(), ['claude-opus-5', 'claude-sonnet-5', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-6-astra']);
});

test('a placeholder-bearing override is still refused until the IDs are replaced', () => {
 const text = readFileSync(COPILOT_EXAMPLE, 'utf8').replace('"gpt-5.6-sol"', '"<copilot-model-id>"');
 const parsed = parseWorkflowConfigText(text);
 assert.equal(parsed.ok, false);
 assert.match(parsed.error, /still the example placeholder/);
 assert.match(parsed.error, /pi --list-models/);
});

test('no example contains a credential-shaped field', () => {
 for (const url of [DEFAULT_EXAMPLE, COPILOT_EXAMPLE]) {
  const text = readFileSync(url, 'utf8');
  for (const forbidden of [/apiKey/i, /\btoken\b/i, /\bsecret\b/i, /sk-/, /\bcookie\b/i]) {
   assert.doesNotMatch(text, forbidden, `${url.pathname} must not contain ${forbidden}`);
  }
 }
});
