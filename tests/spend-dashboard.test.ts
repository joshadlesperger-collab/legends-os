import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {getSpendSummary,saveSpendSnapshot,spendSnapshotSchema} from '../lib/spend-dashboard.ts';
async function fixture(action:(root:string)=>Promise<void>){const root=await fs.mkdtemp(path.join(os.tmpdir(),'spend-dashboard-'));try{await fs.mkdir(path.join(root,'artifacts','card-processing-v2'),{recursive:true});await action(root);}finally{await fs.rm(root,{recursive:true,force:true});}}
const snapshot=(available=46)=>({providerId:'chatgpt',metric:{id:'allowance',kind:'allowance',label:'Verified plan allowance',unit:'percent',available,limit:100,used:100-available,reserved:null,period:'Manually checked current cycle',observedAt:'2026-01-01T00:00:00Z'}});
test('unknown balances remain unknown and cached concurrent headers do not reread changing ledgers within one minute',()=>fixture(async root=>{
 const first=await getSpendSummary(root,1000),pending=getSpendSummary(root,1001);assert.equal(await pending,first);
 assert.equal(first.providers.length,6);assert.ok(first.providers.every(p=>p.metrics.every(m=>m.available===null&&m.used===null)));
 const base=path.join(root,'artifacts','card-processing-v2');
 await fs.writeFile(path.join(base,'config.json'),JSON.stringify({identification:{capMicros:30000000},SECRET:'notreturned'}));
 const bound={authority:'fixture',pricingSource:'https://example.com',inputUsdPerMillion:1,outputUsdPerMillion:2,maxInputTokens:100,maxOutputTokens:50};
 const call={id:'settled',cardId:'privatecard',key:'a'.repeat(64),provider:'openai',model:'test',status:'settled',reservedMicros:200,actualMicros:1000000,at:'2026-01-01T00:00:00Z'};
 await fs.writeFile(path.join(base,'state.json'),JSON.stringify({calls:[call,{...call,id:'pending',status:'uncertain',actualMicros:null,reservedMicros:200,bound}],cards:{secret:'no exposure'}}));
 assert.equal(await getSpendSummary(root,59999),first);
 const fresh=await getSpendSummary(root,61001),m=fresh.providers.find(p=>p.id==='openai')!.metrics.find(m=>m.kind==='app_budget')!;
 assert.equal(m.used,1);assert.equal(m.reserved,.0002);assert.equal(m.available,28.9998);assert.equal(m.limit,30);assert.equal(m.source,'local');
 const text=JSON.stringify(fresh);assert.ok(!text.includes('privatecard'));assert.ok(!text.includes('SECRET'));assert.ok(!text.includes('notreturned'));
 assert.equal(fresh.providers.find(p=>p.id==='openai')!.metrics.find(m=>m.kind==='provider_balance')!.available,null);
}));
test('manual snapshot keeps its old actual observation time and cannot alter application budget',()=>fixture(async root=>{
 const out=await saveSpendSnapshot(root,snapshot());const m=out.providers.find(p=>p.id==='chatgpt')!.metrics[0];assert.equal(m.source,'manual');assert.equal(m.observedAt,'2026-01-01T00:00:00Z');assert.equal(m.available,46);
 const next=await saveSpendSnapshot(root,snapshot(30));assert.equal(next.providers.find(p=>p.id==='chatgpt')!.metrics.length,1);
 assert.equal(spendSnapshotSchema.safeParse({...snapshot(),metric:{...snapshot().metric,id:'card-identification-budget',kind:'app_budget'}}).success,false);
 assert.equal(spendSnapshotSchema.safeParse({...snapshot(),metric:{...snapshot().metric,available:101}}).success,false);
 await assert.rejects(saveSpendSnapshot(root,{...snapshot(),metric:{...snapshot().metric,observedAt:'2099-01-01T00:00:00Z'}}));
 assert.equal(spendSnapshotSchema.safeParse({...snapshot(),token:'secret'}).success,false);
}));
test('invalid accounting never fabricates available credit or zero actual cost',()=>fixture(async root=>{
 const base=path.join(root,'artifacts','card-processing-v2');await fs.writeFile(path.join(base,'config.json'),JSON.stringify({identification:{capMicros:30000000}}));
 await fs.writeFile(path.join(base,'state.json'),JSON.stringify({calls:[{id:'x',cardId:'x',key:'b'.repeat(64),provider:'openai',model:'x',status:'uncertain',reservedMicros:1000000,actualMicros:null,at:'2026-01-01T00:00:00Z'}]}));
 const m=(await getSpendSummary(root)).providers.find(p=>p.id==='openai')!.metrics.find(m=>m.kind==='app_budget')!;assert.equal(m.available,null);assert.equal(m.reserved,1);assert.match(m.note!,/unverified bound/);
}));


test('named custom tools support manual USD budgets without modifying card spending enforcement',()=>fixture(async root=>{
 const raw={providerId:'tool-vercel',providerLabel:'Vercel hosting',metric:{...snapshot().metric,unit:'usd',available:75,used:25,label:'Hosting ceiling'}};
 const out=await saveSpendSnapshot(root,raw),tool=out.providers.find(p=>p.id==='tool-vercel')!;
 assert.equal(tool.label,'Vercel hosting');assert.equal(tool.metrics[0].label,'Manual budget');assert.equal(tool.metrics[0].source,'manual');assert.equal(tool.metrics[0].available,75);assert.equal(tool.billingUrl,undefined);
 assert.equal(spendSnapshotSchema.safeParse({...raw,providerId:'../../secret'}).success,false);
 assert.equal(spendSnapshotSchema.safeParse({...raw,providerLabel:undefined}).success,false);
 await assert.rejects(fs.access(path.join(root,'artifacts','card-processing-v2','config.json')));
}));
