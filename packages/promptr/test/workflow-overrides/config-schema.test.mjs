import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
 CONFIG_ROUTES, CONFIG_THINKING_LEVELS, WORKFLOWS_FILE_ENV, WORKFLOWS_FILE_NAME,
 parseWorkflowConfig, parseWorkflowConfigText,
} from '../../dist/src/workflow/config.mjs';

const SOURCE = new URL('../../src/workflow/config.mts', import.meta.url);

const MINIMAL = { version: 1, providers: ['github-copilot'] };

test('the schema module stays pure: no fs, env, network or process surface', () => {
 const text = readFileSync(SOURCE, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
 for (const forbidden of [
  /\bprocess\b/, /\bnode:/, /\bfetch\s*\(/, /\breadFileSync\b/, /\bwriteFileSync\b/,
  /\bchild_process\b/, /\bspawn\w*\s*\(/, /\beval\s*\(/,
 ]) {
  assert.doesNotMatch(text, forbidden, `config.mts must not contain ${forbidden}`);
 }
});

test('the file name and env override are fixed, documented constants', () => {
 assert.equal(WORKFLOWS_FILE_NAME, 'workflows.json');
 assert.equal(WORKFLOWS_FILE_ENV, 'PROMPTR_WORKFLOWS_FILE');
 assert.deepEqual([...CONFIG_THINKING_LEVELS], ['low', 'medium', 'high', 'xhigh']);
 assert.deepEqual([...CONFIG_ROUTES], ['pi', 'herdr-claude']);
});

test('a minimal provider list parses and is frozen', () => {
 const result = parseWorkflowConfig(MINIMAL);
 assert.equal(result.ok, true);
 assert.deepEqual([...result.value.providers], ['github-copilot']);
 assert.equal(Object.isFrozen(result.value), true);
});

test('the version must be exactly 1', () => {
 for (const version of [0, 2, '1', undefined, null]) {
  const result = parseWorkflowConfig({ ...MINIMAL, version });
  assert.equal(result.ok, false, `version ${String(version)} must be refused`);
  assert.match(result.error, /version must be 1/);
 }
});

test('unknown keys are configuration errors at every level', () => {
 const cases = [
  [{ ...MINIMAL, provider: 'x' }, /unknown key 'provider'/],
  [{ version: 1, workflows: { 'openai-codex-simple': { tier: 'high' } } }, /unknown key 'tier'/],
  [{ version: 1, workflows: { 'openai-codex-simple': { roles: { worker: { effort: 'high' } } } } }, /unknown key 'effort'/],
 ];
 for (const [raw, pattern] of cases) {
  const result = parseWorkflowConfig(raw);
  assert.equal(result.ok, false);
  assert.match(result.error, pattern);
 }
});

test('empty identifiers, empty objects and duplicates are refused', () => {
 const cases = [
  [{ version: 1, providers: [] }, /'providers' is empty/],
  [{ version: 1, providers: [''] }, /non-empty identifier/],
  [{ version: 1, providers: ['a', 'a'] }, /twice/],
  [{ version: 1, providers: ['openai-codex '] }, /no surrounding whitespace/],
  [{ version: 1, workflows: {} }, /'workflows' is empty/],
  [{ version: 1, workflows: { 'openai-codex-simple': {} } }, /is empty/],
  [{ version: 1, workflows: { 'openai-codex-simple': { roles: { worker: {} } } } }, /is empty/],
  [{ version: 1 }, /sets nothing/],
 ];
 for (const [raw, pattern] of cases) {
  const result = parseWorkflowConfig(raw);
  assert.equal(result.ok, false, JSON.stringify(raw));
  assert.match(result.error, pattern);
 }
});

test('unsupported thinking levels and routes are named, never clamped', () => {
 const thinking = parseWorkflowConfig({
  version: 1, workflows: { 'openai-codex-simple': { roles: { worker: { thinking: 'max' } } } },
 });
 assert.equal(thinking.ok, false);
 assert.match(thinking.error, /thinking is 'max'; supported levels are low, medium, high, xhigh/);

 const route = parseWorkflowConfig({
  version: 1, workflows: { 'openai-codex-simple': { roles: { worker: { route: 'ssh' } } } },
 });
 assert.equal(route.ok, false);
 assert.match(route.error, /route is 'ssh'; supported routes are pi, herdr-claude/);
});

test('an unreplaced example placeholder is a configuration error, not a model ID', () => {
 const result = parseWorkflowConfig({
  version: 1,
  workflows: { 'openai-codex-simple': { roles: { worker: { model: '<copilot-worker-model-id>' } } } },
 });
 assert.equal(result.ok, false);
 assert.match(result.error, /still the example placeholder/);
 assert.match(result.error, /no alias is substituted/);
});

test('defaultProvider must be one of the listed providers', () => {
 const result = parseWorkflowConfig({ version: 1, providers: ['github-copilot'], defaultProvider: 'openai-codex' });
 assert.equal(result.ok, false);
 assert.match(result.error, /not listed in 'providers'/);
});

test('a JSON syntax error is reported as a configuration error', () => {
 const result = parseWorkflowConfigText('{ "version": 1, }');
 assert.equal(result.ok, false);
 assert.match(result.error, /not valid JSON/);
});

test('the schema has no field that could carry a credential', () => {
 const text = readFileSync(SOURCE, 'utf8');
 for (const forbidden of [/apiKey/i, /\btoken\b/i, /\bsecret\b/i, /\bcookie\b/i, /authHeader/i]) {
  assert.doesNotMatch(text, forbidden, `config.mts must not mention ${forbidden}`);
 }
});
