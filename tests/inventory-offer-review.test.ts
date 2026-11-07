import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewSources,readOfferReview} from '../lib/inventory-offer-review.ts';
test('bounded source parser rejects unrelated cards and unsafe photo URLs',()=>{
 const h=['Custom Label (SKU)','Item photo URL'];
 assert.throws(()=>reviewSources({headers:h,rows:[['unrelated','']]}));
 assert.deepEqual(reviewSources({headers:h,rows:[['TEST-CSV-cactus13-0001','javascript:alert(1)|https://example.com/a.jpg']]} )[0].photos,['https://example.com/a.jpg']);
});
test('remote reader uses only GET and isolates failures without leaking error text',async()=>{
 const methods:string[]=[];
 const fetcher:typeof fetch=async(input,init)=>{methods.push(init?.method??'');if(String(input).includes('bad'))throw Error('SECRET');return new Response(JSON.stringify(String(input).includes('inventory_item')?{product:{title:'Card'},condition:'LIKE_NEW'}:{offers:[{offerId:'1',status:'UNPUBLISHED',listingPolicies:{paymentPolicyId:'2'}}]}),{status:200});};
 const rows=await readOfferReview('mock',['good','bad'],fetcher);
 assert.equal(rows[0].offers?.[0].status,'UNPUBLISHED');assert.match(rows[1].status,/unavailable/);assert.ok(methods.every(m=>m==='GET'));assert.ok(!JSON.stringify(rows).includes('SECRET'));
});
test('HTTP errors and pagination cannot imply complete saved data',async()=>{
 const fetcher:typeof fetch=async()=>new Response(JSON.stringify({next:'more',errors:[{message:'SECRET'}]}),{status:403});
 const [r]=await readOfferReview('mock',['x'],fetcher);assert.match(r.status,/incomplete/);assert.equal(r.item,undefined);assert.equal(r.offers,undefined);
});
