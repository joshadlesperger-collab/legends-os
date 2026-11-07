import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {newQueue,upsertCard,claimJob,completeJob,fingerprint,recordKnownInventoryObservation,queueSummary,type CardInput} from '../lib/card-orchestrator.ts';
const at='2026-10-24T01:00:00.000Z';
function fixture(){
 const s=newQueue();
 for(const [id,hash,serial,draft,live] of [['a','a','25/99','111','1001'],['b','c','26/99','222','1002']]){
 const input:CardInput={id,sku:id,source:'test',candidates:[],identity:{player:'Player',season:'2024',set:'Set',manufacturer:'Maker',cardNumber:'1',sport:'Basketball',team:'Team',parallel:'Purple',serial,printRun:99,condition:'Near mint or better',autograph:false,patch:false},photos:[{side:'front',path:id+'f',sha256:hash.repeat(64)},{side:'back',path:id+'b',sha256:(hash==='a'?'b':'d').repeat(64)}]};
 upsertCard(s,input,at);
 for(const kind of ['photos','identity'] as const){const c=claimJob(s,'test',kind,id,at)!;completeJob(s,id,kind,c.job.lease!.token,{outcome:'done',data:kind==='photos'?{hashes:input.photos,evidence:'original pair'}:{identity:input.identity,pairMatches:true,frontFirst:true,serialInspected:true,evidence:'Both originals inspected'}},at);}
 s.cards[id].input.knownDraft=draft;s.cards[id].input.knownLive={itemId:live,url:'https://www.ebay.com/itm/'+live,observedAt:at,source:'retained manifest'};
 }
 s.cards.a.exclusion={disposition:'draft',itemId:'222',evidence:'obsolete mapping'};
 const c=s.cards.a;
 const observation={observationId:randomUUID(),seller:'imaydit58',cardId:'a',sku:'a',identityKey:fingerprint(c.jobs.identity.result!.identity),photoKey:fingerprint(c.input.photos),itemId:'1001',disposition:'live',observedAt:at,source:'https://www.ebay.com/itm/1001',evidence:'Visible seller SKU and exact serial matched retained live receipt'};
 return {s,observation};
}
test('fresh known live observation supersedes only obsolete draft exclusion and retains audit',()=>{const {s,observation}=fixture();assert.equal(recordKnownInventoryObservation(s,observation,at),true);assert.equal(s.cards.a.exclusion!.itemId,'1001');assert.ok(s.events.some(e=>e.event==='obsolete-draft-exclusion-superseded'&&e.detail.includes('obsolete mapping')));assert.equal(recordKnownInventoryObservation(s,observation,at),false);});
test('input receipt conflict remains blocked without partial mutation',()=>{const {s,observation}=fixture();s.cards.a.input.knownDraft='222';const before=JSON.stringify(s);assert.throws(()=>recordKnownInventoryObservation(s,observation,at),/ownership conflict/);assert.equal(JSON.stringify(s),before);});
test('stale observation cannot supersede draft exclusion',()=>{const {s,observation}=fixture();assert.throws(()=>recordKnownInventoryObservation(s,observation,'2026-10-24T03:00:00.000Z'),/fresh/);assert.equal(s.cards.a.exclusion!.itemId,'222');});
test('quantity group permits incremental optional review metadata but rejects explicit disagreement',async()=>{
 const {validDraftGroup}=await import('../lib/card-orchestrator.ts');const {s}=fixture();
 for(const c of Object.values(s.cards)){c.input.identity.serial='';c.input.identity.printRun=null;c.input.knownDraft='333';delete c.input.knownLive;delete c.exclusion;c.input.savedReceipts=[{disposition:'draft',itemId:'333',source:'manifest',listingQuantity:2,captureQuantity:1}];c.jobs.identity.result={identity:{...c.input.identity}};}
 const a=s.cards.a.jobs.identity.result!.identity as CardInput['identity'];
 a.artwork='same artwork';a.language='English';a.conditionType='Raw';
 assert.equal(validDraftGroup(s,'333',['a','b']),true);
 (s.cards.b.jobs.identity.result!.identity as CardInput['identity']).artwork='different artwork';
 assert.equal(validDraftGroup(s,'333',['a','b']),false);
});
