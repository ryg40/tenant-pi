import assert from 'node:assert/strict';
import test from 'node:test';
import { browseRequest, searchRequest, searchSelection, sourceSearchRequest } from '../ui/selection.js';

const sources = [
  { id: 'sample-files', lazy: false },
  { id: 'sample-aws', lazy: true },
];

test('default search excludes lazy sources until explicitly selected', () => {
  assert.deepEqual(searchSelection(sources, {}), ['sample-files']);
  assert.equal(searchRequest(sources, { q: 'sample' }).sources, 'sample-files');
  assert.equal(searchRequest(sources, { q: 'sample', s: 'sample-aws' }).sources, 'sample-aws');
});

test('empty source selection produces no search request', () => {
  assert.equal(searchRequest(sources, { q: 'sample', s: '' }), null);
  assert.equal(searchRequest(sources, { q: 'sample', s: 'unknown' }), null);
  assert.equal(searchRequest(sources, { q: '   ', s: 'sample-aws' }), null);
  assert.equal(searchRequest(sources.filter((source) => source.lazy), { q: 'sample' }), null);
});

test('source search without a path does not select a namespace', () => {
  assert.equal(sourceSearchRequest({ q: 'sample' }).path, '');
});

test('opening a lazy source loads no namespace without an explicit path', () => {
  assert.equal(browseRequest({}).path, '');
  assert.equal(browseRequest({ item: 'sample-record' }).path, '');
  assert.equal(browseRequest({ path: '/sample/shared' }).path, '/sample/shared');
  assert.equal(browseRequest({ path: '/sample/shared', q: 'sample' }).path, '');
});
