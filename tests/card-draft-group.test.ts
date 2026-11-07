import test from 'node:test';
import assert from 'node:assert/strict';
import {newQueue,upsertCard,validDraftGroup,jobBlockers,claimJob,completeJob,recordKnownInventoryObservation,recordSoldDraftGroup,recordVerifiedReceipt,fingerprint,existingReceipt,type CardInput} from '../lib/card-orchestrator.ts';
import {randomUUID} from 'node:crypto';
import {applySavedReceipts} from '../lib/card-orchestrator-import.ts';
const now='2026-10-22T23:00:00.000Z';
function fixture(){
 const state=newQueue();
 for(const [id,hash] of [['a','a'],['b','b']]){
  const input:CardInput={id,sku:id,identity:{player:'JuJu Watkins',season:'2024-25',set:'Bowman University Chrome Sapphire',manufacturer:'Topps',cardNumber:'37',sport:'Basketball',team:'USC',parallel:'Base Sapphire',serial:'',printRun:null,condition:'Near mint or better',autograph:null,patch:false},photos:[{side:'front',path:id+'front',sha256:hash.repeat(64)},{side:'back',path:id+'back',sha256:'c'.repeat(64)}],candidates:[],source:'test'};
  upsertCard(state,applySavedReceipts(input,[{source:'manifest',data:{key:id,draftId:'12345',quantity:1,listingQuantity:2,files:input.photos}}]),now);
 }
 return state;
}
test('intentional quantity draft permits local reviews but remains excluded from Add',()=>{
 const state=fixture();assert.equal(validDraftGroup(state,'12345',['a','b']),true);
 assert.deepEqual(jobBlockers(state,state.cards.a,'photos'),[]);
 assert.ok(jobBlockers(state,state.cards.a,'listing').some(r=>r.includes('Already live')));
 const claim=claimJob(state,'test','photos','a',now)!;
 completeJob(state,'a','photos',claim.job.lease!.token,{outcome:'done',data:{hashes:state.cards.a.input.photos.map(({side,sha256})=>({side,sha256})),evidence:'Original files verified'}},now);
 assert.deepEqual(jobBlockers(state,state.cards.a,'identity'),[]);
});
test('verified matching quantity drafts advance to one live receipt without allowing conflicting ownership',()=>{
 const s=fixture();
 for(const c of Object.values(s.cards))upsertCard(s,{...c.input,identity:{...c.input.identity,autograph:false,language:'English',artwork:'Printed base artwork',conditionType:'Ungraded'}},now);
 for(const c of Object.values(s.cards)){
  const photo=claimJob(s,'test','photos',c.input.id,now)!;
  completeJob(s,c.input.id,'photos',photo.job.lease!.token,{outcome:'done',data:{hashes:c.input.photos.map(({side,sha256})=>({side,sha256})),evidence:'Both original captures inspected'}},now);
  const identity=claimJob(s,'test','identity',c.input.id,now)!;
  completeJob(s,c.input.id,'identity',identity.job.lease!.token,{outcome:'done',data:{identity:c.input.identity,pairMatches:true,frontFirst:true,serialInspected:true,evidence:'Matching unnumbered artwork, variant, language and condition inspected'}},now);
 }
 const receipt=(id:string)=>({observationId:randomUUID(),seller:'imaydit58',cardId:id,sku:id,frontHash:s.cards[id].input.photos[0].sha256,backHash:s.cards[id].input.photos[1].sha256,identityKey:fingerprint(s.cards[id].input.identity),draftId:'12345',observedAt:now,photosVerified:true,source:'https://www.ebay.com/sl/list?draft_id=12345',evidence:'Saved quantity two and representative original pair verified; both captures reviewed'});
 const original=structuredClone(s);
 assert.equal(recordVerifiedReceipt(s,receipt('a'),now),true);
 assert.equal(recordVerifiedReceipt(s,receipt('b'),now),true);
 for(const mutate of [
  s=>{s.cards.b.input.savedReceipts![0].listingQuantity=3;},
  s=>{s.cards.b.jobs.identity.state='todo';},
  s=>{delete (s.cards.b.jobs.identity.result!.identity as CardInput['identity']).artwork;},
 ] as Array<(s:typeof original)=>void>){const altered=structuredClone(original);mutate(altered);assert.throws(()=>recordVerifiedReceipt(altered,receipt('a'),now),/Conflicting/);}
 const liveA={...receipt('a'),liveItemId:'999'};
 assert.equal(recordVerifiedReceipt(s,liveA,now),true);
 assert.equal(recordVerifiedReceipt(s,{...receipt('b'),liveItemId:'999'},now),true);
 assert.equal(recordVerifiedReceipt(s,{...liveA,observationId:randomUUID()},now),true);
 s.cards.a.input.knownLive={itemId:'999',url:'https://www.ebay.com/itm/999',observedAt:now,source:'Verified archive import'};
 assert.equal(recordVerifiedReceipt(s,{...receipt('a'),liveItemId:'999'},now),true);
 assert.ok(!jobBlockers(s,s.cards.a,'listing').some(x=>x.includes('Receipt ID')));
 assert.ok(jobBlockers(s,s.cards.a,'listing').some(x=>x.includes('Already live')));
 assert.throws(()=>recordVerifiedReceipt(s,{...receipt('b'),liveItemId:'888'},now),/Conflicting/);
 const unrelated=structuredClone(original);
 unrelated.cards.c=structuredClone(unrelated.cards.b);
 unrelated.cards.c.input.id='c';unrelated.cards.c.input.sku='c';
 unrelated.cards.c.input.photos[0].sha256='d'.repeat(64);
 unrelated.cards.c.input.knownDraft='other';unrelated.cards.c.input.savedReceipts=[];
 unrelated.cards.c.exclusion={disposition:'live',itemId:'999',evidence:'Unrelated listing'};
 assert.throws(()=>recordVerifiedReceipt(unrelated,{...receipt('a'),liveItemId:'999'},now),/Conflicting/);
});
test('conflicting quantities, captures, variants, conditions, serials and live receipts stay blocked',()=>{
 for(const mutate of [
  s=>{s.cards.b.input.savedReceipts![0].listingQuantity=3;},
  s=>{delete s.cards.b.input.savedReceipts![0].listingQuantity;},
  s=>{s.cards.b.input.savedReceipts![0].captureQuantity=2;},
  s=>{s.cards.b.input.savedReceipts![0].source='different';},
  s=>{s.cards.b.input.photos[0].sha256='a'.repeat(64);},
  s=>{s.cards.b.input.identity.parallel='Gold';},
  s=>{s.cards.b.input.identity.condition='Excellent';},
  s=>{s.cards.b.input.identity.serial='1/99';s.cards.b.input.identity.printRun=99;},
  s=>{s.cards.b.exclusion={disposition:'sold',itemId:'12345',evidence:'sold'};},
  s=>{s.cards.b.input.knownLive={itemId:'999',url:'https://www.ebay.com/itm/999',observedAt:now,source:'test'};}
 ] as Array<(s:ReturnType<typeof fixture>)=>void>){const s=fixture();mutate(s);assert.equal(validDraftGroup(s,'12345',['a','b']),false);}
});
test('unknown autograph review may complete independently without inventing the other copy review',()=>{
 const s=fixture();s.cards.a.jobs.identity.state='done';s.cards.a.jobs.identity.result={identity:{...s.cards.a.input.identity,autograph:false}};
 assert.equal(validDraftGroup(s,'12345',['a','b']),true);assert.equal(s.cards.b.jobs.identity.state,'todo');
 s.cards.b.input.identity.autograph=true;assert.equal(validDraftGroup(s,'12345',['a','b']),false);
});
test('known inventory observations bind identity and pair, preserve jobs, and never downgrade sold',()=>{
 const s=fixture(),c=s.cards.a;delete s.cards.b;c.input.knownLive={itemId:'999',url:'https://www.ebay.com/itm/999',observedAt:now,source:'test'};
 c.jobs.identity.state='done';c.jobs.identity.result={identity:{...c.input.identity,autograph:false}};
 const v={observationId:randomUUID(),seller:'imaydit58',cardId:'a',sku:'a',identityKey:fingerprint(c.jobs.identity.result.identity),photoKey:fingerprint(c.input.photos),itemId:'999',disposition:'sold',observedAt:now,source:'Seller Hub sold orders',evidence:'Exact item, physical identity and SKU inspected'};
 for(const patch of [{itemId:'888'},{sku:'other'},{photoKey:'d'.repeat(64)},{identityKey:'e'.repeat(64)}]){const before=JSON.stringify(s);assert.throws(()=>recordKnownInventoryObservation(s,{...v,...patch},now));assert.equal(JSON.stringify(s),before);}
 const jobs=JSON.stringify(c.jobs);assert.equal(recordKnownInventoryObservation(s,v,now),true);assert.equal(JSON.stringify(c.jobs),jobs);assert.equal(recordKnownInventoryObservation(s,v,now),false);
 assert.equal(existingReceipt(c)?.disposition,'sold');assert.throws(()=>recordKnownInventoryObservation(s,{...v,observationId:randomUUID(),disposition:'live'},now),/downgrade/);
 assert.ok(jobBlockers(s,c,'pricing').some(r=>r.includes('Already live')));
});
test('sold quantity group is atomic, snapshot-bound and retains both captures without mapping conflict',()=>{
 const s=fixture();for(const c of Object.values(s.cards)){c.jobs.photos.state='done';c.jobs.identity.state='done';c.jobs.identity.result={identity:c.input.identity};}
 const v={observationId:randomUUID(),seller:'imaydit58',draftId:'12345',itemId:'999',soldQuantity:2,observedAt:now,source:'Retained draft redirects to inspected sold item',evidence:'Original listing shows exactly two sold and no remaining copies',members:Object.values(s.cards).map(c=>({cardId:c.input.id,sku:c.input.sku,identityKey:fingerprint(c.input.identity),photoKey:fingerprint(c.input.photos)}))};
 for(const patch of [{soldQuantity:1},{members:v.members.slice(0,1)},{members:v.members.map(m=>({...m,photoKey:'d'.repeat(64)}))}]){const before=JSON.stringify(s);assert.throws(()=>recordSoldDraftGroup(s,{...v,...patch},now));assert.equal(JSON.stringify(s),before);}
 const jobs=JSON.stringify(Object.values(s.cards).map(c=>c.jobs));assert.equal(recordSoldDraftGroup(s,v,now),true);assert.equal(recordSoldDraftGroup(s,v,now),false);assert.equal(JSON.stringify(Object.values(s.cards).map(c=>c.jobs)),jobs);
 for(const c of Object.values(s.cards)){assert.deepEqual(existingReceipt(c),{disposition:'sold',itemId:'999'});assert.ok(jobBlockers(s,c,'listing').some(x=>x.includes('Already live')));assert.ok(!jobBlockers(s,c,'listing').some(x=>x.includes('Receipt ID')));}
 assert.equal(Object.keys(s.cards).length,2);
});
