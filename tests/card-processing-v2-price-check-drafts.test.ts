import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {refreshV2PriceCheckDraftSource} from '../lib/card-processing-v2-price-check-drafts.ts';
test('read-only draft price refresh coalesces and reuses SHA-bound current source without a second browser',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'price-source-'));let opens=0,closes=0,releases=0;
 try{await fs.mkdir(path.join(root,'artifacts'),{recursive:true});const body={scope:'drafts',seller:'imaydit58',complete:true,observedAt:new Date().toISOString(),rows:[{draftId:'123',sku:'a',quantity:1,price:{amount:'1.79',currency:'USD'},protectedValues:{shipping:'$0.00'}}]},bytes=JSON.stringify(body),evidence={path:'artifacts/observed.json',sha256:createHash('sha256').update(bytes).digest('hex')};await fs.writeFile(path.join(root,evidence.path),bytes);
 const deps={acquire:async()=>async()=>{releases++;},background:async()=>({busy:false}),open:async()=>{opens++;return{status:async()=>({ready:true}),captureDraftMatchSnapshot:async()=>({evidence}),close:async()=>{closes++;}};}};
 const [a,b]=await Promise.all([refreshV2PriceCheckDraftSource(root,deps),refreshV2PriceCheckDraftSource(root,deps)]);assert.equal(opens,1);assert.equal(a.rows[0].price.amount,'1.79');assert.equal(b.rows.length,1);const c=await refreshV2PriceCheckDraftSource(root,deps);assert.equal(c.cached,true);assert.equal(opens,1);assert.equal(closes,1);assert.equal(releases,1);
 await fs.appendFile(path.join(root,evidence.path),' ');await assert.rejects(refreshV2PriceCheckDraftSource(root,deps),/changed/);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('busy workflow prevents any browser action and releases admission ownership',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'price-busy-'));let released=false;
 try{await assert.rejects(refreshV2PriceCheckDraftSource(root,{acquire:async()=>async()=>{released=true;},background:async()=>({busy:true}),open:async()=>{throw Error('Must not open');}}),/workflow is busy/);assert.equal(released,true);}finally{await fs.rm(root,{recursive:true,force:true});}
});
