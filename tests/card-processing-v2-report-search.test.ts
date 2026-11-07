import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSellerReport, searchSellerReportBatch } from '../lib/card-report-batch-search.ts';
const target = { id:'one', name:'Jusuf Nurkić', year:'2024-25',product:'Donruss Optic',number:'87',variant:'Lime Green',serial:'050/149',skuAliases:['legacy-one'] };
const active = 'Item number,Title,Custom label (SKU),Available quantity,Current price,Buyer name\n123,2024-25 Donruss Optic Jusuf Nurkic Blue /49 Suns #87,legacy-one,1,3.99,SECRET BUYER\n';
const source = {path:'active.csv',sha256:'a'.repeat(64),modifiedAt:'2026-11-02T03:00:00Z',kind:'active' as const, rows:parseSellerReport(active,'active')};
test('one batch normalizes accents, preserves wrong variant/run and stale unknowns without private fields',()=>{
 const result=searchSellerReportBatch([target],[source],Date.parse('2026-11-03T16:00:00Z'));
 assert.equal(result.sourceRowsScanned,1);const match=result.targets[0].matches[0];
 assert.equal((match.match as any).nameMatched,true);assert.equal((match.match as any).serial,'different-print-run');
 assert.ok((match.flags as string[]).includes('active-snapshot-stale'));assert.ok((match.flags as string[]).includes('shipping-unknown'));
 assert.equal(match.validatedPrice,false);assert.equal(match.grantsInventoryClearance,false);assert.ok(!JSON.stringify(result).includes('SECRET BUYER'));
});
test('orders metadata and overlapping exact transaction dedup never merge separate sales',()=>{
 const text='Report metadata\nSales Record Number,Item Number,Item Title,Transaction ID,Sale Date,Sold For,Buyer Email\n1,123,Jusuf Nurkic,txn-one,Nov-02-26,2.99,SECRET\n2,123,Jusuf Nurkic,txn-two,Nov-02-26,2.99,SECRET\n';
 const rows=parseSellerReport(text,'orders');assert.equal(rows.length,2);
 const base={...source,kind:'orders' as const,rows};const result=searchSellerReportBatch([target],[base,{...base,path:'overlap.csv',sha256:'b'.repeat(64)},{...base,path:'duplicate.csv'}]);
 assert.equal(result.targets[0].candidateCount,2);assert.equal(result.uniqueSourcesScanned,2);assert.equal(result.duplicateSources.length,1);
 assert.ok(!JSON.stringify(result).includes('txn-one'));assert.ok(!JSON.stringify(result).includes('SECRET'));
});
test('SKU candidate still cannot establish identity and target set must be distinct',()=>{
 const result=searchSellerReportBatch([target],[{...source,rows:[{...source.rows[0],title:'Unrelated name'}]}]);
 assert.equal(result.targets[0].candidateCount,1);assert.equal((result.targets[0].matches[0].match as any).nameMatched,false);
 assert.throws(()=>searchSellerReportBatch([target,target],[source]),/distinct/);
 assert.throws(()=>parseSellerReport('not an orders report','orders'),/header/);
});
