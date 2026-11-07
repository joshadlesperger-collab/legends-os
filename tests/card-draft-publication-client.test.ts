import test from 'node:test';
import assert from 'node:assert/strict';
import {manualDraftPrice,draftDeliveredDelta,discountedDraftPrice,subtotalDraftPrices,ignoredDraftPreferences} from '../lib/card-draft-publication-client.ts';
test('manual dollars remain optional and exact in cents; malformed or below-floor prices cannot publish',()=>{
 assert.deepEqual(manualDraftPrice(''),{});assert.deepEqual(manualDraftPrice(' 2.05 '),{itemCents:205});assert.deepEqual(manualDraftPrice('10.1'),{itemCents:1010});
 for(const x of ['1.48','2.005','1e3','-2','NaN','1000000.01'])assert.ok(manualDraftPrice(x).error);
});

test('8% discounts the lowest delivered total once and keeps our shipping separate',()=>{
 assert.deepEqual(discountedDraftPrice(636,0),{itemCents:585,totalCents:585});
 assert.deepEqual(discountedDraftPrice(697,149),{itemCents:492,totalCents:641});
 assert.ok(discountedDraftPrice(150,0).error);assert.ok(discountedDraftPrice(null,0).error);assert.ok(discountedDraftPrice(697,null).error);
});

test('subtotals retain separate total and comparable coverage without treating unknown prices as zero',()=>{
 assert.deepEqual(subtotalDraftPrices([{ourTotalCents:585,lowestTotalCents:636},{ourTotalCents:200,lowestTotalCents:null},{ourTotalCents:null,lowestTotalCents:300}]),{totalCents:785,deltaCents:-51,totalCount:2,deltaCount:1,count:3});
 assert.deepEqual(subtotalDraftPrices([{ourTotalCents:null,lowestTotalCents:null}]),{totalCents:null,deltaCents:null,totalCount:0,deltaCount:0,count:1});
});

test('ignore preferences are bounded to this report and malformed data never changes pricing or selection',()=>{
 assert.deepEqual(ignoredDraftPreferences('["1","2","1"]',['1']),{'1':true});
 assert.deepEqual(ignoredDraftPreferences('bad',['1']),{});assert.deepEqual(ignoredDraftPreferences('[1]',['1']),{});
});
test('landed delta is ours minus theirs and unknown shipping/comps cannot imply zero',()=>{
 assert.equal(draftDeliveredDelta(179,400),-221);assert.equal(draftDeliveredDelta(728,697),31);assert.equal(draftDeliveredDelta(400,400),0);
 for(const x of [null,undefined,NaN,-1,1.5])assert.equal(draftDeliveredDelta(x,400),null);
 assert.equal(draftDeliveredDelta(400,null),null);
});
