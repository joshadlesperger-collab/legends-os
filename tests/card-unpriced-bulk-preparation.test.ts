import test from 'node:test';
import assert from 'node:assert/strict';
import {newQueue,upsertCard,claimJob,completeJob,type Identity,type JobKind} from '../lib/card-orchestrator.ts';
import {prepareUnpricedBulkDraft} from '../lib/card-unpriced-bulk-preparation.ts';
const now='2026-11-03T03:00:00.000Z';
const identity:Identity={player:'Brandon Roy',season:'2024-25',set:'Panini Prizm Black',manufacturer:'Panini',cardNumber:'300',sport:'Basketball',team:'Portland Trail Blazers',parallel:'White Prizm',serial:'076/175',printRun:175,condition:'Near mint or better',autograph:false,patch:false};
function fixture(){
  const s=newQueue();upsertCard(s,{id:'one',sku:'black-0087',identity,photos:[{side:'front',path:'front.jpg',sha256:'a'.repeat(64)},{side:'back',path:'back.jpg',sha256:'b'.repeat(64)}],candidates:[],source:'test'},now);
  const finish=(kind:JobKind,data:unknown)=>{const claim=claimJob(s,'worker',kind,'one',now)!;assert.ok(claim);completeJob(s,'one',kind,claim.job.lease!.token,{outcome:'done',data},now);};
  finish('photos',{hashes:s.cards.one.input.photos.map(({side,sha256})=>({side,sha256})),evidence:'Original bytes checked'});
  finish('identity',{identity,pairMatches:true,frontFirst:true,serialInspected:true,evidence:'Both originals visually inspected'});
  const photos=['a','b'].map(h=>({originalHash:h.repeat(64),url:`https://i.ebayimg.com/images/${h}/s-l1600.jpg`,expiresAt:'2027-01-01T00:00:00Z',uprightReviewed:true}));
  return {s,photos};
}
test('unpriced transport leaves actual price and description blank, no shipping default or upload authority',()=>{
  const {s,photos}=fixture(),before=JSON.stringify(s);const result=prepareUnpricedBulkDraft(s,['one'],photos,Date.parse(now));
  assert.equal(result.preparedRows,1);assert.match(result.transportCsv!,/"Draft","black-0087","261328"/);
  assert.match(result.transportCsv!,/White Prizm 076\/175","","","1"/);
  assert.match(result.transportCsv!,/"4000","","FixedPrice"/);
  assert.equal(result.cards[0].item,null);assert.equal(result.cards[0].shipping,null);assert.equal(result.cards[0].description,null);
  assert.equal(result.canUpload,false);assert.equal(result.canPublish,false);assert.equal(result.submissionReady,false);
  assert.equal(JSON.stringify(s),before);assert.ok(result.cards[0].entryBlockers.some(b=>b.includes('four')||b.includes('scheduled')));
});
test('existing or unknown creation history cannot enter another import',()=>{
  for(const kind of ['draft','unknown','receipt']){
    const {s,photos}=fixture();
    if(kind==='draft')s.cards.one.input.knownDraft='5283690940321';
    if(kind==='unknown')s.cards.one.draftLifecycle={state:'unknown',binding:'x',observedAt:now,evidence:'Uncertain original submission'};
    if(kind==='receipt')s.cards.one.input.savedReceipts=[{disposition:'live',itemId:'128123456789',source:'retained'}];
    const result=prepareUnpricedBulkDraft(s,['one'],photos,Date.parse(now));assert.equal(result.transportCsv,null);assert.ok(result.exceptions[0].blockers.some(b=>b.includes('reimport')));
  }
});
test('expired, inverted or foreign hosted images and seller holds preserve exceptions',()=>{
  const {s,photos}=fixture();
  for(const changed of [photos.map(p=>({...p,expiresAt:now})),photos.map(p=>({...p,uprightReviewed:false})),photos.map(p=>({...p,url:'https://example.com/image.jpg'}))])assert.equal(prepareUnpricedBulkDraft(s,['one'],changed,Date.parse(now)).transportCsv,null);
  assert.equal(prepareUnpricedBulkDraft(s,['one'],photos,Date.parse(now),{one:'Do not draft'}).transportCsv,null);
});
test('changed original bindings invalidate retained reviews and repeated selected IDs rejected',()=>{
  const {s,photos}=fixture();s.cards.one.input.photos[0].sha256='c'.repeat(64);
  assert.equal(prepareUnpricedBulkDraft(s,['one'],photos,Date.parse(now)).transportCsv,null);
  assert.throws(()=>prepareUnpricedBulkDraft(s,['one','one'],photos),/distinct/);
});
test('unnumbered copies cannot bypass the existing quantity planner',()=>{
  const {s,photos}=fixture();s.cards.one.jobs.identity.result!.identity={...identity,serial:'',printRun:null};
  const result=prepareUnpricedBulkDraft(s,['one'],photos,Date.parse(now));
  assert.equal(result.transportCsv,null);assert.ok(result.exceptions[0].blockers.some(b=>b.includes('quantity-group planner')));
});
