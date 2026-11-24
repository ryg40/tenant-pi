import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkTree, inspectSource } from '../check-readonly.mjs';

const app = fileURLToPath(new URL('../', import.meta.url));
const negative = {
  'fs-write': [
    "import { writeFile as save } from 'node:fs/promises'; save('fixture', 'x');",
    "await fs.writeFile?.('fixture', 'x');",
    "fs['unlinkSync']('fixture');",
    "await handle.write('x');",
    "await handle['write']('x');",
    "truncate('fixture', 0);",
    "fs['openSync']('fixture', 'w');",
    "fs.open?.('fixture', 'w');",
    "x[open]('fixture', 'w');",
    "x[openSync]('fixture', 'w');",
    "import { openSync } from 'node:fs'; const text = `${openSync('fixture', 'w')}`;",
  ],
  'process-write': [
    "import { execSync } from 'node:child_process'; execSync('touch fixture');",
    "const cp = require('child_process');",
    "await import('node:child_process');",
  ],
  'openviking-write': [
    "call('/api/v1/content/write', {method: 'POST'});",
    "call('/api/v1/fs/rm', {method: 'DELETE'});",
    "call('/api/v1/resources', {method: 'POST'});",
  ],
  'okknow-write': [
    "mcp('write', {docName: 'synthetic'});",
    "callTool('edit', {});",
    "rpc('tools/call', {name: 'delete', arguments: {}});",
    "client.callTool({name: 'write', arguments: {}});",
    "client.callTool({'name': 'edit', arguments: {}});",
  ],
  'aws-write': [
    'new CreateMemoryCommand({});',
    "import { DeleteMemoryRecordCommand as Remove } from '@aws-sdk/client-bedrock-agentcore';",
    'new GetMemoryRecordCommand({});',
    "import { BedrockAgentCore as Client } from '@aws-sdk/client-bedrock-agentcore'; new Client({}).deleteMemoryRecord({});",
  ],
  'sql-write': [
    "db.prepare('DELETE FROM memories');",
    "db.exec('CREATE TABLE fixture (id TEXT)');",
    "db.prepare('SELECT 1; DROP TABLE memories');",
    "db.prepare('PRAGMA journal_mode=WAL');",
    "db.prepare('PRAGMA wal_checkpoint(TRUNCATE)');",
    'db.prepare(sql);',
    'db.exec(sql);',
    "db.prepare('SELECT 1; PRAGMA journal_mode=WAL');",
    "db.prepare('PRAGMA query_only(0)');",
    "db['exec']('DROP TABLE memories');",
    "db.prepare('SELECT 1' + '; DELETE FROM memories');",
  ],
  'ui-html': [
    "element.innerHTML = '<p>synthetic</p>';",
    "element['outerHTML'] = '<p>synthetic</p>';",
    "element.insertAdjacentHTML('beforeend', '<p>synthetic</p>');",
    "document.write('synthetic');",
    "document['write']('synthetic');",
  ],
};

for (const [rule, snippets] of Object.entries(negative)) {
  test(`negative control: ${rule}`, () => {
    for (const snippet of snippets) {
      const result = inspectSource(rule === 'ui-html' ? 'ui/control.js' : 'lib/control.mjs', snippet);
      assert.ok(result.some((finding) => finding.rule === rule), snippet);
    }
  });
}

test('negative control: fs module access cannot expose write functions', () => {
  for (const snippet of [
    "import fs, { writeFile as save } from 'node:fs'; save('fixture', 'x');",
    "import fs from 'fs'; const { writeFile: save } = fs.promises;",
    "import * as fs from 'fs/promises'; fs['write' + 'File']('fixture', 'x');",
    "const { writeFile: save } = require('node:fs');",
    "const { readFile } = await import('node:fs/promises');",
    'await import(`fs/promises`);',
    "import { promises as fs } from 'node:fs';",
  ]) {
    assert.ok(inspectSource('lib/control.mjs', snippet).some((f) => f.rule === 'fs-write'), snippet);
  }
});

test('negative control: read calls cannot use write flags', () => {
  for (const snippet of [
    "readFileSync('fixture', {flag: 'w'});",
    "createReadStream('fixture', {'flags': 'a'});",
    "readFile('fixture', {flag: mode});",
    "readFile('fixture', {flag: 'r' + '+'});",
    "readFile('fixture', {flag});",
    "readFile('fixture', {['flag']: 'w'});",
    "readFile('fixture', {get flag() { return 'w'; }});",
    "open(path.join(dir, 'r'), 'w');",
    "open(join(dir, nested('r', name)), mode);",
    "open('fixture');",
    "import { open as read } from 'node:fs/promises'; read(join(dir, 'r'), 'w');",
  ]) {
    assert.ok(inspectSource('lib/control.mjs', snippet).some((f) => f.rule === 'fs-write'), snippet);
  }
});

test('negative control: imported open functions cannot escape the flag check', () => {
  for (const [binding, module, alias] of [
    ['openSync', 'node:fs', 'openSync'],
    ['open as read', 'node:fs/promises', 'read'],
  ]) {
    for (const use of [
      `const o = ${alias}; o('fixture', 'w');`,
      `${alias}.call(null, 'fixture', 'w');`,
      `registry[${alias}]('fixture', 'r');`,
    ]) {
      const snippet = `import { ${binding} } from '${module}'; ${use}`;
      assert.ok(inspectSource('lib/control.mjs', snippet).some((f) => f.rule === 'fs-write'), snippet);
    }
  }
});

test('negative control: SQLite must open through an explicit read-only constructor', () => {
  for (const snippet of [
    'new DatabaseSync(file);',
    'new DatabaseSync(file, {readOnly: false});',
    'new DatabaseSync(join(root, name), {readOnly: enabled});',
    'new DatabaseSync(file, options);',
    'new DatabaseSync(file, {nested: {readOnly: true}});',
    'new DatabaseSync(file, {readOnly: true, ...options});',
    'new DatabaseSync(file, {readOnly: true, readOnly: false});',
    'const DB = DatabaseSync; new DB(file);',
    "import { DatabaseSync as DB } from 'node:sqlite'; new DB(file);",
    "import * as sqlite from 'node:sqlite'; new sqlite.DatabaseSync(file);",
    "const { DatabaseSync } = require('node:sqlite');",
    "const { DatabaseSync } = await import('node:sqlite');",
    "import Database from 'better-sqlite3'; new Database(file);",
  ]) {
    assert.ok(inspectSource('lib/control.mjs', snippet).some((f) => f.rule === 'sql-write'), snippet);
  }
});

test('negative control: numeric open flags cannot enable writes', () => {
  const flags = [
    'constants.O_WRONLY',
    'constants.O_RDWR',
    'constants.O_CREAT',
    'constants.O_TRUNC',
    'constants.O_APPEND',
    'constants.O_RDONLY | constants.O_CREAT',
    'constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_APPEND',
    'constants.O_RDONLY |\n constants.O_TRUNC',
  ];
  for (const expression of flags) {
    const snippet = `open(info.full, ${expression});`;
    const result = inspectSource('lib/control.mjs', snippet);
    assert.ok(result.some((finding) => finding.rule === 'fs-write'), snippet);
  }
});

test('read operations and text rendering pass', () => {
  const snippets = [
    "import { readFile as read } from 'node:fs/promises'; await read('fixture');",
    "openSync('fixture', 'r');",
    "import { openSync } from 'node:fs'; openSync('fixture', 'r');",
    "import { open as read } from 'node:fs/promises'; await read('fixture', 'rs');",
    "import { openSync as read } from 'fs'; read?.('fixture', 'r');",
    "import { open as read, constants as c } from 'node:fs'; read('fixture', c.O_RDONLY | c.O_NOFOLLOW);",
    "call('/api/v1/search/find', {method: 'POST'});",
    "call(`/api/v1/fs/ls?${query}`);",
    "mcp('search', {}); mcp('exec', {command: 'ls -l'});",
    'new ListMemoryRecordsCommand({}); new RetrieveMemoryRecordsCommand({});',
    "db.prepare('SELECT content FROM memories'); db.prepare('PRAGMA table_info(memories)');",
    "element.textContent = '<p>synthetic</p>';",
    "// element.innerHTML = 'not executable';\nelement.textContent = 'safe';",
    "process.stdout.write('diagnostic'); process.stderr.write('diagnostic');",
    "import { truncate } from './model.mjs'; truncate('text', 8);",
    "db.prepare('SELECT 1; PRAGMA table_info(memories)');",
    "client.callTool({name: 'search', arguments: {}});",
  ];
  for (const snippet of snippets) assert.deepEqual(inspectSource('ui/control.js', snippet), [], snippet);
});

test('all real runtime sources pass', async () => {
  const result = await checkTree(app);
  assert.ok(result.files > 0);
  assert.deepEqual(result.findings, []);
});

test('CLI rejects each rule and fails closed on a missing runtime directory', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'tm-readonly-'));
  const { rm } = await import('node:fs/promises');
  try {
    await mkdir(path.join(scratch, 'lib'));
    await mkdir(path.join(scratch, 'ui'));
    await writeFile(path.join(scratch, 'server.mjs'), '');
    for (const [rule, snippets] of Object.entries(negative)) {
      const file = path.join(scratch, rule === 'ui-html' ? 'ui/control.js' : 'lib/control.mjs');
      await writeFile(file, snippets[0]);
      const result = spawnSync(process.execPath, [path.join(app, 'check-readonly.mjs'), scratch], { encoding: 'utf8' });
      assert.equal(result.status, 1, rule);
      await rm(file);
    }
    const clean = spawnSync(process.execPath, [path.join(app, 'check-readonly.mjs'), scratch], { encoding: 'utf8' });
    assert.equal(clean.status, 0);
    await writeFile(path.join(scratch, 'extra.mjs'), negative['fs-write'][0]);
    const extra = await checkTree(scratch);
    assert.ok(extra.findings.some((finding) => finding.file === 'extra.mjs'));
    await rm(path.join(scratch, 'extra.mjs'));
    await symlink(path.join(app, 'server.mjs'), path.join(scratch, 'lib/link.mjs'));
    let result = spawnSync(process.execPath, [path.join(app, 'check-readonly.mjs'), scratch], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    await rm(path.join(scratch, 'lib'), { recursive: true });
    result = spawnSync(process.execPath, [path.join(app, 'check-readonly.mjs'), scratch], { encoding: 'utf8' });
    assert.equal(result.status, 2);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
