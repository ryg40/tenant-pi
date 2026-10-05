import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resumeBriefingInMainPi } from '../../dist/src/companion/briefing-send.mjs';
import { CompanionBriefingDialogs } from '../../dist/src/companion/briefing-dialogs.mjs';
import { BriefingController } from '../../dist/src/briefing/overview.mjs';
import { BriefingStore } from '../../dist/src/briefing/store.mjs';
import { buildCompanionCommand } from '../../dist/src/coordinatr/layout.mjs';
import { main as spikeMain } from '../../dist/src/companion/spike.mjs';
import { CompanionSpikeView } from '../../dist/src/companion/view.mjs';
import { visibleWidth } from '@earendil-works/pi-tui';

function fixture(t) {
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'promptr-split-'));
 t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
 const target={cwd,pane:'w4:p0',sessionFile:'/private/main.jsonl'};
 const agent={agent:'pi',pane_id:target.pane,cwd,foreground_cwd:cwd,agent_status:'idle',terminal_id:'term-original',agent_session:{kind:'path',value:target.sessionFile}};
 const calls=[];const notices=[];let confirmation=true;
 const ui={confirm:async()=>confirmation,notify:(message)=>notices.push(message)};
 const exec=async args=>{calls.push(args);if(args[1]==='prompt') {
   const dir=path.join(cwd,'.promptr/briefing-history');
   const files=fs.readdirSync(dir);assert.equal(files.length,1);
   assert.equal(JSON.parse(fs.readFileSync(path.join(dir,files[0]),'utf8')).text,args[3]);
 } return JSON.stringify({result:{agent}});};
 return {cwd,target,agent,calls,notices,ui,exec,cancel:()=>confirmation=false};
}
test('companion Resume cancel does not send or create an attempt packet',async t=>{
 const f=fixture(t);f.cancel();
 assert.equal(await resumeBriefingInMainPi('reviewed',f.target,f.ui,f.exec),false);
 assert.deepEqual(f.calls.map(c=>c[1]),['get']);
 assert.equal(fs.existsSync(path.join(f.cwd,'.promptr')),false);
});
test('companion Resume saves exact reviewed packet before one argv submission and fences replay',async t=>{
 const f=fixture(t);const text='# Briefing\n\nExact café 🌱\n';
 assert.equal(await resumeBriefingInMainPi(text,f.target,f.ui,f.exec),true);
 assert.deepEqual(f.calls.map(c=>c[1]),['get','get','prompt']);
 assert.deepEqual(f.calls[2],['agent','prompt','w4:p0',text,'--wait','--until','working','--timeout','10000']);
 assert.equal(await resumeBriefingInMainPi(text,f.target,f.ui,f.exec),false);
 assert.equal(f.calls.length,3);assert.match(f.notices.at(-1),/Already attempted/);
});
test('uncertain Herdr send keeps packet and cannot be blindly retried',async t=>{
 const f=fixture(t);const exec=async args=>{await f.exec(args);if(args[1]==='prompt')throw Error('timeout');return JSON.stringify({result:{agent:f.agent}});};
 assert.equal(await resumeBriefingInMainPi('brief',f.target,f.ui,exec),true);
 assert.match(f.notices.at(-1),/failed or uncertain/);
 assert.equal(await resumeBriefingInMainPi('brief',f.target,f.ui,exec),false);
 assert.equal(f.calls.filter(c=>c[1]==='prompt').length,1);
});
test('changed terminal/session/cwd or busy main Pi prevents briefing submission',async t=>{
 for(const change of [a=>a.terminal_id='replacement',a=>a.agent_session.value='/other.jsonl',a=>a.cwd='/other',a=>a.agent_status='working']) {
  const f=fixture(t);f.ui.confirm=async()=>{change(f.agent);return true;};
  assert.equal(await resumeBriefingInMainPi('brief',f.target,f.ui,f.exec),false);
  assert.equal(f.calls.filter(c=>c[1]==='prompt').length,0);
 }
});
test('missing binding, blank and interactive command briefings never execute Herdr',async t=>{
 const f=fixture(t);
 for(const text of ['','  ','/skill:launch',' !rm something']) assert.equal(await resumeBriefingInMainPi(text,f.target,f.ui,f.exec),false);
 assert.equal(await resumeBriefingInMainPi('brief',{...f.target,sessionFile:''},f.ui,f.exec),false);
 assert.equal(f.calls.length,0);
});
test('shared briefing controller supports split local edit/Resume with exact text and no workspace mutation',async t=>{
 const f=fixture(t);const choices=['Edit briefing','Resume','Continue here'];const edits=['saved brief','reviewed brief'];
 const ui={...f.ui,select:async()=>choices.shift(),editor:async()=>edits.shift(),input:async()=>undefined};
 const store=new BriefingStore(f.cwd,'initial');
 assert.equal(await new BriefingController(store).show({cwd:f.cwd,targetLabel:'main Pi w4:p0',ui},()=>true,
  text=>resumeBriefingInMainPi(text,f.target,ui,f.exec)),'sent');
 assert.equal(store.text,'reviewed brief');assert.equal(f.calls.at(-1)[3],'reviewed brief');
});
test('split dialog renders bounded scrollable review, defaults Cancel and pasted Enter never confirms',async()=>{
 let root;const tui={terminal:{rows:20,columns:40},setLayoutRoot:c=>root=c,requestRender(){}};
 const dialogs=new CompanionBriefingDialogs(tui);
 const promise=dialogs.confirm('Review',Array.from({length:40},(_,i)=>`Exact row ${i}`).join('\n'));
 for(const width of [1,3,40]) {const rows=root.render(width);assert.ok(rows.length<=20);assert.ok(rows.every(r=>visibleWidth(r)<=width));}
 dialogs.handleInput('\x1b[200~\r\x1b[201~');
 dialogs.handleInput('\x1b[6~');assert.match(root.render(40).join('\n'),/Exact row 2\d/);
 dialogs.handleInput('\r');assert.equal(await promise,false);
 const edited=dialogs.editor('Edit','brief');dialogs.handleInput('\x1b[200~ café 🌱\x1b[201~');dialogs.handleInput('\x13');
 assert.match(await edited,/café 🌱/);
});
test('Kitty key-release never moves a choice list: press+release steps once, release alone never',async()=>{
 const tui={terminal:{rows:30,columns:80},setLayoutRoot(){},requestRender(){}};
 const choices=['Resume','Edit briefing','Save locally','Close'];
 let dialogs=new CompanionBriefingDialogs(tui);
 let promise=dialogs.select('Overview',choices);
 dialogs.handleInput('\x1b[B');dialogs.handleInput('\x1b[1;1:3B');dialogs.handleInput('\r');
 assert.equal(await promise,'Edit briefing');
 dialogs=new CompanionBriefingDialogs(tui);
 promise=dialogs.select('Overview',choices);
 dialogs.handleInput('\x1b[1;1:3B');dialogs.handleInput('\r');
 assert.equal(await promise,'Resume');
});
test('Save locally writes the file and confirms visibly instead of silently redisplaying',async t=>{
 const f=fixture(t);const choices=['Save locally','Close'];
 const ui={...f.ui,select:async()=>choices.shift(),editor:async()=>undefined,input:async()=>undefined};
 const store=new BriefingStore(f.cwd,'initial');
 assert.equal(await new BriefingController(store).show({cwd:f.cwd,targetLabel:'test',ui},()=>true,async()=>false),'close');
 assert.equal(fs.readFileSync(path.join(f.cwd,'.promptr/briefing.md'),'utf8'),'initial');
 assert.match(f.notices.join('\n'),/Saved locally/);
});
test('companion help states Esc/Ctrl+C step back without exiting',()=>{
 let out='';const write=process.stdout.write.bind(process.stdout);
 process.stdout.write=(chunk,...args)=>{out+=String(chunk);return true;};
 try { assert.equal(spikeMain(['--help']),0); } finally { process.stdout.write=write; }
 assert.match(out,/Esc \/ Ctrl\+C step back/);
});
test('narrow briefing editor blocks Ctrl+S visibly and saves after widening',async()=>{
 let root;const tui={terminal:{rows:20,columns:40},setLayoutRoot:c=>root=c,requestRender(){}};
 const dialogs=new CompanionBriefingDialogs(tui);
 const promise=dialogs.editor('Edit','brief \u{1F331}');
 root.render(2); // narrower than the 2-column glyph needs
 dialogs.handleInput('\x13');
 let settled=false;void promise.then(()=>{settled=true;});
 await new Promise(r=>setTimeout(r,10));
 assert.equal(settled,false);
 assert.match(root.render(80).join('\n'),/widen the pane to save/);
 dialogs.handleInput('\x13');
 assert.match(await promise,/brief/);
});
test('persistent workspace overview request is consumed without touching drafts; launcher binds project/session',()=>{
 const tui={requestRender(){},terminal:{rows:40,columns:100}};
 const view=new CompanionSpikeView(tui,{noteText:'note',hosted:true,overviewNavigation:true});
 view.setFocus('composer');view.handleInput('draft');const before=view.snapshot();view.handleInput('\x0f');
 assert.equal(view.consumeOverviewRequest(),true);assert.equal(view.consumeOverviewRequest(),false);assert.deepEqual(view.snapshot(),before);
 const command=buildCompanionCommand('/entry.mjs',undefined,'/state','w4:p0',"/repo's cwd",'/private/session.jsonl');
 assert.ok(command.includes("--project-cwd '/repo'\\''s cwd'"));assert.ok(command.includes("--pi-session '/private/session.jsonl'"));
});
