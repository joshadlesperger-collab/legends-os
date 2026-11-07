import test from 'node:test';
import assert from 'node:assert/strict';
import {observeV2PhotoStep,appendV2PhotoSegments,type V2PhotoSegment} from '../lib/card-processing-v2-photo-timing.ts';
test('photo inner observer buffers durations and preserves one callback outcome without recording provider text',async()=>{
 const segments:V2PhotoSegment[]=[];let calls=0;
 const result=await observeV2PhotoStep(s=>segments.push(s),'photo-eps-request',async()=>{calls++;return{url:'https://example.test/photo'};});
 assert.equal(calls,1);assert.equal(result.url,'https://example.test/photo');assert.equal(segments.length,1);assert.equal(segments[0].status,'completed');assert.ok(segments[0].durationMs>=0);assert.ok(Date.parse(segments[0].endedAt)>=Date.parse(segments[0].startedAt));
 const failure=Error('private provider failure must never enter telemetry');
 await assert.rejects(observeV2PhotoStep(s=>segments.push(s),'photo-eps-request',async()=>{calls++;throw failure;}),error=>error===failure);
 assert.equal(calls,2);assert.equal(segments[1].status,'failed');assert.ok(!JSON.stringify(segments).includes('private provider'));
});
test('photo observer failure cannot replace domain success or cause another remote call',async()=>{
 let calls=0;assert.equal(await observeV2PhotoStep(()=>{throw Error('sink failure');},'photo-eps-request',async()=>{calls++;return 42;}),42);assert.equal(calls,1);
});
test('all completed inner photo segments append as one journal event with exact card/run metadata',async()=>{
 const segments:V2PhotoSegment[]=[];for(const step of ['photo-verified-original-read','photo-orientation-encode','photo-eps-request','photo-media-state-commit'])await observeV2PhotoStep(s=>segments.push(s),step,async()=>true);
 let writes=0;await appendV2PhotoSegments('synthetic-root',segments,{cardId:'physical-copy',runId:'exact-run'},async(root,id,spans)=>{writes++;assert.equal(root,'synthetic-root');assert.match(id,/^photo-inner-/);assert.equal(spans.length,4);assert.equal(new Set(spans.map(s=>s.id)).size,4);assert.ok(spans.every(s=>s.cardId==='physical-copy'&&s.runId==='exact-run'&&s.status==='completed'));return{replayed:false,warnings:[]};});
 assert.equal(writes,1);await appendV2PhotoSegments('synthetic-root',[],{cardId:'physical-copy'},async()=>{writes++;return{replayed:false,warnings:[]};});assert.equal(writes,1);
});

test('new acknowledgement recovery and pre-request fence persist with the complete actual photo sequence',async()=>{
 const steps=['photo-media-ack-recovery','photo-upload-attempt-fence','photo-verified-original-read','photo-connection-read','photo-orientation-encode','photo-eps-request','photo-media-state-commit'];
 const segments:V2PhotoSegment[]=[];for(const step of steps)await observeV2PhotoStep(s=>segments.push(s),step,async()=>true);
 let writes=0;await appendV2PhotoSegments('synthetic-root',segments,{cardId:'exact-card',runId:'exact-run'},async(_root,_id,spans)=>{writes++;assert.deepEqual(spans.map(s=>s.step),steps);assert.ok(spans.every(s=>s.cardId==='exact-card'&&s.runId==='exact-run'));return{replayed:false,warnings:[]};});assert.equal(writes,1);
 await assert.rejects(appendV2PhotoSegments('synthetic-root',[{...segments[0],step:'photo-unapproved-provider-text'}],{cardId:'exact-card'},async()=>{writes++;return{replayed:false,warnings:[]};}),/Bounded photo timing/);assert.equal(writes,1);
});
