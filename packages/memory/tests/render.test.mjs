import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { el, inline, renderMarkdown, renderText } from '../ui/render.js';

// Only the DOM operations used by the renderer exist in this shim.
class Node {
  constructor(tag = null, text = '') {
    this.tagName = tag?.toUpperCase() ?? null;
    this.value = text;
    this.childNodes = [];
    this.attributes = {};
    this.listeners = {};
  }
  append(...children) {
    for (const child of children) this.childNodes.push(typeof child === 'string' ? new Node(null, child) : child);
  }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(key, value) { this.listeners[key] = value; }
  set className(value) { this.setAttribute('class', value); }
  get className() { return this.attributes.class ?? ''; }
  set textContent(value) { this.childNodes = []; this.value = String(value); }
  get textContent() { return this.value + this.childNodes.map((child) => child.textContent).join(''); }
  get lastChild() { return this.childNodes.at(-1); }
}

globalThis.document = {
  createElement: (tag) => new Node(tag),
  createTextNode: (text) => new Node(null, text),
};

function descendants(node, tag) {
  return [node, ...node.childNodes.flatMap((child) => descendants(child))]
    .filter((child) => !tag || child.tagName === tag.toUpperCase());
}
function tokens(text) { return el('div', {}, ...inline(text)); }

test('el builds text nodes and registers events without markup parsing', () => {
  const listener = () => {};
  const node = el('button', { class: 'quiet', disabled: true, hidden: false, title: null, onclick: listener }, '<script>sample</script>');
  assert.equal(node.className, 'quiet');
  assert.equal(node.attributes.disabled, '');
  assert.equal(node.attributes.hidden, undefined);
  assert.equal(node.listeners.click, listener);
  assert.equal(node.childNodes[0].tagName, null);
  assert.equal(node.textContent, '<script>sample</script>');
});

test('inline tokenizer emits the earliest token and preserves surrounding text', () => {
  const node = tokens('Before **bold** and _em_ then `literal *code*` after.');
  assert.equal(node.textContent, 'Before bold and em then literal *code* after.');
  assert.equal(descendants(node, 'strong')[0].textContent, 'bold');
  assert.equal(descendants(node, 'em')[0].textContent, 'em');
  assert.equal(descendants(node, 'code')[0].textContent, 'literal *code*');
});

test('inline nested emphasis, wiki aliases and privacy placeholders stay separate', () => {
  const node = tokens('**Read _carefully_** [[concepts/sample|Sample]] {{ov_privacy:sample:viking://user/sample/privacy#/values/key}}');
  assert.equal(descendants(node, 'strong')[0].textContent, 'Read carefully');
  assert.equal(descendants(node, 'em')[0].textContent, 'carefully');
  const spans = descendants(node, 'span');
  assert.equal(spans[0].className, 'wikilink');
  assert.equal(spans[0].textContent, 'Sample');
  assert.equal(spans[1].className, 'private');
  assert.ok(!JSON.stringify(node).includes('/values/key'));
});

test('only HTTP links are active; raw HTML and images never become elements', () => {
  const node = tokens('[safe](https://example.invalid/sample) [unsafe](javascript:alert) [local](/sample) <img src=x onerror=sample> ![image](data:image/png;base64,sample)');
  const links = descendants(node, 'a');
  assert.equal(links.length, 1);
  assert.equal(links[0].attributes.rel, 'noopener noreferrer');
  assert.equal(links[0].attributes.target, '_blank');
  assert.equal(descendants(node, 'img').length, 0);
  assert.equal(descendants(node, 'script').length, 0);
  assert.equal(descendants(node, 'span').filter((span) => span.className === 'link-off').length, 3);
  assert.match(node.textContent, /<img src=x onerror=sample>/);
});

test('bare URL punctuation stays outside the link', () => {
  const node = tokens('Read https://example.invalid/sample, then https://example.invalid/notes.');
  assert.deepEqual(descendants(node, 'a').map((link) => link.attributes.href),
    ['https://example.invalid/sample', 'https://example.invalid/notes']);
  assert.equal(node.textContent, 'Read https://example.invalid/sample, then https://example.invalid/notes.');
});

test('unmatched delimiters and null inline input remain safe', () => {
  assert.equal(tokens('**open [[unfinished `code <script>sample</script>').textContent, '**open [[unfinished `code <script>sample</script>');
  assert.deepEqual(inline(null), []);
});

test('deep quotes and unmatched brackets render within a bounded time', { timeout: 1000 }, async () => {
  const quoted = renderMarkdown('>'.repeat(5000));
  const quotes = descendants(quoted, 'blockquote');
  assert.ok(quotes.length > 0 && quotes.length < 100);
  assert.equal(quoted.textContent, '>'.repeat(5000 - quotes.length));
  const brackets = '['.repeat(50000);
  assert.equal(renderMarkdown(brackets).textContent, brackets);
  // Let the test deadline run after the synchronous renderer finishes.
  await setImmediate();
});

test('Markdown headings, paragraphs and rules preserve text', () => {
  const node = renderMarkdown('# Sample\r\n\r\nA paragraph\r\ncontinues.\r\n---\r\n###### Deep heading');
  const headings = descendants(node).filter((child) => /^H[1-6]$/.test(child.tagName));
  assert.deepEqual(headings.map((heading) => heading.textContent), ['Sample', 'Deep heading']);
  assert.equal(descendants(node, 'p')[0].textContent, 'A paragraph continues.');
  assert.equal(descendants(node, 'hr').length, 1);
});

test('fenced code is literal, including HTML comments and shorter fences', () => {
  const node = renderMarkdown('````html\n<!-- sample -->\n<script>sample</script>\n```\n````\n\n~~~text\n**literal**\n~~~');
  const code = descendants(node, 'code');
  assert.equal(code[0].textContent, '<!-- sample -->\n<script>sample</script>\n```');
  assert.equal(code[0].attributes['data-lang'], 'html');
  assert.equal(code[1].textContent, '**literal**');
  assert.equal(descendants(node, 'script').length, 0);
  assert.equal(renderMarkdown('```\nunclosed').textContent, 'unclosed');
});

test('lists, task markers, continuations and quotes render in their blocks', () => {
  const node = renderMarkdown('- [x] Done\n- [ ] Pending\n  continuation\n1. Ordered\n2. Second\n\n> Quoted **text**\n> next line');
  assert.equal(descendants(node, 'ul').length, 1);
  assert.equal(descendants(node, 'ol').length, 1);
  const pending = descendants(node, 'li')[1];
  assert.match(pending.textContent, /Pending/);
  assert.match(pending.textContent, /continuation/);
  assert.ok(descendants(pending, 'span').some((span) => span.className === 'task'));
  assert.equal(descendants(node, 'blockquote')[0].textContent, 'Quoted text next line');
});

test('Markdown tables create scoped headers and do not render the separator row', () => {
  const node = renderMarkdown('| Source | State |\n| :--- | ---: |\n| **Sample** | Ready |');
  assert.equal(descendants(node, 'table').length, 1);
  assert.equal(descendants(node, 'tr').length, 2);
  assert.deepEqual(descendants(node, 'th').map((cell) => cell.attributes.scope), ['col', 'col']);
  assert.deepEqual(descendants(node, 'td').map((cell) => cell.textContent), ['Sample', 'Ready']);
});

test('text format does not interpret Markdown or fetch links', () => {
  const node = renderText('**literal**\nline\n\nhttps://example.invalid/sample <img>');
  assert.equal(descendants(node, 'p').length, 2);
  assert.equal(descendants(node, 'strong').length, 0);
  assert.equal(descendants(node, 'a').length, 0);
  assert.match(node.textContent, /\*\*literal\*\*/);
  assert.equal(renderText(null).textContent, '');
});

test('synthetic fixture ids stay in the sample namespace', async () => {
  const directory = new URL('../sample/', import.meta.url);
  for (const file of (await readdir(directory)).filter((file) => file.endsWith('.json'))) {
    const fixture = JSON.parse(await readFile(new URL(file, directory)));
    for (const doc of fixture.docs) assert.match(doc.id, /^sample-/);
  }
});

test('UI sources contain no markup sinks, inline style attributes or remote assets', async () => {
  const directory = new URL('../ui/', import.meta.url);
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const files = await Promise.all(entries.filter((entry) => entry.isFile())
    .map((entry) => readFile(`${entry.parentPath}/${entry.name}`, 'utf8')));
  const text = files.join('\n');
  assert.doesNotMatch(text, /\.(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write\s*\(/);
  assert.doesNotMatch(text, /\bstyle\s*=|setAttribute\(['"]style['"]|\.cssText\s*=/);
  assert.doesNotMatch(text, /(?:src|href)=["']https?:|@import|url\(["']?https?:/);
});
