// Shared helpers: the item shape, dates, front matter, text scoring and snippets.
// An item is the unit that every adapter returns in a list:
//   { source, id, title, snippet, scope, kind, date, dateLabel, tags }
// `date` is an ISO 8601 string or null. `dateLabel` says which date it is.

export const SNIPPET_LENGTH = 220;

export function makeItem(source, fields) {
  return {
    source,
    id: String(fields.id),
    title: clean(fields.title) || '(untitled)',
    snippet: fields.snippet ?? '',
    scope: fields.scope ?? '',
    kind: fields.kind ?? '',
    date: toIso(fields.date),
    dateLabel: fields.dateLabel ?? (fields.date ? 'updated' : ''),
    tags: Array.isArray(fields.tags) ? fields.tags.slice(0, 12).map(String) : [],
    ...(typeof fields.score === 'number' ? { score: fields.score } : {}),
  };
}

export function clean(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

export function toIso(value) {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// The first sentence or line of a text, at most `max` characters.
export function titleFrom(text, max = 96) {
  const body = stripMarkup(text);
  const first = body.split(/(?<=[.!?])\s|\n/)[0] || body;
  return truncate(first, max);
}

export function truncate(text, max) {
  const t = clean(text);
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.6 ? cut.slice(0, space) : cut) + '…';
}

export function stripMarkup(text) {
  return String(text ?? '')
    .replace(/\{\{ov_privacy:[^}]*\}\}/g, '‹private›')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#+\s*/gm, '')
    .replace(/[*_`>]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]*)(\|[^\]]*)?\]\]/g, '$1')
    .replace(/^[ \t|:]*-{3}[- \t|:]*\r?$/gm, ' ')
    .replace(/^[ \t]*\|[^\r\n]*\|[ \t]*\r?$/gm, (row) => row.replace(/\|/g, ' '))
    .trim();
}

// Minimal YAML front matter: `key: value` lines and `key: [a, b]` lists.
// Nested values stay as text. The result is for display, not for a decision.
export function parseFrontMatter(text) {
  const src = String(text ?? '');
  const m = src.match(/^---\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m);
  if (!m || m.index !== 0) return { meta: {}, body: src };
  const meta = {};
  let lastKey = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (kv) {
      lastKey = kv[1];
      let v = kv[2].trim();
      if (/^\[.*\]$/.test(v)) {
        v = v.slice(1, -1).split(',').map((s) => unquote(s.trim())).filter(Boolean);
      } else {
        v = unquote(v);
      }
      Object.defineProperty(meta, lastKey, { value: v, enumerable: true, writable: true, configurable: true });
    } else if (lastKey && /^\s+-\s+/.test(line)) {
      const item = unquote(line.replace(/^\s+-\s+/, '').trim());
      if (!Array.isArray(meta[lastKey])) meta[lastKey] = meta[lastKey] ? [meta[lastKey]] : [];
      meta[lastKey].push(item);
    }
  }
  return { meta, body: src.slice(m[0].length) };
}

function unquote(s) {
  return s.replace(/^(['"])(.*)\1$/, '$2');
}

// Query terms: lower case words of two or more characters.
export function terms(query) {
  return Array.from(new Set(
    String(query ?? '').toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((t) => t.length >= 2),
  )).slice(0, 12);
}

// A plain text score. Every term must occur (AND). Title hits count more.
// A match of the whole query as a phrase adds a bonus. 0 means no match.
export function scoreText(query, title, body) {
  const ts = terms(query);
  if (ts.length === 0) return 0;
  const t = String(title ?? '').toLowerCase();
  const b = String(body ?? '').toLowerCase();
  let score = 0;
  for (const term of ts) {
    const inTitle = countOf(t, term);
    const inBody = countOf(b, term);
    if (inTitle + inBody === 0) return 0;
    score += inTitle * 4 + Math.min(inBody, 8) + 1;
  }
  const phrase = String(query).toLowerCase().trim();
  if (ts.length > 1 && (t.includes(phrase) || b.includes(phrase))) score += 6;
  return score;
}

function countOf(haystack, needle) {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1 && n < 50) {
    n += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

// A window of the text around the first term, or the start of the text.
export function snippetFor(text, query, max = SNIPPET_LENGTH) {
  const body = clean(stripMarkup(text));
  const ts = terms(query);
  const lower = body.toLowerCase();
  let at = -1;
  for (const term of ts) {
    const i = lower.indexOf(term);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  if (at <= max / 3) return truncate(body, max);
  const start = body.lastIndexOf(' ', at - Math.floor(max / 3));
  return '…' + truncate(body.slice(start + 1), max - 1);
}

// Run a promise with a deadline. The error has code "timeout".
export async function withTimeout(promise, ms, what = 'request') {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${what} took longer than ${ms} ms`);
      err.code = 'timeout';
      reject(err);
    }, ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

// An error for the API: a stable code and a short message without secrets.
export class SourceError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const ERROR_MESSAGES = {
  aws_failed: 'The AgentCore namespace read failed.',
  bad_request: 'The request has an invalid or missing parameter.',
  bad_path: 'The path is not valid for this source.',
  bad_reply: 'The service returned an invalid reply.',
  config: 'The source is not configured correctly.',
  credentials: 'No credential is available for this source.',
  denied: 'The service denied the read.',
  failed: 'The read failed.',
  method: 'This method is not allowed.',
  not_found: 'Not found.',
  review_denied: 'The service denied the record move.',
  review_failed: 'The record move failed.',
  review_off: 'This source or this record allows no review.',
  not_mounted: 'The source directory is not available.',
  outside_roots: 'The path is outside the configured roots.',
  timeout: 'The source did not reply before the deadline.',
  unknown_namespace: 'The namespace is not in the configuration.',
  unknown_source: 'No source has this id.',
  unreachable: 'The service is not reachable.',
};

export function publicError(err) {
  // Adapter messages can contain service replies. Publish only fixed messages.
  let code = 'failed';
  if (err instanceof SourceError && Object.hasOwn(ERROR_MESSAGES, err.code)) code = err.code;
  else if (err?.code === 'timeout') code = 'timeout';
  else if (err?.name === 'AccessDeniedException' || err?.$metadata?.httpStatusCode === 403) code = 'denied';
  else if (err?.name === 'CredentialsProviderError') code = 'credentials';
  return { code, message: ERROR_MESSAGES[code] };
}
