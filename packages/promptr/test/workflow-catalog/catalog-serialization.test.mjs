import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
 catalogPort, expandWorkflow, listProviders, listWorkflows, serializeWorkflow,
} from '../../dist/src/workflow/catalog.mjs';

const INPUT = { template: 'openai-claude', provider: 'openai-codex-2', readiness: 'unknown' };

function expand(input = INPUT) {
 const result = expandWorkflow(input);
 assert.equal(result.ok, true);
 return result.value;
}

test('serialization is byte-identical across repeated expansions', () => {
 const first = serializeWorkflow(expand());
 for (let attempt = 0; attempt < 5; attempt += 1) {
  assert.equal(serializeWorkflow(expand()), first);
 }
});

test('serialized output carries no timestamp or random identifier', () => {
 for (const template of ['openai-codex-simple', 'openai-codex-medium', 'openai-codex-high', 'openai-claude-simple', 'openai-claude']) {
  const text = serializeWorkflow(expand({ template, provider: 'openai-codex', readiness: 'ready' }));
  assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T/);
  assert.doesNotMatch(text, /"(createdAt|fetchedAt|generatedAt|id|nonce|seed|uuid)"/);
 }
});

test('serialized key order is fixed and ends with exactly one newline', () => {
 const text = serializeWorkflow(expand());
 assert.ok(text.endsWith('\n'));
 assert.ok(!text.endsWith('\n\n'));
 assert.deepEqual(Object.keys(JSON.parse(text)), [
  'version', 'template', 'provider', 'execution', 'roles', 'instructions', 'warnings',
 ]);
 assert.equal(JSON.parse(text).execution, 'pi-subagents', 'the default execution is written out, never left implicit');
 assert.deepEqual(Object.keys(JSON.parse(text).roles[0]), [
  'role', 'provider', 'model', 'thinking', 'route',
 ]);
});

test('a round trip through the serialized form preserves the expansion', () => {
 const value = expand();
 assert.deepEqual(JSON.parse(serializeWorkflow(value)), JSON.parse(JSON.stringify(value)));
});

test('returned data is deeply frozen, so a preview cannot mutate the catalog', () => {
 const value = expand();
 assert.ok(Object.isFrozen(value));
 assert.ok(Object.isFrozen(value.roles));
 assert.ok(Object.isFrozen(value.roles[0]));
 assert.ok(Object.isFrozen(value.instructions));
 assert.ok(Object.isFrozen(value.warnings));
 assert.throws(() => { value.roles[0].model = 'tampered'; }, TypeError);
 assert.throws(() => { value.warnings.push('extra'); }, TypeError);
 assert.equal(expand().roles[0].model, 'gpt-6-astra');
});

test('choice lists are frozen and stable between calls', () => {
 for (const list of [listWorkflows(), listProviders()]) {
  assert.ok(Object.isFrozen(list));
  assert.ok(Object.isFrozen(list[0]));
  assert.throws(() => { list.push({ id: 'x', label: 'x', description: 'x' }); }, TypeError);
 }
 assert.deepEqual(listWorkflows(), listWorkflows());
 assert.deepEqual(listProviders(), listProviders());
});

test('catalogPort exposes exactly the structural port and returns the same data', () => {
 assert.deepEqual(Object.keys(catalogPort).sort(), ['expandWorkflow', 'listProviders', 'listWorkflows']);
 assert.deepEqual(catalogPort.listWorkflows(), listWorkflows());
 assert.deepEqual(catalogPort.listProviders(), listProviders());
 assert.deepEqual(catalogPort.expandWorkflow(INPUT), expandWorkflow(INPUT));
 assert.equal(catalogPort.expandWorkflow({ ...INPUT, template: 'nope' }).ok, false);
});
