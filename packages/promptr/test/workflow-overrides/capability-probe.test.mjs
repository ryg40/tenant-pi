import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCapabilityProbeFile, loadEffectiveCatalog } from '../../dist/src/workflow/load.mjs';
import { loadCapabilityProbe } from '../../dist/src/generate/launch.mjs';
import { parseCapabilityProbe } from '../../dist/src/workflow/registry.mjs';
import { catalogPort } from '../../dist/src/workflow/catalog.mjs';

test('custom capability path is resolved exactly and relative paths fail', () => {
 assert.deepEqual(resolveCapabilityProbeFile({ PROMPTR_WORKFLOW_CAPABILITIES: '/custom/probe.json' }), { path: '/custom/probe.json', explicit: true });
 assert.match(resolveCapabilityProbeFile({ PROMPTR_WORKFLOW_CAPABILITIES: 'probe.json' }).error, /absolute/);
});
test('configured workflows cannot launch without a readable default probe', () => {
 const env = { PI_CODING_AGENT_DIR: '/fixture' };
 const read = p => p.endsWith('workflows.json') ? '{"version":1,"providers":["github-copilot"]}' : undefined;
 const result = loadCapabilityProbe(env, read);
 assert.equal(result.ok, false);
 assert.match(result.reason, /require a readable capability probe/);
});
test('unknown defaultProvider without provider list is rejected', () => {
 const text = '{"version":1,"defaultProvider":"typo","workflows":{"openai-codex-simple":{"roles":{"worker":{"thinking":"high"}}}}}';
 const result = loadEffectiveCatalog(catalogPort, { PI_CODING_AGENT_DIR: '/fixture' }, { exists: () => true, readFile: () => text });
 assert.match(result.error, /effective providers/);
});
test('malformed thinking entries are rejected rather than filtered', () => {
 for (const thinking of [['high', 2], ['high', 'max'], [null]]) {
  const result = parseCapabilityProbe(JSON.stringify([{ provider: 'p', model: 'm', thinking, route: 'pi' }]));
  assert.equal(result.ok, false);
 }
});
