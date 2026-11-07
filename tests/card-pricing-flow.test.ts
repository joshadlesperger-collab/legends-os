import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { newQueue, upsertCard, claimJob, completeJob, type Identity, type JobKind } from "../lib/card-orchestrator.ts";
import { loadCardBacklog } from "../lib/card-backlog-store.ts";
import { withWorkflow, saveReview, readReviews } from "../lib/card-workflow-store.ts";
import { canApprovePrice, approvedAskingPrice } from "../lib/card-workflow.ts";
import { batchPacket } from "../lib/card-batch.ts";
import { bulkDraftExport } from "../lib/card-bulk-draft.ts";
import { CURRENT_CARD_PRICE_POLICY } from "../lib/card-price-policy.ts";
import { flowPacket } from "../lib/card-orchestrator-flow.ts";
import { configureDraftWriter } from "../lib/card-draft-lifecycle.ts";

async function setup() {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"isolated-price-flow-")),now=new Date().toISOString();
 const identity:Identity={player:"Test Player",season:"2025",set:"Test",manufacturer:"Test",cardNumber:"1",sport:"Basketball",team:"Test",parallel:"Purple",serial:"25/99",printRun:99,condition:"Near mint or better",conditionType:"Ungraded",autograph:false,patch:false};
 const state=newQueue(),photos=[{side:"front" as const,path:"test-front.jpg",sha256:"a".repeat(64)},{side:"back" as const,path:"test-back.jpg",sha256:"b".repeat(64)}];
 upsertCard(state,{id:"test",sku:"test",identity,photos,candidates:[],source:"test"},now);
 for(const [kind,data] of [
  ["photos",{hashes:photos.map(({side,sha256})=>({side,sha256})),evidence:"test originals"}],
  ["identity",{identity,pairMatches:true,frontFirst:true,serialInspected:true,evidence:"test identity"}],
  ["pricing",{comps:[{saleId:"123456789",sourceUrl:"https://www.ebay.com/itm/123456789",soldDate:now.slice(0,10),itemPrice:10,shipping:2,currency:"USD",identity:{...identity,serial:"9/99"},serialObserved:true,priceDisclosed:true,ownAcquisition:false,graded:false,lot:false,condition:"Near mint or better",evidenceMode:"original-sale",evidence:"fixture only"}],tracked:false,envelopeEligible:true,evidence:"fixture evidence"}],
 ] as [JobKind,unknown][]) {
  const claimed=claimJob(state,"fixture",kind,"test",now)!;
  completeJob(state,"test",kind,claimed.job.lease!.token,{outcome:"done",data},now);
 }
 // Simulate retained legacy evidence; projection history must survive loading.
 (state.cards.test.jobs.pricing.result!.projection as {policyVersion:string}).policyVersion="legacy-9pct";
 await fs.mkdir(path.join(root,"artifacts/card-orchestrator"),{recursive:true});
 const file=path.join(root,"artifacts/card-orchestrator/state.json");
 const persist=()=>fs.writeFile(file,JSON.stringify(state));await persist();
 const load=()=>loadCardBacklog({root,inbox:path.join(root,"empty"),scans:[]});
 const batch={id:"fixture",cardIds:[`capture:${"a".repeat(64)}`],createdAt:now,revision:1,intervals:[]};
 const photosHosted=photos.map(p=>({originalHash:p.sha256,url:`https://i.ebayimg.com/images/${p.side}/s-l1600.jpg`,expiresAt:new Date(Date.now()+7*86400000).toISOString(),uprightReviewed:true}));
 async function approve(){const view=await withWorkflow(await load(),root),c=view.cards[0];return saveReview({requestId:randomUUID(),cardId:c.id,token:view.workflow[c.id].token,action:"approve-price",note:"Fixture review only"},load,root);}
 return {root,state,file,persist,load,batch,photosHosted,approve};
}

test("real backlog → saved approval → reload → Draft CSV uses current price and preserves evidence",async()=>{
 const f=await setup();try{
  const before=await fs.readFile(f.file),s=await f.load(),card=s.cards[0];
  assert.equal(card.proposal?.policy,CURRENT_CARD_PRICE_POLICY);assert.equal(card.proposal?.item,10.49);assert.equal(card.proposal?.shipping,1.95);
  assert.ok(card.prices.some(p=>p.policy!==CURRENT_CARD_PRICE_POLICY));assert.equal(card.approvedPrice,null);
  assert.ok(canApprovePrice(card));
  const unreviewed=batchPacket(f.batch,{...s,workflow:{}});
  assert.equal(unreviewed.cards[0].priceApproved,false);assert.equal(unreviewed.cards[0].priceReviewStage,"ebay-draft");
  assert.equal(bulkDraftExport(unreviewed,f.photosHosted).ready,true);
  assert.equal((await readReviews(f.root)).events.length,0,"Draft preparation must not manufacture seller approval");
  await f.approve();const reloaded=await withWorkflow(await f.load(),f.root);
  const packet=batchPacket(f.batch,reloaded),csv=bulkDraftExport(packet,f.photosHosted);
  assert.equal(csv.ready,true);assert.match(csv.csv!,/"Draft","test"/);assert.match(csv.csv!,/"10.49","1"/);
  assert.equal(csv.verification[0].pricingPolicy,CURRENT_CARD_PRICE_POLICY);assert.ok(csv.verification[0].pricingEvidenceKey);
  assert.equal(csv.canPublish,false);assert.equal(packet.canUpload,false);
  assert.deepEqual(await fs.readFile(f.file),before);assert.equal((await readReviews(f.root)).events.length,1);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
test("evidence changes invalidate approval even when rounded price stays equal",async()=>{
 const f=await setup();try{
  const approved=await f.approve(),old=approved.cards[0].proposal!;
  const comps=f.state.cards.test.jobs.pricing.result!.comps as {sourceUrl:string;saleId:string}[];
  comps[0].sourceUrl="https://www.ebay.com/itm/987654321";comps[0].saleId="987654321";await f.persist();
  const fresh=await withWorkflow(await f.load(),f.root),c=fresh.cards[0];
  assert.equal(c.proposal?.item,old.item);assert.notEqual(c.proposal?.evidenceKey,old.evidenceKey);
  assert.equal(approvedAskingPrice(c,fresh.workflow[c.id]),null);
  const current=batchPacket(f.batch,fresh);assert.equal(current.cards[0].priceApproved,false);assert.equal(current.cards[0].pricingEvidenceKey,c.proposal?.evidenceKey);
  assert.equal((await readReviews(f.root)).events.length,1);
  await assert.rejects(saveReview({requestId:randomUUID(),cardId:c.id,token:approved.workflow[c.id].token,action:"approve-price",note:"stale"},f.load,f.root),/changed/);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test("dispatcher uses validated draft prices without seller approval and preserves pricing holds",async()=>{
 const f=await setup();try{
  configureDraftWriter(f.state,"fixture",["test"],"Explicit draft-only test scope",new Date().toISOString());
  const card=flowPacket(f.state,["test"]).cards[0];
  assert.equal(card.pricing.approved,false);assert.equal(card.pricing.approvedAt,null);
  assert.equal(card.pricing.draftAuthorized,true);assert.equal(card.pricing.reviewStage,"ebay-draft");
  assert.equal(card.pricing.draftProposal?.item,10.49);assert.notEqual(card.draft?.owner,"seller");assert.equal(card.canPublish,false);
  const held=flowPacket(f.state,["test"],new Date().toISOString(),[],{},{test:{holdReason:"Inspect this copy"}}).cards[0];
  assert.equal(held.draft?.action,"seller-hold");assert.equal(held.pricing.draftAuthorized,false);
  (f.state.cards.test.jobs.pricing.result!.comps as {shipping:number|null}[])[0].shipping=null;
  const missing=flowPacket(f.state,["test"]).cards[0];
  assert.equal(missing.pricing.draftAuthorized,false);assert.equal(missing.pricing.draftProposal,null);
  assert.equal(missing.draft?.action,"resolve-pricing-evidence");assert.equal(missing.nextOwner,"pricing");
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
test("legacy policy, expired evidence, missing shipping and floor violations cannot escape export",async()=>{
 const f=await setup();try{
  const view=await f.approve(),card=view.cards[0],packet=batchPacket(f.batch,view);
  for(const item of [0.99,1.48]){const bad=structuredClone(packet);bad.listings[0].item=item;assert.equal(bulkDraftExport(bad,f.photosHosted).csv,null);}
  const legacy=structuredClone(packet);legacy.listings[0].pricingPolicy="item-only-9pct";assert.equal(bulkDraftExport(legacy,f.photosHosted).csv,null);
  const expired=structuredClone(packet);expired.listings[0].pricingEvidenceExpiresAt="2000-01-01";assert.equal(bulkDraftExport(expired,f.photosHosted).csv,null);
  await assert.rejects(saveReview({requestId:randomUUID(),cardId:card.id,token:view.workflow[card.id].token,action:"set-price",note:"bad",price:{item:.99,shipping:0}},f.load,f.root),/1.49/);
  (f.state.cards.test.jobs.pricing.result!.comps as {shipping:number|null}[])[0].shipping=null;await f.persist();
  const fresh=await withWorkflow(await f.load(),f.root);assert.equal(fresh.cards[0].proposal,null);assert.throws(()=>batchPacket(f.batch,fresh));
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
test("holds and existing draft receipts remain effective after fresh price approval",async()=>{
 const f=await setup();try{
  const view=await f.approve(),card=view.cards[0];
  await saveReview({requestId:randomUUID(),cardId:card.id,token:view.workflow[card.id].token,action:"hold",note:"Inspect original back"},f.load,f.root);
  const held=await withWorkflow(await f.load(),f.root);assert.throws(()=>batchPacket(f.batch,held));
  const packet=batchPacket(f.batch,view);packet.listings[0].receipts=[{id:"12345",disposition:"draft",source:"fixture"}];
  const exported=bulkDraftExport(packet,f.photosHosted);assert.equal(exported.draftCount,0);assert.equal(exported.existing[0].receipts[0].id,"12345");assert.equal(exported.csv,null);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
