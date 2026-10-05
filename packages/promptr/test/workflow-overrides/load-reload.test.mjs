import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { catalogPort } from '../../dist/src/workflow/catalog.mjs';
import {
 createReloadingCatalog, loadEffectiveCatalog, loadWorkflowConfig,
 nodeWorkflowLoadDeps, resolveWorkflowsFile, workflowStateRoot,
} from '../../dist/src/workflow/load.mjs';

function scratch() {
 const dir = mkdtempSync(path.join(tmpdir(), 'promptr-workflows-'));
 return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const COPILOT = {
 version: 1,
 providers: ['github-copilot'],
 defaultProvider: 'github-copilot',
 workflows: { 'openai-codex-simple': { roles: { worker: { model: 'gpt-5.1-codex', thinking: 'high' } } } },
};

test('the default path follows the Pi agent directory convention, never a hardcoded home', () => {
 const agentDir = path.join(tmpdir(), 'agent-dir-fixture');
 const resolved = resolveWorkflowsFile({ PI_CODING_AGENT_DIR: agentDir });
 assert.equal(resolved.path, path.join(agentDir, 'promptr', 'workflows.json'));
 assert.equal(resolved.explicit, false);
 assert.equal(workflowStateRoot({ PI_CODING_AGENT_DIR: agentDir }), path.join(agentDir, 'promptr'));
 // With no agent directory the root is still derived from the host home, not a literal path.
 assert.match(workflowStateRoot({}), /[\\/]\.pi[\\/]agent[\\/]promptr$/);
});

test('PROMPTR_WORKFLOWS_FILE selects another absolute path and must be absolute', () => {
 const explicit = resolveWorkflowsFile({ PROMPTR_WORKFLOWS_FILE: '/etc/promptr/workflows.json' });
 assert.equal(explicit.path, '/etc/promptr/workflows.json');
 assert.equal(explicit.explicit, true);

 const relative = resolveWorkflowsFile({ PROMPTR_WORKFLOWS_FILE: 'workflows.json' });
 assert.match(relative.error, /must be an absolute path/);
});

test('no file means shipped defaults and the shipped port object itself', () => {
 const { dir, cleanup } = scratch();
 try {
  const env = { PI_CODING_AGENT_DIR: dir };
  const load = loadWorkflowConfig(env, nodeWorkflowLoadDeps);
  assert.equal(load.ok, true);
  assert.equal(load.config, undefined);

  const effective = loadEffectiveCatalog(catalogPort, env, nodeWorkflowLoadDeps);
  assert.equal(effective.error, undefined);
  assert.equal(effective.configured, false);
  assert.equal(effective.catalog, catalogPort);
  assert.deepEqual(effective.catalog.listProviders().map((p) => p.id), ['openai-codex', 'openai-codex-2']);
 } finally { cleanup(); }
});

test('an explicitly requested file that does not exist is an error, not a silent default', () => {
 const { dir, cleanup } = scratch();
 try {
  const env = { PROMPTR_WORKFLOWS_FILE: path.join(dir, 'absent.json') };
  const effective = loadEffectiveCatalog(catalogPort, env, nodeWorkflowLoadDeps);
  assert.match(effective.error, /does not exist/);
  assert.deepEqual([...effective.catalog.listWorkflows()], []);
 } finally { cleanup(); }
});

test('a malformed override blocks selection and every expansion, quoting the file', () => {
 const { dir, cleanup } = scratch();
 try {
  const file = path.join(dir, 'workflows.json');
  writeFileSync(file, JSON.stringify({ version: 1, providers: ['x'], tier: 'high' }));
  const effective = loadEffectiveCatalog(catalogPort, { PROMPTR_WORKFLOWS_FILE: file }, nodeWorkflowLoadDeps);
  assert.match(effective.error, /unknown key 'tier'/);
  assert.match(effective.error, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.deepEqual([...effective.catalog.listWorkflows()], []);
  assert.deepEqual([...effective.catalog.listProviders()], []);
  const expansion = effective.catalog.expandWorkflow({
   template: 'openai-codex-simple', provider: 'openai-codex', readiness: 'ready',
  });
  assert.equal(expansion.ok, false);
  assert.match(expansion.error, /unknown key 'tier'/);
 } finally { cleanup(); }
});

test('editing the file and refreshing shows the new matrix; renders do not re-read', () => {
 const { dir, cleanup } = scratch();
 try {
  mkdirSync(path.join(dir, 'promptr'), { recursive: true });
  const file = path.join(dir, 'promptr', 'workflows.json');
  const env = { PI_CODING_AGENT_DIR: dir };
  const reloading = createReloadingCatalog(catalogPort, env, nodeWorkflowLoadDeps);
  assert.deepEqual(reloading.port.listProviders().map((p) => p.id), ['openai-codex', 'openai-codex-2']);
  assert.match(reloading.describe(), /workflow overrides: none/);

  writeFileSync(file, JSON.stringify(COPILOT));
  // Not refreshed yet: the cached snapshot is what the picker keeps showing.
  assert.deepEqual(reloading.port.listProviders().map((p) => p.id), ['openai-codex', 'openai-codex-2']);

  const refreshed = reloading.refresh();
  assert.equal(refreshed.configured, true);
  assert.deepEqual(reloading.port.listProviders().map((p) => p.id), ['github-copilot']);
  assert.match(reloading.describe(), /workflow override active/);
  const worker = reloading.port.expandWorkflow({
   template: 'openai-codex-simple', provider: 'github-copilot', readiness: 'ready',
  }).value.roles.find((r) => r.role === 'worker');
  assert.deepEqual(worker, {
   role: 'worker', provider: 'github-copilot', model: 'gpt-5.1-codex', thinking: 'high', route: 'pi',
  });

  // A later edit that breaks the file blocks on the next refresh and says why.
  writeFileSync(file, '{ "version": 1, ');
  const broken = reloading.refresh();
  assert.match(broken.error, /not valid JSON/);
  assert.match(reloading.describe(), /Nothing is generated, launched or sent/);

  // Fixing it recovers without a restart.
  writeFileSync(file, JSON.stringify(COPILOT));
  assert.equal(reloading.refresh().error, undefined);
 } finally { cleanup(); }
});

test('the loader never writes, and reads only the override file', () => {
 const { dir, cleanup } = scratch();
 try {
  const file = path.join(dir, 'workflows.json');
  writeFileSync(file, JSON.stringify(COPILOT));
  const read = [];
  const deps = {
   exists: (p) => p === file,
   readFile: (p) => { read.push(p); return JSON.stringify(COPILOT); },
  };
  const effective = loadEffectiveCatalog(catalogPort, { PROMPTR_WORKFLOWS_FILE: file }, deps);
  assert.equal(effective.error, undefined);
  assert.deepEqual(read, [file]);
 } finally { cleanup(); }
});
