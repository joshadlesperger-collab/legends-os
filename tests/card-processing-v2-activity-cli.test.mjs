import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readV2ActivitySnapshot} from '../lib/card-processing-v2-activity-client.mjs';
const cli=fileURLToPath(new URL('../scripts/card-processing-v2-activity.mjs',import.meta.url));
async function fixture(t,body,timeout=5000){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'v2-activity-cli-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const id='55555555-5555-4555-8555-555555555555',directory=path.join(root,'artifacts/card-processing-v2');
 await fs.mkdir(path.join(directory,'processing-batches'),{recursive:true});
 const state=JSON.stringify({cards:{},calls:[],submissions:{},timings:[]});await fs.writeFile(path.join(directory,'state.json'),state);
 await fs.writeFile(path.join(directory,'processing-batches',id+'.json'),JSON.stringify({jobId:id,status:'accepted',clickedAt:new Date(Date.now()-1000).toISOString(),captures:[{candidateId:'a'.repeat(64),photos:[{hash:'b'.repeat(64),side:'front'},{hash:'c'.repeat(64),side:'back'}]}]}));
 await fs.writeFile(path.join(root,'artifacts/request.json'),JSON.stringify({batchId:id,lane:'agent',phase:'engineering',owner:'test-controller',runTimeoutMs:timeout}));
 await fs.writeFile(path.join(root,'artifacts/operation.mjs'),body);
 return{root,id,state,run:()=>spawnSync(process.execPath,[cli,'run','artifacts/request.json','artifacts/operation.mjs'],{cwd:root,encoding:'utf8',timeout:15000,windowsHide:true}),snapshot:()=>readV2ActivitySnapshot(root,id)};
}
test('bounded operation records ownership/output without changing card or cost records',async t=>{
 const f=await fixture(t,"console.log('actual-operation-output');");const r=f.run();assert.equal(r.status,0,r.stderr);
 assert.equal(await fs.readFile(path.join(f.root,'artifacts/card-processing-v2/state.json'),'utf8'),f.state);
 const snapshot=await f.snapshot();assert.equal(snapshot.phases.length,1);assert.equal(snapshot.phases[0].status,'completed');assert.equal(snapshot.productiveWorkClaimed,false);
 const result=JSON.parse(r.stdout.trim());assert.equal(result.exitCode,0);assert.equal(result.timedOut,false);assert.match(await fs.readFile(path.join(f.root,result.outputFile),'utf8'),/actual-operation-output/);assert.doesNotMatch(r.stdout,/actual-operation-output|token/);
});
test('failed operation is retained once, never silently retried',async t=>{
 const f=await fixture(t,"import fs from 'node:fs';fs.appendFileSync('artifacts/executions.txt','one\\n');process.exitCode=7;");const r=f.run();assert.equal(r.status,1);
 assert.equal(await fs.readFile(path.join(f.root,'artifacts/executions.txt'),'utf8'),'one\n');const s=await f.snapshot();assert.equal(s.phases.length,1);assert.equal(s.phases[0].status,'failed');assert.equal(s.productiveWorkClaimed,false);
});
test('hung local operation has a finite deadline and failed activity evidence',async t=>{
 const f=await fixture(t,'setInterval(()=>{},1000);',150),r=f.run();assert.equal(r.status,1);assert.equal(JSON.parse(r.stdout.trim()).timedOut,true);const s=await f.snapshot();assert.equal(s.phases.length,1);assert.equal(s.phases[0].status,'failed');assert.equal(s.productiveWorkClaimed,false);
});
