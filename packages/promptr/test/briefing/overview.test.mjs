import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BriefingStore } from '../../dist/src/briefing/store.mjs';
import { BriefingOverview } from '../../dist/src/extension/briefing.mjs';
import { CompanionSpikeView } from '../../dist/src/companion/view.mjs';
import { projectSlug } from '../../dist/src/sync/project-pages.mjs';
function setup(t, choices, edits) {
 const cwd = fs.mkdtempSync(path.join(os.tmpdir(),'promptr-overview-'));
 t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
 const sends=[]; const notices=[];
 const ctx={cwd, isIdle:()=>true, hasPendingMessages:()=>false,
  sessionManager:{getSessionId:()=> 'current-session', getLeafId:()=> 'leaf'},
  ui:{select:async()=>choices.shift(),editor:async()=>edits.shift(), notify:(...args)=>notices.push(args)}};
 const store=new BriefingStore(cwd,'initial');
 return {store,overview:new BriefingOverview(store),ctx,pi:{sendUserMessage:(...args)=>sends.push(args)},sends,notices};
}
test('Resume edit cancellation and final review cancellation never send', async t=>{
 for(const edits of [[undefined],['reviewed']]) {
  const h=setup(t,edits[0]===undefined?['Resume','Close']:['Resume','Continue here','Close'],edits);
  assert.equal(await h.overview.show(h.pi,h.ctx,new Set(),()=>true,async()=>false),'close');
  assert.equal(h.sends.length,0);
 }
});
test('Continue here sends exact reviewed text once with expansion disabled; no queue drain',async t=>{
 const h=setup(t,['Resume','Continue here'],['exact continuation']);
 const attempts=new Set(); let reviews=0;
 assert.equal(await h.overview.show(h.pi,h.ctx,attempts,()=>true,async text=>{reviews++;assert.equal(text,'exact continuation');return true;}),'sent');
 assert.deepEqual(h.sends,[['exact continuation',{expandPromptTemplates:false}]]); assert.equal(reviews,1);
 const next=['Resume','Continue here','Close']; h.ctx.ui.select=async()=>next.shift(); h.ctx.ui.editor=async()=> 'exact continuation';
 await h.overview.show(h.pi,h.ctx,attempts,()=>true,async()=>{throw Error('must not re-review attempted text');});
 assert.equal(h.sends.length,1);
});
test('session change during final review and Start fresh launch nothing',async t=>{
 const h=setup(t,['Resume','Continue here','Resume','Start fresh','Close'],['brief','brief']);
 let leaf='leaf'; h.ctx.sessionManager.getLeafId=()=>leaf;
 await h.overview.show(h.pi,h.ctx,new Set(),()=>true,async()=>{leaf='changed';return true;});
 assert.equal(h.sends.length,0); assert.ok(h.notices.some(n=>n[0].includes('Start fresh needs Herdr')));
});
test('hosted Continue here rejects slash/shell-prefixed briefings like the companion guard',async t=>{
 for(const text of ['/coordinatr','!run this']) {
  const h=setup(t,['Resume','Continue here','Close'],[text]);
  assert.equal(await h.overview.show(h.pi,h.ctx,new Set(),()=>true,async()=>{throw Error('prefixed text must never review');}),'close');
  assert.equal(h.sends.length,0);
  assert.ok(h.notices.some(n=>String(n[0]).includes('not a slash or shell command')));
 }
});
test('View sources documents attempt packets as send records, not revisions',async t=>{
 const h=setup(t,['View sources','Close'],[]);
 assert.equal(await h.overview.show(h.pi,h.ctx,new Set(),()=>true,async()=>false),'close');
 assert.ok(h.notices.some(n=>String(n[0]).includes('*-resume-attempt.json')&&String(n[0]).includes('*-fresh-attempt.json')));
});
test('overview/workspace navigation keeps composer, note, selection and queue',()=>{
 const tui={requestRender(){},terminal:{rows:40,columns:100}};
 const view=new CompanionSpikeView(tui,{noteText:'note\nsecond',hosted:true,overviewNavigation:true});
 view.setFocus('composer');view.handleInput('draft');
 view.handleInput('\x1b[200~ café 🌱\x1b[201~');
 const before=view.snapshot(); view.handleInput('\x0f'); // Ctrl+O
 assert.equal(view.getOverviewRequested(),true);assert.deepEqual(view.snapshot(),before);
 const reopened=new CompanionSpikeView(tui,{noteText:'ignored',hosted:true,sessionState:view.snapshot(),overviewNavigation:true});
 assert.equal(reopened.getComposerText(),'draft café 🌱');assert.equal(reopened.getNoteText(),'note\nsecond');
 assert.deepEqual(reopened.snapshot(),before);
 // Bracketed pasted control sequences cannot navigate or submit.
 reopened.handleInput('\x1b[200~\x0f\x13\x1b[201~');
 assert.equal(reopened.getOverviewRequested(),false);assert.equal(reopened.getReviewRequested(),false);
});

test('Connect cancellation at the single confirmation writes no target and sends no request; local edit needs no connection',async t=>{
 const saved={u:process.env.OPENKNOWLEDGE_USERNAME,p:process.env.OPENKNOWLEDGE_PASSWORD,o:process.env.OPENKNOWLEDGE_ORIGIN};
 process.env.OPENKNOWLEDGE_USERNAME='fixture-user';process.env.OPENKNOWLEDGE_PASSWORD='fixture-password';process.env.OPENKNOWLEDGE_ORIGIN='https://wiki.example';
 const realFetch=globalThis.fetch; let requests=0; globalThis.fetch=async()=>{requests++;throw Error('no network in tests');};
 t.after(()=>{globalThis.fetch=realFetch;for(const [k,v] of [['OPENKNOWLEDGE_USERNAME',saved.u],['OPENKNOWLEDGE_PASSWORD',saved.p],['OPENKNOWLEDGE_ORIGIN',saved.o]]){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
 const h=setup(t,['Connect OpenKnowledge','Edit briefing','Close'],['local work']);
 const confirms=[]; h.ctx.ui.input=async()=>{throw Error('no input prompts in the one-confirmation flow');};
 h.ctx.ui.confirm=async(title,message)=>{confirms.push([title,message]);return false;};
 await h.overview.show(h.pi,h.ctx,new Set(),()=>true,async()=>{throw Error('no review expected');});
 assert.equal(confirms.length,1);assert.equal(confirms[0][0],'Connect OpenKnowledge project pages?');
 const slug=projectSlug(path.basename(h.ctx.cwd));
 for(const line of ['https://wiki.example',`brief: projects/${slug}/brief`,`inbox: projects/${slug}/inbox`,`workspace: projects/${slug}/workspace`,`handoffs: projects/${slug}/handoffs`]) assert.ok(confirms[0][1].includes(line),line);
 assert.ok(!confirms[0][1].includes('fixture-password'));
 assert.equal(requests,0);assert.equal(h.store.target,undefined);assert.equal(h.store.text,'local work');
 assert.equal(h.store.status,'local');assert.equal(h.sends.length,0);
});

test('Connect without credentials notifies unbound, prompts nothing and writes no target',async t=>{
 const saved={u:process.env.OPENKNOWLEDGE_USERNAME,p:process.env.OPENKNOWLEDGE_PASSWORD};
 delete process.env.OPENKNOWLEDGE_USERNAME;delete process.env.OPENKNOWLEDGE_PASSWORD;
 t.after(()=>{if(saved.u!==undefined)process.env.OPENKNOWLEDGE_USERNAME=saved.u;if(saved.p!==undefined)process.env.OPENKNOWLEDGE_PASSWORD=saved.p;});
 const h=setup(t,['Connect OpenKnowledge','Close'],[]);
 h.ctx.ui.confirm=async()=>{throw Error('no confirmation without credentials');};
 await h.overview.show(h.pi,h.ctx,new Set(),()=>true,async()=>false);
 assert.ok(h.notices.some(n=>String(n[0]).startsWith('OpenKnowledge unbound')&&n[1]==='warning'));
 assert.equal(h.store.target,undefined);
});

test('Browse projects inspects without sending; Back/Close preserves everything', async t=>{
 // Row-list select gets 'Back' when rows exist; if the scan finds nothing,
 // the leftover 'Back' falls through the menu harmlessly. Either way:
 // no sends, no launch, clean close.
 const h=setup(t,['Browse projects','Back','Close'],[]);
 assert.equal(await h.overview.show(h.pi,h.ctx,new Set(),()=>true,async()=>{throw Error('browse must never review');}),'close');
 assert.equal(h.sends.length,0);
 assert.ok(h.notices.some(n=>String(n[0]).includes('Scanning recent projects')));
});

test('shared views appear only when bound with a reader; saving the view seeds an explicit resume draft; saves reach the hook',async t=>{
 const { buildSharedResumeDraft } = await import('../../dist/src/briefing/overview.mjs');
 const { defaultProjectLabel } = await import('../../dist/src/sync/project-pages.mjs');
 assert.equal(defaultProjectLabel('/tmp/checkout-two', 'git@gitea.example:owner/promptr.git'), 'promptr');
 assert.equal(defaultProjectLabel('/tmp/checkout-two', undefined), 'checkout-two');
 assert.match(buildSharedResumeDraft('/tmp/promptr', 'Shared workspace', 'body'), /^# Resume promptr from Shared workspace\n[\s\S]*## Shared workspace \(as read\)\n\nbody\n$/);

 const cwd = fs.mkdtempSync(path.join(os.tmpdir(),'promptr-shared-'));
 t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
 const store = new BriefingStore(cwd,'initial');
 const saved = [];
 const reads = [];
 const client = { async readDocument(name){ reads.push(name); return name.endsWith('/workspace') ? '# promptr workspace\n\nClient: desk-ffff\n' : null; }, async createPage(){ return 'exists'; }, async writeMarkdown(){} };
 const menus = [];
 const editors = [];
 const sends = [];
 const mk = (choices, edits) => ({
  cwd, isIdle:()=>true, hasPendingMessages:()=>false,
  sessionManager:{getSessionId:()=>'s', getLeafId:()=>'leaf'},
  ui:{ select:async(_t, list)=>{ menus.push(list); return choices.shift(); }, editor:async(_t, text)=>{ editors.push(text); return edits.shift(); }, notify:()=>{} },
 });
 // Unbound: no shared entries.
 let overview = new BriefingOverview(store, { onSave:(t)=>saved.push(t), sharedReader:()=>client });
 await overview.show({sendUserMessage:()=>{}}, mk(['Close'],[]), new Set(), ()=>true, async()=>true);
 assert.ok(!menus[0].includes('Shared workspace'));
 // Bound with a reader: entries appear; the view's save becomes a draft, reviewed, then sent once.
 store.connect({ origin:'https://wiki.example', docName:'projects/promptr/brief' });
 overview = new BriefingOverview(store, { onSave:(t)=>saved.push(t), sharedReader:()=>client });
 const result = await overview.show({sendUserMessage:(...a)=>sends.push(a)}, mk(['Shared workspace','Continue here'],['viewed text','final draft']), new Set(), ()=>true, async(text)=>{ assert.equal(text,'final draft'); return true; });
 assert.equal(result, 'sent');
 assert.ok(menus[1].includes('Shared workspace') && menus[1].includes('Shared history'));
 assert.deepEqual(reads, ['projects/promptr/workspace']);
 assert.match(editors[0], /Client: desk-ffff/);
 assert.match(editors[1], /^# Resume .* from Shared workspace/);
 assert.deepEqual(saved, ['final draft']);
 assert.deepEqual(sends, [['final draft',{expandPromptTemplates:false}]]);
 // Esc on the view sends nothing and saves nothing; Edit briefing save reaches the hook.
 overview = new BriefingOverview(store, { onSave:(t)=>saved.push(t), sharedReader:()=>client });
 await overview.show({sendUserMessage:()=>{ throw Error('must not send'); }}, mk(['Shared history','Edit briefing','Close'],[undefined,'edited brief']), new Set(), ()=>true, async()=>true);
 assert.deepEqual(saved, ['final draft','edited brief']);
 assert.ok(reads.includes('projects/promptr/prompt-log') && reads.includes('projects/promptr/handoffs'));
});
