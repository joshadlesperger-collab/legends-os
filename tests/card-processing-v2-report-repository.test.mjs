import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stageSellerReports, readSellerReports } from '../scripts/stage-seller-reports.mjs';
test('immutable private snapshots and hashed indexes replay without renewing original date',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'seller-reports-'));
 try {
  await fs.writeFile(path.join(root,'.gitignore'),'/reports/ebay/\n');
  const source=path.join(root,'source.csv'), text='Sales Record Number,Item Number,Item Title,Transaction ID,Sale Date,Buyer Email\n1,123,Example Card,secret-transaction,Nov-02-26,secret-buyer@example.com\n';
  await fs.writeFile(source,text);const packet={seller:'imaydit58',sources:[{path:source,kind:'orders',exportDate:'2026-11-02',coverage:'recent-90-days'}]};
  const first=await stageSellerReports(root,packet);await stageSellerReports(root,packet);
  assert.equal(await fs.readFile(source,'utf8'),text);assert.equal(await fs.readFile(path.join(root,first.staged[0].rawPath),'utf8'),text);
  const index=await fs.readFile(path.join(root,first.staged[0].indexPath),'utf8');assert.ok(!index.includes('secret-transaction'));assert.ok(!index.includes('secret-buyer'));
  const read=await readSellerReports(root);assert.equal(read[0].modifiedAt,first.staged[0].sourceModifiedAt);assert.equal(read[0].rows.length,1);
  const manifest=JSON.parse(await fs.readFile(path.join(root,first.manifest),'utf8'));assert.equal(manifest.freshLiveObservation,false);
  await fs.writeFile(path.join(root,first.staged[0].indexPath),'{}');await assert.rejects(readSellerReports(root),/hash mismatch/);
  await assert.rejects(stageSellerReports(root,packet),/Immutable/);
 } finally {await fs.rm(root,{recursive:true,force:true});}
});
test('raw staging refuses missing privacy ignore before copying source',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'seller-reports-'));
 try {await fs.writeFile(path.join(root,'.gitignore'),'');await assert.rejects(stageSellerReports(root,{seller:'imaydit58',sources:[{}]}),/git-ignored/);}
 finally{await fs.rm(root,{recursive:true,force:true});}
});
