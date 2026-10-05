import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { catalogPort } from '../../dist/src/workflow/catalog.mjs';
import { parseWorkflowConfigText } from '../../dist/src/workflow/config.mjs';
import { createConfiguredCatalog } from '../../dist/src/workflow/configured.mjs';
import { INIT_HELP, buildInitConfig, parseInitArgs, runWorkflowInit } from '../../dist/src/workflow/init.mjs';

const SOURCE = new URL('../../src/workflow/init.mts', import.meta.url);
const EXAMPLES = new URL('../../examples/', import.meta.url);

function harness(existing = {}) {
 const files = { ...existing };
 const log = [];
 const deps = {
  exists: (file) => Object.hasOwn(files, file),
  readFile: (file) => files[file],
  writeFile: (file, text) => { files[file] = text; },
  log: (line) => log.push(line),
  examplePath: (name) => path.join(EXAMPLES.pathname, name === 'copilot' ? 'workflows.copilot.json' : 'workflows.example.json'),
 };
 // Packaged examples are read from disk exactly as the shipped command does.
 const readFile = deps.readFile;
 deps.readFile = (file) => (Object.hasOwn(files, file) ? readFile(file) : readSafely(file));
 return { files, log, deps };
}

function readSafely(file) {
 try { return readFileSync(file, 'utf8'); } catch { return undefined; }
}

test('the initializer has no launch, session or credential surface', () => {
 const text = readFileSync(SOURCE, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
 for (const forbidden of [
  /\bchild_process\b/, /\bspawn\w*\s*\(/, /\bexecFile\w*\s*\(/, /\bfetch\s*\(/,
  /\bauth\.json\b/, /\bapiKey\b/, /\bsettings\.json\b/, /\blogin\b/,
  // The Claude/Herdr route is named in text only; nothing here drives Herdr.
  /herdr-cli/i, /\bagent start\b/, /\btab create\b/,
 ]) {
  assert.doesNotMatch(text, forbidden, `init.mts must not contain ${forbidden}`);
 }
});

test('the help names the file, the env override and the inert contract', () => {
 assert.match(INIT_HELP, /PROMPTR_WORKFLOWS_FILE/);
 assert.match(INIT_HELP, /promptr\/workflows\.json/);
 assert.match(INIT_HELP, /never launches an agent/);
 assert.match(INIT_HELP, /--force/);
});

test('a provider or an example is required, and they are mutually exclusive', () => {
 assert.match(parseInitArgs([]).error, /name the provider/);
 assert.match(parseInitArgs(['--provider', 'a', '--example', 'copilot']).error, /not both/);
 assert.match(parseInitArgs(['--example', 'nope']).error, /unknown example/);
 assert.match(parseInitArgs(['--path', 'relative.json']).error, /must be absolute/);
 assert.match(parseInitArgs(['--frobnicate']).error, /unknown argument/);
 assert.equal(parseInitArgs(['--help']).ok, true);
});

test('a generated file covers every workflow and role and re-parses as valid', () => {
 const built = buildInitConfig(catalogPort, 'openai-codex', false);
 assert.equal(built.ok, true);
 const parsed = parseWorkflowConfigText(built.text);
 assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.error);
 assert.deepEqual(Object.keys(parsed.value.workflows),
  catalogPort.listWorkflows().map((w) => w.id));
 for (const override of Object.values(parsed.value.workflows)) {
  assert.deepEqual(Object.keys(override.roles),
   ['coordinator', 'scout', 'researcher', 'worker', 'reviewer', 'generator']);
 }
 // Shipped models are kept for a shipped provider; the Claude route is untouched.
 const configured = createConfiguredCatalog(catalogPort, parsed.value, { source: 'generated' });
 const mixed = configured.catalog.expandWorkflow({
  template: 'openai-claude', provider: 'openai-codex', readiness: 'ready',
 }).value;
 assert.equal(mixed.roles.find((r) => r.role === 'worker').route, 'herdr-claude');
});

test('an unknown provider gets placeholder models, so nothing is invented', () => {
 const built = buildInitConfig(catalogPort, 'github-copilot', true);
 assert.equal(built.ok, true);
 assert.match(built.text, /"model": "<set-worker-model-id>"/);
 const parsed = parseWorkflowConfigText(built.text);
 assert.equal(parsed.ok, false);
 assert.match(parsed.error, /still the example placeholder/);

 // With --all-pi the Claude roles are retargeted and the description says so.
 const filled = parseWorkflowConfigText(built.text.replace(/<set-[a-z-]+-model-id>/g, 'copilot-model'));
 assert.equal(filled.ok, true, filled.ok ? '' : filled.error);
 const configured = createConfiguredCatalog(catalogPort, filled.value, { source: 'generated' });
 const mixed = configured.catalog.expandWorkflow({
  template: 'openai-claude', provider: 'github-copilot', readiness: 'ready',
 }).value;
 assert.deepEqual([...new Set(mixed.roles.map((r) => r.route))], ['pi']);
 assert.deepEqual([...new Set(mixed.roles.map((r) => r.provider))], ['github-copilot']);
 assert.match(configured.catalog.listWorkflows().find((w) => w.id === 'openai-claude').description,
  /retargeted to Pi sessions on github-copilot/);
});

test('without --all-pi the shipped Claude route is written out verbatim', () => {
 const built = buildInitConfig(catalogPort, 'github-copilot', false);
 const text = built.text;
 assert.match(text, /"provider": "anthropic"/);
 assert.match(text, /"route": "herdr-claude"/);
 assert.match(text, /"model": "claude-opus-5"/);
});

test('writing refuses an existing file and says how to proceed', () => {
 const target = '/tmp/promptr-init-fixture/workflows.json';
 const { files, log, deps } = harness({ [target]: '{"version":1}' });
 const outcome = runWorkflowInit(['--provider', 'openai-codex', '--path', target], {}, deps, catalogPort);
 assert.equal(outcome.ok, false);
 assert.match(outcome.error, /already exists\. Nothing was written/);
 assert.match(outcome.error, /--force/);
 assert.equal(files[target], '{"version":1}');
 assert.deepEqual(log, []);
});

test('--force overwrites and reports that nothing was launched or verified', () => {
 const target = '/tmp/promptr-init-fixture/workflows.json';
 const { files, log, deps } = harness({ [target]: '{"version":1}' });
 const outcome = runWorkflowInit(['--provider', 'openai-codex', '--path', target, '--force'], {}, deps, catalogPort);
 assert.equal(outcome.ok, true);
 assert.equal(outcome.written, true);
 assert.equal(outcome.valid, true);
 assert.notEqual(files[target], '{"version":1}');
 assert.match(log.join('\n'), /nothing was launched, authenticated or verified/);
});

test('--print writes nothing at all', () => {
 const target = '/tmp/promptr-init-fixture/absent.json';
 const { files, log, deps } = harness();
 const outcome = runWorkflowInit(['--provider', 'openai-codex', '--path', target, '--print'], {}, deps, catalogPort);
 assert.equal(outcome.ok, true);
 assert.equal(outcome.written, false);
 assert.deepEqual(Object.keys(files), []);
 assert.match(log.join('\n'), /# would write \/tmp\/promptr-init-fixture\/absent\.json/);
});

test('a placeholder file is announced as not usable yet, never as success', () => {
 const target = '/tmp/promptr-init-fixture/copilot.json';
 const { log, deps } = harness();
 const outcome = runWorkflowInit(['--provider', 'github-copilot', '--path', target], {}, deps, catalogPort);
 assert.equal(outcome.ok, true);
 assert.equal(outcome.valid, false);
 assert.match(log.join('\n'), /not usable yet/);
 assert.match(log.join('\n'), /edit the file, then reopen the workflow picker/);
});

test('--example copies the packaged Copilot example to the target path', () => {
 const target = '/tmp/promptr-init-fixture/from-example.json';
 const { files, deps } = harness();
 const outcome = runWorkflowInit(['--example', 'copilot', '--path', target], {}, deps, catalogPort);
 assert.equal(outcome.ok, true);
 assert.equal(files[target], readFileSync(new URL('workflows.copilot.json', EXAMPLES), 'utf8'));
});

test('the default target follows PROMPTR_WORKFLOWS_FILE, then the agent directory', () => {
 const { files, deps } = harness();
 runWorkflowInit(['--provider', 'openai-codex'], { PROMPTR_WORKFLOWS_FILE: '/tmp/promptr-init-fixture/env.json' }, deps, catalogPort);
 assert.ok(Object.hasOwn(files, '/tmp/promptr-init-fixture/env.json'));

 const second = harness();
 runWorkflowInit(['--provider', 'openai-codex'], { PI_CODING_AGENT_DIR: '/tmp/promptr-init-fixture/agent' }, second.deps, catalogPort);
 assert.ok(Object.hasOwn(second.files, '/tmp/promptr-init-fixture/agent/promptr/workflows.json'));
});

test('--keep-models keeps the shipped IDs for a provider that serves them, and stays explicit', () => {
 assert.equal(parseInitArgs(['--provider', 'github-copilot', '--all-pi', '--keep-models']).value.keepModels, true);
 assert.match(parseInitArgs(['--example', 'copilot', '--keep-models']).error, /apply to a generated file/);
 assert.match(INIT_HELP, /--keep-models/);
 const built = buildInitConfig(catalogPort, 'github-copilot', true, true);
 assert.equal(built.ok, true);
 assert.doesNotMatch(built.text, /<set-[a-z-]+-model-id>/, 'no placeholders with --keep-models');
 const parsed = parseWorkflowConfigText(built.text);
 assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.error);
 const configured = createConfiguredCatalog(catalogPort, parsed.value, { source: 'generated' });
 const simple = configured.catalog.expandWorkflow({ template: 'openai-codex-simple', provider: 'github-copilot', readiness: 'ready' }).value;
 assert.deepEqual(simple.roles.map((r) => `${r.provider}/${r.model}:${r.thinking}`), [
  'github-copilot/gpt-5.6-sol:xhigh', 'github-copilot/gpt-5.6-luna:xhigh', 'github-copilot/gpt-5.6-luna:xhigh',
  'github-copilot/gpt-5.6-sol:medium', 'github-copilot/gpt-5.6-luna:xhigh', 'github-copilot/gpt-5.6-sol:medium',
 ]);
 const mixed = configured.catalog.expandWorkflow({ template: 'openai-claude', provider: 'github-copilot', readiness: 'ready' }).value;
 const worker = mixed.roles.find((r) => r.role === 'worker');
 assert.deepEqual(worker, { role: 'worker', provider: 'github-copilot', model: 'claude-opus-5', thinking: 'high', route: 'pi' });
 // Without --keep-models the same call still writes placeholders.
 assert.match(buildInitConfig(catalogPort, 'github-copilot', true).text, /<set-worker-model-id>/);
});
