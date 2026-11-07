import { CURRENT_CARD_PRICE_POLICY } from "../lib/card-price-policy.ts";
import { reviewBinding } from "../lib/card-workflow.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { bulkDraftExport,categoryDraftCompletionFields,type DraftPacket } from "../lib/card-bulk-draft.ts";
import { batchPacket,batchWorkPlan } from "../lib/card-batch.ts";
import { reconcileBacklog,backlogCounts,reconcileScans } from "../lib/card-backlog.ts";
import { draftFields } from "../lib/card-draft-fields.ts";
import { uploadCardImage } from "../lib/ebay-card-media.ts";
import type { WorkflowSnapshot } from "../lib/card-workflow.ts";
const now="2026-10-23T02:00:00Z";
test("category completion refuses missing location/policies and any existing draft reimport",()=>{
 const input={conditionLabel:"Near mint or better",shippingPolicyName:"Exact shipping name",paymentPolicyName:"Exact payment name",returnPolicyName:"Exact return name",location:"Seller city, state"};
 const fields=categoryDraftCompletionFields(input);
 assert.equal(fields["CD:Card Condition - (ID: 40001)"],"Near mint or better - (ID: 400010)");
 assert.equal(fields["Payment profile name"],input.paymentPolicyName);
 for(const key of ["location","shippingPolicyName","paymentPolicyName","returnPolicyName"])assert.throws(()=>categoryDraftCompletionFields({...input,[key]:""}),/Missing/);
 assert.throws(()=>categoryDraftCompletionFields({...input,existingDraftId:"5434946111410"}),/Existing draft/);
 assert.throws(()=>categoryDraftCompletionFields({...input,conditionLabel:"Unknown"}),/verification/);
});
function fixture(){
  const cards=reconcileBacklog(["a","b"].map((h,i)=>({kind:"identity" as const,source:"test",id:String(i),sku:`card-${i}`,frontHash:h.repeat(64),backHash:"c".repeat(64),identityStatus:"identified" as const,identity:{player:"Pikachu",season:"2021",set:"Test",manufacturer:"Pokemon",sport:"Pokemon",cardNumber:"1",parallel:"Regular Non-Holo",condition:"Near mint or better",conditionType:"Ungraded",language:"English",artwork:"Same"},proposal:{item:2.98,shipping:0,source:"test",policy:CURRENT_CARD_PRICE_POLICY,evidenceKey:"e".repeat(64),evidenceExpiresAt:"2099-01-01T00:00:00Z",reviewRequired:true}})),now);
  const s:WorkflowSnapshot={version:2,asOf:now,mode:"read-only-local",cards,counts:backlogCounts(cards),scan:reconcileScans(cards,[]),sources:[],warnings:[],marketplace:{complete:false,absenceMeansUnlisted:false,note:""},workflow:Object.fromEntries(cards.map(c=>[c.id,{token:"t",approvedBinding:reviewBinding(c),approvedAt:now,history:[]}]))};
  return {s,b:{id:"batch",cardIds:cards.map(c=>c.id),createdAt:now,revision:1,intervals:[]}};
}
const photos=["a","b","c"].map(h=>({originalHash:h.repeat(64),url:`https://i.ebayimg.com/images/${h}/s-l1600.jpg`,expiresAt:"2026-11-23T00:00:00Z",uprightReviewed:true}));
test("official Draft CSV groups copies, preserves evidence and cannot publish",()=>{
  const {s,b}=fixture(),result=bulkDraftExport(batchPacket(b,s),photos,Date.parse(now));
  assert.equal(result.draftCount,1);assert.equal(result.physicalCopies,2);assert.equal(result.canPublish,false);
  assert.equal(result.readinessScope,"csv-import-only");
  assert.equal(result.submissionReady,false);
  assert.equal(result.requiresPostImportVerification,true);
  assert.ok(result.postImportFields.includes("shipping policy"));
  assert.match(result.csv!,/"Draft","card-0","183454"/);assert.match(result.csv!,/"2.98","2"/);
  assert.ok(!result.csv!.includes('"Add"'));assert.equal(result.verification[0].shipping,0);assert.equal(result.verification[0].captureIds.length,2);
  delete s.workflow[s.cards[1].id].approvedAt;assert.equal(batchPacket(b,s).cards[1].priceApproved,false);
});
test("missing, stale, non-upright and foreign hosted photos block export",()=>{
  const {s,b}=fixture(),packet=batchPacket(b,s);
  for(const changed of [[],photos.map(p=>({...p,expiresAt:now})),photos.map(p=>({...p,uprightReviewed:false})),photos.map(p=>({...p,url:"https://example.com/a.jpg"}))]){
    const result=bulkDraftExport(packet,changed,Date.parse(now));assert.equal(result.csv,null);assert.ok(result.blockers.length);
  }
});
test("approved manual prices resolve pricing holds only and preserve their evidence",()=>{
  const {s,b}=fixture();
  for(const card of s.cards){
    card.holds=["pricing: no exact sold comparable"];
    s.workflow[card.id].manualPrice={item:1.49,shipping:0,source:"Seller",policy:"seller-manual-price-v1",reviewRequired:false};
  }
  const packet=batchPacket(b,s);
  assert.equal(packet.cards[0].item,1.49);
  assert.equal(packet.cards[0].offersEnabled,false);
  assert.equal(packet.cards[0].minimumOffer,undefined);
  assert.equal(packet.cards[0].autoAccept,undefined);
  const exported=bulkDraftExport(packet,photos,Date.parse(now));
  assert.equal(exported.ready,true);
  assert.equal(exported.verification[0].offersEnabled,false);
  assert.equal(exported.verification[0].minimumOffer,undefined);
  assert.equal(exported.verification[0].autoAccept,undefined);
  assert.ok(packet.cards[0].requirements.includes("pricing: no exact sold comparable"));
  s.cards[0].holds.push("photos: obscured back");
  assert.throws(()=>batchPacket(b,s),/obscured back/);
  s.cards[0].holds.pop();delete s.workflow[s.cards[0].id].manualPrice;
  assert.throws(()=>batchPacket(b,s),/no exact sold comparable/);
});
test("existing receipts never create another draft, and formula-like SKUs are rejected",()=>{
  const {s,b}=fixture(),packet=batchPacket(b,s);
  packet.listings[0].receipts=[{id:"123",disposition:"draft",source:"test"}];
  const r=bulkDraftExport(packet,photos,Date.parse(now));assert.equal(r.draftCount,0);assert.equal(r.existing.length,1);assert.equal(r.csv,null);
  packet.listings[0].receipts=[];packet.listings[0].sku="=HYPERLINK()";assert.equal(bulkDraftExport(packet,photos,Date.parse(now)).csv,null);
});
test("non-holo, reverse holo and holo stay distinct",()=>{
  for(const [parallel,finish] of [["Regular Non-Holo","Regular"],["Reverse Holo","Reverse Holo"],["Holo","Holo"],["Nonfoil","Regular"]])assert.equal(draftFields({sport:"Pokemon",parallel}).specifics.Finish,finish);
});
test("Media API uses image multipart, retains resource URI and never sends listing actions",async()=>{
  let calls=0;
  const fake:typeof fetch=async(input,init)=>{calls++;assert.equal(input,"https://apim.ebay.com/commerce/media/v1_beta/image/create_image_from_file");assert.equal(init?.method,"POST");assert.ok(init?.body instanceof FormData);assert.ok(init.body.get("image") instanceof Blob);assert.equal((init.headers as Record<string,string>)["Content-Type"],undefined);
    return new Response(JSON.stringify({imageUrl:photos[0].url,expirationDate:photos[0].expiresAt}),{status:201,headers:{Location:"https://apim.ebay.com/commerce/media/v1_beta/image/123"}});};
  const result=await uploadCardImage("test",new Uint8Array([1,2]),"image/jpeg",fake);assert.equal(calls,1);assert.equal(result.url,photos[0].url);assert.ok(result.resourceUri.endsWith("/123"));
  await assert.rejects(uploadCardImage("test",new Uint8Array([1]),"image/jpeg",async()=>new Response("",{status:403})),/403/);
});

test("ready partition never splits a quantity group when one copy lacks valid evidence",()=>{
 const {s,b}=fixture();delete s.workflow[s.cards[1].id].approvedAt;s.cards[1].proposal!.evidenceExpiresAt="2000-01-01";
 const plan=batchWorkPlan(b,s);assert.equal(plan.readyIds.length,0);assert.equal(plan.exceptions[0].cardIds.length,2);
});
test("bulk edit groups preserve only shared specifics and do not mutate packets",()=>{
 const {s,b}=fixture(),packet=batchPacket(b,s);const first=packet.listings[0];
 packet.listings.push({...first,id:"other",sku:"other",specifics:{...first.specifics,Name:"Other"}});
 const before=JSON.stringify(packet);const output=bulkDraftExport(packet,photos,Date.parse(now));
 assert.equal(output.bulkEditGroups.length,1);assert.equal(output.bulkEditGroups[0].skus.length,2);
 assert.equal(output.bulkEditGroups[0].specifics.Name,undefined);assert.equal(JSON.stringify(packet),before);
});
