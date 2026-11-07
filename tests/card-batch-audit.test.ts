import test from 'node:test';
import assert from 'node:assert/strict';
import { auditBatch, applyDraftHandoffHolds } from '../lib/card-batch-audit.ts';
import { batchTiming,transitionBatch,type TimedBatch } from '../lib/card-batch.ts';
function fixture():any{const fields={sku:'S1',title:'Verified card',item:2.61,shipping:0,quantity:1,condition:'Near mint or better'};return {captures:[{id:'a',frontHash:'a'.repeat(64),backHash:'b'.repeat(64),serial:null}],outcomes:[{captureId:'a',route:'draft',targetId:'123',evidence:'saved-reopened.json',expected:{...fields},reopened:{...fields},savedAt:'2026-10-25T20:00:00Z',reopenedAt:'2026-10-25T20:01:00Z',criticalFieldsVerified:true,observedSerial:null,photos:{count:2,frontHash:'a'.repeat(64),backHash:'b'.repeat(64),evidence:'photos.json'},inventory:{checkedAt:'2026-10-25T20:00:00Z',scopes:['active','sold','drafts','scheduled'],sameCaptureActiveIds:[],otherDraftIds:[],evidence:'inventory.json'}}]};}
test('successful saved comparison never grants publication',()=>{const r=auditBatch(fixture());assert.equal(r.complete,true);assert.equal(r.canPublish,false);});
test('omitted capture fails without losing independently verified card',()=>{const p=fixture();p.captures.push({id:'b',frontHash:'b'.repeat(64)});const r=auditBatch(p);assert.equal(r.complete,false);assert.deepEqual(r.verified,['a']);assert.match(r.issues[0],/b:/);});
test('duplicate outcomes and copied captures cannot inflate completeness',()=>{const p=fixture();p.outcomes.push(p.outcomes[0]);assert.equal(auditBatch(p).complete,false);p.captures.push({id:'b',frontHash:'a'.repeat(64)});assert.ok(auditBatch(p).issues.some(x=>x.includes('hash')));});
test('visible but uncommitted price is caught',()=>{const p=fixture();p.outcomes[0].reopened.item=0;assert.match(auditBatch(p).issues.join(),/item mismatch/);});
test('explicit exception accounts for capture but does not claim completion',()=>{const p=fixture();const r=auditBatch({...p,outcomes:[{captureId:'a',route:'exception',evidence:'hold.json',reason:'variant unresolved'}]});assert.equal(r.accountedFor,true);assert.equal(r.complete,false);});
test('save without reopen and uncertain identity cannot pass',()=>{const p=fixture();p.outcomes[0].reopenedAt='2026-10-25T19:00:00Z';p.outcomes[0].criticalFieldsVerified=false;assert.ok(auditBatch(p).issues.length>=2);});
test('engineering and generation are separate from operator work',()=>{let b:TimedBatch={id:'test',cardIds:['a'],createdAt:'2026-10-25T20:00:00Z',revision:0,intervals:[]};b=transitionBatch(b,'generation',b.createdAt);b=transitionBatch(b,'engineering','2026-10-25T20:00:10Z');b=transitionBatch(b,'save','2026-10-25T20:00:30Z');b=transitionBatch(b,null,'2026-10-25T20:00:35Z');const t=batchTiming(b,Date.parse('2026-10-25T20:00:35Z'));assert.equal(t.workSeconds,5);assert.equal(t.elapsedSeconds,35);});

test('photo-less draft cannot pass a general verified flag',()=>{const p=fixture();p.outcomes[0].photos.count=0;assert.match(auditBatch(p).issues.join(),/photo/);});
test('swapped or wrong original photos fail',()=>{const p=fixture();p.outcomes[0].photos.backHash='c'.repeat(64);assert.equal(auditBatch(p).complete,false);});
test('original serial beats copied title and model consensus',()=>{const p=fixture();p.captures[0].serial='31/49';p.outcomes[0].observedSerial='36/49';assert.match(auditBatch(p).issues.join(),/serial/);p.outcomes[0].observedSerial='31/49';p.outcomes[0].reopened.title='RJ Luis 36/49';p.outcomes[0].expected.title='RJ Luis 36/49';assert.match(auditBatch(p).issues.join(),/title serial/);});
test('already active capture and leftover draft cannot count as complete',()=>{const p=fixture();p.outcomes[0].inventory.sameCaptureActiveIds=['12345'];p.outcomes[0].inventory.otherDraftIds=['54321'];const r=auditBatch(p);assert.equal(r.complete,false);assert.match(r.issues.join(),/already active/);assert.match(r.issues.join(),/duplicate drafts/);});
test('known stale draft hold cannot be hidden by clean observations',()=>{const p=fixture();p.draftHolds=[{draftId:'123',captureId:'a',activeItemId:'456',reason:'already active',evidence:'hold.json'}];assert.equal(auditBatch(p).complete,false);});
test('old and incomplete inventory reads fail closed',()=>{const p=fixture();p.outcomes[0].inventory.checkedAt='2026-10-25T18:00:00Z';assert.equal(auditBatch(p).complete,false);p.outcomes[0].inventory.checkedAt='2026-10-25T20:00:00Z';p.outcomes[0].inventory.scopes=['active'];assert.equal(auditBatch(p).complete,false);});
test('legacy blanket verification lacks required structured evidence',()=>{const p=fixture();delete p.outcomes[0].photos;delete p.outcomes[0].inventory;delete p.outcomes[0].observedSerial;assert.equal(auditBatch(p).complete,false);});

test('normal handoff exposes stale draft IDs without mutating source receipts',()=>{const p={cards:[{id:'a',blockers:[],nextOwner:'writer',nextAction:'resume'}]};const r=applyDraftHandoffHolds(p,[{draftId:'123',captureId:'a',activeItemId:'456',reason:'Already live',evidence:'retained.txt'}]);assert.match(r.cards[0].blockers[0],/123/);assert.match(r.cards[0].blockers[0],/ebay.com/);assert.equal(p.cards[0].blockers.length,0);});

test('only a complete verified quantity group can share a draft ID',()=>{
 const p=fixture();p.captures.push({id:'b',frontHash:'c'.repeat(64),backHash:'d'.repeat(64),serial:null});
 p.outcomes.push({...structuredClone(p.outcomes[0]),captureId:'b',photos:{...p.outcomes[0].photos,frontHash:'c'.repeat(64),backHash:'d'.repeat(64)}});
 for(const o of p.outcomes){o.expected.quantity=2;o.reopened.quantity=2;o.photos.count=4;}
 assert.equal(auditBatch(p).complete,false);
 const groups={'123':{members:['a','b'],sku:'S1'}};
 assert.equal(auditBatch(p,groups).complete,true);
 p.outcomes[1].reopened.quantity=1;assert.equal(auditBatch(p,groups).complete,false);
 p.outcomes[1].reopened.quantity=2;p.outcomes.pop();assert.equal(auditBatch({...p,outcomes:p.outcomes},groups).complete,false);
});
