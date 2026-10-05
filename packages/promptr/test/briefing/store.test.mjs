import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BriefingStore } from '../../dist/src/briefing/store.mjs';
import { OpenKnowledgeBriefing, briefingTarget } from '../../dist/src/briefing/openknowledge.mjs';
const target = briefingTarget('https://wiki.example', 'projects/promptr/brief');
const env = { OPENKNOWLEDGE_USERNAME: 'fixture-user', OPENKNOWLEDGE_PASSWORD: 'fixture-password' };
function fixture(t, initial = 'initial') {
 const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'promptr-briefing-'));
 t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
 return { cwd, store: new BriefingStore(cwd, initial) };
}
function server(initial = null) {
 let text = initial; const calls = [];
 const request = async (url, init) => {
  calls.push({url, ...init});
  const route = new URL(url).pathname;
  if (init.method === 'GET') return text === null ? new Response('', {status:404}) : Response.json({docName:target.docName,content:text});
  const body = JSON.parse(init.body);
  if (route === '/api/create-page') { assert.equal(body.path, 'projects/promptr/brief.md'); text = ''; }
  else { assert.equal(route, '/api/agent-write-md'); assert.equal(body.position, 'replace'); text = body.markdown; }
  return Response.json({docName:target.docName});
 };
 return { remote: new OpenKnowledgeBriefing(target, env, request), calls, set: value => {text = value;} };
}
test('local save/load retains revisions and does not touch root notebook', t => {
 const {cwd,store} = fixture(t); fs.writeFileSync(path.join(cwd,'promptr.md'), 'untouched');
 store.save('first'); store.save('second');
 assert.equal(new BriefingStore(cwd,'fallback').text,'second');
 assert.equal(fs.readFileSync(path.join(cwd,'promptr.md'),'utf8'),'untouched');
 const revisions = fs.readdirSync(path.join(cwd,'.promptr/briefing-history'));
 assert.equal(revisions.length,1); assert.equal(fs.readFileSync(path.join(cwd,'.promptr/briefing-history',revisions[0]),'utf8'),'first');
});
test('missing remote create/write/readback fixture; no write on connect/refresh', async t => {
 const {store} = fixture(t); const api = server(); store.connect(target); store.save('local');
 await store.refresh(api.remote); assert.ok(api.calls.every(c => c.method === 'GET'));
 await store.sync(api.remote); assert.equal(store.status,'synced');
 assert.deepEqual(api.calls.filter(c => c.method === 'POST').map(c => new URL(c.url).pathname), ['/api/create-page','/api/agent-write-md']);
 assert.ok(api.calls.every(c => c.redirect === 'error' && c.headers.Authorization.startsWith('Basic ')));
});
test('offline and 401 retain local, never interpreted as missing/create', async t => {
 const {cwd,store} = fixture(t); store.connect(target); store.save('offline work');
 for (const request of [async () => {throw Error('private network detail');}, async () => new Response('',{status:401})]) {
  const remote = new OpenKnowledgeBriefing(target,env,request);
  await assert.rejects(store.sync(remote)); assert.match(store.status,/pending/);
  assert.equal(new BriefingStore(cwd,'').text,'offline work');
 }
});
test('remote change conflicts without overwriting either copy; explicit adopt retains local', async t => {
 const {store,cwd} = fixture(t); const api = server('remote original'); store.connect(target);
 await store.refresh(api.remote); assert.equal(store.text,'remote original');
 store.save('my changes'); api.set('other client');
 await store.sync(api.remote); assert.match(store.status,/conflict/); assert.equal(api.calls.filter(c=>c.method==='POST').length,0);
 const result = await store.refresh(api.remote); assert.equal(result.conflict,true); assert.equal(store.text,'my changes');
 store.adoptRemote(result.remote); assert.equal(store.text,'other client');
 assert.ok(fs.readdirSync(path.join(cwd,'.promptr/briefing-history')).some(f=>f.endsWith('-local.md')));
});
test('adapter rejects unrelated targets, malformed document, redirects and missing credentials', async () => {
 for (const name of ['promptr','promptr.md','projects/../brief','projects/foo/other']) assert.throws(()=>briefingTarget('https://wiki.example',name));
 assert.throws(()=>briefingTarget('http://wiki.example',target.docName));
 assert.throws(()=>new OpenKnowledgeBriefing(target,{}));
 const remote = new OpenKnowledgeBriefing(target,env,async()=>Response.json({docName:'promptr',content:'wrong'}));
 await assert.rejects(remote.read(),/different document/);
});

test('refresh with a saved local briefing and no remote page reports pending, not conflict', async t => {
 const {store} = fixture(t); const api = server(); store.connect(target); store.save('local only');
 const result = await store.refresh(api.remote);
 assert.deepEqual(result, { conflict: false, remote: null });
 assert.match(store.status, /^pending — remote page missing/);
 assert.equal(store.text, 'local only');
 assert.ok(api.calls.every(c => c.method === 'GET'));
 await store.sync(api.remote); assert.equal(store.status, 'synced');
});
