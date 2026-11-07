import test from 'node:test';
import assert from 'node:assert/strict';
import { digest, type V2Card } from '../lib/card-processing-v2.ts';
import {planV2DraftMerges,type V2DraftMergePlanInput,type V2MergeDraft} from '../lib/card-processing-v2-draft-merge-plan.ts';
const now=Date.parse('2026-11-06T15:00:00Z'),evidence={path:'artifacts/synthetic.json',sha256:digest('proof')};
function card(id:string,draftId?:string,serial=''):V2Card {return{
 id,sku:'SKU-'+id,captureId:digest(id),photos:[{path:id+'-front.jpg',hash:digest(id+'front'),side:'front'},{path:id+'-back.jpg',hash:digest(id+'back'),side:'back'}],
 stage:draftId?'verified':'identified',identity:{name:'Player',year:'2024-25',manufacturer:'Panini',product:'Prizm Black',number:'12',categoryId:'261328',language:'English',variant:'Red Sparkle Prizm',artwork:'Player portrait',sportOrGame:'Basketball',team:'Team',serial,graded:false,damage:false,specifics:{}},
 condition:'Near mint or better',title:'Card title',description:'Card description',descriptionSource:'factual',issues:[],nextAction:'Fixture',createdAt:new Date(now-1000).toISOString(),updatedAt:new Date(now-1000).toISOString(),...(draftId?{draftId}:{})};}
function draft(c:V2Card,quantity=1,amount:string|null='2.49'):V2MergeDraft{return{draftId:c.draftId!,sku:c.sku,quantity,price:{amount,currency:'USD'},protectedValues:{title:'Card title',shipping:'Existing shipping',price:amount??''},evidence};}
function input(knownCards:V2Card[],newCards:V2Card[]=[],drafts=knownCards.map(c=>draft(c))):V2DraftMergePlanInput{return{snapshot:{scope:'drafts',complete:true,observedAt:new Date(now-1000).toISOString(),evidence},drafts,knownCards,newCards};}
test('sum current saved quantities once and add only new physical captures without mutating records',()=>{
 const a=card('a','100'),b=card('b','200'),n=card('new'),packet=input([a,b],[n],[draft(a,3),draft(b,2)]),before=structuredClone(packet);
 const result=planV2DraftMerges(packet,now),merge=result.merges[0];
 assert.equal(result.merges.length,1);assert.equal(merge.existingQuantity,5);assert.equal(merge.targetQuantity,6);
 assert.equal(merge.survivorDraftId,'100');assert.deepEqual(merge.deleteDraftIds,['200']);
 assert.equal(merge.knownExistingCaptures.length,2);assert.equal(merge.unattributedExistingQuantity,3);assert.equal(merge.newCaptures[0].captureId,n.captureId);
 assert.deepEqual(packet,before);assert.equal(result.activeInventoryScans,0);assert.equal(result.publish,false);
 assert.deepEqual(merge.survivor.protectedValues,packet.drafts[0].protectedValues);
 assert.deepEqual(merge.requiredOrder.slice(1,5),['save-survivor-quantity','reopen-survivor-verify-protected-values','delete-exact-donors','verify-donor-absence']);
 assert.equal(planV2DraftMerges({...packet,drafts:[...packet.drafts].reverse()},now).merges[0].id,merge.id);
});
test('one existing draft accepts new copies without creating or deleting another draft',()=>{
 const a=card('a','100'),result=planV2DraftMerges(input([a],[card('new')]),now);
 assert.equal(result.merges[0].targetQuantity,2);assert.deepEqual(result.merges[0].deleteDraftIds,[]);assert.equal(result.newDraftGroups.length,0);
});
test('prefer populated-price survivor, preserve it, and isolate conflicting populated prices',()=>{
 const a=card('a','100'),b=card('b','200');
 const result=planV2DraftMerges(input([a,b],[],[draft(a,1,null),draft(b,1,'2.49')]),now);
 assert.equal(result.merges[0].survivorDraftId,'200');assert.equal(result.merges[0].survivor.price.amount,'2.49');
 const conflict=planV2DraftMerges(input([a,b],[],[draft(a,1,'2.49'),draft(b,1,'3.49')]),now);
 assert.equal(conflict.merges.length,0);assert.equal(conflict.exceptions[0].code,'PRICE_CONFLICT');
});
test('serialize and finish differences remain separate and unknown draft identity is isolated',()=>{
 const a=card('a','100'),serial=card('serial','200','001/144'),foil=card('foil','300');foil.identity!.specifics.Finish=['Foil'];
 const result=planV2DraftMerges(input([a,serial,foil],[],[draft(a),draft(serial),draft(foil),{...draft(a),draftId:'400',sku:'unknown'}]),now);
 assert.equal(result.merges.length,0);assert.ok(result.exceptions.some(e=>e.code==='SERIALIZED_SEPARATE'));assert.ok(result.exceptions.some(e=>e.code==='UNKNOWN_DRAFT_IDENTITY'));
});
test('same new capture repeated is rejected; already draft-owned capture cannot be added again',()=>{
 const a=card('a','100'),n=card('new');assert.throws(()=>planV2DraftMerges(input([a],[n,n]),now),/Repeated new capture/);
 const result=planV2DraftMerges(input([a],[{...a,draftId:undefined,stage:'identified'}]),now);
 assert.equal(result.merges.length,0);assert.equal(result.exceptions[0].code,'NEW_CAPTURE_NOT_UNBOUND');
});
test('unfinished merge resumes its exact operation; completed merge additions cannot be replayed',()=>{
 const a=card('a','100'),b=card('b','200'),n=card('new'),op={id:'retained',status:'quantity-saved' as const,survivorDraftId:'100',sourceDraftIds:['100','200'],newCaptureIds:[n.captureId]};
 const packet=input([a,b],[n,card('later')]);packet.retainedOperations=[op];
 const pending=planV2DraftMerges(packet,now);assert.deepEqual(pending.resumeOperationIds,['retained']);assert.equal(pending.merges.length,0);assert.equal(pending.newDraftGroups.length,0);assert.ok(pending.exceptions.some(e=>e.code==='MERGE_IN_PROGRESS'));
 const done=input([a],[n],[draft(a,3)]);done.retainedOperations=[{...op,status:'complete'}];
 assert.equal(planV2DraftMerges(done,now).merges.length,0);
});
test('unknown scope freshness and quantity/ownership conflicts never authorize a merge',()=>{
 const a=card('a','100'),b=card('b','100'),packet=input([a,b],[],[draft(a,1)]);
 const result=planV2DraftMerges(packet,now);assert.equal(result.merges.length,0);assert.equal(result.exceptions[0].code,'DRAFT_OWNERSHIP_CONFLICT');
 assert.throws(()=>planV2DraftMerges({...packet,snapshot:{...packet.snapshot,observedAt:new Date(now-3600001).toISOString()}},now),/fresh/);
 assert.throws(()=>planV2DraftMerges({...packet,drafts:[draft(a),draft(a)]},now),/Unique/);
});
test('brand new duplicates group once for normal draft creation and require no inventory source',()=>{
 const result=planV2DraftMerges(input([],[card('new1'),card('new2')]),now);
 assert.equal(result.merges.length,0);assert.equal(result.newDraftGroups.length,1);assert.equal(result.newDraftGroups[0].quantity,2);
});
test('generated pose/background prose does not split catalog-identical copies but named artwork remains distinct',()=>{
 const a=card('a','100'),b=card('b','200');a.identity!.artwork='Player dribbling, red confetti background.';b.identity!.artwork='Red sparkle confetti pattern; player portrait';
 assert.equal(planV2DraftMerges(input([a,b]),now).merges[0].targetQuantity,2);
 b.identity!.specifics['Image Variation']=['Alternate Art B'];
 assert.equal(planV2DraftMerges(input([a,b]),now).merges.length,0);
 delete b.identity!.specifics['Image Variation'];b.identity!.artwork='Alternate art illustration';
 assert.equal(planV2DraftMerges(input([a,b]),now).merges.length,0);
});
test('prefer existing quantity-two survivor over quantity-one draft with same price and different prose',()=>{
 const one=card('one','100'),two=card('two','200');one.identity!.artwork='Wade dribbling basketball';two.identity!.artwork='Basketball player, Dwyane Wade, dribbling.';
 const result=planV2DraftMerges(input([one,two],[],[draft(one,1),draft(two,2)]),now);
 assert.equal(result.merges[0].survivorDraftId,'200');assert.equal(result.merges[0].targetQuantity,3);assert.deepEqual(result.merges[0].deleteDraftIds,['100']);
});
