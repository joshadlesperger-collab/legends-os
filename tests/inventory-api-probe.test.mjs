import test from 'node:test';
import assert from 'node:assert/strict';
import {probeInventoryOffers} from '../lib/inventory-api-probe.mjs';
test('only bounded GETs; empty API offers never authorize creation',async()=>{
 const calls=[];const r=await probeInventoryOffers({token:'mock',skus:['a','a','b'].slice(0,2),fetcher:async(u,o)=>{calls.push([u,o]);return {ok:true,status:200,json:async()=>({offers:[]})}}});
 assert.equal(calls.length,1);assert.equal(calls[0][1].method,'GET');assert.equal(r.creationAllowed,false);assert.equal(r.writesPerformed,0);
});
test('isolates failure and suppresses raw error text',async()=>{
 let n=0;const r=await probeInventoryOffers({token:'mock',skus:['a','b'],fetcher:async()=>{if(!n++)throw Error('SECRET');return {ok:false,status:403,json:async()=>({errors:[{errorId:1100,message:'SECRET'}]})}}});
 assert.equal(r.results.length,2);assert.equal(r.results[1].httpStatus,403);assert.ok(!JSON.stringify(r).includes('SECRET'));
});
test('rejects unbounded inventory scans',async()=>{
 await assert.rejects(probeInventoryOffers({token:'mock',skus:['a','b','c']}));
});
