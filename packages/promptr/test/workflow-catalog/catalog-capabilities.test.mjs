import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandWorkflow, validateWorkflowCapabilities } from '../../dist/src/workflow/catalog.mjs';

function expand(template, provider = 'openai-codex') {
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
 for (const template of ['openai-codex-simple', 'openai-codex-medium', 'openai-codex-high', 'openai-claude-simple', 'openai-claude']) {
  for (const provider of ['openai-codex', 'openai-codex-2']) {
   const value = expand(template, provider);
   const result = validateWorkflowCapabilities(value, coveringCapabilities(value));
   assert.equal(result.ok, true, `${template}/${provider}: ${result.error}`);
   assert.equal(result.value, value);
  }
 }
});

test('a missing capability list is a visible failure, never implicit all-supported', () => {
 const value = expand('openai-codex-medium');
 for (const capabilities of [undefined, null, {}, 'all']) {
  const result = validateWorkflowCapabilities(value, capabilities);
  assert.equal(result.ok, false);
  assert.match(result.error, /Absence is not implicit support/);
 }
});

test('an empty capability list confirms nothing', () => {
 const result = validateWorkflowCapabilities(expand('openai-codex-high'), []);
 assert.equal(result.ok, false);
 assert.match(result.error, /empty/);
 assert.match(result.error, /Absence is not implicit support/);
});

test('a missing thinking level blocks the exact role and names it', () => {
 const value = expand('openai-codex-simple');
 const capabilities = coveringCapabilities(value).map((capability) =>
  capability.model === 'gpt-5.6-sol' && capability.thinking[0] === 'xhigh'
   ? { ...capability, thinking: ['low', 'medium', 'high'] }
   : capability);
 const result = validateWorkflowCapabilities(value, capabilities);
 assert.equal(result.ok, false);
 assert.match(result.error, /coordinator \(openai-codex\/gpt-5\.6-sol xhigh via pi\)/);
 assert.match(result.error, /Missing capabilities block; nothing is substituted/);
});

test('the other OpenAI provider does not satisfy the selected one', () => {
 const value = expand('openai-codex-medium', 'openai-codex-2');
 const wrongProvider = coveringCapabilities(expand('openai-codex-medium', 'openai-codex'));
 const result = validateWorkflowCapabilities(value, wrongProvider);
 assert.equal(result.ok, false);
 assert.match(result.error, /coordinator \(openai-codex-2\//);
});

test('a Pi capability never satisfies a Herdr-Claude role', () => {
 const value = expand('openai-claude');
 const capabilities = coveringCapabilities(value).map((capability) =>
  capability.route === 'herdr-claude' ? { ...capability, route: 'pi' } : capability);
 const result = validateWorkflowCapabilities(value, capabilities);
 assert.equal(result.ok, false);
 assert.match(result.error, /worker \(anthropic\/claude-opus-5 high via herdr-claude\)/);
 assert.match(result.error, /reviewer \(anthropic\/claude-sonnet-5 high via herdr-claude\)/);
});

test('no unlisted model is inferred from a related one', () => {
 const value = expand('openai-codex-high');
 const capabilities = coveringCapabilities(value).map((capability) =>
  capability.model === 'gpt-6-astra' ? { ...capability, model: 'gpt-6-astra-preview' } : capability);
 const result = validateWorkflowCapabilities(value, capabilities);
 assert.equal(result.ok, false);
 assert.match(result.error, /coordinator \(openai-codex\/gpt-6-astra medium via pi\)/);
});

test('validation reports a malformed expansion rather than passing it through', () => {
 const value = expand('openai-codex-medium');
 const result = validateWorkflowCapabilities({ ...value, roles: 'all' }, coveringCapabilities(value));
 assert.equal(result.ok, false);
 assert.match(result.error, /cannot validate workflow/);
});

test('validation is a separate step: expansion alone never claims runtime support', () => {
 const value = expand('openai-codex-simple');
 assert.ok(!Object.keys(value).includes('validated'));
 assert.match(value.warnings.join(' '), /Validate capabilities before any launch or send/);
});
