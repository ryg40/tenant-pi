import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandWorkflow } from '../../dist/src/workflow/catalog.mjs';

const SIMPLE = ['openai-codex-simple', 'openai-claude-simple'];
const HEAVIER = ['openai-codex-medium', 'openai-codex-high', 'openai-claude'];

function expand(template, readiness, provider = 'openai-codex') {
 return expandWorkflow({ template, provider, readiness });
}

test('every expansion warns that the static preview is runtime-unverified', () => {
 for (const template of [...SIMPLE, ...HEAVIER]) {
  const result = expand(template, 'ready');
  assert.equal(result.ok, true);
  assert.match(result.value.warnings[0], /Static preview only/);
  assert.match(result.value.warnings[0], /not verified runtime availability/);
 }
});

test('a ready task adds no readiness warning beyond the runtime-unverified one', () => {
 for (const template of [...SIMPLE, ...HEAVIER]) {
  const result = expand(template, 'ready');
  assert.equal(result.value.warnings.length, 1, `${template} should carry one warning`);
 }
});

test('simple workflows refuse an unresolved design outright and name no automatic fallback', () => {
 for (const template of SIMPLE) {
  for (const provider of ['openai-codex', 'openai-codex-2']) {
   const result = expand(template, 'unresolved-design', provider);
   assert.equal(result.ok, false);
   assert.equal(result.value, undefined);
   assert.match(result.error, /well-developed tasks only/);
   assert.match(result.error, /No template is substituted automatically/);
  }
 }
});

test('simple workflows with unknown readiness preview, but demand confirmation and infer nothing', () => {
 for (const template of SIMPLE) {
  const result = expand(template, 'unknown');
  assert.equal(result.ok, true);
  const readinessWarning = result.value.warnings[1];
  assert.match(readinessWarning, /Task readiness is unknown/);
  assert.match(readinessWarning, /confirm the task is well developed before execution/);
  assert.match(readinessWarning, /never inferred from an issue title or body/);
 }
});

test('the heavier templates keep unknown or unresolved evidence for the Coordinator to design', () => {
 for (const template of HEAVIER) {
  const unknown = expand(template, 'unknown');
  assert.equal(unknown.ok, true, `${template} must accept unknown readiness`);
  assert.match(unknown.value.warnings[1], /Coordinator must resolve the remaining evidence and design/);

  const unresolved = expand(template, 'unresolved-design');
  assert.equal(unresolved.ok, true, `${template} must accept an unresolved design`);
  assert.match(unresolved.value.warnings[1], /Coordinator must complete the solution design before worker dispatch/);
 }
});

test('readiness never changes the role matrix, only the warnings', () => {
 const ready = expand('openai-codex-high', 'ready').value;
 const unknown = expand('openai-codex-high', 'unknown').value;
 assert.deepEqual(unknown.roles, ready.roles);
 assert.deepEqual(unknown.instructions, ready.instructions);
 assert.equal(unknown.warnings.length, ready.warnings.length + 1);
});
