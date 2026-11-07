import test from 'node:test';
import assert from 'node:assert/strict';
import {validateComps,pricingProjection,type Identity} from '../lib/card-orchestrator.ts';
const now='2026-10-25T20:00:00.000Z';
const identity:Identity={player:'Cam Thomas',season:'2025-26',set:'Topps Chrome Cactus Jack',manufacturer:'Topps',cardNumber:'3',sport:'Basketball',team:'Nets',parallel:'Base',serial:'',printRun:null,condition:'Near mint or better',autograph:false,patch:false,language:'English'};
const comp={listingId:'123456789012',sourceUrl:'https://www.ebay.com/itm/123456789012',observedAt:now,itemPrice:.99,shipping:.78,currency:'USD',identity,seller:'other-seller',active:true,buyItNow:true,singleCard:true,exactVariantVerified:true,unconditionalPrice:true,evidenceMode:'active-listing',evidence:'Exact listing and sorted search verified'};
test('lowest delivered asking total remains an estimate, with no invented sale date',()=>{
 const second={...comp,listingId:'123456789013',sourceUrl:'https://www.ebay.com/itm/123456789013',itemPrice:.50,shipping:2};
 const v=validateComps(identity,[second,comp],now,'active-lowest');
 assert.equal(v.buyerTotalMean,1.77);assert.equal(v.reviewEstimate,true);assert.equal(v.comps.some(c=>'soldDate' in c),false);
 const p=pricingProjection(v.buyerTotalMean,'active-lowest');assert.equal(p.item,1.77);assert.equal(p.shipping,0);
 assert.equal(pricingProjection(2.61,'active-lowest').item,2.61);
 assert.equal(pricingProjection(1.77,'exact').item,1.95);
 assert.equal(pricingProjection(1.10,'active-lowest').item,1.49);
});
test('active fallback rejects mismatch, own seller, stale evidence and unsafe offers',()=>{
 for(const change of [{identity:{...identity,parallel:'Refractor'}},{identity:{...identity,condition:'Excellent'}},{identity:{...identity,language:'Japanese'}},{seller:'imaydit58'},{observedAt:'2026-10-25T18:59:59.000Z'},{shipping:null},{buyItNow:false},{singleCard:false},{unconditionalPrice:false},{active:false}])assert.throws(()=>validateComps(identity,[{...comp,...change}],now,'active-lowest'));
 assert.throws(()=>validateComps(identity,[comp,comp],now,'active-lowest'));
 assert.throws(()=>validateComps(identity,[comp],now,'exact'));
});

test('seller asking reuse preserves the exact asking split without sold rounding or approval',()=>{
 const source={...comp,seller:'imaydit58',itemPrice:2.61,shipping:1.25};
 const v=validateComps(identity,[source],now,'seller-asking');
 const p=pricingProjection(v.buyerTotalMean,'seller-asking',{},v.asking);
 assert.equal(p.item,2.61);assert.equal(p.shipping,1.25);assert.equal(p.overridden,false);
 assert.equal(v.estimateLabel,'current seller asking price');assert.equal(v.reviewEstimate,true);
 assert.equal(v.comps.some(c=>'soldDate' in c),false);
 assert.throws(()=>pricingProjection(v.buyerTotalMean,'seller-asking'));
});
test('seller asking reuse rejects foreign, stale, ambiguous and invalid priced sources',()=>{
 const own={...comp,seller:'imaydit58',itemPrice:1.98,shipping:0};
 for(const change of [{seller:'other-seller'},{observedAt:'2026-10-25T18:00:00Z'},{shipping:null},{identity:{...identity,parallel:'Refractor'}},{identity:{...identity,language:'Japanese'}}])assert.throws(()=>validateComps(identity,[{...own,...change}],now,'seller-asking'));
 assert.throws(()=>validateComps(identity,[own,own],now,'seller-asking'));
 assert.throws(()=>pricingProjection(1,'seller-asking',{}, {item:1,shipping:0}));
 const numbered={...identity,parallel:'Pandora',printRun:400,serial:'352/400'};
 for(const serial of ['', '/400','352/400','0352/400','401/400','298/399'])assert.throws(()=>validateComps(numbered,[{...own,identity:{...numbered,serial}}],now,'seller-asking'));
 assert.equal(validateComps(numbered,[{...own,identity:{...numbered,serial:'298/400'}}],now,'seller-asking').buyerTotalMean,1.98);
});

test('seller asking completion survives handoff, remains unapproved and expires after 60 minutes',async()=>{
 const {newQueue,upsertCard,claimJob,completeJob}=await import('../lib/card-orchestrator.ts');
 const {flowPacket}=await import('../lib/card-orchestrator-flow.ts');
 const s=newQueue(),photos=[{side:'front' as const,path:'fixture-front',sha256:'a'.repeat(64)},{side:'back' as const,path:'fixture-back',sha256:'b'.repeat(64)}];
 upsertCard(s,{id:'asking-fixture',sku:'fixture',identity,photos,candidates:[],source:'fixture'},now);
 for(const [kind,data] of [
  ['photos',{hashes:photos.map(({side,sha256})=>({side,sha256})),evidence:'fixture hashes'}],
  ['identity',{identity,pairMatches:true,frontFirst:true,serialInspected:true,evidence:'fixture identity'}],
  ['pricing',{comps:[{...comp,seller:'imaydit58',itemPrice:2.61,shipping:1.25}],basis:'seller-asking',tracked:false,envelopeEligible:true,evidence:'fixture own asking source',exactSearchEvidence:'fixture active/sold/knowledge checked'}]
 ] as const){const claim=claimJob(s,'test',kind,'asking-fixture',now)!;completeJob(s,'asking-fixture',kind,claim.job.lease!.token,{outcome:'done',data},now);}
 const current=flowPacket(s,['asking-fixture'],now).cards[0];
 assert.equal(current.pricing.draftProposal?.item,2.61);assert.equal(current.pricing.draftProposal?.shipping,1.25);
 assert.equal(current.pricing.approved,false);assert.equal(current.pricing.estimateLabel,'current seller asking price');
 assert.equal(current.pricing.reason,'fixture own asking source');assert.equal(current.canPublish,false);
 assert.equal(flowPacket(s,['asking-fixture'],'2026-10-25T21:00:01.000Z').cards[0].pricing.draftProposal,null);
});
