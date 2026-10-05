import test from 'node:test';
import assert from 'node:assert/strict';
import { herdrRoleName, herdrRoleNameFromList, parseHerdrWorkspaceList, workspacePrefix } from '../../dist/src/herdr/naming.mjs';

const valid = (name) => /^[a-z][a-z0-9_-]{0,31}$/.test(name);

test('Promptr role names include the coordinator and researcher examples', () => {
  const workspace = { id: 'wR', label: 'Promptr' };
  const list = [workspace];
  assert.equal(herdrRoleName(workspace, 'coordinator', list), 'prompt-coord');
  assert.equal(herdrRoleName(workspace, 'researcher', list), 'prompt-resea');
  for (const role of ['planner', 'reviewer', 'worker', 'generator']) assert.ok(valid(herdrRoleName(workspace, role, list)));
});

test('normalization, malformed labels, duplicate labels and shortening are deterministic and valid', () => {
  assert.equal(workspacePrefix('  My Project!! '), 'my-project');
  assert.equal(workspacePrefix('123'), undefined);
  const duplicate = [{ id: 'wA', label: 'Same project' }, { id: 'wB', label: 'same--project' }];
  const a = herdrRoleName(duplicate[0], 'coordinator', duplicate);
  const b = herdrRoleName(duplicate[1], 'coordinator', duplicate);
  assert.notEqual(a, b);
  const longA = herdrRoleName({ id: 'wLongA', label: 'This workspace label is much too long to fit naturally' }, 'researcher', duplicate);
  const malformed = herdrRoleName({ id: 'wOdd', label: '--- 123 ---' }, 'worker', duplicate);
  const unknownA = herdrRoleName({ id: 'wA', label: 'Promptr' }, 'coordinator');
  const unknownB = herdrRoleName({ id: 'wB', label: 'Promptr' }, 'coordinator');
  for (const name of [a, b, longA, malformed, unknownA, unknownB]) assert.ok(valid(name), name);
  assert.notEqual(unknownA, unknownB, 'missing bounded list uses opaque-ID fallback');
  assert.equal(herdrRoleName({ id: 'wOdd', label: '--- 123 ---' }, 'worker', duplicate), malformed);
});

test('bounded live workspace evidence supplies labels and malformed or duplicate lists use ID fallback', () => {
  const live = JSON.stringify({ result: { workspaces: [
    { workspace_id: 'wR', label: 'Promptr' },
    { workspace_id: 'wV', label: 'Example Repo' },
  ] } });
  assert.deepEqual(parseHerdrWorkspaceList(live), [
    { id: 'wR', label: 'Promptr' }, { id: 'wV', label: 'Example Repo' },
  ]);
  assert.equal(herdrRoleNameFromList('wR', 'coordinator', live), 'prompt-coord');
  assert.equal(herdrRoleNameFromList('wR', 'researcher', live), 'prompt-resea');
  const fallback = herdrRoleName({ id: 'wR' }, 'coordinator');
  assert.equal(herdrRoleNameFromList('wR', 'coordinator', '{bad'), fallback);
  const duplicateIds = JSON.stringify({ result: { workspaces: [
    { workspace_id: 'wR', label: 'Promptr' }, { workspace_id: 'wR', label: 'Other' },
  ] } });
  assert.equal(parseHerdrWorkspaceList(duplicateIds), undefined);
  assert.equal(herdrRoleNameFromList('wR', 'coordinator', duplicateIds), fallback);
  const oversized = JSON.stringify({ result: { workspaces: Array.from({ length: 65 }, (_, i) => ({ workspace_id: `w${i}`, label: 'X' })) } });
  assert.equal(parseHerdrWorkspaceList(oversized), undefined);
});
