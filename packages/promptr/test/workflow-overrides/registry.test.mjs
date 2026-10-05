import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogPort } from '../../dist/src/workflow/catalog.mjs';
import { parseWorkflowConfig } from '../../dist/src/workflow/config.mjs';
import { createConfiguredCatalog } from '../../dist/src/workflow/configured.mjs';
import {
 CATALOG_THINKING_LEVELS, capabilitiesFromRegistry, checkExpansion, describeRoleChecks, parseCapabilityProbe,
 serializeCapabilityProbe, summarizeRoleChecks, thinkingLevelsOf,
} from '../../dist/src/workflow/registry.mjs';
import { defaultCapabilityProbePath, loadCapabilityProbe } from '../../dist/src/generate/launch.mjs';

const REGISTRY = [
 { provider: 'github-copilot', id: 'gpt-5.6-sol', reasoning: true },
 { provider: 'github-copilot', id: 'gpt-5.6-luna', reasoning: true, thinkingLevelMap: { xhigh: null } },
 { provider: 'github-copilot', id: 'gpt-4.1', reasoning: false },
 { provider: 'openai-codex', id: 'gpt-5.6-sol', reasoning: true },
 { provider: 'openai-codex', id: 'gpt-5.6-sol', reasoning: true }, // duplicate row
];

test('registry rows become exact pi-route capabilities; thinking follows reasoning and the level map', () => {
 assert.deepEqual([...CATALOG_THINKING_LEVELS], ['low', 'medium', 'high', 'xhigh']);
 assert.deepEqual([...thinkingLevelsOf({ provider: 'p', id: 'm', reasoning: true })], ['low', 'medium', 'high']);
 assert.deepEqual([...thinkingLevelsOf({ provider: 'p', id: 'm', reasoning: true, thinkingLevelMap: { xhigh: 'xhigh' } })], ['low', 'medium', 'high', 'xhigh']);
 assert.deepEqual([...thinkingLevelsOf({ provider: 'p', id: 'm', reasoning: false })], []);
 assert.deepEqual([...thinkingLevelsOf({ provider: 'p', id: 'm', reasoning: true, thinkingLevelMap: { xhigh: null, high: 'h' } })], ['low', 'medium', 'high']);
 const caps = capabilitiesFromRegistry(REGISTRY);
 assert.equal(caps.length, 4, 'duplicates collapse');
 assert.ok(caps.every((c) => c.route === 'pi'));
 assert.deepEqual(caps.find((c) => c.model === 'gpt-4.1').thinking, []);
 assert.ok(Object.isFrozen(caps) && Object.isFrozen(caps[0]));
});

test('the probe file round-trips and carries no credential fields; bare arrays still parse', () => {
 const caps = capabilitiesFromRegistry(REGISTRY);
 const text = serializeCapabilityProbe(caps, '2026-09-08T10:00:00.000Z', 'pi modelRegistry.getAvailable()');
 assert.doesNotMatch(text, /apiKey|token|baseUrl/);
 const parsed = parseCapabilityProbe(text);
 assert.equal(parsed.ok, true);
 assert.equal(parsed.writtenAt, '2026-09-08T10:00:00.000Z');
 assert.equal(parsed.source, 'pi modelRegistry.getAvailable()');
 assert.deepEqual(parsed.capabilities, caps.map((c) => ({ ...c, thinking: [...c.thinking] })));
 const bare = parseCapabilityProbe(JSON.stringify([{ provider: 'p', model: 'm', thinking: ['low'], route: 'pi' }]));
 assert.equal(bare.ok, true);
 assert.equal(bare.writtenAt, undefined);
 assert.match(parseCapabilityProbe('{"version":2,"capabilities":[]}').reason, /version must be 1/);
 assert.match(parseCapabilityProbe('{"version":1}').reason, /capabilities array/);
 assert.match(parseCapabilityProbe('nope').reason, /not valid JSON/);
 assert.match(parseCapabilityProbe('[{"provider":"p"}]').reason, /needs provider, model/);
});

function copilotExpansion() {
 const parsed = parseWorkflowConfig({
  version: 1, providers: ['github-copilot'], defaultProvider: 'github-copilot',
  workflows: { 'openai-codex-simple': { roles: { coordinator: { thinking: 'high' }, reviewer: { model: 'gpt-5.6-luna', thinking: 'xhigh' } } } },
 });
 const built = createConfiguredCatalog(catalogPort, parsed.value, { source: '/x/workflows.json' });
 return built.catalog.expandWorkflow({ template: 'openai-codex-simple', provider: 'github-copilot', readiness: 'ready' }).value;
}

test('checkExpansion reports ok, missing (provider, model, thinking) and unverifiable herdr-claude roles exactly', () => {
 const caps = capabilitiesFromRegistry(REGISTRY);
 const checks = checkExpansion(copilotExpansion(), caps);
 const byRole = Object.fromEntries(checks.map((c) => [c.role, c]));
 assert.equal(byRole.coordinator.status, 'ok');
 assert.equal(byRole.worker.status, 'ok');
 assert.equal(byRole.reviewer.status, 'missing');
 assert.match(byRole.reviewer.reason, /thinking xhigh unsupported .*supports low, medium, high/);
 assert.equal(byRole.scout.status, 'missing', 'luna xhigh is not supported by the level map');
 const totals = summarizeRoleChecks(checks);
 assert.deepEqual(totals, { ok: 3, missing: 3, unverifiable: 0 });

 const noProvider = checkExpansion(copilotExpansion(), capabilitiesFromRegistry([{ provider: 'openai-codex', id: 'gpt-5.6-sol', reasoning: true }]));
 assert.ok(noProvider.every((c) => c.status === 'missing' && /provider github-copilot not in the registry/.test(c.reason)));

 const mixed = catalogPort.expandWorkflow({ template: 'openai-claude', provider: 'openai-codex', readiness: 'ready' }).value;
 const mixedChecks = checkExpansion(mixed, capabilitiesFromRegistry(REGISTRY));
 assert.equal(mixedChecks.find((c) => c.role === 'worker').status, 'unverifiable');
 assert.match(describeRoleChecks(mixedChecks).find((l) => /worker/.test(l)), /^unverifiable +worker +anthropic\/claude-opus-5:high via herdr-claude — herdr-claude route/);
});

test('the companion reads the hosted probe from the default path when no env override is set', () => {
 const env = { PI_CODING_AGENT_DIR: '/agent' };
 const path = defaultCapabilityProbePath(env);
 assert.equal(path, '/agent/promptr/capabilities.json');
 assert.equal(loadCapabilityProbe(env, () => undefined), undefined, 'absent default probe keeps existing behaviour');
 const text = serializeCapabilityProbe(capabilitiesFromRegistry(REGISTRY), '2026-09-08T10:00:00.000Z', 'pi');
 const loaded = loadCapabilityProbe(env, (file) => (file === path ? text : undefined));
 assert.equal(loaded.ok, true);
 assert.equal(loaded.path, path);
 assert.equal(loaded.capabilities.length, 4);
 const broken = loadCapabilityProbe(env, (file) => (file === path ? '{' : undefined));
 assert.equal(broken.ok, false);
 assert.match(broken.reason, /not valid JSON/);
 const explicit = loadCapabilityProbe({ ...env, PROMPTR_WORKFLOW_CAPABILITIES: '/elsewhere.json' }, (file) => (file === '/elsewhere.json' ? text : undefined));
 assert.equal(explicit.ok, true);
 assert.equal(explicit.path, '/elsewhere.json');
});
