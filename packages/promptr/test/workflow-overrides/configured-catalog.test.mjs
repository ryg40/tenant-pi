import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogPort, expandWorkflow } from '../../dist/src/workflow/catalog.mjs';
import { parseWorkflowConfig } from '../../dist/src/workflow/config.mjs';
import { createConfiguredCatalog } from '../../dist/src/workflow/configured.mjs';

const SOURCE = { source: '/tmp/workflows.json' };

function build(raw) {
 const parsed = parseWorkflowConfig(raw);
 assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.error);
 return createConfiguredCatalog(catalogPort, parsed.value, SOURCE);
}

function roleMap(expansion) {
 return Object.fromEntries(expansion.roles.map((r) => [r.role, `${r.provider}/${r.model}:${r.thinking}@${r.route}`]));
}

test('no config returns the shipped port itself, so default behaviour is unchanged', () => {
 const built = createConfiguredCatalog(catalogPort, undefined, SOURCE);
 assert.equal(built.ok, true);
 assert.equal(built.configured, false);
 assert.equal(built.catalog, catalogPort);
});

test('the shipped catalog still ends its instructions with the route summary this module replaces', () => {
 const pi = expandWorkflow({ template: 'openai-codex-simple', provider: 'openai-codex', readiness: 'ready' }).value;
 const mixed = expandWorkflow({ template: 'openai-claude', provider: 'openai-codex', readiness: 'ready' }).value;
 assert.match(pi.instructions.at(-1), /^Every role runs as a Pi session\b/);
 assert.match(mixed.instructions.at(-1), /^Claude worker and reviewer run through Herdr\b/);
});

test('the quota fallback line is recomputed from the effective providers, never inherited from the shipped list', () => {
 const single = build({ version: 1, providers: ['github-copilot'], defaultProvider: 'github-copilot' });
 assert.equal(single.ok, true);
 const alone = single.catalog.expandWorkflow({ template: 'openai-codex-simple', provider: 'github-copilot', readiness: 'ready' }).value;
 const aloneLines = alone.instructions.filter((l) => l.startsWith('Provider quota fallback (pre-authorized):'));
 assert.equal(aloneLines.length, 1);
 assert.match(aloneLines[0], /no fallback provider is configured; a usage-limit or quota error is a stop condition/);
 assert.doesNotMatch(alone.instructions.join(' '), /openai-codex/, 'shipped providers never leak into a single-provider override');

 const pair = build({ version: 1, providers: ['github-copilot', 'openai-codex'], defaultProvider: 'github-copilot' });
 assert.equal(pair.ok, true);
 const first = pair.catalog.expandWorkflow({ template: 'openai-codex-simple', provider: 'github-copilot', readiness: 'ready' }).value;
 const second = pair.catalog.expandWorkflow({ template: 'openai-codex-simple', provider: 'openai-codex', readiness: 'ready' }).value;
 assert.match(first.instructions.find((l) => l.startsWith('Provider quota fallback')), /relaunch that role on openai-codex with/);
 assert.match(second.instructions.find((l) => l.startsWith('Provider quota fallback')), /relaunch that role on github-copilot with/);
 assert.match(first.instructions.at(-1), /^Every role runs as a Pi session\b/, 'route summary still closes the list');
});

test('the execution mode passes through the override catalog unchanged', () => {
 const built = build({ version: 1, providers: ['github-copilot'], defaultProvider: 'github-copilot' });
 assert.equal(built.ok, true);
 const native = built.catalog.expandWorkflow({ template: 'openai-codex-simple', provider: 'github-copilot', readiness: 'ready', execution: 'herdr-native' }).value;
 assert.equal(native.execution, 'herdr-native');
 assert.match(native.instructions.join(' '), /interactive Herdr-native Pi sessions/);
 const plain = built.catalog.expandWorkflow({ template: 'openai-codex-simple', provider: 'github-copilot', readiness: 'ready' }).value;
 assert.equal(plain.execution, 'pi-subagents');
 assert.equal(built.catalog.expandWorkflow({ template: 'openai-codex-simple', provider: 'github-copilot', readiness: 'ready', execution: 'nope' }).ok, false);
});

test('provider-only remapping moves every Pi role and leaves model IDs untouched', () => {
 const built = build({ version: 1, providers: ['github-copilot'], defaultProvider: 'github-copilot' });
 assert.equal(built.ok, true);
 const configured = built.catalog.expandWorkflow({
  template: 'openai-codex-high', provider: 'github-copilot', readiness: 'ready',
 }).value;
 const shipped = expandWorkflow({ template: 'openai-codex-high', provider: 'openai-codex', readiness: 'ready' }).value;
 assert.deepEqual(configured.roles.map((r) => r.role), shipped.roles.map((r) => r.role));
 assert.deepEqual(configured.roles.map((r) => r.model), shipped.roles.map((r) => r.model));
 assert.deepEqual(configured.roles.map((r) => r.thinking), shipped.roles.map((r) => r.thinking));
 assert.deepEqual([...new Set(configured.roles.map((r) => r.provider))], ['github-copilot']);
});

test('a role override beats the selected provider; omitted fields keep the shipped value', () => {
 const built = build({
  version: 1,
  providers: ['github-copilot', 'openai-codex'],
  workflows: {
   'openai-codex-simple': {
    roles: {
     worker: { provider: 'openai-codex', model: 'gpt-5.6-sol', thinking: 'xhigh' },
     scout: { thinking: 'low' },
    },
   },
  },
 });
 assert.equal(built.ok, true);
 const value = built.catalog.expandWorkflow({
  template: 'openai-codex-simple', provider: 'github-copilot', readiness: 'ready',
 }).value;
 const map = roleMap(value);
 assert.equal(map.worker, 'openai-codex/gpt-5.6-sol:xhigh@pi');
 assert.equal(map.scout, 'github-copilot/gpt-5.6-luna:low@pi');
 assert.equal(map.coordinator, 'github-copilot/gpt-5.6-sol:xhigh@pi');
 assert.equal(map.generator, 'github-copilot/gpt-5.6-sol:medium@pi');
});

test('legacy mixed Claude routes survive a provider-only override', () => {
 const built = build({ version: 1, providers: ['github-copilot'] });
 const value = built.catalog.expandWorkflow({
  template: 'openai-claude', provider: 'github-copilot', readiness: 'ready',
 }).value;
 const map = roleMap(value);
 assert.equal(map.worker, 'anthropic/claude-opus-5:high@herdr-claude');
 assert.equal(map.reviewer, 'anthropic/claude-sonnet-5:high@herdr-claude');
 assert.equal(map.coordinator, 'github-copilot/gpt-6-astra:low@pi');
});

test('an explicit all-Pi override retargets the Claude roles and drops the Herdr claim', () => {
 const built = build({
  version: 1,
  providers: ['github-copilot'],
  workflows: {
   'openai-claude': {
    label: 'Copilot - mixed tiers',
    roles: {
     worker: { route: 'pi', provider: 'github-copilot', model: 'gpt-5.1-codex', thinking: 'high' },
     reviewer: { route: 'pi', provider: 'github-copilot', model: 'gpt-5.1-codex-mini', thinking: 'high' },
    },
   },
  },
 });
 const value = built.catalog.expandWorkflow({
  template: 'openai-claude', provider: 'github-copilot', readiness: 'ready',
 }).value;
 assert.deepEqual([...new Set(value.roles.map((r) => r.route))], ['pi']);
 assert.deepEqual([...new Set(value.roles.map((r) => r.provider))], ['github-copilot']);
 const joined = value.instructions.join(' ');
 assert.doesNotMatch(joined, /Herdr/);
 assert.doesNotMatch(joined, /selected OpenAI provider/);
 assert.match(joined, /Every role runs as a Pi session on github-copilot\./);
 assert.equal(built.catalog.listWorkflows().find((w) => w.id === 'openai-claude').label, 'Copilot - mixed tiers');
});

test('a route change without a provider is a configuration error, not an inherited provider', () => {
 const built = build({
  version: 1,
  providers: ['github-copilot'],
  workflows: { 'openai-claude': { roles: { worker: { route: 'pi' } } } },
 });
 assert.equal(built.ok, false);
 assert.match(built.error, /changes route to 'pi' without naming a provider/);
});

test('unknown workflow IDs and role names name what actually exists', () => {
 const workflow = build({ version: 1, workflows: { 'copilot-simple': { roles: { worker: { thinking: 'low' } } } } });
 assert.equal(workflow.ok, false);
 assert.match(workflow.error, /not a known workflow\. Known workflows: openai-codex-simple/);

 const role = build({ version: 1, workflows: { 'openai-codex-simple': { roles: { oracle: { thinking: 'low' } } } } });
 assert.equal(role.ok, false);
 assert.match(role.error, /not a role of that workflow\. Its roles are: coordinator, scout/);
});

test('the picker offers exactly the configured providers, defaultProvider first', () => {
 const built = build({ version: 1, providers: ['openai-codex', 'github-copilot'], defaultProvider: 'github-copilot' });
 assert.deepEqual(built.catalog.listProviders().map((p) => p.id), ['github-copilot', 'openai-codex']);
 for (const provider of built.catalog.listProviders()) {
  assert.doesNotMatch(provider.description, /OpenAI/);
  assert.match(provider.description, /not proof that it is loaded or authenticated/);
 }
 assert.match(built.catalog.listProviders()[0].description, /defaultProvider/);
});

test('selecting a provider the override does not offer is refused by name', () => {
 const built = build({ version: 1, providers: ['github-copilot'] });
 const result = built.catalog.expandWorkflow({
  template: 'openai-codex-simple', provider: 'openai-codex', readiness: 'ready',
 });
 assert.equal(result.ok, false);
 assert.match(result.error, /unknown provider 'openai-codex'\. Known providers: github-copilot/);
});

test('readiness rules and role order come from the shipped catalog, not the override', () => {
 const built = build({ version: 1, providers: ['github-copilot'] });
 const refused = built.catalog.expandWorkflow({
  template: 'openai-codex-simple', provider: 'github-copilot', readiness: 'unresolved-design',
 });
 assert.equal(refused.ok, false);
 assert.match(refused.error, /well-developed tasks only/);

 const value = built.catalog.expandWorkflow({
  template: 'openai-codex-medium', provider: 'github-copilot', readiness: 'unknown',
 }).value;
 assert.deepEqual(value.roles.map((r) => r.role),
  ['coordinator', 'scout', 'researcher', 'worker', 'reviewer', 'generator']);
 assert.match(value.warnings.join(' '), /Static preview only/);
 assert.match(value.warnings.join(' '), /Task readiness is unknown/);
});

test('an expansion says where the effective roles came from and that it is unverified', () => {
 const built = build({ version: 1, providers: ['github-copilot'] });
 const value = built.catalog.expandWorkflow({
  template: 'openai-codex-simple', provider: 'github-copilot', readiness: 'ready',
 }).value;
 assert.match(value.warnings.at(-1), /local workflow override at \/tmp\/workflows\.json/);
 assert.match(value.warnings.at(-1), /not verified runtime availability/);
});
