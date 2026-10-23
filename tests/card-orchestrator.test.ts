import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { calculateCardPrice, roundUpCardPrice } from "../lib/card-orchestrator-policy.ts";
import { claimJob, completeJob, fingerprint, listingTitle, localReviewListings, newQueue, quarantineImport, queueSummary, retryHeld, upsertCard, validateComps, type CardInput, type Identity, type JobKind, type QueueState } from "../lib/card-orchestrator.ts";
import { readQueue, withQueue } from "../lib/card-orchestrator-store.ts";
import { applySavedReceipts, importLegacyCard, savedReceiptDependencies } from "../lib/card-orchestrator-import.ts";
import { flowPacket, flowHtml, pricingContext } from "../lib/card-orchestrator-flow.ts";

const now="2026-10-18T08:00:00.000Z";
const identity:Identity={player:"Payton Pritchard",season:"2024-25",set:"Panini Prizm Black",manufacturer:"Panini",cardNumber:"212",sport:"Basketball",team:"Boston Celtics",parallel:"Purple Prizm",serial:"25/99",printRun:99,condition:"Near mint or better",autograph:false,patch:false};
const input=(id="card-1",serial="25/99"):CardInput=>({id,sku:id,identity:{...identity,serial},photos:[{side:"front",path:"front.jpg",sha256:(id==="card-1"?"a":"c").repeat(64)},{side:"back",path:"back.jpg",sha256:(id==="card-1"?"b":"d").repeat(64)}],candidates:[],source:"test"});
const seeded=()=>{const s=newQueue();upsertCard(s,input(),now);return s;};
function finish(s:QueueState,kind:JobKind,data:unknown,id="card-1") {const c=claimJob(s,"worker",kind,id,now)!;assert.ok(c);completeJob(s,id,kind,c.job.lease!.token,{outcome:"done",data:kind==="pricing"?{scarcitySearchEvidence:"Test search verified no additional comparable numbered sales",...(data as object)}:data},now);}
function identified(){const s=seeded();finish(s,"photos",{hashes:s.cards["card-1"].input.photos.map(({side,sha256})=>({side,sha256})),evidence:"original files"});finish(s,"identity",{identity,pairMatches:true,frontFirst:true,serialInspected:true,evidence:"both originals read"});return s;}
const comp=(changes:Record<string,unknown>={})=>({saleId:"407092203088",sourceUrl:"https://www.ebay.com/itm/407092203088",soldDate:"2026-07-27",itemPrice:1.75,shipping:null,currency:"USD",identity:{...identity,serial:"9/99"},serialObserved:true,priceDisclosed:true,ownAcquisition:false,graded:false,lot:false,condition:"Near mint or better",evidenceMode:"original-sale",evidence:"Original sale verified",...changes});

// Independent synthetic sales for sample-size regression coverage.
const threeSales=(c:ReturnType<typeof comp>)=>[c,...[1,2].map(n=>({...c,saleId:c.saleId+String(n),sourceUrl:c.sourceUrl+String(n)}))];

test("current price rule converts under-three base once, excluding comp postage",()=>{
  const p=calculateCardPrice(1.75);assert.equal(p.roundedBase,1.95);assert.equal(p.item,3.44);assert.equal(p.shipping,0);assert.equal(p.minimumOffer,2.76);assert.equal(p.autoAccept,3.10);
  assert.equal(calculateCardPrice(2).item,3.98);assert.equal(calculateCardPrice(3).item,3.49);assert.equal(calculateCardPrice(3).shipping,1.49);
  assert.equal(roundUpCardPrice(6.95),6.95);assert.equal(roundUpCardPrice(6.96),7.49);
});
test("shipping tiers, patch rule, tracked exceptions and explicit overrides",()=>{
  assert.equal(calculateCardPrice(6,{patch:true}).shipping,1.95);
  assert.equal(calculateCardPrice(12).shipping,1.95);assert.equal(calculateCardPrice(20).shipping,6.29);
  const tracked=calculateCardPrice(1.75,{tracked:true});assert.equal(tracked.item,1.95);assert.equal(tracked.shipping,6.29);
  const override=calculateCardPrice(5,{override:{item:1,shipping:0,evidence:"User explicitly chose one dollar"}});assert.equal(override.item,1);assert.ok(override.minimumOffer<=1);
  assert.throws(()=>calculateCardPrice(0));assert.throws(()=>calculateCardPrice(5,{premiumPercent:50}));
});
test("jobs follow prerequisites, and no operation creates a publishable payload",()=>{
  const s=seeded();assert.equal(claimJob(s,"worker","identity",undefined,now),null);
  const ready=identified();finish(ready,"listing",{prepare:true});const result=ready.cards["card-1"].jobs.listing.result!;
  assert.equal(result.action,"");assert.equal(result.canPublish,false);assert.equal(result.canUpload,false);assert.equal(result.quantity,1);assert.equal(result.pricing,null);
  assert.equal(queueSummary(ready,now).counts.readyForUpload,0);
});
test("live and draft receipts exclude cards, even when subsequent source rows omit them",()=>{
  const s=seeded();upsertCard(s,{...input(),knownLive:{itemId:"123",url:"https://www.ebay.com/itm/123",observedAt:now,source:"test"}},now);
  upsertCard(s,input(),now);assert.equal(claimJob(s,"worker",undefined,undefined,now),null);
  const d=seeded();upsertCard(d,{...input(),knownDraft:"456"},now);assert.equal(claimJob(d,"worker","listing",undefined,now),null);
  assert.ok(claimJob(d,"worker","photos",undefined,now));
});
test("a reviewed draft can finish pricing while Add and conflicting receipts stay blocked",()=>{
  const s=identified();upsertCard(s,{...input(),knownDraft:"456"},now);
  assert.equal(claimJob(s,"worker","listing","card-1",now),null);
  finish(s,"pricing",{comps:[comp({shipping:1.49})],tracked:false,envelopeEligible:true,evidence:"Reused pricing agent evidence"});
  assert.equal((s.cards["card-1"].jobs.pricing.result!.projection as {item:number}).item,3.44);
  assert.deepEqual(localReviewListings(s,now),[]);assert.equal(queueSummary(s,now).counts.readyForUpload,0);
  const conflict=identified();upsertCard(conflict,{...input(),knownDraft:"456"},now);
  upsertCard(conflict,{...input("card-2","26/99"),knownDraft:"456"},now);
  assert.equal(claimJob(conflict,"worker","pricing","card-1",now),null);
  const live=identified();upsertCard(live,{...input(),knownLive:{itemId:"123",url:"https://www.ebay.com/itm/123",observedAt:now,source:"test"}},now);
  assert.equal(claimJob(live,"worker","pricing","card-1",now),null);
});
test("same photos, same SKU and exact physical serial are independently blocked",()=>{
  for(const change of [{photos:input().photos},{sku:"card-1"},{identity}]){
    const s=seeded();upsertCard(s,{...input("card-2","26/99"),...change},now);assert.equal(claimJob(s,"worker",undefined,undefined,now),null);
  }
  const s=seeded();upsertCard(s,input("card-2","26/99"),now);assert.ok(claimJob(s,"worker","photos","card-2",now));
});
test("lease ownership prevents competing workers from overwriting results",()=>{
  const s=seeded(),first=claimJob(s,"a","photos",undefined,now)!;
  assert.equal(claimJob(s,"b","photos",undefined,now),null);
  assert.throws(()=>completeJob(s,"card-1","photos","wrong",{outcome:"held",reason:"x"},now),/Lease/);
  const later="2026-10-18T08:06:00.000Z",next=claimJob(s,"b","photos",undefined,later)!;assert.ok(next);
  assert.notEqual(first.job.lease!.token,next.job.lease!.token);
  assert.throws(()=>completeJob(s,"card-1","photos",first.job.lease!.token,{outcome:"held",reason:"late"},later),/Lease/);
  assert.equal(claimJob(s,"c","photos",undefined,"2026-10-18T08:12:00.000Z"),null);assert.equal(s.cards["card-1"].jobs.photos.state,"held");
});
test("changed photos invalidate identity, prices and local listing work",()=>{
  const s=identified();finish(s,"pricing",{comps:[comp()],tracked:false,envelopeEligible:true,evidence:"eligible"});finish(s,"listing",{prepare:true});
  const updated=input();updated.photos[0].sha256="e".repeat(64);upsertCard(s,updated,now);
  for(const kind of ["photos","identity","pricing","listing"] as const)assert.equal(s.cards["card-1"].jobs[kind].state,"todo");
});
test("changed source invalidates a worker's in-flight completion",()=>{
  const s=seeded(),claim=claimJob(s,"a","photos",undefined,now)!;const updated=input();updated.photos[0].sha256="f".repeat(64);upsertCard(s,updated,now);
  assert.throws(()=>completeJob(s,"card-1","photos",claim.job.lease!.token,{outcome:"held",reason:"old input"},now),/Lease/);
});
test("held work stays quiet, and retries require evidence and stop at attempt limit",()=>{
  const s=seeded();let c=claimJob(s,"a","photos",undefined,now)!;completeJob(s,"card-1","photos",c.job.lease!.token,{outcome:"held",reason:"missing original"},now);
  assert.equal(claimJob(s,"a",undefined,undefined,now),null);assert.throws(()=>retryHeld(s,"card-1","photos","",now));
  retryHeld(s,"card-1","photos","Original restored",now);c=claimJob(s,"a","photos",undefined,now)!;completeJob(s,"card-1","photos",c.job.lease!.token,{outcome:"held",reason:"still missing"},now);
  assert.throws(()=>retryHeld(s,"card-1","photos","Try again",now));
});
test("bad import quarantines prepared work without erasing original data",()=>{
  const s=identified();finish(s,"listing",{prepare:true});quarantineImport(s,"card-1","invalid override",now);
  assert.equal(queueSummary(s,now).counts.localListingsPrepared,0);assert.equal(claimJob(s,"worker",undefined,undefined,now),null);
  assert.equal(s.cards["card-1"].input.photos[0].sha256,"a".repeat(64));
  upsertCard(s,input(),now);assert.equal(s.cards["card-1"].jobs.identity.state,"todo");
});
test("matching sold item amounts ignore unknown shipping; weak evidence stays review-only",()=>{
  const validated=validateComps(identity,[comp({condition:"Unknown",evidenceMode:"sold-result"})],now);
  assert.equal(validated.mean,1.75);assert.equal(validated.reviewEstimate,true);
  assert.equal(validateComps(identity,[comp({shipping:99})],now).mean,1.75);
});
test("comp safeguards reject own acquisition, wrong player, duplicate sale and stale evidence",()=>{
  assert.throws(()=>validateComps(identity,[comp({identity})],now),/Own exact/);
  assert.throws(()=>validateComps(identity,[comp({identity:{...identity,player:"Wrong",serial:"9/99"}})],now),/does not match/);
  assert.throws(()=>validateComps(identity,[comp(),comp({saleId:"other",sourceUrl:"https://www.ebay.com/itm/name/407092203088?x=y"})],now),/Duplicate/);
  assert.throws(()=>validateComps(identity,[comp({soldDate:"2026-01-01"})],now),/90-day/);
  assert.throws(()=>validateComps(identity,[comp({priceDisclosed:false})],now));
  assert.throws(()=>validateComps(identity,[comp({serialObserved:false})],now),/serial/);
  assert.throws(()=>validateComps(identity,[comp({condition:"Unknown"})],now),/condition/);
});

test("related numbered-parallel estimates scale item amounts and remain labeled for review",()=>{
  const s=identified();
  const related=comp({identity:{...identity,parallel:"Blue Prizm",serial:"14/198",printRun:198},shipping:0});
  finish(s,"pricing",{comps:threeSales(related),basis:"related-print-run",exactSearchEvidence:"Focused exact sold search found no usable independent sale",tracked:false,envelopeEligible:true,evidence:"Independent related original sale and physical serial reviewed"});
  const result=s.cards["card-1"].jobs.pricing.result!;
  assert.equal(result.mean,3.5);assert.equal(result.reviewEstimate,true);
  assert.equal((result.basisDetails as object[]).length,3);assert.deepEqual((result.basisDetails as object[])[0],{saleId:"407092203088",sourceUrl:"https://www.ebay.com/itm/407092203088",itemPrice:1.75,sourcePrintRun:198,targetPrintRun:99,multiplier:2,adjustedItemPrice:3.5});
  assert.equal((result.projection as {item:number}).item,3.95);
  finish(s,"listing",{prepare:true});
  const row=localReviewListings(s,now)[0];
  assert.equal(row.priceBasis,"related-print-run");assert.equal(row.reviewEstimate,true);assert.equal(row.priceNeedsReview,true);
  assert.deepEqual(row.priceBasisDetails,result.basisDetails);
  assert.equal(row.action,"");assert.equal(row.canUpload,false);assert.equal(row.canPublish,false);
  assert.equal(queueSummary(s,now).cards[0].jobs.find(j=>j.kind==="pricing")!.state,"done");
  queueSummary(s,"2026-11-01T08:00:00.000Z");
  assert.equal(s.cards["card-1"].jobs.pricing.state,"held");assert.equal(localReviewListings(s,"2026-11-01T08:00:00.000Z").length,0);
});

test("related estimate fallback requires exact-search evidence and retains acquisition safeguards",()=>{
  const related=comp({identity:{...identity,parallel:"Blue Prizm",serial:"14/198",printRun:198}});
  const s=identified(),claim=claimJob(s,"worker","pricing",undefined,now)!;
  const payload={comps:[related],basis:"related-print-run",tracked:false,envelopeEligible:true,evidence:"Related sale inspected"};
  assert.throws(()=>completeJob(s,"card-1","pricing",claim.job.lease!.token,{outcome:"done",data:payload},now),/exact sold/);
  assert.throws(()=>validateComps(identity,[related],now),/does not match/);
  assert.throws(()=>validateComps(identity,[comp()],now,"related-print-run"),/exact basis/);
  for(const changes of [{ownAcquisition:true},{priceDisclosed:false},{graded:true},{lot:true},{serialObserved:false}]) {
    assert.throws(()=>validateComps(identity,[{...related,...changes}],now,"related-print-run"));
  }
  assert.throws(()=>validateComps(identity,[{...related,identity:{...related.identity,cardNumber:"999"}}],now,"related-print-run"),/same card/);
  assert.throws(()=>validateComps({...identity,serial:"",printRun:null},[related],now,"related-print-run"),/known numbered/);
  assert.throws(()=>validateComps(identity,[{...related,identity:{...related.identity,serial:"",printRun:null}}],now,"related-print-run"),/known numbered/);
  assert.throws(()=>validateComps(identity,[related,related],now,"related-print-run"),/Duplicate/);
});

test("related arithmetic preserves unrounded means, exact low-price conversion and user overrides",()=>{
  const related=(id:string,price:number)=>comp({saleId:id,sourceUrl:`https://www.ebay.com/itm/${id}`,itemPrice:price,identity:{...identity,parallel:"White Prizm",serial:"7/50",printRun:50},shipping:0});
  const v=validateComps(identity,[related("100",1.01),related("101",2)],now,"related-print-run");
  assert.equal(v.mean,(1.01*50/99+2*50/99)/2);
  const s=identified();finish(s,"pricing",{comps:threeSales(comp({identity:{...identity,parallel:"Other Prizm",serial:"7/99"},shipping:0})),basis:"related-print-run",exactSearchEvidence:"No exact parallel sale",tracked:false,envelopeEligible:true,evidence:"Independent related parallel"});
  assert.equal((s.cards["card-1"].jobs.pricing.result!.projection as {item:number}).item,3.44);
  const override={item:7.11,shipping:2.22,evidence:"Direct user override"};
  upsertCard(s,{...input(),override},now);
  finish(s,"pricing",{comps:threeSales(related("102",2)),basis:"related-print-run",exactSearchEvidence:"No usable exact sold comp",tracked:false,envelopeEligible:true,evidence:"Related original reviewed"});
  const p=s.cards["card-1"].jobs.pricing.result!.projection as {item:number;shipping:number;overridden:boolean};
  assert.deepEqual({item:p.item,shipping:p.shipping,overridden:p.overridden},{item:7.11,shipping:2.22,overridden:true});
});

test("numbered comp serials must be complete and consistent before pricing",()=>{
  for(const serial of ["25","25/98","0/99","100/99"])assert.throws(()=>validateComps(identity,[comp({identity:{...identity,serial}})],now),/complete numerator/);
  assert.throws(()=>validateComps(identity,[comp({identity:{...identity,serial:"025/099"}})],now),/Own exact/);
});
test("CLI review report preserves a related estimate and its source arithmetic across restart",async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"card-related-report-")),checkedAt=new Date().toISOString();
  try {
    await withQueue(path.join(dir,"artifacts/card-orchestrator"),s=>{
      upsertCard(s,input(),checkedAt);
      const done=(kind:JobKind,data:unknown)=>{
        const claimed=claimJob(s,"report-test",kind,"card-1",checkedAt)!;
        completeJob(s,"card-1",kind,claimed.job.lease!.token,{outcome:"done",data},checkedAt);
      };
      done("photos",{hashes:input().photos.map(({side,sha256})=>({side,sha256})),evidence:"Test fixture hashes"});
      done("identity",{identity,pairMatches:true,frontFirst:true,serialInspected:true,evidence:"Test fixture identity"});
      done("pricing",{basis:"related-print-run",exactSearchEvidence:"No usable exact sale in test fixture",tracked:false,envelopeEligible:true,evidence:"Test fixture related sale",comps:threeSales(comp({shipping:0,soldDate:checkedAt.slice(0,10),identity:{...identity,parallel:"Blue Prizm",printRun:198,serial:"14/198"}}))});
      done("listing",{prepare:true});
    });
    const script=fileURLToPath(new URL("../scripts/card-orchestrator.ts",import.meta.url));
    execFileSync(process.execPath,["--experimental-strip-types",script,"status"],{cwd:dir,stdio:["ignore","pipe","pipe"]});
    const html=await fs.readFile(path.join(dir,"artifacts/card-orchestrator/status.html"),"utf8");
    assert.match(html,/Related numbered-parallel estimate; price approval required/);
    assert.match(html,/Source sold item \$1\.75 × 198\/99 = \$3\.5000 before premium and rounding/);
    assert.match(html,/https:\/\/www\.ebay\.com\/itm\/407092203088/);
    const saved=await readQueue(path.join(dir,"artifacts/card-orchestrator"));
    assert.equal(saved.cards["card-1"].jobs.pricing.state,"done");
    assert.equal(saved.cards["card-1"].jobs.listing.result!.canPublish,false);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});

test("identity review cannot invent a serial or erase a user condition override",()=>{
  const s=seeded();finish(s,"photos",{hashes:input().photos.map(({side,sha256})=>({side,sha256})),evidence:"original"});
  const c=claimJob(s,"worker","identity",undefined,now)!;
  const submit=(i:Identity)=>completeJob(s,"card-1","identity",c.job.lease!.token,{outcome:"done",data:{identity:i,pairMatches:true,frontFirst:true,serialInspected:true,evidence:"viewed"}},now);
  assert.throws(()=>submit({...identity,serial:"100/99"}),/numerator/);assert.throws(()=>submit({...identity,condition:"Excellent"}),/override/);assert.throws(()=>submit({...identity,autograph:null}),/autograph/);
});
test("clear inventory requires fresh observations in all four scopes for the right seller",()=>{
  const s=identified(),c=claimJob(s,"worker","reconcile",undefined,now)!;
  const data={seller:"imaydit58",disposition:"clear",checkedAt:now,scopes:["active","drafts","scheduled","sold"],evidence:"SKU and exact identity checked"};
  const submit=(change:Record<string,unknown>)=>completeJob(s,"card-1","reconcile",c.job.lease!.token,{outcome:"done",data:{...data,...change}},now);
  assert.throws(()=>submit({scopes:["active"]}),/active, draft/);assert.throws(()=>submit({seller:"other"}));assert.throws(()=>submit({checkedAt:"2026-10-18T06:00:00.000Z"}),/fresh/);
  submit({});assert.equal(s.cards["card-1"].jobs.reconcile.state,"done");
});
test("a positive external receipt survives identity changes",()=>{
  const s=identified();finish(s,"reconcile",{seller:"imaydit58",disposition:"live",checkedAt:now,scopes:["active"],itemId:"123",evidence:"exact listing"});
  upsertCard(s,{...input(),identity:{...identity,team:"Corrected team"}},now);
  assert.equal(claimJob(s,"worker",undefined,undefined,now),null);
});
test("new external receipts remove prepared cards from the review export without erasing history",()=>{
  for(const disposition of ["live","draft","scheduled","sold"]){
    const s=identified();finish(s,"listing",{prepare:true});assert.equal(localReviewListings(s,now).length,1);
    finish(s,"reconcile",{seller:"imaydit58",disposition,checkedAt:now,scopes:[disposition==="live"?"active":disposition==="draft"?"drafts":disposition],itemId:"123",evidence:"Exact physical copy"});
    assert.deepEqual(localReviewListings(s,now),[]);
    const summary=queueSummary(s,now);assert.equal(summary.counts.localListingsPrepared,0);assert.equal(summary.counts.excludedPreparedListings,1);
    assert.deepEqual(summary.cards[0].existingReceipt,{disposition,itemId:"123"});assert.equal(summary.cards[0].liveItemId,disposition==="live"?"123":null);
    assert.equal(s.cards["card-1"].jobs.listing.state,"done");assert.ok(s.cards["card-1"].jobs.listing.result?.title);
  }
  const s=identified();finish(s,"listing",{prepare:true});upsertCard(s,{...input(),knownDraft:"456"},now);
  assert.equal(localReviewListings(s,now).length,0);assert.equal(queueSummary(s,now).cards[0].existingReceipt?.itemId,"456");
  const d=identified();finish(d,"listing",{prepare:true});upsertCard(d,{...input("card-2","26/99"),photos:input().photos},now);
  assert.equal(localReviewListings(d,now).length,0);
});
test("long player titles retain identifying details and only shorten redundant brand words",()=>{
  const long={...identity,player:"Nickeil Alexander-Walker",cardNumber:"193",parallel:"Purple Ice Prizm",serial:"051/149",printRun:149};
  const title=listingTitle(long);assert.ok(title.length<=80);assert.match(title,/Nickeil Alexander-Walker/);assert.match(title,/#193/);assert.match(title,/Purple Ice/);assert.match(title,/051\/149/);assert.match(title,/Prizm Black/);
  assert.equal(listingTitle(identity),"2024-25 Panini Prizm Black Payton Pritchard #212 Purple Prizm 25/99");
  assert.throws(()=>listingTitle({...long,parallel:"Unique Unabridgeable Parallel ".repeat(4)}),/needs review/);
});
test("a reused draft ID is surfaced as conflicting evidence while both physical cards remain excluded",()=>{
  const s=seeded();upsertCard(s,{...input(),knownDraft:"123"},now);
  upsertCard(s,{...input("card-2","26/99"),knownDraft:"456",savedReceipts:[{disposition:"draft",itemId:"123",source:"saved manifest"}]},now);
  const summary=queueSummary(s,now);assert.equal(summary.counts.receiptConflicts,1);assert.equal(summary.counts.alreadyListed,2);
  assert.deepEqual(summary.receiptConflicts,[{itemId:"123",cardIds:["card-1","card-2"]}]);assert.equal(summary.counts.actionableJobs,0);
});
test("expired comps and reconciliation clearance cannot remain ready indefinitely",()=>{
  const s=identified();finish(s,"pricing",{comps:[comp()],tracked:false,envelopeEligible:true,evidence:"eligible"});finish(s,"listing",{prepare:true});
  finish(s,"reconcile",{seller:"imaydit58",disposition:"clear",checkedAt:now,scopes:["active","drafts","scheduled","sold"],evidence:"four scopes checked"});
  queueSummary(s,"2026-11-01T08:00:00.000Z");
  assert.equal(s.cards["card-1"].jobs.pricing.state,"held");assert.equal(s.cards["card-1"].jobs.reconcile.state,"held");assert.equal(s.cards["card-1"].jobs.listing.state,"todo");
});
test("file store persists results, rejects overlapping writers and fails closed on corrupt state",async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"card-orchestrator-test-"));
  try{
    await withQueue(dir,s=>upsertCard(s,input(),now));assert.equal((await readQueue(dir)).revision,1);
    await withQueue(dir,async()=>{await assert.rejects(()=>withQueue(dir,()=>undefined),/locked/);});
    assert.equal((await readQueue(dir)).revision,1);
    await assert.rejects(()=>withQueue(dir,s=>{delete s.cards["card-1"];throw new Error("simulated failure");}),/simulated/);
    assert.ok((await readQueue(dir)).cards["card-1"]);
    await fs.writeFile(path.join(dir,"state.json"),"broken");await assert.rejects(()=>withQueue(dir,()=>undefined));
    await assert.rejects(()=>fs.stat(path.join(dir,"queue.lock")),{code:"ENOENT"});
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test("importer refuses missing required fields and ambiguous saved overrides",()=>{
  assert.throws(()=>importLegacyCard({}, {}, []));
  const row={card_id:"card-1",source_key:"sku1",quantity:1,player:identity.player,season:identity.season,set:identity.set,manufacturer:identity.manufacturer,card_number:identity.cardNumber,sport_game:identity.sport,parallel:identity.parallel,condition_plan:identity.condition,print_run:99,serial_text:"25/99",front_original_path:"front.jpg",back_original_path:"back.jpg",front_sha256:"a".repeat(64),back_sha256:"b".repeat(64)};
  assert.equal(importLegacyCard(row,{user_price_override:4.99,buyer_shipping:0},[]).override!.item,4.99);
  assert.throws(()=>importLegacyCard(row,{user_price_override:"confirmed"},[]),/override/);
});
test("pricing-agent estimates survive import as review information, never approved prices",()=>{
  const row={card_id:"card-1",source_key:"sku1",quantity:1,player:identity.player,season:identity.season,set:identity.set,manufacturer:identity.manufacturer,card_number:identity.cardNumber,sport_game:identity.sport,parallel:identity.parallel,condition_plan:identity.condition,print_run:99,serial_text:"25/99",front_original_path:"front.jpg",back_original_path:"back.jpg",front_sha256:"a".repeat(64),back_sha256:"b".repeat(64)};
  const pricing={...row,serial_text:"",serial_number:"025",status:"review-estimate",proposed_item_price:6.49,buyer_shipping:1.49,pricing_policy_version:"item-only",updated_at:now,review_reason:"Source serial unresolved"};
  const imported=importLegacyCard(row,pricing,[]);assert.equal(imported.pricingHandoff?.item,6.49);assert.equal(imported.pricingHandoff?.shipping,1.49);
  assert.equal(imported.pricingHandoff?.matchesOriginals,true);assert.equal(imported.pricingHandoff?.needsReview,true);
  const s=newQueue();upsertCard(s,imported,now);assert.equal(s.cards["card-1"].jobs.pricing.state,"todo");
  assert.equal(queueSummary(s,now).cards[0].pricingHandoff?.status,"review-estimate");
  for(const changed of [{back_sha256:"f".repeat(64)},{card_id:"other"},{serial_number:"26"},{parallel:"Different parallel"}]) {
    const mismatch=importLegacyCard(row,{...pricing,...changed},[]).pricingHandoff!;
    assert.equal(mismatch.item,null);assert.equal(mismatch.matchesOriginals,false);
  }
  assert.equal(importLegacyCard(row,{...pricing,proposed_item_price:""},[]).pricingHandoff?.item,null);
});
test("saved batch receipts exclude exact original pairs and fail closed on conflicting identifiers",()=>{
  const source="artifacts/batch-11/manifest.json",files=input().photos.map(p=>({sha256:p.sha256.toUpperCase()}));
  const draft=applySavedReceipts(input(),[{source,data:{key:"card-1",draftId:"123",files}}]);
  assert.equal(draft.knownDraft,"123");assert.equal(draft.savedReceipts?.[0].source,source);
  const s=newQueue();upsertCard(s,draft,now);assert.equal(claimJob(s,"worker","listing",undefined,now),null);
  assert.throws(()=>applySavedReceipts(input(),[{source,data:{key:"card-1",draftId:"123",files:[{sha256:"e".repeat(64)}]}}]),/reconcile/);
  assert.equal(applySavedReceipts(input(),[{source,data:{key:"unrelated",draftId:"123",files:[]}}]).knownDraft,undefined);
  const grouped=applySavedReceipts(input(),[{source:"artifacts/one-piece-processing.json",data:{liveItemId:"789",photoArchive:{files}}}]);assert.equal(grouped.knownLive?.itemId,"789");assert.equal(grouped.knownLive?.observedAt,"");
  const pilot=applySavedReceipts(input(),[{source,data:{cardId:"card-1",draftId:"456",frontHash:files[0].sha256,backHash:files[1].sha256}}]);assert.equal(pilot.knownDraft,"456");
  upsertCard(s,applySavedReceipts(input(),[]),now);assert.equal(s.cards["card-1"].input.knownDraft,"123");
});
test("receipt dependency keys ignore unrelated changes but detect new receipts and conflicting hashes",()=>{
  const i={card_id:"card-1",source_key:"card-1",front_sha256:"a".repeat(64),back_sha256:"b".repeat(64)},source="manifest";
  const unrelated={source,data:{key:"other",draftId:"789",frontHash:"c".repeat(64),backHash:"d".repeat(64)}};
  assert.deepEqual(savedReceiptDependencies(i,[unrelated]),[]);
  assert.deepEqual(savedReceiptDependencies({},[unrelated]),[]);
  const matching={source,data:{key:"card-1",draftId:"123",frontHash:i.front_sha256,backHash:i.back_sha256}};
  const key=(entries:Parameters<typeof savedReceiptDependencies>[1])=>fingerprint(savedReceiptDependencies(i,entries));
  assert.equal(key([matching]),key([unrelated,{...matching,data:{...matching.data,audit:"Changed description",price:99}}]));
  assert.notEqual(key([matching]),key([{...matching,data:{...matching.data,draftId:"456"}}]));
  assert.notEqual(key([matching]),key([{...matching,data:{...matching.data,backHash:"e".repeat(64)}}]));
  assert.notEqual(key([]),key([{source,data:{key:"renamed",draftId:"123",frontHash:i.front_sha256,backHash:i.back_sha256}}]));
});
test("CLI resumes across processes and skips unchanged bad imports without blocking new cards",async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"card-orchestrator-cli-"));
  try {
    await fs.mkdir(path.join(dir,"artifacts/identity-queue"),{recursive:true});await fs.mkdir(path.join(dir,"artifacts/pricing-queue"),{recursive:true});
    const front=path.join(dir,"front.jpg"),back=path.join(dir,"back.jpg");await fs.writeFile(front,"fixture front bytes");await fs.writeFile(back,"fixture back bytes");
    const good={card_id:"good",source_key:"sku-good",quantity:1,player:identity.player,season:identity.season,set:identity.set,manufacturer:identity.manufacturer,card_number:identity.cardNumber,sport_game:identity.sport,parallel:identity.parallel,condition_plan:identity.condition,print_run:99,serial_text:"25/99",front_original_path:front,back_original_path:back,front_sha256:createHash("sha256").update("fixture front bytes").digest("hex"),back_sha256:createHash("sha256").update("fixture back bytes").digest("hex")};
    await fs.writeFile(path.join(dir,"artifacts/identity-queue/cards.json"),JSON.stringify({generation:"test",cards:[{...good,card_id:"bad",player:""},good]}));
    await fs.writeFile(path.join(dir,"artifacts/pricing-queue/queue-state.json"),JSON.stringify({cards:[],comps:[]}));
    const script=fileURLToPath(new URL("../scripts/card-orchestrator.ts",import.meta.url));
    const run=()=>JSON.parse(execFileSync(process.execPath,["--experimental-strip-types",script,"run","--new","--limit","1"],{cwd:dir,encoding:"utf8",stdio:["ignore","pipe","pipe"]}));
    assert.equal(run().sync.skipped.length,1);
    await withQueue(path.join(dir,"artifacts/card-orchestrator"),s=>{
      s.rejectedImports!.bad.inputKey=fingerprint([{...good,card_id:"bad",player:""},null,fingerprint([])]);
    });
    const second=run();assert.equal(second.sync.changed,1);assert.equal(second.photos.completed,1);
    const state=await readQueue(path.join(dir,"artifacts/card-orchestrator"));assert.equal(state.cards.good.jobs.photos.state,"done");
    const third=run();assert.equal(third.sync.changed,0);assert.equal(third.photos.completed,0);
    assert.equal(third.sync.skipped.length,0);assert.equal(third.status.counts.importExceptions,1);
    const heldStatus=JSON.parse(await fs.readFile(path.join(dir,"artifacts/card-orchestrator/status.json"),"utf8"));
    assert.equal(heldStatus.importExceptions[0].id,"bad");assert.equal(heldStatus.importExceptions[0].sku,"sku-good");
    assert.match(await fs.readFile(path.join(dir,"artifacts/card-orchestrator/status.html"),"utf8"),/Identity source is missing required fields/);
    assert.equal((await readQueue(path.join(dir,"artifacts/card-orchestrator"))).revision,state.revision);
    const review=JSON.parse(await fs.readFile(path.join(dir,"artifacts/card-orchestrator/review-listings.json"),"utf8"));assert.equal(review.canUpload,false);
    await fs.mkdir(path.join(dir,"artifacts/batch-11"));
    await fs.writeFile(path.join(dir,"artifacts/batch-11/manifest.json"),JSON.stringify({cards:[{key:"unrelated",draftId:"789",frontHash:"e".repeat(64),backHash:"f".repeat(64)}]}));
    const unrelatedUpdate=run();assert.equal(unrelatedUpdate.sync.skipped.length,0);assert.equal(unrelatedUpdate.status.counts.importExceptions,1);
    assert.equal((await readQueue(path.join(dir,"artifacts/card-orchestrator"))).revision,state.revision);
    await fs.writeFile(path.join(dir,"artifacts/batch-11/manifest.json"),JSON.stringify({cards:[{key:"sku-good",draftId:"123",files:[{sha256:good.front_sha256},{sha256:good.back_sha256}]}]}));
    const afterReceipt=run();assert.equal(afterReceipt.status.counts.alreadyListed,1);assert.equal(afterReceipt.status.counts.actionableJobs,1);
    const status=JSON.parse(await fs.readFile(path.join(dir,"artifacts/card-orchestrator/status.json"),"utf8"));assert.equal(status.cards[0].existingReceipt.disposition,"draft");
    await fs.mkdir(path.join(dir,"artifacts/bulk-photo-pilot-20261018"));
    await fs.writeFile(path.join(dir,"artifacts/bulk-photo-pilot-20261018/manifest.json"),JSON.stringify({cards:[{cardId:"good",key:"sku-good",draftId:"123",frontHash:good.front_sha256,backHash:good.back_sha256}]}));
    const nativeReceipt=run();assert.equal(nativeReceipt.status.counts.alreadyListed,1);assert.equal(nativeReceipt.status.counts.actionableJobs,1);
    const nativeState=await readQueue(path.join(dir,"artifacts/card-orchestrator"));
    assert.ok(nativeState.cards.good.input.savedReceipts?.some(r=>r.source==="artifacts/bulk-photo-pilot-20261018/manifest.json"&&r.itemId==="123"));
    assert.equal(run().sync.changed,0);
    await fs.writeFile(path.join(dir,"artifacts/pricing-queue/queue-state.json"),JSON.stringify({cards:[{...good,status:"review-estimate",proposed_item_price:6.49,buyer_shipping:1.49,updated_at:now,review_reason:"Source serial unresolved"}],comps:[]}));
    run();
    const handoffReport=JSON.parse(await fs.readFile(path.join(dir,"artifacts/card-orchestrator/status.json"),"utf8"));
    assert.equal(handoffReport.cards[0].existingReceipt.itemId,"123");assert.equal(handoffReport.cards[0].pricingHandoff.item,6.49);
    const handoffHtml=await fs.readFile(path.join(dir,"artifacts/card-orchestrator/status.html"),"utf8");
    assert.match(handoffHtml,/proposed item \$6\.49/);assert.match(handoffHtml,/unapproved, not an eBay price/);assert.match(handoffHtml,/Source serial unresolved/);
    const preflight=JSON.parse(execFileSync(process.execPath,["--experimental-strip-types",script,"preflight","--card","good"],{cwd:dir,encoding:"utf8",stdio:["ignore","pipe","pipe"]}));
    assert.equal(preflight.cards[0].route,"resume-existing-draft");assert.equal(preflight.cards[0].pricing.agentProposal.item,6.49);assert.equal(preflight.canUpload,false);
    assert.match(await fs.readFile(path.join(dir,"artifacts/card-orchestrator/handoff.html"),"utf8"),/Unapproved/);
    assert.equal((await readQueue(path.join(dir,"artifacts/card-orchestrator"))).cards.good.jobs.pricing.state,"todo");
    await fs.writeFile(path.join(dir,"artifacts/identity-queue/cards.json"),JSON.stringify({generation:"corrected",cards:[{...good,card_id:"bad",source_key:"sku-repaired"},good]}));
    assert.equal(run().status.counts.importExceptions,0);
    assert.doesNotMatch(await fs.readFile(path.join(dir,"artifacts/card-orchestrator/status.html"),"utf8"),/Identity source is missing required fields/);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});

test("flow separates text completion, source estimates, evidence validation and publication",()=>{
  const s=identified();finish(s,"listing",{prepare:true});
  let packet=flowPacket(s,["card-1"],now);assert.equal(packet.cards[0].textPrepared,true);assert.equal(packet.cards[0].nextOwner,"pricing");
  upsertCard(s,{...input(),knownDraft:"456",pricingHandoff:{status:"review-estimate",item:6.49,shipping:1.49,updatedAt:now,policyVersion:"wrong-rule",reason:"Missing original serial",source:"test",matchesOriginals:true,needsReview:true}},now);
  packet=flowPacket(s,["card-1"],now);assert.equal(packet.cards[0].nextOwner,"pricing-review");assert.equal(packet.cards[0].route,"resume-existing-draft");
  assert.equal(packet.cards[0].pricing.approved,false);assert.equal(packet.cards[0].pricing.validatedProposal,null);assert.equal(packet.cards[0].pricing.agentProposal?.item,6.49);
  assert.ok(packet.cards[0].blockers.includes("Source proposal policy needs reconciliation"));assert.match(flowHtml(packet),/Missing original serial/);
  assert.equal(flowPacket(s,["card-1"],"2027-02-01T00:00:00Z").cards[0].pricing.sourceFresh,false);
  assert.throws(()=>flowPacket(s,["missing"],now));assert.throws(()=>flowPacket(s,["card-1","card-1"],now));
});

test("asking-price approval is exact and never grants publication or validates comp evidence",()=>{
  const s=identified();
  const handoff={status:"review-estimate",item:6.49,shipping:1.49,updatedAt:now,policyVersion:"item-only-9pct-49-95-under3-exact149-free",reason:"Evidence review remains",source:"test",matchesOriginals:true,needsReview:true as const};
  upsertCard(s,{...input(),pricingHandoff:handoff},now);
  const a={cardId:"card-1",item:6.49,shipping:1.49,sourceUpdatedAt:now,policyVersion:handoff.policyVersion,photoHashes:input().photos.map(p=>p.sha256),sourceIdentityKey:fingerprint(input().identity),approvedAt:now};
  const packet=flowPacket(s,["card-1"],now,[a]);
  assert.equal(packet.cards[0].pricing.approved,false);
  assert.equal(packet.cards[0].nextOwner,"pricing-review");
  assert.equal(packet.cards[0].pricing.validatedProposal,null);
  assert.equal(packet.cards[0].canPublish,false);
  assert.match(flowHtml(packet),/Numbered source proposal requires current scarcity validation/);
  for(const changed of [{...a,item:6.95},{...a,shipping:0},{...a,sourceUpdatedAt:"2026-10-17T00:00:00Z"},{...a,photoHashes:[]},{...a,sourceIdentityKey:"changed"}])assert.equal(flowPacket(s,["card-1"],now,[changed]).cards[0].pricing.approved,false);
  s.cards["card-1"].input.override={item:5,shipping:0,evidence:"Individual seller override"};
  assert.equal(flowPacket(s,["card-1"],now,[a]).cards[0].pricing.approved,false);
});

test("matching copies share research context but cannot research concurrently or reuse own-copy sales",()=>{
  const s=identified();upsertCard(s,input("card-2","26/99"),now);
  finish(s,"photos",{hashes:s.cards["card-2"].input.photos.map(({side,sha256})=>({side,sha256})),evidence:"Originals"},"card-2");
  finish(s,"identity",{identity:{...identity,serial:"26/99"},pairMatches:true,frontFirst:true,serialInspected:true,evidence:"Original pair"},"card-2");
  const first=claimJob(s,"pricing-A","pricing","card-1",now)!;assert.ok(first);
  assert.equal(claimJob(s,"pricing-B","pricing","card-2",now),null);
  completeJob(s,"card-1","pricing",first.job.lease!.token,{outcome:"done",data:{scarcitySearchEvidence:"No additional related sold evidence found",comps:[comp({shipping:1})],tracked:false,envelopeEligible:true,evidence:"Shared source"}},now);
  assert.equal(pricingContext(s,"card-2",now).reusableEvidence.length,1);
  const result=s.cards["card-1"].jobs.pricing.result!;
  result.comps=[comp({shipping:1,identity:{...identity,serial:"26/99"}})];
  assert.equal(pricingContext(s,"card-2",now).reusableEvidence.length,0);
  assert.ok(claimJob(s,"pricing-B","pricing","card-2",now));
});

 test("scarcity contradiction holds only this card and preserves seller override",()=>{
 const s=identified();
 const own=input();own.override={item:3,shipping:0,evidence:"Historical proposed price"};upsertCard(s,own,now);
 const related=comp({saleId:"111222333",sourceUrl:"https://www.ebay.com/itm/111222333",identity:{...identity,parallel:"Blue Prizm",printRun:199,serial:"9/199"},itemPrice:5,shipping:0});
 finish(s,"pricing",{comps:[comp({itemPrice:1,shipping:0})],scarcityComps:[related],tracked:false,envelopeEligible:true,evidence:"Exact and related sales inspected"});
 assert.equal(s.cards["card-1"].jobs.pricing.state,"held");assert.equal(s.cards["card-1"].jobs.pricing.result!.projection,null);
 assert.equal(s.cards["card-1"].input.override!.item,3);
 assert.match(s.cards["card-1"].jobs.pricing.reason!,/preserve existing/);
 upsertCard(s,input("independent","30/99"),now);assert.ok(claimJob(s,"worker","photos","independent",now));
 });
