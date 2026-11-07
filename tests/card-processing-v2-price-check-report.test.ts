import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {readV2PriceCheckReport} from '../lib/card-processing-v2-price-check-report.ts';

const report=()=>({status:'complete',startedAt:'2026-11-06T23:00:00Z',endedAt:'2026-11-06T23:01:00Z',
 snapshotObservedAt:'2026-11-06T23:00:05Z',totalDrafts:0,completedDrafts:0,elapsedMs:60000,
 marketRequestCount:0,aiRequests:0,unattempted:0,rows:[],privateAccountData:'must not be returned'});
async function fixture(body:unknown){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'price-report-'));
 const dir=path.join(root,'artifacts/card-processing-v2/price-check/reports');await fs.mkdir(dir,{recursive:true});
 const file=path.join(root,'artifacts/report.json'),bytes=JSON.stringify(body);await fs.writeFile(file,bytes);
 const pointer={version:1,reportId:'test-report',evidence:{path:'artifacts/report.json',sha256:createHash('sha256').update(bytes).digest('hex')}};
 const index=path.join(dir,'latest.json');await fs.writeFile(index,JSON.stringify(pointer));
 return{root,file,index,pointer,close:async()=>{assert.equal(path.dirname(root),os.tmpdir());await fs.rm(root,{recursive:true,force:true});}};
}
test('saved report is preview-only and strips unrelated account metadata',async()=>{
 const f=await fixture(report());try{const result=await readV2PriceCheckReport(f.root);assert.equal(result.reportId,'test-report');assert.equal(result.canPublish,false);assert.equal(result.mode,'preview');assert.equal(result.rows.length,0);assert.ok(!('privateAccountData' in result));}finally{await f.close();}
});
test('changed report bytes and escaped artifact paths stop the read',async()=>{
 const f=await fixture(report());try{
  await fs.appendFile(f.file,' ');await assert.rejects(readV2PriceCheckReport(f.root),/changed/);
  await fs.writeFile(f.index,JSON.stringify({...f.pointer,evidence:{...f.pointer.evidence,path:'artifacts/../../outside.json'}}));
  await assert.rejects(readV2PriceCheckReport(f.root),/stay in local artifacts/);
 }finally{await f.close();}
});
test('incomplete or unsuccessful snapshots cannot appear as a completed report',async()=>{
 for(const body of [{...report(),totalDrafts:1},{...report(),status:'stopped'},{...report(),unattempted:1}]){
  const f=await fixture(body);try{await assert.rejects(readV2PriceCheckReport(f.root));}finally{await f.close();}
 }
});
