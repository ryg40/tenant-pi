import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseFrontMatter, publicError, scoreText, snippetFor, SourceError, stripMarkup, titleFrom, toIso, withTimeout } from '../lib/model.mjs';

const { docs } = JSON.parse(await readFile(new URL('../sample/openviking-bob.json', import.meta.url), 'utf8'));

test('front matter parses scalars, quoted values, inline lists and block lists', () => {
  const text = '---\r\ntitle: "Sample title"\r\ntags: [one, "two", \'three\']\r\nlinks:\r\n  - first\r\n  - "second"\r\nnested: {key: value}\r\n---\r\nBody';
  assert.deepEqual(parseFrontMatter(text), {
    meta: { title: 'Sample title', tags: ['one', 'two', 'three'], links: ['first', 'second'], nested: '{key: value}' },
    body: 'Body',
  });
  for (const text of ['Body', '---\ntitle: sample', 'prefix\n---\ntitle: sample\n---\nBody', '---\ntitle: sample\n---suffix']) {
    assert.deepEqual(parseFrontMatter(text), { meta: {}, body: text });
  }
  assert.deepEqual(parseFrontMatter(null), { meta: {}, body: '' });
  assert.deepEqual(parseFrontMatter('---\n---\nBody'), { meta: {}, body: 'Body' });
  assert.deepEqual(parseFrontMatter('---\ntitle: sample\n---'), { meta: { title: 'sample' }, body: '' });
  const { meta } = parseFrontMatter('---\n__proto__: [sample]\n  - value\nconstructor: display\n---\nBody');
  assert.equal(Object.getPrototypeOf(meta), Object.prototype);
  assert.deepEqual(meta.__proto__, ['sample', 'value']);
  assert.equal(meta.constructor, 'display');
  assert.equal({}.sample, undefined);
});

test('text scoring requires every term, weights titles and limits repeated hits', () => {
  assert.equal(scoreText('a !', 'a', 'a'), 0);
  assert.equal(scoreText('alpha beta', 'alpha', 'gamma'), 0);
  assert.equal(scoreText('ALPHA', 'Alpha', ''), 5);
  assert.equal(scoreText('alpha alpha', '', 'alpha'), 2);
  assert.equal(scoreText('alpha', '', 'alpha '.repeat(100)), 9);
  assert.equal(scoreText('alpha beta', '', 'alpha beta'), 10);
  assert.equal(scoreText('alpha beta', '', 'beta then alpha'), 4);
  assert.equal(scoreText('alpha', null, undefined), 0);
});

test('snippets strip markup, use the earliest match and stay bounded', () => {
  assert.equal(snippetFor('# Sample **title**\n\nA [link](https://example.invalid).', ''), 'Sample title A link.');
  assert.equal(snippetFor(null, 'sample'), '');
  const body = `${'start '.repeat(40)}alpha ${'middle '.repeat(30)}beta ${'end '.repeat(40)}`;
  const snippet = snippetFor(body, 'beta alpha', 80);
  assert.ok(snippet.includes('alpha'));
  assert.ok(!snippet.includes('beta'));
  assert.ok(snippet.length <= 80);
  assert.equal(snippet.codePointAt(0), 0x2026);
  assert.ok(snippetFor(body, 'absent', 80).startsWith('start'));
  assert.ok(snippetFor(body, 'absent', 80).length <= 80);
  const table = docs.find((doc) => doc.id === 'sample-bob-gateway');
  const privateDoc = docs.find((doc) => doc.id === 'sample-bob-reports');
  for (const render of [stripMarkup, (text) => snippetFor(text, 'placeholder')]) {
    const text = render(`${privateDoc.body}\n${privateDoc.body}`);
    assert.doesNotMatch(text, /ov_privacy|viking:\/\/|privacy\/credential|values\/token/);
    assert.ok(text.includes('placeholder stays private'));
  }
  for (const render of [stripMarkup, (text) => snippetFor(text, 'Check')]) {
    const text = render(table.body);
    assert.doesNotMatch(text, /\||---/);
    assert.ok(text.includes('Check'));
    assert.ok(text.includes('Result'));
    assert.ok(text.includes('Ready'));
    const plain = render('Check | Result\n:--- | ---:\nSample | Ready');
    assert.ok(plain.includes('Check | Result'));
    assert.ok(plain.includes('Sample | Ready'));
    assert.doesNotMatch(plain, /---/);
    assert.equal(render('a | b'), 'a | b');
  }
});

test('titles use the first sentence or line after removing markup', () => {
  assert.equal(titleFrom('# First sentence. Next sentence.'), 'First sentence.');
  assert.equal(titleFrom('First line\nSecond line'), 'First line');
  assert.equal(titleFrom('# a | b'), 'a | b');
  assert.equal(titleFrom('---\r\ntitle: hidden\r\n---\r\n# Visible'), 'Visible');
  assert.equal(titleFrom(null), '');
  assert.ok(titleFrom('sample '.repeat(50), 20).length <= 20);
});

test('dates normalize valid values and reject absent or invalid dates', () => {
  assert.equal(toIso('2026-01-02T03:00:00+03:00'), '2026-01-02T00:00:00.000Z');
  assert.equal(toIso(new Date('2026-01-02')), '2026-01-02T00:00:00.000Z');
  assert.equal(toIso(0), '1970-01-01T00:00:00.000Z');
  for (const value of [null, undefined, '', 'not a date', new Date(NaN)]) assert.equal(toIso(value), null);
});

test('public errors use fixed messages, including adapter and timeout failures', () => {
  const privateText = '/sample/private/file sample-secret sample-content';
  for (const err of [new Error(privateText), new SourceError('failed', privateText), new SourceError(privateText, privateText), Object.assign(new Error(privateText), { code: 'timeout' })]) {
    assert.doesNotMatch(JSON.stringify(publicError(err)), /sample-private|sample-secret|sample-content|\/sample\/private|stack/);
  }
  assert.equal(publicError({ name: 'AccessDeniedException' }).code, 'denied');
  assert.equal(publicError({ $metadata: { httpStatusCode: 403 } }).code, 'denied');
  assert.equal(publicError({ name: 'CredentialsProviderError' }).code, 'credentials');
});

test('deadlines return successes, reject timeouts and preserve original failures', async () => {
  assert.equal(await withTimeout(Promise.resolve(3), 100), 3);
  const error = new Error('sample error');
  await assert.rejects(withTimeout(Promise.reject(error), 100), (err) => err === error);
  await assert.rejects(withTimeout(new Promise(() => {}), 10), { code: 'timeout' });
});
