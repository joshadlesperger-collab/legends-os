import {nextV2BrowserAction} from '../lib/card-processing-v2-browser-dispatch.ts';
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { digest, type V2Card, type V2Payload } from "../lib/card-processing-v2.ts";
import { reviewV2Nonprice } from "../lib/card-processing-v2-nonprice-review.ts";
import { readV2State, withV2State } from "../lib/card-processing-v2-store.ts";

async function fixture(run: (root: string, body: any, observation: any, retain: () => Promise<any>) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "v2-nonprice-")), at = new Date().toISOString(), hash = digest("capture"), draftId = "12345";
  const card: V2Card = { id: "V2-test", sku: "V2-test", captureId: hash, photos: ["front","back"].map(side => ({path: side, hash: digest(side), side: side as "front"|"back"})), stage: "prepared", condition: "Near mint or better", groupId: "group", draftId, title: "Test title", description: "Original frozen description", descriptionSource: "factual", issues: [], nextAction: "Verify", createdAt: at, updatedAt: at, identity: { name: "Player", year: "2025", manufacturer: "Panini", product: "Optic", number: "1", categoryId: "261328", language: "English", variant: "Blue", artwork: "Player", sportOrGame: "Basketball", team: "Team", serial: "", graded: false, damage: false, specifics: {} } };
  const payload: V2Payload = { sku: card.sku, captureIds: [hash], title: card.title, categoryId: "261328", specifics: { Sport: ["Basketball"] }, quantity: 1, photos: card.photos.map((p,n) => ({hash: p.hash, url: `https://i.ebayimg.com/images/g/resource${n}/s-l1600.jpg`, expiresAt: at, upright: true})), conditionId: "4000", conditionDescriptorName: "Card Condition", conditionDescriptorValue: "400010", condition: card.condition, description: card.description, descriptionSource: "factual", pricing: "unpriced-grok-pending" };
  const description = "2025 Optic Player #1 Blue Team";
  const observation: any = { kind: "saved-reopened-draft-nonprice-observation", draftId, url: `https://www.ebay.com/lstng?draftId=${draftId}`, observedAt: at, scope: "non-price-fields; pricing left untouched per seller", priceWritePerformed: false, ax: "Sports Mem, Cards & Fan Shop > Sports Trading Cards\nCard Condition Near mint or better:\nReturn policy : No Return Accepted (248164940010)\n(Waxahachie, Texas, United States)", dom: { category: [{text: "Trading Card Singles"}], photos: [0,1].map(n=>({background:`url(https://i.ebayimg.com/z/resource${n}/photo.jpg)`})), fields: Object.entries({title:card.title,customLabel:card.sku,quantity:"1",condition:"4000","40001":"400010","attributes.Sport":"Basketball",description,paymentPolicyId:"eBay Managed Payments (248164941010)",shippingPolicyId:"Deferred policy"}).map(([name,value])=>({name,value})).concat([{name:"scheduleListingSelection",checked:false}] as any) }, features:{ax:""} };
  const checks = Object.fromEntries(["sameId","title","sku","quantity","sportsSinglesCategory","specifics","rawCondition","nearMint","exactPhotosInOrder","descriptionReviewed","paymentPresent","returnsPresent","locationPresent","notScheduled"].map(k=>[k,true]));
  const body: any = {kind:"five-saved-draft-nonprice-review",seller:"imaydit58",reviewer:"Independent fixture reviewer",reviewedAt:at,authority:"v2-leave-pricing-alone-20261103",reviews:[{cardId:card.id,captureId:hash,sku:card.sku,draftId,observedAt:at,evidence:{path:"",sha256:""},scope:"non-price-fields",checks,aspectChecks:{Sport:true},specifics:payload.specifics,description,pricing:{status:"deferred-preserved",owner:"Grok",writesPerformed:false,sourceNotInferred:true},shipping:{status:"deferred-preserved",observedPolicy:"Deferred policy",writesPerformed:false},fullUnpricedVerification:false,passed:true}],allPassed:true,published:false,priceWritesSinceDeferral:false};
  async function write(name: string, value: unknown) { const bytes=JSON.stringify(value), relative=`artifacts/${name}.json`; await fs.writeFile(path.join(root,relative),bytes);return {path:relative,sha256:createHash("sha256").update(bytes).digest("hex")}; }
  try { await withV2State(s=>{s.cards[card.id]=card;s.cards.other={...structuredClone(card),id:"other",sku:"other",captureId:digest("other"),draftId:undefined,groupId:undefined};s.submissions[digest("intent")]={key:digest("intent"),groupId:"group",payload,status:"submitted",draftId,at};},root);
    await run(root,body,observation,async()=>{body.reviews[0].evidence=await write("raw",observation);return {evidence:await write("report",body)};});
  } finally {await fs.rm(root,{recursive:true,force:true});}
}
test("partial review retains actual nonprice proof without full verification, payload or unrelated changes",()=>fixture(async(root,body,raw,retain)=>{
  const before=await readV2State(root);await reviewV2Nonprice(root,await retain());const after=await readV2State(root);
  assert.deepEqual(after.submissions,before.submissions);assert.deepEqual(after.cards.other,before.cards.other);const card=after.cards[body.reviews[0].cardId];assert.equal(card.stage,"prepared");assert.equal(card.verification,undefined);assert.equal(card.nonpriceVerification?.pricing,"deferred-preserved");assert.equal(card.description,before.cards[card.id].description);assert.equal(after.calls.length,0);
}));
test("true reviewer flags cannot conceal changed actual fields and transaction rolls back",()=>fixture(async(root,body,raw,retain)=>{
  raw.dom.fields.find((v:any)=>v.name==="title").value="Different card";const before=await readV2State(root);await assert.rejects(reviewV2Nonprice(root,await retain()),/mismatch/);
  const after=await readV2State(root),{timings:_beforeTimings,revision:_beforeRevision,...beforeDomain}=before,{timings:_afterTimings,revision:_afterRevision,...afterDomain}=after;
  assert.deepEqual(afterDomain,beforeDomain,"failed review preserves every domain record, payload and receipt");assert.equal(after.revision,before.revision,"timing failure must not rewrite inventory or advance its revision");assert.equal(after.timings.length,before.timings.length+1);assert.equal(after.timings.at(-1)?.status,"failed");assert.ok(after.timings.at(-1)?.durationMs!==undefined);
}));
test("hash replacement, foreign seller, wrong capture and source holds are rejected",()=>fixture(async(root,body,raw,retain)=>{
  const packet=await retain();await fs.appendFile(path.join(root,body.reviews[0].evidence.path)," ");await assert.rejects(reviewV2Nonprice(root,packet),/hash/);
  body.seller="other";await assert.rejects(reviewV2Nonprice(root,await retain()));body.seller="imaydit58";
  body.reviews[0].captureId=digest("foreign");await assert.rejects(reviewV2Nonprice(root,await retain()),/submission/);body.reviews[0].captureId=digest("capture");
  await withV2State(s=>{s.cards["V2-test"].issues.push({code:"SOURCE",owner:"seller",detail:"hold"});},root);await assert.rejects(reviewV2Nonprice(root,await retain()),/unheld/);
}));
test("outside artifacts and stale captures cannot establish partial proof",()=>fixture(async(root,body,raw,retain)=>{
  await assert.rejects(reviewV2Nonprice(root,{evidence:{path:"../outside",sha256:digest("x")}}),/artifacts/);
  raw.observedAt=new Date(Date.now()-7200000).toISOString();body.reviews[0].observedAt=raw.observedAt;await assert.rejects(reviewV2Nonprice(root,await retain()),/Fresh/);
}));
test("retained Ewing Event/Tournament display label binds Event without changing the frozen payload",()=>fixture(async(root,body,raw,retain)=>{
  // Sanitized actual Ewing saved observation: AX154 Event/Tournament followed by AX155 1992 Summer Olympics.
  raw.ax+='\n154 button (collapsed) Event/Tournament, ID: s0-1-0-25-15-@ATTRIBUTES-1-34-4-item-specific-dropdown-label-28, Secondary Actions: Expand\n155 button (collapsed) 1992 Summer Olympics, Secondary Actions: Expand';
  await withV2State(s=>{Object.values(s.submissions)[0].payload.specifics.Event=["1992 Summer Olympics"];},root);body.reviews[0].specifics.Event=["1992 Summer Olympics"];body.reviews[0].aspectChecks.Event=true;
  const before=(await readV2State(root)).submissions;await reviewV2Nonprice(root,await retain());assert.deepEqual((await readV2State(root)).submissions,before);
}));
test("conflicting Event and Event/Tournament controls cannot be approved by reviewer flags",()=>fixture(async(root,body,raw,retain)=>{
  raw.ax+='\n154 button (collapsed) Event/Tournament, ID: item-specific-dropdown-label-28, Secondary Actions: Expand\n155 button (collapsed) 1992 Summer Olympics, Secondary Actions: Expand';raw.dom.fields.push({name:"attributes.Event",value:"1996 Summer Olympics"});
  await withV2State(s=>{Object.values(s.submissions)[0].payload.specifics.Event=["1992 Summer Olympics"];},root);body.reviews[0].specifics.Event=["1992 Summer Olympics"];body.reviews[0].aspectChecks.Event=true;
  await assert.rejects(reviewV2Nonprice(root,await retain()),/Conflicting Event/);assert.equal((await readV2State(root)).cards["V2-test"].nonpriceVerification,undefined);
}));

test('bounded future report requires current captured internal-browser no-price authority with actual field checks',()=>fixture(async(root,body,raw,retain)=>{
 body.kind='saved-draft-nonprice-review';body.authority='v2-finish-twelve-workflow-connection-20261103';
 const dir=path.join(root,'artifacts/engineering-mission');await fs.mkdir(dir,{recursive:true});const instruction={id:body.authority,taskIds:['v2-draft-upload-workflow-connection-20261103'],policyRefs:['leave-pricing-alone','internal-browser-only','draft-only-no-publication']};
 await fs.writeFile(path.join(dir,'work-queue.json'),JSON.stringify({instructions:[instruction]}));
 await reviewV2Nonprice(root,await retain());assert.ok((await readV2State(root)).cards[body.reviews[0].cardId].nonpriceVerification);
 await fs.writeFile(path.join(dir,'work-queue.json'),JSON.stringify({instructions:[{...instruction,policyRefs:['leave-pricing-alone']}]}));await assert.rejects(reviewV2Nonprice(root,await retain()),/authority/);
}));


test('old five-card authority cannot authorize expanded generic reports',()=>fixture(async(root,body,raw,retain)=>{
 body.kind='saved-draft-nonprice-review';await assert.rejects(reviewV2Nonprice(root,await retain()),/authority/);
}));
test('actual inline Autographed checkboxes bind No and never consume the next aspect label',()=>fixture(async(root,body,raw,retain)=>{
 const actual='\n118 button (collapsed) Autographed, ID: s0-1-0-25-15-@ATTRIBUTES-1-34-4-item-specific-dropdown-label-17, Secondary Actions: Expand\n119 content list Autographed\n120 checkbox Yes, Value: 0\n121 text Yes\n122 checkbox No, Value: 1\n123 text No\n124 button (collapsed) Autograph Authentication, ID: s0-1-0-25-15-@ATTRIBUTES-1-34-4-item-specific-dropdown-label-18, Secondary Actions: Expand\n125 button (collapsed) Description: Autograph Authentication, Secondary Actions: Expand';
 await withV2State(s=>{Object.values(s.submissions)[0].payload.specifics.Autographed=['No'];},root);body.reviews[0].specifics.Autographed=['No'];body.reviews[0].aspectChecks.Autographed=true;const base=raw.ax;
 for(const malformed of [actual.replace('checkbox No, Value: 1','checkbox No, Value: 0'),actual.replace('checkbox Yes, Value: 0','checkbox Yes, Value: 1'),actual.replace('checkbox Yes, Value: 0','checkbox Yes, Value: 1').replace('checkbox No, Value: 1','checkbox No, Value: 0'),actual.replace('122 checkbox No, Value: 1','122 text No')]){raw.ax=base+malformed;await assert.rejects(reviewV2Nonprice(root,await retain()),/specifics mismatch/);}
 raw.ax=base+actual;await reviewV2Nonprice(root,await retain());assert.ok((await readV2State(root)).cards['V2-test'].nonpriceVerification);
}));
test('duplicate actual title, quantity and schedule controls cannot be resolved by expected-value choice in strict or audit paths',()=>fixture(async(root,body,raw,retain)=>{
 const {auditV2BulkCompletion}=await import('../lib/card-processing-v2-bulk-completion.ts');const base=structuredClone(raw.dom.fields);
 for(const [name,change] of [['title',{value:'Conflicting actual title'}],['quantity',{value:'2'}],['scheduleListingSelection',{checked:true}],['title',{}]] as const){raw.dom.fields=structuredClone(base);const original=raw.dom.fields.find((v:any)=>v.name===name);raw.dom.fields.push({...original,...change});await retain();const s=await readV2State(root),sub=Object.values(s.submissions)[0],job={id:digest('duplicate-controls-audit'),groups:[{groupId:sub.groupId,cardIds:[body.reviews[0].cardId],payload:sub.payload,key:sub.key}]};const audit=auditV2BulkCompletion(job,s,[{cardId:body.reviews[0].cardId,evidence:body.reviews[0].evidence,observation:raw}]);assert.equal(audit.readyForStrictFinish,false,name);assert.equal(audit.rows[0].route,'hold',name);assert.equal(audit.correctionBatches.length,0,'ambiguity never authorizes a guessed correction');await assert.rejects(reviewV2Nonprice(root,await retain()),/duplicate actual control/,name);assert.equal((await readV2State(root)).cards[body.reviews[0].cardId].nonpriceVerification,undefined);}
}));

test('non-sport saved review requires actual numeric named category and every frozen aspect',()=>fixture(async(root,body,raw,retain)=>{
 await withV2State(s=>{s.cards['V2-test'].identity!.categoryId='183050';Object.values(s.submissions)[0].payload.categoryId='183050';},root);
 delete body.reviews[0].checks.sportsSinglesCategory;body.reviews[0].checks.categoryMatched=true;
 raw.ax=raw.ax.replace('Sports Mem, Cards & Fan Shop > Sports Trading Cards','Collectibles > Non-Sport Trading Cards > Trading Card Singles');
 raw.dom.category=[{text:'Trading Card Singles',href:'https://www.ebay.com/b/Non-Sport-Trading-Card-Singles/183050/bn_123'}];
 await reviewV2Nonprice(root,await retain());assert.ok((await readV2State(root)).cards['V2-test'].nonpriceVerification);
 raw.dom.category=[{text:'Trading Card Singles'}];await assert.rejects(reviewV2Nonprice(root,await retain()),/numeric category/);
 raw.dom.category=[{text:'Trading Card Singles',href:'https://www.ebay.com/b/Sports-Trading-Card-Singles/261328/bn_123'}];await assert.rejects(reviewV2Nonprice(root,await retain()),/category ID/);
 raw.dom.category.push({text:'Trading Card Singles',href:'https://www.ebay.com/b/Non-Sport-Trading-Card-Singles/183050/bn_123'});await assert.rejects(reviewV2Nonprice(root,await retain()),/category ID/);
}));

test('sports legacy breadcrumb cannot hide a conflicting numeric actual category',()=>fixture(async(root,body,raw,retain)=>{
 raw.dom.category.push({text:'Trading Card Singles',href:'https://www.ebay.com/b/Non-Sport-Trading-Card-Singles/183050/bn_123'});
 await assert.rejects(reviewV2Nonprice(root,await retain()),/category ID/);
}));

import {consolidationKey} from '../lib/card-processing-v2.ts';
import {v2Dir} from '../lib/card-processing-v2-store.ts';
async function quantityFixture(root:string,body:any,raw:any){
 const state=await readV2State(root),first=structuredClone(state.cards['V2-test']),second={...structuredClone(first),id:'second-copy',sku:'second-copy',captureId:digest('second-copy')};first.groupId=consolidationKey(first);second.groupId=first.groupId;
 const folder=path.join(root,'scans');await fs.mkdir(folder);for(const c of [first,second]){c.photos=[];for(const side of ['front','back'] as const){const bytes=Buffer.from(c.id+side),filename=path.join(folder,c.id+'-'+side+'.jpg');await fs.writeFile(filename,bytes);c.photos.push({path:filename,hash:createHash('sha256').update(bytes).digest('hex'),side});}}
 await fs.writeFile(path.join(v2Dir(root),'config.json'),JSON.stringify({folder}));
 const sub=structuredClone(Object.values(state.submissions)[0]);sub.groupId=first.groupId!;sub.payload.captureIds=[first.captureId,second.captureId].sort();sub.payload.quantity=2;sub.payload.photos=sub.payload.photos.map((p,n)=>({...p,hash:first.photos[n].hash}));raw.dom.fields.find((v:any)=>v.name==='quantity').value='2';
 const cards=[first,second],capturesHash=digest(cards.map(c=>({id:c.id,sku:c.sku,captureId:c.captureId,photos:c.photos,identity:c.identity,groupId:c.groupId,title:c.title,description:c.description,descriptionSource:c.descriptionSource,condition:c.condition,resetTransfer:c.resetTransfer})).sort((a,b)=>a.id.localeCompare(b.id)));
 const begin={kind:'v2-draft-begin',key:sub.key,groupId:sub.groupId,payload:sub.payload,capturesHash,reconciliation:{seller:'imaydit58',observedAt:first.createdAt,source:'live-seller-read',scopes:{drafts:true,active:true,sold:true,scheduled:true},captures:cards.map(c=>({captureId:c.captureId,sku:c.sku,disposition:'absent'})),expectedPolicies:{payment:'Fixture',returns:'No Return Accepted',shipping:null,location:'Fixture',pricingShippingUnresolved:true},evidence:{path:'artifacts/source.json',sha256:digest('source')}},at:first.createdAt,canPublish:false};
 const bytes=JSON.stringify(begin),reference='artifacts/quantity-begin.json';await fs.writeFile(path.join(root,reference),bytes);await withV2State(s=>{s.cards[first.id]=first;s.cards[second.id]=second;s.submissions[sub.key]=sub;s.events.push({at:first.createdAt,stage:'draft-intent',cardId:first.id,detail:reference+'#sha256='+createHash('sha256').update(bytes).digest('hex')});},root);return{first,second,sub};
}
test('one strict saved quantity observation receipts every frozen distinct physical copy without extra reads',()=>fixture(async(root,body,raw,retain)=>{
 const q=await quantityFixture(root,body,raw);await assert.rejects(reviewV2Nonprice(root,await retain(),['V2-test']),/caller-owned job scope/);assert.equal((await readV2State(root)).cards['V2-test'].nonpriceVerification,undefined);const result=await reviewV2Nonprice(root,await retain());assert.equal(result.reviewed,2);assert.deepEqual(result.reviewedCardIds.sort(),['V2-test','second-copy']);const after=await readV2State(root);for(const id of result.reviewedCardIds)assert.equal(after.cards[id].nonpriceVerification?.draftId,q.first.draftId);assert.equal(after.calls.length,0);assert.equal(after.submissions[q.sub.key].payload.quantity,2);
}));
test('quantity review rejects held or changed member, wrong saved quantity/photo and foreign original path',()=>fixture(async(root,body,raw,retain)=>{
 const q=await quantityFixture(root,body,raw),before=await readV2State(root);
 for(const mutate of [(s:any)=>s.cards['second-copy'].issues.push({code:'HOLD',owner:'seller',detail:'held'}),(s:any)=>s.cards['second-copy'].identity.number='99',(s:any)=>s.cards['second-copy'].photos[0].path=path.join(root,'foreign.jpg'),(s:any)=>s.cards['second-copy'].groupId='foreign']){
  await withV2State(s=>{s.cards=structuredClone(before.cards);mutate(s);},root);await assert.rejects(reviewV2Nonprice(root,await retain()));assert.equal((await readV2State(root)).cards['V2-test'].nonpriceVerification,undefined);
 }
 await withV2State(s=>{s.cards=structuredClone(before.cards);},root);raw.dom.fields.find((v:any)=>v.name==='quantity').value='1';await assert.rejects(reviewV2Nonprice(root,await retain()),/mismatch/);raw.dom.fields.find((v:any)=>v.name==='quantity').value='2';raw.dom.photos.reverse();await assert.rejects(reviewV2Nonprice(root,await retain()),/photo/);
}));

import {auditV2BrowserJob,verifyReadyV2BrowserJob} from '../lib/card-processing-v2-browser-upload-workflow.ts';
test('one quantity draft readback audits once and verify-ready immediately archives every exact owned copy',()=>fixture(async(root,body,raw,retain)=>{
 const q=await quantityFixture(root,body,raw),groups=[{groupId:q.sub.groupId,cardIds:['V2-test','second-copy'],payload:q.sub.payload,key:q.sub.key}],id=digest(groups.map(({key,...g})=>g)),lease={owner:'synthetic-quantity-writer',token:digest('lease')},directory=path.join(v2Dir(root),'browser-jobs');await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,id+'.json'),JSON.stringify({version:1,id,stage:'imported',groups,at:q.first.createdAt,updatedAt:q.first.createdAt,lease,canPublish:false,pricing:'deferred-preserved'}));
 const dispatch=await nextV2BrowserAction(root,{id,owner:lease.owner});assert.equal(dispatch.readback.requests.length,1);assert.equal(dispatch.readback.requests[0].cardId,'V2-test');assert.equal(dispatch.readback.requests[0].sku,q.first.sku);assert.deepEqual(dispatch.readback.requests[0].physicalCardIds,['V2-test','second-copy']);assert.equal(dispatch.mapping.length,2);
 raw.dom.fields.find((v:any)=>v.name==='40001').value='';await retain();const correction=await nextV2BrowserAction(root,{id,owner:lease.owner,observations:[{cardId:'V2-test',evidence:body.reviews[0].evidence}]});assert.equal(correction.correction.requests.length,1);assert.equal(correction.correction.requests[0].observedAt,raw.observedAt);assert.equal(correction.correction.requests[0].draftId,q.first.draftId);assert.equal(correction.correction.requests[0].defects[0].field,'condition-descriptor');raw.dom.fields.find((v:any)=>v.name==='40001').value='400010';
 const packet=await retain(),audit=await auditV2BrowserJob(root,id,{observations:[{cardId:'V2-test',evidence:body.reviews[0].evidence}]});assert.equal(audit.rows.length,1);assert.equal(audit.rows[0].route,'finish-archive-without-editor-writes');
 const instruction={id:'quantity-archive',text:'Archive the verified exact quantity group originals',taskIds:['v2-draft-archive-enforcement-20261103']},file='artifacts/quantity-archive.json',bytes=JSON.stringify({instruction});await fs.writeFile(path.join(root,file),bytes);await fs.mkdir(path.join(root,'artifacts/engineering-mission'),{recursive:true});await fs.writeFile(path.join(root,'artifacts/engineering-mission/work-queue.json'),JSON.stringify({instructions:[instruction]}));
 const result=await verifyReadyV2BrowserJob(root,id,lease,{review:packet,archiveAuthority:{instructionId:instruction.id,evidence:{path:file,sha256:createHash('sha256').update(bytes).digest('hex')}}});assert.equal(result.job.stage,'ready-pricing');assert.deepEqual(result.reviewed.sort(),['V2-test','second-copy']);assert.equal(result.archive.length,2);
 const state=await readV2State(root);for(const c of [q.first,q.second]){assert.equal(state.cards[c.id].draftArchive?.status,'moved');for(const p of c.photos){await assert.rejects(fs.stat(p.path),{code:'ENOENT'});const dest=state.cards[c.id].draftArchive!.files.find(f=>f.hash===p.hash)!.destination;assert.equal(createHash('sha256').update(await fs.readFile(dest)).digest('hex'),p.hash);}}assert.equal(state.calls.length,0);
}));

test('actual Captain Hook named non-sport category button plus adjacent complete breadcrumb is strict category proof',()=>fixture(async(root,body,raw,retain)=>{
 await withV2State(s=>{s.cards['V2-test'].identity!.categoryId='183050';Object.values(s.submissions)[0].payload.categoryId='183050';},root);delete body.reviews[0].checks.sportsSinglesCategory;body.reviews[0].checks.categoryMatched=true;
 const category='53 heading ITEM CATEGORY, Value: 2\n54 text ITEM CATEGORY\n55 button Edit Item category\n56 button Trading Card Singles Item category First category\n57 text in Collectibles > Non-Sport Trading Cards';raw.ax=raw.ax.replace('Sports Mem, Cards & Fan Shop > Sports Trading Cards',category);const correct=raw.ax;
 await reviewV2Nonprice(root,await retain());
 for(const malformed of [correct.replace('57 text in Collectibles > Non-Sport Trading Cards','57 text in Sports Mem, Cards & Fan Shop > Sports Trading Cards'),correct.replace('57 text in Collectibles > Non-Sport Trading Cards','57 text in Collectibles'),correct.replace('56 button Trading Card Singles Item category First category','56 text Trading Card Singles'),correct+'\n99 button Trading Card Singles Item category First category\n100 text in Collectibles > Non-Sport Trading Cards']){raw.ax=malformed;await assert.rejects(reviewV2Nonprice(root,await retain()),/category/);}
 raw.ax=correct;raw.dom.category.push({text:'Trading Card Singles',href:'https://www.ebay.com/b/Sports-Trading-Card-Singles/261328/bn_123'});await assert.rejects(reviewV2Nonprice(root,await retain()),/category/);
}));
test('actual DON CCG category button binds183454 only once within the native item-category section',async()=>{
 const {assertV2ObservedCategory}=await import('../lib/card-processing-v2-nonprice-review.ts');
 const category='56 heading ITEM CATEGORY, Value: 2\n57 text ITEM CATEGORY\n58 button Edit Item category\n59 button CCG Individual Cards Item category First category\n61 heading Store category, Value: 3\n62 text Store category\n63 button Other Store category First category';
 const raw:any={kind:'saved-reopened-draft-nonprice-observation',draftId:'5295668163920',url:'https://www.ebay.com/lstng?draftId=5295668163920',observedAt:new Date().toISOString(),scope:'non-price-fields; pricing left untouched per seller',priceWritePerformed:false,ax:category,dom:{fields:[],category:[],photos:[]},features:{ax:''}};
 assert.doesNotThrow(()=>assertV2ObservedCategory(raw,'183454'));
 for(const ax of [category+'\n99 button CCG Individual Cards Item category First category',category.replace('CCG Individual Cards','Trading Card Singles'),category.replace('56 heading ITEM CATEGORY, Value: 2','56 heading DIFFERENT, Value: 2'),category.replace('58 button Edit Item category','58 text Edit Item category'),category.replace('59 button CCG Individual Cards Item category First category','59 text CCG Individual Cards')])assert.throws(()=>assertV2ObservedCategory({...raw,ax},'183454'),/category/i);
 for(const id of ['183050','261328'])assert.throws(()=>assertV2ObservedCategory({...raw,dom:{...raw.dom,category:[{text:'CCG Individual Cards',href:`https://www.ebay.com/b/CCG-Individual-Cards/${id}/bn_123`}] }},'183454'),/category/i);
 assert.throws(()=>assertV2ObservedCategory({...raw,dom:{...raw.dom,category:[{text:'Trading Card Singles'}]}},'183454'),/category/i);
 assert.throws(()=>assertV2ObservedCategory({...raw,ax:category+'\n99 button Trading Card Singles Item category First category',dom:{...raw.dom,category:[{text:'CCG Individual Cards',href:'https://www.ebay.com/b/CCG-Individual-Cards/183454/bn_123'}]}},'183454'),/category/i);
});

test('explicit dedicated background review authority preserves strict actual values without requiring internal-browser-only',()=>fixture(async(root,body,raw,retain)=>{
 const file=path.join(root,'artifacts/engineering-mission/work-queue.json');await fs.mkdir(path.dirname(file),{recursive:true});const instruction={id:'background-review-authority',text:'Dedicated app browser may create selected drafts and move verified originals.',capturedAt:new Date().toISOString(),taskIds:['v2-background-runner-20261105'],policyRefs:['dedicated-background-browser-authorized','leave-pricing-alone','draft-only-no-publication','preserve-all-photo-bytes']};await fs.writeFile(file,JSON.stringify({instructions:[instruction],tasks:[{id:'v2-background-runner-20261105',status:'in-progress'}]}));body.kind='saved-draft-nonprice-review';body.authority=instruction.id;
 raw.dom.fields.find((f:any)=>f.name==='title').value='Wrong card';await assert.rejects(reviewV2Nonprice(root,await retain()),/mismatch/);raw.dom.fields.find((f:any)=>f.name==='title').value='Test title';await reviewV2Nonprice(root,await retain());assert.ok((await readV2State(root)).cards['V2-test'].nonpriceVerification);
 instruction.policyRefs=instruction.policyRefs.filter(p=>p!=='draft-only-no-publication');await fs.writeFile(file,JSON.stringify({instructions:[instruction],tasks:[{id:'v2-background-runner-20261105',status:'in-progress'}]}));await assert.rejects(reviewV2Nonprice(root,await retain()),/authority required/);
}));

test('actual rendered condition linebreak and return punctuation pass without rewriting evidence',()=>fixture(async(root,body,raw,retain)=>{raw.ax=raw.ax.replace('Card Condition Near mint or better:','Card Condition\nNear mint or better:').replace('Return policy :','Return policy:');await reviewV2Nonprice(root,await retain());assert.ok((await readV2State(root)).cards[body.reviews[0].cardId].nonpriceVerification);}));
