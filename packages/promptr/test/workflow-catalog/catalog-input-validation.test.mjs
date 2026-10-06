import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandWorkflow, serializeWorkflow } from '../../dist/src/workflow/catalog.mjs';

const GOOD = { template: 'worker-medium', provider: 'default-provider', readiness: 'ready' };

function failure(input) {
 const result = expandWorkflow(input);
 assert.equal(result.ok, false, `expected a visible failure for ${JSON.stringify(input)}`);
 assert.equal(typeof result.error, 'string');
 assert.ok(result.error.length > 0);
 return result.error;
}

// The caller is a TUI reading an untrusted selection, so the types are a
// convenience, not a guarantee: these all arrive at runtime.
test('a non-object input is rejected rather than throwing', () => {
 for (const input of [undefined, null, 'worker-simple', 42, [], () => GOOD]) {
  assert.match(failure(input), /must be an object|must be a string/);
 }
});

test('a missing or non-string template or provider is rejected', () => {
 assert.match(failure({ ...GOOD, template: undefined }), /template must be a string/);
 assert.match(failure({ ...GOOD, provider: 7 }), /provider must be a string/);
});

test('an unknown workflow or provider is rejected and lists what is known', () => {
 const template = failure({ ...GOOD, template: 'worker-ultra' });
 assert.match(template, /unknown workflow 'worker-ultra'/);
 assert.match(template, /worker-simple, worker-medium, worker-high, reviewer-simple, reviewer/);

 const provider = failure({ ...GOOD, provider: 'second-provider' });
 assert.match(provider, /unknown provider 'second-provider'/);
 assert.match(provider, /Known providers: default-provider\./);
});

test('an unknown execution mode is rejected; omitted means pi-subagents', () => {
 for (const execution of ['', 'HERDR-NATIVE', 'claude', 7, null]) {
  assert.match(failure({ ...GOOD, execution }), /unknown execution/);
 }
 const omitted = expandWorkflow(GOOD);
 assert.equal(omitted.ok, true);
 assert.equal(omitted.value.execution, 'pi-subagents');
 const explicit = expandWorkflow({ ...GOOD, execution: 'herdr-native' });
 assert.equal(explicit.ok, true);
 assert.equal(explicit.value.execution, 'herdr-native');
});

test('an unknown readiness value is rejected instead of being treated as ready', () => {
 for (const readiness of [undefined, '', 'READY', 'probably', true]) {
  assert.match(failure({ ...GOOD, readiness }), /unknown task readiness/);
 }
});

test('a workflow id is not matched case-insensitively or with surrounding space', () => {
 assert.match(failure({ ...GOOD, template: 'Worker-Medium' }), /unknown workflow/);
 assert.match(failure({ ...GOOD, template: ' worker-medium ' }), /unknown workflow/);
});

test('serializeWorkflow refuses a malformed expansion rather than emitting a half packet', () => {
 const value = expandWorkflow(GOOD).value;
 assert.throws(() => serializeWorkflow(undefined), /cannot serialize workflow/);
 assert.throws(() => serializeWorkflow({ ...value, version: 2 }), /version must be 1/);
 assert.throws(() => serializeWorkflow({ ...value, roles: [] }), /non-empty array/);
 assert.throws(
  () => serializeWorkflow({ ...value, roles: [{ ...value.roles[0], route: 'shell' }] }),
  /unknown route 'shell'/,
 );
 assert.throws(
  () => serializeWorkflow({ ...value, roles: [{ ...value.roles[0], role: 'operator' }] }),
  /unknown role 'operator'/,
 );
});
