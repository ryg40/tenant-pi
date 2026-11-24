// A small Markdown renderer that builds DOM nodes. It never sets innerHTML:
// every piece of text goes through a text node. It knows the blocks that the
// memory stores use: headings, paragraphs, lists, quotes, fenced code, tables
// and rules; and the inline forms code, bold, emphasis, links, [[wiki links]]
// and the OpenViking privacy placeholders.

const PRIVACY = /\{\{ov_privacy:[^}]*\}\}/;
const MAX_QUOTE_DEPTH = 8;

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function renderText(text) {
  const wrap = el('div', { class: 'md md-text' });
  for (const para of String(text ?? '').split(/\n{2,}/)) {
    if (para.trim()) wrap.append(el('p', {}, para));
  }
  return wrap;
}

export function renderMarkdown(source) {
  return renderBlocks(source, 0);
}

function renderBlocks(source, quoteDepth) {
  const root = el('div', { class: 'md' });
  const text = String(source ?? '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i += 1; continue; }

    const fence = line.match(/^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/);
    if (fence) {
      const body = [];
      const end = new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`);
      i += 1;
      while (i < lines.length && !end.test(lines[i])) { body.push(lines[i]); i += 1; }
      i += 1;
      root.append(el('pre', {}, el('code', fence[2] ? { 'data-lang': fence[2] } : {}, body.join('\n'))));
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.min(6, heading[1].length + 2);
      const content = heading[2].trimEnd();
      let end = content.length;
      while (end > 0 && content[end - 1] === '#') end -= 1;
      root.append(el(`h${level}`, {}, ...inline(content.slice(0, end).trimEnd())));
      i += 1;
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { root.append(el('hr')); i += 1; continue; }

    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(lines[i]); i += 1; }
      root.append(table(rows));
      continue;
    }

    if (/^\s*>/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        body.push(quoteDepth < MAX_QUOTE_DEPTH ? lines[i].replace(/^\s*>\s?/, '') : lines[i]);
        i += 1;
      }
      // Keep excess markers literal instead of recursing through untrusted text.
      if (quoteDepth >= MAX_QUOTE_DEPTH) root.append(el('p', {}, body.join('\n')));
      else {
        const quote = renderBlocks(body.join('\n'), quoteDepth + 1);
        root.append(el('blockquote', {}, ...quote.childNodes));
      }
      continue;
    }

    const bullet = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
    if (bullet.test(line)) {
      const ordered = /\d/.test(line.match(bullet)[2]);
      const list = el(ordered ? 'ol' : 'ul');
      while (i < lines.length && (bullet.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && list.lastChild))) {
        const m = lines[i].match(bullet);
        if (m) {
          if (/\d/.test(m[2]) !== ordered) break;
          const li = el('li', m[1].length >= 2 ? { class: 'nested' } : {});
          const task = m[3].match(/^\[([ xX])\]\s+(.*)$/);
          if (task) li.append(el('span', { class: 'task', text: task[1] === ' ' ? '☐ ' : '☑ ' }), ...inline(task[2]));
          else li.append(...inline(m[3]));
          list.append(li);
        } else {
          list.lastChild.append(' ', ...inline(lines[i].trim()));
        }
        i += 1;
      }
      root.append(list);
      continue;
    }

    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*```|\s*~~~|\s*>|\s*\|.*\|\s*$|\s*([-*+]|\d+[.)])\s)/.test(lines[i]) && !/^\s*([-*_])(\s*\1){2,}\s*$/.test(lines[i])) {
      para.push(lines[i].trim());
      i += 1;
    }
    if (para.length === 0) { para.push(line.trim()); i += 1; }
    root.append(el('p', {}, ...inline(para.join(' '))));
  }
  return root;
}

function table(rows) {
  const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const body = rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r));
  const [head, ...rest] = body;
  const t = el('table');
  if (head) t.append(el('thead', {}, el('tr', {}, ...cells(head).map((c) => el('th', { scope: 'col' }, ...inline(c))))));
  t.append(el('tbody', {}, ...rest.map((r) => el('tr', {}, ...cells(r).map((c) => el('td', {}, ...inline(c)))))));
  return el('div', { class: 'table-wrap' }, t);
}

// One scan finds the earliest form; separate scans would revisit the entire
// suffix for every token. Alternatives keep their order when matches tie.
const INLINE = [
  ['code', /`([^`]+)`/],
  ['private', PRIVACY],
  ['wiki', /\[\[([^\]|]{1,300})(?:\|([^\]]{1,300}))?\]\]/],
  ['link', /\[([^\]]{1,300})\]\(([^)\s]+)(?:\s+"[^"]*")?\)/],
  ['bold', /\*\*([^*]+)\*\*|__([^_]+)__/],
  ['em', /(?<![\w*])\*([^*\s][^*]*?)\*(?!\w)|(?<![\w_])_([^_\s][^_]*?)_(?![\w_])/],
  ['url', /https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/],
];

const INLINE_TOKEN = new RegExp(INLINE.map(([kind, re]) => `(?<${kind}>${re.source})`).join('|'));

export function inline(text) {
  const out = [];
  let rest = String(text ?? '');
  while (rest) {
    const m = INLINE_TOKEN.exec(rest);
    if (!m) { out.push(rest); break; }
    const [kind, re] = INLINE.find(([kind]) => m.groups[kind] !== undefined);
    if (m.index > 0) out.push(rest.slice(0, m.index));
    out.push(token(kind, re.exec(m[0])));
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

function token(kind, m) {
  switch (kind) {
    case 'code': return el('code', {}, m[1]);
    case 'private': return el('span', { class: 'private', title: 'OpenViking privacy placeholder: the value stays in the privacy store.' }, 'private value');
    case 'wiki': return el('span', { class: 'wikilink', title: `Wiki link: ${m[1]}` }, m[2] ?? m[1]);
    case 'link': return safeLink(m[2], inline(m[1]));
    case 'bold': return el('strong', {}, ...inline(m[1] ?? m[2]));
    case 'em': return el('em', {}, ...inline(m[1] ?? m[2]));
    case 'url': return safeLink(m[0], [m[0]]);
    default: return m[0];
  }
}

function safeLink(href, children) {
  if (!/^https?:\/\//i.test(href)) return el('span', { class: 'link-off', title: href }, ...children);
  return el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, ...children);
}
