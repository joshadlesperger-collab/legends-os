import test from "node:test";
import assert from "node:assert/strict";
import { candidatePrice, compareCardPrice } from "../lib/card-pricing-candidate.ts";
import { newQueue, upsertCard, claimJob, completeJob, type Identity, type JobKind } from "../lib/card-orchestrator.ts";

const now="2026-10-23T12:00:00Z";
function fixture(shipping:number|null=2) {
  const identity:Identity={player:"Test",season:"2025",set:"Test set",manufacturer:"Test",cardNumber:"1",sport:"Basketball",team:"Test",parallel:"Purple",serial:"25/99",printRun:99,condition:"Near mint or better",autograph:false,patch:false};
  const state=newQueue();
  const photos=[{side:"front" as const,path:"front.jpg",sha256:"a".repeat(64)},{side:"back" as const,path:"back.jpg",sha256:"b".repeat(64)}];
  upsertCard(state,{id:"one",sku:"one",identity,photos,candidates:[],source:"test"},now);
  function finish(kind:JobKind,data:unknown){const job=claimJob(state,"test",kind,"one",now)!;completeJob(state,"one",kind,job.job.lease!.token,{outcome:"done",data},now);}
  finish("photos",{hashes:photos.map(({side,sha256})=>({side,sha256})),evidence:"verified originals"});
  finish("identity",{identity,pairMatches:true,frontFirst:true,serialInspected:true,evidence:"verified identity"});
  finish("pricing",{comps:[{saleId:"123456789",sourceUrl:"https://www.ebay.com/itm/123456789",soldDate:"2026-10-20",itemPrice:10,shipping:shipping??0,currency:"USD",identity:{...identity,serial:"9/99"},serialObserved:true,priceDisclosed:true,ownAcquisition:false,graded:false,lot:false,condition:"Near mint or better",evidenceMode:"original-sale",evidence:"source verified"}],tracked:false,envelopeEligible:true,evidence:"validated"});
  if(shipping===null)(state.cards.one.jobs.pricing.result!.comps as {shipping:number|null}[])[0].shipping=null;
  return state.cards.one;
}

test("latest tiered rounding and hard floor", () => {
  for (const [raw, expected] of [[1,1.49],[3,2.95],[3.01,3.49],[20,20.49],[2.49,2.49],[2.95,2.95],[1.72,1.49]])
    assert.equal(candidatePrice(raw,0).item, expected, String(raw));
});
test("shipping is subtracted once, no buffer is added", () => {
  const p = candidatePrice(10,1.49);
  assert.equal(p.item,8.95); assert.equal(p.buyerTotal,10.44);
  assert.equal(p.automaticBufferPercent,0); assert.equal(p.approved,false);
});
test("floor preserves low market target and flags economics", () => {
  const p = candidatePrice(1,1.49);
  assert.equal(p.item,1.49); assert.equal(p.targetBuyerTotal,1); assert.equal(p.economicsReview,true);
});
test("invalid totals and unknown shipping are never coerced", () => {
  for (const n of [NaN,Infinity,-1,0]) assert.throws(()=>candidatePrice(n,0));
  for (const n of [NaN,Infinity,-1,undefined,null]) assert.throws(()=>candidatePrice(10,n as number));
});
test("adapter preserves complete evidence, old projection and approval history",()=>{
  const card=fixture(),before=JSON.stringify(card),result=compareCardPrice(card,now);
  assert.ok(result.candidate);assert.equal(result.candidate.targetBuyerTotal,12);
  assert.equal(result.candidate.approved,false);assert.equal(JSON.stringify(card),before);
  assert.equal(result.old,card.jobs.pricing.result!.projection);
});
test("missing sale shipping blocks rather than inventing zero",()=>{
  const result=compareCardPrice(fixture(null),now);
  assert.equal(result.candidate,null);assert.match(result.blockers.join(" "),/shipping unknown/);
});
test("expired or duplicated evidence remains blocked",()=>{
  const card=fixture();
  assert.equal(compareCardPrice(card,"2027-10-23T12:00:00Z").candidate,null);
  const comps=card.jobs.pricing.result!.comps as unknown[];comps.push(structuredClone(comps[0]));
  assert.equal(compareCardPrice(card,now).candidate,null);
});
test("changed original capture invalidates candidate without clearing evidence",()=>{
  const card=fixture();card.input.photos[0].sha256="c".repeat(64);
  const before=JSON.stringify(card);
  assert.equal(compareCardPrice(card,now).candidate,null);assert.equal(JSON.stringify(card),before);
});
test("seller overrides are preserved",()=>{
  const card=fixture();card.input.override={item:20,shipping:0,evidence:"seller price"};
  assert.equal(compareCardPrice(card,now).candidate,null);
});
test("condition uplift affects the item, never source postage",()=>{
  const card=fixture();
  const comps=card.jobs.pricing.result!.comps as {condition:string}[];comps[0].condition="Very good";
  assert.equal(compareCardPrice(card,now).candidate?.targetBuyerTotal,14.5);
});

test("incomplete stages retain evidence and override precedence without mutation",()=>{
 for(const kind of ["photos","identity","pricing"] as const)for(const state of ["todo","held","leased"] as const){
  const card=fixture();card.jobs[kind].state=state;
  const before=JSON.stringify(card),result=compareCardPrice(card,now);
  assert.equal(result.candidate,null);
  assert.deepEqual(result.blockers,["Current photo/identity/pricing snapshot is incomplete or invalidated; saved evidence retained"]);
  assert.deepEqual(result.evidence,card.jobs.pricing.result!.comps);
  assert.equal(JSON.stringify(card),before);
 }
});

test("seller override takes precedence over an incomplete pricing stage",()=>{
 const card=fixture();card.jobs.pricing.state="held";card.input.override={item:20,shipping:0,evidence:"seller price"};
 const before=JSON.stringify(card),result=compareCardPrice(card,now);
 assert.deepEqual(result.blockers,["Seller override preserved; not automatically recalculated"]);
 assert.equal(result.candidate,null);assert.equal(JSON.stringify(card),before);
});
