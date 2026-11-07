import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {appendV2TimingEvent,readV2TimingJournal} from '../lib/card-processing-v2-timing-journal.ts';
import {readV2State,withV2State} from '../lib/card-processing-v2-store.ts';
import {measureV2,recoverV2Timings} from '../lib/card-processing-v2-timing.ts';
import type {V2Timing} from '../lib/card-processing-v2.ts';
const span=(id=randomUUID()):V2Timing=>({id,step:'test-operation',runId:'original-run',cardId:'card',pid:process.pid,startedAt:new Date().toISOString(),status:'running'});
const finished=(s:V2Timing):V2Timing=>({...s,status:'completed',endedAt:new Date().toISOString(),durationMs:1});
async function fixture(fn:(root:string)=>Promise<void>){const root=await fs.mkdtemp(path.join(os.tmpdir(),'v2-timing-journal-'));try{await fn(root);}finally{await fs.rm(root,{recursive:true,force:true});}}
const stateFile=(root:string)=>path.join(root,'artifacts/card-processing-v2/state.json');
test('timing preserves inventory bytes/revision while live readers see durable start and completion',()=>fixture(async root=>{
 await withV2State(s=>{s.notices.push('protected existing inventory');},root);const before=await fs.readFile(stateFile(root),'utf8'),revision=(await readV2State(root)).revision;
 assert.equal(await measureV2(root,'actual-operation',async()=>{const state=await readV2State(root);assert.equal(state.timings.at(-1)!.status,'running');return 42;},{runId:'original-run',cardIds:['card']}),42);
 assert.equal(await fs.readFile(stateFile(root),'utf8'),before);const state=await readV2State(root);assert.equal(state.revision,revision);assert.equal(state.timings.at(-1)!.status,'completed');assert.deepEqual(state.timings.at(-1)!.cardIds,['card']);
}));
test('domain commit retains timing guard visibility without copying independent history into inventory',()=>fixture(async root=>{
 const started=span();await appendV2TimingEvent(root,'start',[started]);await withV2State(s=>{assert.equal(s.timings[0].status,'running');s.notices.push('domain result');},root);
 assert.deepEqual(JSON.parse(await fs.readFile(stateFile(root),'utf8')).timings,[]);await appendV2TimingEvent(root,'end',[finished(started)]);assert.equal((await readV2State(root)).timings[0].status,'completed');
 await assert.rejects(withV2State(s=>{s.timings[0].status='failed';},root),/journal-owned/);assert.deepEqual((await readV2State(root)).notices,['domain result']);
}));
test('legacy history and dead-span recovery remain visible without rewriting historical inventory',()=>fixture(async root=>{
 const old={...span(),pid:2147483647};await withV2State(s=>{s.timings.push(old);},root);const bytes=await fs.readFile(stateFile(root),'utf8');assert.equal(await recoverV2Timings(root),1);assert.equal(await fs.readFile(stateFile(root),'utf8'),bytes);const current=await readV2State(root);assert.equal(current.timings[0].status,'interrupted');assert.equal(current.timings[0].durationMs,undefined);assert.equal(await recoverV2Timings(root),0);
 await withV2State(s=>s.notices.push('later domain write'),root);assert.equal(JSON.parse(await fs.readFile(stateFile(root),'utf8')).timings[0].status,'running');assert.equal((await readV2State(root)).timings[0].status,'interrupted');
}));
test('exact event replay is idempotent and conflicting evidence or terminal mutation rejects',()=>fixture(async root=>{
 const started=span(),end=finished(started);await appendV2TimingEvent(root,'start',[started]);assert.equal((await appendV2TimingEvent(root,'start',[started])).replayed,true);await assert.rejects(appendV2TimingEvent(root,'start',[{...started,cardId:'foreign'}]),/different evidence/);await appendV2TimingEvent(root,'end',[end]);assert.equal((await readV2TimingJournal(root)).spans.length,1);await assert.rejects(appendV2TimingEvent(root,'other-end',[{...end,status:'failed'}]),/Terminal/);
}));
test('a crash-torn tail is retained, reported and rotated without inventing a terminal duration',()=>fixture(async root=>{
 const started=span();await appendV2TimingEvent(root,'start',[started]);const dir=path.join(root,'artifacts/card-processing-v2/timing-journal'),active=JSON.parse(await fs.readFile(path.join(dir,'active.json'),'utf8')),file=path.join(dir,active.segment);await fs.appendFile(file,'{"version":1,"id":"torn');const torn=await fs.readFile(file);assert.equal((await readV2TimingJournal(root)).warnings.length,1);assert.equal((await readV2State(root)).timings[0].status,'running');
 await appendV2TimingEvent(root,'another-start',[span()]);assert.deepEqual(await fs.readFile(file),torn);assert.notEqual(JSON.parse(await fs.readFile(path.join(dir,'active.json'),'utf8')).segment,active.segment);assert.equal((await readV2TimingJournal(root)).spans.length,2);assert.equal((await readV2TimingJournal(root)).warnings.length,1);
}));
test('committed malformed or checksum-changed journal records fail closed',()=>fixture(async root=>{
 await appendV2TimingEvent(root,'start',[span()]);const dir=path.join(root,'artifacts/card-processing-v2/timing-journal'),active=JSON.parse(await fs.readFile(path.join(dir,'active.json'),'utf8')),file=path.join(dir,active.segment),bytes=await fs.readFile(file,'utf8');await fs.writeFile(file,bytes.replace('test-operation','fake-operation'));await assert.rejects(readV2State(root),/checksum/);
}));
test('a missing committed segment cannot be silently recreated by the next writer',()=>fixture(async root=>{
 await appendV2TimingEvent(root,'start',[span()]);const dir=path.join(root,'artifacts/card-processing-v2/timing-journal'),active=JSON.parse(await fs.readFile(path.join(dir,'active.json'),'utf8'));await fs.rename(path.join(dir,active.segment),path.join(dir,active.segment+'.retained'));await assert.rejects(appendV2TimingEvent(root,'second',[span()]),/unavailable/);await assert.rejects(readV2State(root),/unavailable/);await assert.rejects(fs.access(path.join(dir,active.segment)));
}));
test('independent concurrent timings retain every start/end and do not claim an inventory revision',()=>fixture(async root=>{
 await Promise.all(Array.from({length:8},(_,n)=>measureV2(root,'operation-'+n,()=>n)));const state=await readV2State(root);assert.equal(state.revision,0);assert.equal(state.timings.length,8);assert.ok(state.timings.every(t=>t.status==='completed'));await assert.rejects(fs.access(stateFile(root)));
}));
test('failure to retain timing before work prevents work; telemetry failure after a result never replays it',()=>fixture(async root=>{
 const dir=path.join(root,'artifacts/card-processing-v2/timing-journal');await fs.mkdir(path.dirname(dir),{recursive:true});await fs.writeFile(dir,'not a directory');let calls=0;await assert.rejects(measureV2(root,'cannot-start',()=>{calls++;}));assert.equal(calls,0);await fs.unlink(dir);
 const result=await measureV2(root,'retained-domain-result',async()=>{calls++;const active=JSON.parse(await fs.readFile(path.join(dir,'active.json'),'utf8'));await fs.appendFile(path.join(dir,active.segment),'invalid committed row\n');return 'saved-once';});assert.equal(result,'saved-once');assert.equal(calls,1);assert.ok((await fs.readdir(dir)).some(n=>n.startsWith('coverage-warning-')));
}));
