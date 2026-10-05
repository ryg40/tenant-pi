import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  herdrWorkspaceFromPaneId, isHerdrPaneId, isHerdrPaneInWorkspace,
  isHerdrTabId, isHerdrWorkspaceId,
} from '../../dist/src/herdr/identity.mjs';

test('Herdr identity validators accept numeric, alphabetic and mixed suffixes', () => {
  for (const id of ['w8', 'wR', 'wAlpha2']) assert.equal(isHerdrWorkspaceId(id), true, id);
  for (const id of ['w8:pT', 'wR:p1', 'wAlpha2:pZ9']) assert.equal(isHerdrPaneId(id), true, id);
  for (const id of ['w8:tJ', 'wR:t1', 'wAlpha2:ta']) assert.equal(isHerdrTabId(id), true, id);
});

test('Herdr identity validators reject malformed and cross-workspace ids', () => {
  for (const id of ['', 'w', 'xR', 'wR!', 'wR:p1', 'wR\n', 'wR\r\n']) assert.equal(isHerdrWorkspaceId(id), false, JSON.stringify(id));
  for (const id of ['', 'wR', 'wR:p', 'wR:p1!', 'wR:t1', 'xR:p1', 'wR:p1\n', 'wR:p1\r\n']) assert.equal(isHerdrPaneId(id), false, JSON.stringify(id));
  for (const id of ['', 'wR', 'wR:t', 'wR:t1!', 'wR:p1', 'xR:t1', 'wR:t1\n', 'wR:t1\r\n']) assert.equal(isHerdrTabId(id), false, JSON.stringify(id));
  assert.equal(isHerdrPaneInWorkspace('wR:p1', 'wR'), true);
  assert.equal(isHerdrPaneInWorkspace('w8:p1', 'wR'), false);
  assert.equal(herdrWorkspaceFromPaneId('wR:p1'), 'wR');
  assert.equal(herdrWorkspaceFromPaneId('bad'), undefined);
});
