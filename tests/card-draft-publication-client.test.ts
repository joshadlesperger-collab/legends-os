import test from 'node:test';
import assert from 'node:assert/strict';
import {manualDraftPrice,draftDeliveredDelta} from '../lib/card-draft-publication-client.ts';
test('manual dollars remain optional and exact in cents; malformed or below-floor prices cannot publish',()=>{
 assert.deepEqual(manualDraftPrice(''),{});assert.deepEqual(manualDraftPrice(' 2.05 '),{itemCents:205});assert.deepEqual(manualDraftPrice('10.1'),{itemCents:1010});
 for(const x of ['1.48','2.005','1e3','-2','NaN','1000000.01'])assert.ok(manualDraftPrice(x).error);
});
test('landed delta is ours minus theirs and unknown shipping/comps cannot imply zero',()=>{
 assert.equal(draftDeliveredDelta(179,400),-221);assert.equal(draftDeliveredDelta(728,697),31);assert.equal(draftDeliveredDelta(400,400),0);
 for(const x of [null,undefined,NaN,-1,1.5])assert.equal(draftDeliveredDelta(x,400),null);
 assert.equal(draftDeliveredDelta(400,null),null);
});
