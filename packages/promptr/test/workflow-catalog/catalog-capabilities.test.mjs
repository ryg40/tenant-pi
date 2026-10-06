import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandWorkflow, validateWorkflowCapabilities } from '../../dist/src/workflow/catalog.mjs';

function expand(template, provider = 'default-provider') {
 const result = expandWorkflow({ template, provider, readiness: 'ready' });
 assert.equal(result.ok, true);
 return result.value;
}

/** Exactly the capabilities an expansion needs, one entry per distinct role slot. */
function coveringCapabilities(value) {
 return value.roles.map((role) => ({
  provider: role.provider, model: role.model, thinking: [role.thinking], route: role.route,
 }));
}

test('an expansion validates when every role is exactly covered', () => {
 for (const template of ['worker-simple', 'worker-medium', 'worker-high', 'reviewer-simple', 'reviewer']) {
  for (const provider of ['default-provider']) {
   const value = expand(template, provider);
   const result = validateWorkflowCapabilities(value, coveringCapabilities(value));
   assert.equal(result.ok, true, `${template}/${provider}: ${result.error}`);
   assert.equal(result.value, value);
  }
 }
});

test('a missing capability list is a visible failure, never implicit all-supported', () => {
 const value = expand('worker-medium');
 for (const capabilities of [undefined, null, {}, 'all']) {
  const result = validateWorkflowCapabilities(value, capabilities);
  assert.equal(result.ok, false);
  assert.match(result.error, /Absence is not implicit support/);
 }
});

test('an empty capability list confirms nothing', () => {
 const result = validateWorkflowCapabilities(expand('worker-high'), []);
 assert.equal(result.ok, false);
 assert.match(result.error, /empty/);
 assert.match(result.error, /Absence is not implicit support/);
});

test('a missing thinking level blocks the exact role and names it', () => {
 const value = expand('worker-simple');
 const capabilities = coveringCapabilities(value).map((capability) =>
  capability.model === 'standard-model' && capability.thinking[0] === 'xhigh'
   ? { ...capability, thinking: ['low', 'medium', 'high'] }
   : capability);
 const result = validateWorkflowCapabilities(value, capabilities);
 assert.equal(result.ok, false);
 assert.match(result.error, /coordinator \(default-provider\/standard-model xhigh via pi\)/);
 assert.match(result.error, /Missing capabilities block; nothing is substituted/);
});

test('another provider does not satisfy the selected one', () => {
 const value = expand('worker-medium', 'default-provider');
 const wrongProvider = coveringCapabilities(value).map((capability) =>
  capability.provider === 'default-provider' ? { ...capability, provider: 'second-provider' } : capability);
 const result = validateWorkflowCapabilities(value, wrongProvider);
 assert.equal(result.ok, false);
 assert.match(result.error, /coordinator \(default-provider\//);
});

test('a Pi capability never satisfies a Herdr-Claude role', () => {
 const value = expand('reviewer');
 const capabilities = coveringCapabilities(value).map((capability) =>
  capability.route === 'herdr-claude' ? { ...capability, route: 'pi' } : capability);
 const result = validateWorkflowCapabilities(value, capabilities);
 assert.equal(result.ok, false);
 assert.match(result.error, /worker \(claude\/claude-large-model high via herdr-claude\)/);
 assert.match(result.error, /reviewer \(claude\/claude-standard-model high via herdr-claude\)/);
});

test('no unlisted model is inferred from a related one', () => {
 const value = expand('worker-high');
 const capabilities = coveringCapabilities(value).map((capability) =>
  capability.model === 'large-model' ? { ...capability, model: 'large-model-preview' } : capability);
 const result = validateWorkflowCapabilities(value, capabilities);
 assert.equal(result.ok, false);
 assert.match(result.error, /coordinator \(default-provider\/large-model medium via pi\)/);
});

test('validation reports a malformed expansion rather than passing it through', () => {
 const value = expand('worker-medium');
 const result = validateWorkflowCapabilities({ ...value, roles: 'all' }, coveringCapabilities(value));
 assert.equal(result.ok, false);
 assert.match(result.error, /cannot validate workflow/);
});

test('validation is a separate step: expansion alone never claims runtime support', () => {
 const value = expand('worker-simple');
 assert.ok(!Object.keys(value).includes('validated'));
 assert.match(value.warnings.join(' '), /Validate capabilities before any launch or send/);
});
