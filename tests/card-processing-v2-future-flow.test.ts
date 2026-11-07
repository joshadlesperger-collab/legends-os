import test from 'node:test';import assert from 'node:assert/strict';
import { planV2FutureBatch } from '../lib/card-processing-v2-future-flow.ts';
const group={key:'a'.repeat(64),captureIds:['b'.repeat(64)],draftId:'5289381326721',fieldMismatches:['Card Condition','Return policy','Item price','Shipping amount']};
test('nonblank unknown price is preserved while same-ID nonprice repairs remain eligible',()=>{
 const packet={groups:[{...group,priceObservation:{value:'2.79',reportedSource:'unknown'}}],pricingDeferred:true},before=JSON.stringify(packet),plan=planV2FutureBatch(packet),g=plan.groups[0];
 assert.equal(g.nonPriceReview,'eligible-same-id');assert.equal(g.fullUnpricedVerification,'blocked-nonblank-preserve-and-reconcile');assert.equal(g.price.observedValue,'2.79');assert.equal(g.price.reportedSource,'unknown');assert.deepEqual(g.price.allowedWrites,[]);assert.equal(g.price.preserveCurrentValue,true);assert.ok(g.fieldRepairs.every(f=>f.action==='repair-and-save-reopen-same-id'&&!f.allowedToChangePrice));assert.deepEqual(g.deferredPriceFields,['Item price','Shipping amount']);assert.equal(g.fieldRepairs.length,2);assert.equal(JSON.stringify(packet),before);
 assert.equal(plan.newFxDraftWritesAllowed,false);assert.equal(plan.pricingGenerationAllowed,false);assert.equal(plan.canPublish,false);assert.ok(plan.browserTemplateFirstLine.startsWith('#INFO,Version='));
});
test('claimed Grok source cannot be inferred from amount, and retained attribution grants no write or verification',()=>{
 assert.throws(()=>planV2FutureBatch({groups:[{...group,priceObservation:{value:'2.79',reportedSource:'grok'}}],pricingDeferred:true}),/provenance/);
 const result=planV2FutureBatch({groups:[{...group,priceObservation:{value:'2.79',reportedSource:'grok',sourceEvidence:{path:'artifacts/proposal.json',sha256:'c'.repeat(64)}}}],pricingDeferred:true}).groups[0];
 assert.equal(result.price.sourceVerified,false);assert.equal(result.price.reportedSource,'grok');assert.deepEqual(result.price.allowedWrites,[]);assert.equal(result.fullUnpricedVerification,'blocked-nonblank-preserve-and-reconcile');
});
test('zero is nonblank; missing/blank observations cannot silently become full verification',()=>{
 for(const value of ['0','0.00','Suggested $2.79'])assert.equal(planV2FutureBatch({groups:[{...group,priceObservation:{value,reportedSource:'unknown'}}],pricingDeferred:true}).groups[0].fullUnpricedVerification,'blocked-nonblank-preserve-and-reconcile');
 assert.equal(planV2FutureBatch({groups:[group],pricingDeferred:true}).groups[0].fullUnpricedVerification,'blocked-price-observation-missing');
 assert.equal(planV2FutureBatch({groups:[{...group,priceObservation:{value:'',reportedSource:'unknown'}}],pricingDeferred:true}).groups[0].fullUnpricedVerification,'requires-independent-full-saved-readback');
});
test('unimported groups require fresh reconciliation and overlapping ownership refuses work',()=>{
 assert.equal(planV2FutureBatch({groups:[{...group,draftId:undefined}],pricingDeferred:true}).groups[0].nonPriceReview,'requires-imported-id');
 assert.throws(()=>planV2FutureBatch({groups:[group,{...group,key:'d'.repeat(64),draftId:'123'}],pricingDeferred:true}),/ownership/);
 assert.throws(()=>planV2FutureBatch({groups:[group],pricingDeferred:false}));
});
