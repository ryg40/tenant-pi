#!/usr/bin/env node
// A conservative source guard, not a JavaScript sandbox. Tests may write fixtures.
// One named exception: the record move command in lib/adapters/agentcore-review.mjs.
// Scan app sources except tests, samples, dependencies and this guard.
// Files importing open/openSync cannot use template interpolation.
// Known limits: dynamic OpenViking routes, okknow exec text, and regex-literal comment stripping.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP = fileURLToPath(new URL('.', import.meta.url));
const FS_READS = new Set([
  'access', 'accessSync', 'constants', 'existsSync', 'readFile', 'readFileSync',
  'read', 'readSync', 'readv', 'readvSync', 'readdir', 'readdirSync', 'opendir',
  'opendirSync', 'realpath', 'realpathSync', 'stat', 'statSync', 'lstat', 'lstatSync',
  'fstat', 'fstatSync', 'readlink', 'readlinkSync', 'open', 'openSync', 'close',
  'closeSync', 'createReadStream',
]);
const FS_WRITES = 'appendFile|writeFile|writev|createWriteStream|mkdir|mkdtemp|rm|rmdir|unlink|rename|copyFile|cp|chmod|chown|lchmod|lchown|fchmod|fchown|utimes|lutimes|futimes|ftruncate|link|symlink';
const AWS_READS = new Set(['ListMemoryRecordsCommand', 'RetrieveMemoryRecordsCommand']);
// The one write of the app, on the word of the owner: the record move of a review source, in one file only.
const AWS_REVIEW = { file: 'lib/adapters/agentcore-review.mjs', command: 'BatchUpdateMemoryRecordsCommand' };
const OV_READS = new Set(['fs/ls', 'fs/stat', 'content/read', 'search/find', 'search/grep']);

// Preserve string contents and line numbers. Regex literals need separate review.
function withoutComments(source) {
  return source.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (part) => part.startsWith('//') || part.startsWith('/*') ? part.replace(/[^\n]/g, ' ') : part);
}

// Strings stay whole so commas and brackets inside them do not split arguments.
function tokensOf(text) {
  return [...text.matchAll(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*|\.\.\.|\?\.|[^\s]/g)]
    .map((m) => ({ value: m[0], index: m.index }));
}

function groupAt(tokens, start) {
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const stack = [pairs[tokens[start]?.value]];
  if (!stack[0]) return null;
  const parts = [];
  let from = start + 1;
  for (let i = from; i < tokens.length; i += 1) {
    const value = tokens[i].value;
    if (Object.hasOwn(pairs, value)) stack.push(pairs[value]);
    else if ([')', ']', '}'].includes(value)) {
      if (stack.pop() !== value) return null;
      if (!stack.length) {
        if (i > from) parts.push(tokens.slice(from, i));
        return { parts, end: i };
      }
    } else if (value === ',' && stack.length === 1) {
      parts.push(tokens.slice(from, i));
      from = i + 1;
    }
  }
  return null;
}

function literal(value) {
  return /^(?:'[^'\\]*'|"[^"\\]*")$/.test(value ?? '') ? value.slice(1, -1) : null;
}

function readOnlyOptions(tokens) {
  if (tokens?.[0]?.value !== '{') return false;
  const group = groupAt(tokens, 0);
  if (!group || group.end !== tokens.length - 1) return false;
  let readOnly = 0;
  for (const part of group.parts) {
    const key = literal(part[0]?.value) ?? part[0]?.value;
    // No spreads, computed keys or accessors can override the readOnly setting.
    if (!/^[A-Za-z_$][\w$]*$/.test(key ?? '') || part[1]?.value !== ':') return false;
    if (key === 'readOnly') {
      if (part.length !== 3 || part[2].value !== 'true') return false;
      readOnly += 1;
    }
  }
  return readOnly === 1;
}

export function inspectSource(file, source) {
  const text = withoutComments(source);
  const findings = [];
  const seen = new Set();
  function report(rule, index, message) {
    const line = text.slice(0, index).split('\n').length;
    const key = `${rule}:${line}:${message}`;
    if (!seen.has(key)) findings.push({ file, line, rule, message });
    seen.add(key);
  }
  const each = (re, fn) => { for (const match of text.matchAll(re)) fn(match); };

  const tokens = tokensOf(text);
  const openNames = new Set();
  const openImports = new Set();
  const constantNames = new Set(['constants']);
  const sqliteImports = new Set();
  for (let i = 0; i < tokens.length; i += 1) {
    const value = tokens[i].value;
    const module = literal(value) ?? (/^`[^`\\$]*`$/.test(value) ? value.slice(1, -1) : null);
    const fs = /^(?:node:)?fs(?:\/promises)?$/.test(module ?? '');
    const sqlite = ['node:sqlite', 'sqlite', 'sqlite3', 'better-sqlite3'].includes(module);
    const child = /^(?:node:)?child_process$/.test(module ?? '');
    if (!fs && !sqlite && !child) continue;
    let start = i - 1;
    const from = tokens[start]?.value === 'from';
    if (from) {
      while (start >= 0 && !['import', 'export', ';'].includes(tokens[start].value)) start -= 1;
    }
    const loader = tokens[i - 1]?.value === '(' && ['import', 'require'].includes(tokens[i - 2]?.value);
    const sideEffect = tokens[i - 1]?.value === 'import';
    if (!from && !loader && !sideEffect) continue;
    if (child) {
      report('process-write', tokens[i].index, 'Child process imports are forbidden.');
      continue;
    }
    const group = tokens[start + 1]?.value === '{' ? groupAt(tokens, start + 1) : null;
    const named = from && tokens[start]?.value === 'import' && group?.end === i - 2;
    const allowed = named && group.parts.every((part) => {
      const name = part[0]?.value;
      const binding = part.length === 1 || (part.length === 3 && part[1].value === 'as' && /^[A-Za-z_$][\w$]*$/.test(part[2].value));
      return binding && (fs ? FS_READS.has(name) : module === 'node:sqlite' && name === 'DatabaseSync' && part.length === 1);
    });
    if (!allowed) {
      report(fs ? 'fs-write' : 'sql-write', tokens[i].index,
        fs ? 'Only named imports from the fs read allowlist are allowed.' : 'Only the named DatabaseSync import from node:sqlite is allowed.');
      continue;
    }
    for (const part of group.parts) {
      const name = part[0].value;
      const alias = part.at(-1).value;
      if (fs && ['open', 'openSync'].includes(name)) {
        openNames.add(alias);
        for (const token of part) openImports.add(token.index);
      }
      if (fs && name === 'constants') constantNames.add(alias);
      if (sqlite) sqliteImports.add(part[0].index);
    }
  }

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const name = literal(token.value) ?? token.value;
    if (openNames.size && token.value.startsWith('`') && token.value.includes('${')) {
      report('fs-write', token.index, 'Files importing open functions cannot use template interpolation.');
    }
    if (['flag', 'flags'].includes(name)) {
      let next = i + 1;
      if (tokens[i - 1]?.value === '[' && tokens[next]?.value === ']') next += 1;
      const colon = tokens[next]?.value === ':';
      const shorthand = ['{', ','].includes(tokens[i - 1]?.value) && [',', '}'].includes(tokens[next]?.value);
      const method = tokens[next]?.value === '(' && ['{', ',', 'get', 'set'].includes(tokens[i - 1]?.value);
      if (shorthand || method || (colon && (!['r', 'rs'].includes(literal(tokens[next + 1]?.value)) || ![',', '}'].includes(tokens[next + 2]?.value)))) {
        report('fs-write', token.index, 'The flag and flags options require a literal r or rs.');
      }
    }
    if ((openNames.has(name) || ['open', 'openSync'].includes(name)) && !openImports.has(token.index)) {
      let next = i + 1;
      if (tokens[next]?.value === ']' && (literal(token.value) !== null || !openNames.has(token.value))) next += 1;
      if (tokens[next]?.value === '?.') next += 1;
      if (tokens[next]?.value === '(') {
        const flags = groupAt(tokens, next)?.parts[1];
        const string = flags?.length === 1 && ['r', 'rs'].includes(literal(flags[0].value));
        const value = flags?.map((t) => t.value).join('');
        const constants = [...constantNames].some((c) => value === `${c}.O_RDONLY` || value === `${c}.O_RDONLY|${c}.O_NOFOLLOW`);
        if (!string && !constants) report('fs-write', token.index, 'Open requires literal read-only flags or O_RDONLY with optional O_NOFOLLOW.');
      } else if (openNames.has(token.value)) {
        report('fs-write', token.index, 'Imported open functions must be called directly with read-only flags.');
      }
    }
    if (name === 'DatabaseSync' && !sqliteImports.has(token.index)) {
      const call = tokens[i - 1]?.value === 'new' && token.value === name && tokens[i + 1]?.value === '(';
      const args = call ? groupAt(tokens, i + 1)?.parts : null;
      if (!args || args.length !== 2 || !readOnlyOptions(args[1])) {
        report('sql-write', token.index, 'Use new DatabaseSync with explicit readOnly: true options.');
      }
    }
    if (name === 'BedrockAgentCore') report('aws-write', token.index, 'Use BedrockAgentCoreClient with the two allowed read commands.');
  }
  each(new RegExp(`\\b(?:${FS_WRITES})(?:Sync)?(?:['"]\\s*\\])?\\s*(?:\\?\\.)?\\s*\\(`, 'g'),
    (m) => report('fs-write', m.index, 'File-system mutation is forbidden.'));
  each(/\[\s*['"](?:write|writeSync|truncate|truncateSync)['"]\s*\]\s*(?:\?\.)?\s*\(/g,
    (m) => report('fs-write', m.index, 'File and stream writes are forbidden.'));
  each(/\b(?:[\w$]+\s*(?:\?\.|\.)\s*)?(?:write|writeSync|truncate|truncateSync)\s*(?:\?\.)?\s*\(/g, (m) => {
    // The text helper is not fs.truncate; stdout and stderr are diagnostic streams.
    const prefix = text.slice(Math.max(0, m.index - 8), m.index);
    if (/^(?:stdout|stderr)\s*\.\s*write\s*\(/.test(m[0]) && prefix.endsWith('process.')) return;
    if (m[0].startsWith('truncate(') && /import\s*\{[^}]*\btruncate\b[^}]*\}\s*from\s*['"][^'"]*model\.mjs['"]|export\s+function\s+truncate\s*\(/.test(text)) return;
    report('fs-write', m.index, 'File and stream writes are forbidden.');
  });

  each(/\/api\/v1\/([a-zA-Z0-9_/-]+)/g, (m) => {
    if (!OV_READS.has(m[1])) report('openviking-write', m.index, 'OpenViking routes must be on the read allowlist.');
  });
  each(/\b(?:mcp|callTool)\s*\(\s*(['"`])([^'"`]+)\1/g, (m) => {
    if (!['search', 'exec'].includes(m[2])) report('okknow-write', m.index, 'Only the search and exec MCP tools are allowed.');
  });
  each(/(?:['"]tools\/call['"]\s*,|\bcallTool\s*\()\s*\{\s*(?:['"]name['"]|name)\s*:\s*(['"])([^'"]+)\1/g, (m) => {
    if (!['search', 'exec'].includes(m[2])) report('okknow-write', m.index, 'Only the search and exec MCP tools are allowed.');
  });
  each(/\b[A-Z][A-Za-z0-9]*Command\b/g, (m) => {
    const review = m[0] === AWS_REVIEW.command && file.replaceAll('\\', '/') === AWS_REVIEW.file;
    if (!AWS_READS.has(m[0]) && !review) report('aws-write', m.index, 'AWS commands must be on the read allowlist.');
  });
  each(/\b(?:prepare|query|execute|exec)(?:['"]\s*\])?\s*\(\s*(['"`])([\s\S]*?)\1/g, (m) => {
    // RegExp.exec is not SQL. A database call uses a receiver or a standalone SQL verb.
    const sql = m[2].trim();
    const before = text.slice(Math.max(0, m.index - 80), m.index);
    const database = /(?:db|database|sqlite|connection)\s*(?:\.\s*|\[\s*['"])$/i.test(before);
    if (m[0].startsWith('exec') && !database && !/^(?:SELECT|PRAGMA|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|REPLACE|ATTACH|DETACH|VACUUM|BEGIN|COMMIT)\b/i.test(sql)) return;
    if (/^\s*\+/.test(text.slice(m.index + m[0].length))) {
      report('sql-write', m.index, 'SQL literals must not be concatenated at the call site.');
    }
    const statements = sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '').split(';').filter((s) => s.trim());
    if (!statements.length || statements.some((s) => !/^\s*(?:SELECT|PRAGMA)\b/i.test(s))) {
      report('sql-write', m.index, 'SQL statements must start with SELECT or PRAGMA.');
    }
    if (/\b(?:INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|REPLACE|ATTACH|DETACH|VACUUM)\b/i.test(sql)) {
      report('sql-write', m.index, 'SQL mutation is forbidden.');
    }
    // PRAGMA can write too. Permit introspection, not assignment or writable controls.
    for (const statement of statements.map((s) => s.trim())) {
      if (/^PRAGMA\b/i.test(statement) && !/^PRAGMA\s+(?:(?:table_info|table_xinfo|index_list|index_info|index_xinfo)\s*\([^;=]*\)|database_list|query_only)\s*$/i.test(statement)) {
        report('sql-write', m.index, 'Only read-only PRAGMA introspection is allowed.');
      }
    }
  });
  each(/\b(?:(?:prepare|query|execute)|(?:db|database|sqlite|connection)\s*\.\s*exec)\s*\(\s*(?!['"`])\s*([A-Za-z_$][\w$]*)/g,
    (m) => report('sql-write', m.index, 'SQL must be visible as a literal at its call site.'));

  if (file.replaceAll('\\', '/').startsWith('ui/')) {
    each(/\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b|\bdocument\s*(?:\.\s*write(?:ln)?\b|\[\s*['"]write(?:ln)?['"]\s*\])/g,
      (m) => report('ui-html', m.index, 'Use textContent and DOM nodes, not HTML injection.'));
  }
  return findings;
}

export async function checkTree(root = APP) {
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (dir === '.' && ['node_modules', 'tests', 'sample', 'check-readonly.mjs'].includes(entry.name)) continue;
      if (entry.isSymbolicLink()) throw new Error(`runtime symlinks are not allowed: ${file}`);
      if (entry.isDirectory()) await walk(file);
      else if (/\.(?:mjs|cjs|js|html)$/.test(entry.name)) files.push(file);
    }
  }
  await walk('.');
  // Missing runtime directories must fail even if the root has other source files.
  await readdir(path.join(root, 'lib'));
  await readdir(path.join(root, 'ui'));
  await readFile(path.join(root, 'server.mjs'));
  const findings = [];
  for (const file of files.sort()) findings.push(...inspectSource(file, await readFile(path.join(root, file), 'utf8')));
  return { files: files.length, findings };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { files, findings } = await checkTree(process.argv[2] ? path.resolve(process.argv[2]) : APP);
    for (const f of findings) console.error(`${f.file}:${f.line}: ${f.rule}: ${f.message}`);
    console.log(`check:readonly: ${files} files, ${findings.length} finding(s)`);
    process.exitCode = findings.length ? 1 : 0;
  } catch (err) {
    console.error(`check:readonly: ${err.message}`);
    process.exitCode = 2;
  }
}
