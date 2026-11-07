import test from 'node:test';import assert from 'node:assert/strict';
import {captureV2InternalDraft,captureV2InternalDraftBatch,inspectV2BrowserAttempt,confirmV2BrowserRecovery,rebindV2BrowserRecovery} from '../lib/card-processing-v2-internal-readback.mjs';
const req=id=>({draftId:id,url:'https://www.ebay.com/lstng?draftId='+id+'&mode=AddItem',expandFeatures:false});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function fixture({axPending,events=[]}={}){let url=req('123').url;const tab={url:async()=>{events.push('url:'+new URL(url).searchParams.get('draftId'));return url;},goto:async value=>{url=value;events.push('goto:'+new URL(url).searchParams.get('draftId'));},getAXState:async()=>{events.push('ax');return axPending?axPending.promise:'Actual full native saved field tree '.repeat(8);},playwright:{locator:()=>({first:()=>({waitFor:async()=>{}})}),evaluate:async()=>{events.push('dom');return{url,observedAt:new Date().toISOString(),dom:{fields:[{name:'customLabel',value:'actual'}],category:[],photos:[]}};}}};return{tab,events};}
function proof(tab){const s=inspectV2BrowserAttempt(tab);return{attemptId:s.attemptId,draftId:s.draftId,observedAt:new Date().toISOString(),checkpoint:{path:'retained/actual-failure.json',sha256:'a'.repeat(64)},quiescent:true};}
test('step timeout retains pending checkpoint, fences replay, and discards late observation',async()=>{
 const pending=deferred(),f=fixture({axPending:pending}),checkpoints=[],retained=[],failures=[];
 await assert.rejects(captureV2InternalDraft(f.tab,req('123'),{stepTimeoutMs:12,cardTimeoutMs:100,checkpoint:async x=>{checkpoints.push(x);return{path:'actual-start.json'};},retain:async x=>retained.push(x),retainFailure:async x=>failures.push(x)}),/deadline/);
 assert.ok(checkpoints.some(x=>x.status==='started'&&x.step==='browser-ax-read'));assert.equal(failures.length,1);assert.equal(inspectV2BrowserAttempt(f.tab).unknownInFlight,true);
 const calls=f.events.length;await assert.rejects(captureV2InternalDraft(f.tab,req('123')),/reconciled/);assert.equal(f.events.length,calls);assert.throws(()=>confirmV2BrowserRecovery(f.tab,proof(f.tab)),/not settled/);
 pending.resolve('LATE actual full tree '.repeat(20));await pause(1);assert.equal(retained.length,0);assert.equal(f.events.includes('dom'),false);assert.equal(inspectV2BrowserAttempt(f.tab).unknownInFlight,false);assert.equal(inspectV2BrowserAttempt(f.tab).needsRecovery,true);
 confirmV2BrowserRecovery(f.tab,proof(f.tab));const result=await captureV2InternalDraft(f.tab,req('123'));assert.equal(result.observation.draftId,'123');
});
test('only one explicit same-ID retry is permitted after settled failures',async()=>{
 const pending=deferred(),f=fixture({axPending:pending});pending.reject(Error('read failed'));
 await assert.rejects(captureV2InternalDraft(f.tab,req('123')),/read failed/);confirmV2BrowserRecovery(f.tab,proof(f.tab));
 await assert.rejects(captureV2InternalDraft(f.tab,req('123')),/read failed/);assert.throws(()=>confirmV2BrowserRecovery(f.tab,proof(f.tab)),/One fresh/);
});
test('explicit isolated rebind permits read-only same-ID retry while old late operation stays retired',async()=>{
 const pending=deferred(),old=fixture({axPending:pending}),fresh=fixture();await assert.rejects(captureV2InternalDraft(old.tab,req('123'),{stepTimeoutMs:10,cardTimeoutMs:100}),/deadline/);
 assert.throws(()=>rebindV2BrowserRecovery(old.tab,fresh.tab,{...proof(old.tab),oldTabIsolated:false,observedUrl:req('123').url}),/isolated/);
 rebindV2BrowserRecovery(old.tab,fresh.tab,{...proof(old.tab),oldTabIsolated:true,observedUrl:req('123').url});assert.equal(inspectV2BrowserAttempt(old.tab).retired,true);
 assert.equal((await captureV2InternalDraft(fresh.tab,req('123'))).observation.draftId,'123');await assert.rejects(captureV2InternalDraft(old.tab,req('123')),/reconciled/);pending.resolve('late');await pause(1);assert.equal(inspectV2BrowserAttempt(old.tab).retired,true);
});
test('whole-card deadline also bounds a sequence whose individual steps settle',async()=>{
 const f=fixture(),original=f.tab.url;f.tab.url=async()=>{await pause(12);return original();};const originalAX=f.tab.getAXState;f.tab.getAXState=async()=>{await pause(12);return originalAX();};
 await assert.rejects(captureV2InternalDraft(f.tab,req('123'),{stepTimeoutMs:30,cardTimeoutMs:18}),/deadline/);assert.equal(f.events.includes('dom'),false);await pause(15);
});
test('bounded batch defaults to one and finalizes immediately before next card',async()=>{
 const events=[],f=fixture({events}),options={checkpoint:async r=>{events.push('checkpoint:'+r.status+':'+r.draftId);},retain:async(_r,q)=>events.push('retain:'+q.draftId),finalize:async(_r,q)=>{events.push('finalize:'+q.draftId);return true;}};
 const first=await captureV2InternalDraftBatch(f.tab,[req('123'),req('456'),req('789')],options);assert.equal(first.results.length,1);assert.equal(first.remainingRequests.length,2);
 events.length=0;const all=await captureV2InternalDraftBatch(f.tab,[req('123'),req('456'),req('789')],{...options,maxCards:3});assert.equal(all.results.length,3);assert.ok(events.indexOf('finalize:123')<events.indexOf('goto:456'));assert.ok(events.indexOf('finalize:456')<events.indexOf('goto:789'));
 assert.equal(all.results[0].trace.some(x=>x.step==='browser-evidence-finalize'),false,'local finalization is not labeled browser trace');assert.ok(all.results[0].localTrace.some(x=>x.step==='browser-evidence-finalize'));
});
test('started checkpoint precedes native call; failed checkpoint prevents that call',async()=>{
 const f=fixture();await assert.rejects(captureV2InternalDraftBatch(f.tab,[req('123')],{checkpoint:async()=>{throw Error('disk unavailable');},retain:async()=>{},finalize:async()=>true}),/disk unavailable/);assert.deepEqual(f.events,[]);
});
test('unsettled finalization is bounded and fences the next card and late result',async()=>{
 const f=fixture(),pending=deferred();let finalized=0;await assert.rejects(captureV2InternalDraftBatch(f.tab,[req('123'),req('456')],{maxCards:3,budgetMs:60,stepTimeoutMs:12,cardTimeoutMs:55,checkpoint:async()=>{},retain:async()=>{},finalize:async()=>{finalized++;return pending.promise;}}),/deadline/);assert.equal(finalized,1);assert.equal(f.events.includes('goto:456'),false);assert.equal(inspectV2BrowserAttempt(f.tab).unknownInFlight,true);pending.resolve(true);await pause(1);assert.equal(inspectV2BrowserAttempt(f.tab).needsRecovery,true);
});
test('batch count and wall deadline limits fail before any native action',async()=>{
 const f=fixture(),o={checkpoint:async()=>{},retain:async()=>{},finalize:async()=>true};await assert.rejects(captureV2InternalDraftBatch(f.tab,[req('1'),req('2'),req('3'),req('4')],o),/One to three/);await assert.rejects(captureV2InternalDraftBatch(f.tab,[req('1')],{...o,budgetMs:45001}),/Bounded45/);await assert.rejects(captureV2InternalDraftBatch(f.tab,[req('1')],{}),/Durable checkpoint/);assert.deepEqual(f.events,[]);
});
test('nonfinite external deadline cannot disable step or card bounds',async()=>{for(const deadline of [NaN,Infinity,-Infinity]){const f=fixture();await assert.rejects(captureV2InternalDraft(f.tab,req('123'),{deadline}),/Finite browser deadline/);assert.deepEqual(f.events,[]);}});
test('synchronous event-loop stall cannot accept late success before its overdue timer fires',async()=>{const f=fixture(),retained=[];f.tab.url=async()=>{const until=performance.now()+15;while(performance.now()<until){}return req('123').url;};await assert.rejects(captureV2InternalDraft(f.tab,req('123'),{stepTimeoutMs:2,cardTimeoutMs:1000,retain:async r=>retained.push(r)}),/settled after its deadline/);assert.equal(retained.length,0);assert.equal(f.events.includes('ax'),false);assert.equal(inspectV2BrowserAttempt(f.tab).needsRecovery,true);assert.equal(inspectV2BrowserAttempt(f.tab).unknownInFlight,false,'late operation settled but still requires explicit recovery');});
test('wall-clock expiry also rejects a fulfilled result when the timer queue has not run',async()=>{const f=fixture(),realNow=Date.now;let offset=0;Date.now=()=>realNow()+offset;f.tab.url=async()=>{offset=1000;return req('123').url;};try{await assert.rejects(captureV2InternalDraft(f.tab,req('123'),{stepTimeoutMs:100,cardTimeoutMs:500}),/settled after its deadline/);assert.equal(f.events.includes('ax'),false);}finally{Date.now=realNow;}});
