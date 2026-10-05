import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogPort } from '../../dist/src/workflow/catalog.mjs';
import { parseWorkflowConfig } from '../../dist/src/workflow/config.mjs';
import { createConfiguredCatalog } from '../../dist/src/workflow/configured.mjs';
import { buildGeneratorPacket } from '../../dist/src/generate/packet.mjs';
import {
 CAPABILITY_PROBE_ENV, capabilityBlock, generatorRuntime, loadCapabilityProbe,
 requiredExtensions, runGenerator, runtimeLabel,
} from '../../dist/src/generate/launch.mjs';
import { buildTaskPromptDraft } from '../../dist/src/tracking/prompt-draft.mjs';

const SCRATCH = '/scratch';
const PANE = 'w8:p12';
const PROBE = '/probe/capabilities.json';
const OUTPUT = `${SCRATCH}/output.md`;
const GOOD_OUTPUT = '# Coordinator task prompt — #1 Workflow overrides\n\n- x\n';

const COPILOT_CONFIG = {
 version: 1,
 providers: ['github-copilot'],
 defaultProvider: 'github-copilot',
 workflows: {
  'openai-codex-simple': {
   label: 'Copilot - simple',
   roles: {
    coordinator: { model: 'copilot-big', thinking: 'high' },
    scout: { model: 'copilot-small', thinking: 'medium' },
    researcher: { model: 'copilot-small', thinking: 'medium' },
    worker: { model: 'copilot-mid', thinking: 'medium' },
    reviewer: { model: 'copilot-small', thinking: 'high' },
    generator: { model: 'copilot-mid', thinking: 'medium' },
   },
  },
 },
};

function copilotExpansion() {
 const parsed = parseWorkflowConfig(COPILOT_CONFIG);
 const built = createConfiguredCatalog(catalogPort, parsed.value, { source: '/tmp/workflows.json' });
 const result = built.catalog.expandWorkflow({
  template: 'openai-codex-simple', provider: 'github-copilot', readiness: 'ready',
 });
 assert.equal(result.ok, true, result.ok ? '' : result.error);
 return result.value;
}

function request(workflow) {
 return {
  version: 1, kind: 'generate-prompt-request',
  task: {
   repo: { host: 'https://gitea.local', owner: 'example-owner', repo: 'promptr' }, number: 1,
   url: 'https://gitea.local/example-owner/promptr/issues/1', title: 'Workflow overrides', body: 'body',
   bodyTruncated: false, state: 'open', labels: ['type:task'],
   updatedAt: '2026-09-08T10:00:00Z', fetchedAt: '2026-09-08T10:05:00Z',
   dependencies: { status: 'complete', items: [], blockers: 0 },
  },
  workflow, createdAt: '2026-09-08T10:06:00Z',
 };
}

const CTX = {
 cwd: '/repo', ref: 'main', head: 'abc123', dirty: false, targetLabel: 'w8:p1',
 nowIso: '2026-09-08T10:07:00Z', skillPath: '/skill/SKILL.md', outputPath: OUTPUT,
};

function harness({ env = {}, files = {}, workflow } = {}) {
 const calls = [];
 const written = new Map();
 let clock = 1_000_000;
 let gets = 0;
 const record = (status) => JSON.stringify({ result: { agent: {
  agent: 'pi', pane_id: PANE, cwd: SCRATCH, foreground_cwd: SCRATCH, agent_status: status,
  agent_session: { kind: 'path', value: '/sessions/gen.jsonl' }, terminal_id: 't1',
 } } });
 const deps = {
  exec: async (args) => {
   calls.push(args);
   if (args[0] === 'tab') return JSON.stringify({ result: { root_pane: { pane_id: PANE } } });
   if (args[1] === 'get') { gets += 1; return record(gets === 1 ? 'idle' : 'idle'); }
   return '{}';
  },
  readFile: (p) => (p === OUTPUT ? GOOD_OUTPUT : files[p]),
  exists: () => true,
  writeFile: (p, text) => { written.set(p, text); },
  sleep: async (ms) => { clock += ms; },
  now: () => clock,
 };
 const req = request(workflow);
 const packet = buildGeneratorPacket(req, CTX);
 const run = () => runGenerator(
  { request: req, packet, scratchDir: SCRATCH, workspace: 'w8', env, agentDir: '/agent', pollMs: 10, deadlineMs: 100 },
  deps,
 );
 return { run, calls, written, packet };
}

test('the packet freezes the effective expansion; preview, draft and generator agree', () => {
 const workflow = copilotExpansion();
 const packet = buildGeneratorPacket(request(workflow), CTX);
 assert.deepEqual(packet.workflow, workflow);
 const runtime = generatorRuntime(packet.workflow);
 assert.deepEqual(runtime, { provider: 'github-copilot', model: 'copilot-mid', thinking: 'medium' });

 const draft = buildTaskPromptDraft(request(workflow), {
  cwd: '/repo', ref: 'main', head: 'abc123', dirty: false, targetLabel: 'test', nowIso: CTX.nowIso,
 });
 for (const role of workflow.roles) {
  assert.ok(draft.includes(`${role.provider}/${role.model}`),
   `draft must show ${role.role} as ${role.provider}/${role.model}`);
 }
 // The template ID still reads `openai-codex-simple`; what must not appear is
 // a role bound to that provider once the override moved it.
 assert.ok(!draft.includes('openai-codex/'), 'draft must not bind a role to the replaced provider');
 assert.ok(!draft.includes('anthropic/'), 'the simple template has no Claude role to keep');
 assert.equal(runtimeLabel(runtime), 'github-copilot/copilot-mid:medium');
});

test('a Copilot generator never requires the second OpenAI account extension', () => {
 assert.deepEqual(requiredExtensions('github-copilot', '/agent'), ['/agent/extensions/herdr-agent-state.ts']);
 assert.deepEqual(requiredExtensions('openai-codex', '/agent'), ['/agent/extensions/herdr-agent-state.ts']);
 assert.deepEqual(requiredExtensions('openai-codex-2', '/agent'),
  ['/agent/extensions/herdr-agent-state.ts', '/agent/extensions/openai-codex-2.ts']);
});

test('frozen configured expansion still requires a probe after override deletion', async () => {
 const workflow = copilotExpansion();
 assert.equal(workflow.requiresCapabilityProbe, true);
 const h = harness({ workflow }); // No override file remains at dispatch.
 const result = await h.run();
 assert.equal(result.ok, false);
 assert.match(result.reason, /requires a readable capability probe/);
 assert.deepEqual(h.calls, []);
});

test('shipped defaults retain legacy no-probe dispatch', async () => {
 const workflow = catalogPort.expandWorkflow({ template: 'openai-codex-simple', provider: 'openai-codex', readiness: 'ready' }).value;
 const h = harness({ workflow });
 assert.equal((await h.run()).ok, true);
});

test('a probe that does not cover the effective runtime blocks dispatch before any call', async () => {
 const probe = JSON.stringify([
  { provider: 'openai-codex', model: 'gpt-5.6-sol', thinking: ['medium'], route: 'pi' },
 ]);
 const h = harness({
  workflow: copilotExpansion(),
  env: { [CAPABILITY_PROBE_ENV]: PROBE },
  files: { [PROBE]: probe },
 });
 const result = await h.run();
 assert.equal(result.ok, false);
 assert.match(result.reason, /runtime capability check failed/);
 assert.match(result.reason, /github-copilot\/copilot-mid medium via pi/);
 assert.match(result.reason, /nothing is substituted/i);
 assert.deepEqual(h.calls, [], 'no tab, agent or prompt call may be made');
});

test('an unsupported thinking level blocks even when the model matches', () => {
 const capabilities = [{ provider: 'github-copilot', model: 'copilot-mid', thinking: ['low'], route: 'pi' }];
 const blocked = capabilityBlock({ provider: 'github-copilot', model: 'copilot-mid', thinking: 'medium' }, capabilities);
 assert.match(blocked, /do not cover/);
 assert.equal(capabilityBlock({ provider: 'github-copilot', model: 'copilot-mid', thinking: 'low' }, capabilities), undefined);
});

test('a covering probe lets the dispatch through unchanged', async () => {
 const probe = JSON.stringify([
  { provider: 'github-copilot', model: 'copilot-mid', thinking: ['medium', 'high'], route: 'pi' },
 ]);
 const h = harness({
  workflow: copilotExpansion(),
  env: { [CAPABILITY_PROBE_ENV]: PROBE },
  files: { [PROBE]: probe },
 });
 const result = await h.run();
 assert.equal(result.ok, true, JSON.stringify(result));
});

test('a present but unusable probe blocks; it is never read as all-supported', async () => {
 for (const [body, pattern] of [
  ['not json', /not valid JSON/],
  ['{}', /version must be 1/],
  ['{"version":1}', /capabilities array/],
  ['[{"provider":"x"}]', /needs provider, model, thinking\[\] and route/],
  [null, /could not be read/],
 ]) {
  const h = harness({
   workflow: copilotExpansion(),
   env: { [CAPABILITY_PROBE_ENV]: PROBE },
   files: body === null ? {} : { [PROBE]: body },
  });
  const result = await h.run();
  assert.equal(result.ok, false, `probe ${String(body)} must block`);
  assert.match(result.reason, pattern);
  assert.deepEqual(h.calls, []);
 }
});

test('an empty probe list blocks: absence of capabilities is not support', async () => {
 const h = harness({
  workflow: copilotExpansion(),
  env: { [CAPABILITY_PROBE_ENV]: PROBE },
  files: { [PROBE]: '[]' },
 });
 const result = await h.run();
 assert.equal(result.ok, false);
 assert.match(result.reason, /Absence is not implicit support/);
});

test('the probe loader is off by default and refuses a relative path', () => {
 assert.equal(loadCapabilityProbe({}, () => undefined), undefined);
 const relative = loadCapabilityProbe({ [CAPABILITY_PROBE_ENV]: 'probe.json' }, () => '[]');
 assert.equal(relative.ok, false);
 assert.match(relative.reason, /must be an absolute path/);
});

test('a probe carries no credential-shaped field into the packet or launch record', async () => {
 const probe = JSON.stringify([
  { provider: 'github-copilot', model: 'copilot-mid', thinking: ['medium'], route: 'pi' },
 ]);
 const h = harness({
  workflow: copilotExpansion(),
  env: { [CAPABILITY_PROBE_ENV]: PROBE },
  files: { [PROBE]: probe },
 });
 await h.run();
 const all = [...h.written.values()].join('\n');
 for (const forbidden of [/api[_-]?key/i, /\btoken\b/i, /\bsecret\b/i, /Authorization/i, /\bcookie\b/i]) {
  assert.doesNotMatch(all, forbidden);
 }
});
