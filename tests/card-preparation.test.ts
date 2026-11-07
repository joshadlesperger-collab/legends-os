import { CURRENT_CARD_PRICE_POLICY } from "../lib/card-price-policy.ts";
import { reviewBinding } from "../lib/card-workflow.ts";
import test from "node:test";
import assert from "node:assert/strict";
import {draftFields} from "../lib/card-draft-fields.ts";
import {quantityPlan} from "../lib/card-quantity-plan.ts";
import {reconcileBacklog,backlogCounts,reconcileScans} from "../lib/card-backlog.ts";
import {batchPacket} from "../lib/card-batch.ts";
import type {WorkflowSnapshot} from "../lib/card-workflow.ts";
import {newQueue,upsertCard,claimJob,completeJob,type Identity,type JobKind} from "../lib/card-orchestrator.ts";
import {reusablePricing,reusePricing} from "../lib/card-pricing-library.ts";
const now="2026-10-23T02:00:00Z";
const identity:Identity={player:"Player",season:"2026",set:"Prizm",manufacturer:"Panini",cardNumber:"1",sport:"Basketball",team:"Team",parallel:"Base",serial:"",printRun:null,condition:"Near mint or better",autograph:false,patch:false,language:"English",artwork:"Standard",conditionType:"Ungraded"};
function cards(){return reconcileBacklog(["a","b"].map((hash,i)=>({kind:"identity" as const,source:"test",id:String(i),sku:String(i),frontHash:hash.repeat(64),backHash:"c".repeat(64),identityStatus:"identified" as const,identity:Object.fromEntries(Object.entries(identity).filter(([,v])=>v!==null).map(([k,v])=>[k,String(v)])),proposal:{item:4.44,shipping:0,source:"test",policy:CURRENT_CARD_PRICE_POLICY,evidenceKey:"e".repeat(64),evidenceExpiresAt:"2099-01-01T00:00:00Z",reviewRequired:true}})),now);}
function snapshot():WorkflowSnapshot{const c=cards();return {version:2,asOf:now,mode:"read-only-local",cards:c,counts:backlogCounts(c),scan:reconcileScans(c,[]),sources:[],warnings:[],marketplace:{complete:false,absenceMeansUnlisted:false,note:""},workflow:Object.fromEntries(c.map(x=>[x.id,{token:"test",approvedBinding:reviewBinding(x),approvedAt:now,history:[]}]))};}
test("matching physical copies produce one quantity packet; reimports count once",()=>{
  const s=snapshot(),b={id:"batch",cardIds:s.cards.map(c=>c.id),createdAt:now,revision:1,intervals:[]};
  const p=batchPacket(b,s);assert.equal(p.listings.length,1);assert.equal(p.listings[0].quantity,2);assert.equal(p.cards.length,2);assert.equal(p.canPublish,false);
  assert.equal(quantityPlan(s.cards[0],[...s.cards,s.cards[0]]).proposedNewQuantity,2);
  delete s.workflow[s.cards[1].id].approvedAt;
  const unapproved=batchPacket(b,s);
  assert.equal(unapproved.listings[0].quantity,2);
  assert.equal(unapproved.canUpload,false);assert.equal(unapproved.canPublish,false);
  assert.equal(s.workflow[s.cards[1].id].approvedAt,undefined);
  s.workflow[s.cards[1].id].holdReason="Seller hold remains authoritative";
  assert.throws(()=>batchPacket(b,s),/validated or seller-set draft price/);
  delete s.workflow[s.cards[1].id].holdReason;
  s.cards[1].proposal=null;
  assert.throws(()=>batchPacket(b,s),/validated or seller-set draft price/);
});
test("existing matches route to quantity review, never infer available stock or add again",()=>{
  const c=cards();c[0].receipts=[{id:"123",disposition:"live",source:"old",quantity:20}];
  const p=quantityPlan(c[1],c);assert.equal(p.route,"review-existing-quantity");assert.equal(p.proposedNewQuantity,null);assert.equal(p.proposedAdditionalQuantity,1);
  assert.equal(quantityPlan(c[0],c).route,"resume-existing");
  const s=snapshot();s.cards[0].receipts=c[0].receipts;
  const extra={...s.cards[1],id:"third-copy",frontHash:"d".repeat(64)};s.cards.push(extra);
  assert.throws(()=>batchPacket({id:"b",cardIds:[s.cards[1].id],createdAt:now,revision:1,intervals:[]},s),/every additional copy/);
});
test("unknown copy attributes block grouping; different languages and serials stay separate",()=>{
  const c=cards();delete c[1].identity.artwork;assert.equal(quantityPlan(c[0],c).route,"review-possible-duplicates");
  c[1].identity.language="Japanese";assert.equal(quantityPlan(c[0],c).proposedNewQuantity,1);
  c[1].identity.language="English";c[0].identity.serial="1/50";c[0].identity.printRun="50";assert.equal(quantityPlan(c[0],c).proposedNewQuantity,1);
});
test("TCG packets use card/game fields; missing language, holds and unequal group prices block export",()=>{
  const f=draftFields({...identity,sport:"Magic: The Gathering",player:"Ob Nixilis, the Ascended",set:"Reality Fracture Commander",parallel:"Extended Art Nonfoil",cardNumber:"0090"});
  assert.equal(f.category,"CCG Individual Cards");assert.equal(f.specifics["Player/Athlete"],undefined);assert.ok(f.title.length<=80);
  assert.ok(draftFields({...identity,sport:"Pokemon",language:""}).missing.length);
  const s=snapshot(),b={id:"b",cardIds:s.cards.map(c=>c.id),createdAt:now,revision:1,intervals:[]};
  s.cards[0].holds=["listing: obscured back"];s.workflow[s.cards[0].id].approvedBinding=reviewBinding(s.cards[0]);assert.throws(()=>batchPacket(b,s),/obscured/);
  s.cards[0].holds=[];s.cards[1].proposal!.item=5;for(const c of s.cards)s.workflow[c.id].approvedBinding=reviewBinding(c);assert.throws(()=>batchPacket(b,s),/different approved prices/);
});
function queue(){const s=newQueue();for(const [id,hash] of [["source","a"],["target","b"]]){
  upsertCard(s,{id,sku:id,identity,photos:[{side:"front",path:`${id}-front`,sha256:hash.repeat(64)},{side:"back",path:`${id}-back`,sha256:"c".repeat(64)}],candidates:[],source:"test"},now);
  for(const [kind,data] of [["photos",{hashes:s.cards[id].input.photos,evidence:"Read originals"}],["identity",{identity,pairMatches:true,frontFirst:true,serialInspected:false,evidence:"Both originals reviewed"}]] as [JobKind,unknown][]){
    const j=claimJob(s,"test",kind,id,now)!;completeJob(s,id,kind,j.job.lease!.token,{outcome:"done",data},now);
  }
}
const comp={saleId:"1234",sourceUrl:"https://www.ebay.com/itm/1234",soldDate:"2026-10-20",itemPrice:2,shipping:1,currency:"USD",identity,serialObserved:false,priceDisclosed:true,ownAcquisition:false,graded:false,lot:false,condition:"Near mint or better",evidenceMode:"sold-result",evidence:"Sold title reviewed"};
const claim=claimJob(s,"test","pricing","source",now)!;completeJob(s,"source","pricing",claim.job.lease!.token,{outcome:"done",data:{comps:[comp],tracked:false,envelopeEligible:true,evidence:"Reviewed sale"}},now);return s;}
test("reuse validates per copy, computes proposal and does not copy approval; replay cannot increment work",()=>{
  const s=queue(),o=reusablePricing(s,"target",now).options[0];assert.ok(o);
  assert.throws(()=>reusePricing(s,"target",o.sourceId,o.token,false,now),/Confirm/);
  reusePricing(s,"target",o.sourceId,o.token,true,now);
  assert.equal(s.cards.target.jobs.pricing.state,"done");assert.equal(s.cards.target.jobs.pricing.result?.ruleCorrectionApproval,undefined);assert.equal(s.cards.target.jobs.pricing.result?.envelopeEligible,false);
  assert.throws(()=>reusePricing(s,"target",o.sourceId,o.token,true,now));assert.equal(s.cards.target.jobs.pricing.attempts,1);
});
test("reuse rejects stale tokens, stale sales, holds, overrides and language mismatches",()=>{
  for(const mode of ["token","hold","override","language","expired"]){const s=queue(),o=reusablePricing(s,"target",now).options[0];
    if(mode==="token")s.cards.source.jobs.pricing.result!.evidence="Changed evidence";
    if(mode==="override")s.cards.target.input.override={item:50,shipping:0,evidence:"Seller price"};
    if(mode==="language")(s.cards.target.jobs.identity.result!.identity as Identity).language="Japanese";
    assert.throws(()=>reusePricing(s,"target",o.sourceId,o.token,true,mode==="expired"?"2027-02-01T00:00:00Z":now,mode==="hold"?{target:"Pause"}:{}));
  }
});
