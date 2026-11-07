import test from 'node:test';
import assert from 'node:assert/strict';
import {captureV2InternalDraft} from '../lib/card-processing-v2-internal-readback.mjs';

const request={draftId:'5290761669820',url:'https://www.ebay.com/lstng?draftId=5290761669820&mode=AddItem',acquisitionMode:'single-expanded-native-AX'};
function fixture({expanded='false',wrongId=false,failAX=false,notReady=false}={}){
 const calls=[],ax='Actual complete native AX with selected Features and saved fields '.repeat(4);
 const field={getAttribute:async()=>expanded,click:async()=>{calls.push('expand');}};
 const tab={url:async()=> 'https://www.ebay.com/sh/lst/drafts',goto:async url=>calls.push(['goto',url]),getAXState:async options=>{calls.push(['ax',options]);if(failAX)throw Error('Actual UI unavailable');return ax;},playwright:{locator:selector=>{if(selector==='button[name="attributes.Features"]')return field;assert.ok(['input[name="title"]','input[name="customLabel"]','button[name^="attributes."], input[name^="attributes."]'].includes(selector));return{first:()=>({waitFor:async options=>{calls.push(['ready',selector,options]);if(notReady&&selector.includes('attributes'))throw Error('Specifics still loading');}})};},evaluate:async()=>{calls.push('dom');return{url:wrongId?'https://www.ebay.com/lstng?draftId=999':request.url,observedAt:new Date().toISOString(),dom:{fields:[{name:'title',value:'ACTUAL TITLE'}],category:[],photos:[]}};}}};
 return{tab,calls,ax};
}
test('one full native tree supplies both saved fields and expanded feature evidence; no save action',async()=>{
 const f=fixture(),retained=[];const r=await captureV2InternalDraft(f.tab,request,{retain:async result=>retained.push(result)});
 assert.equal(f.calls.filter(c=>Array.isArray(c)&&c[0]==='ax').length,1);
 assert.equal(r.observation.ax,f.ax);assert.equal(r.observation.features.ax,f.ax);
 assert.equal(r.observation.dom.fields[0].value,'ACTUAL TITLE');assert.equal(r.verificationPerformed,false);
 assert.equal(r.savedFieldWrites,0);assert.equal(retained.length,1);assert.ok(r.trace.every(t=>t.status==='completed'));
});
test('already-expanded actual Features is not toggled closed',async()=>{
 const f=fixture({expanded:'true'});await captureV2InternalDraft(f.tab,request);assert.ok(!f.calls.includes('expand'));
});
test('payload without Features needs no menu interaction and still retains one full actual tree',async()=>{
 const f=fixture();await captureV2InternalDraft(f.tab,{...request,expandFeatures:false});assert.ok(!f.calls.includes('expand'));assert.equal(f.calls.filter(c=>Array.isArray(c)&&c[0]==='ax').length,1);
});
test('default keeps proven required-Features path after mixed experimental live timings',async()=>{
 const f=fixture();const {acquisitionMode,...normal}=request;const r=await captureV2InternalDraft(f.tab,normal);assert.equal(r.readbackMode,'adaptive');assert.equal(f.calls.filter(c=>Array.isArray(c)&&c[0]==='ax').length,2);
});
test('foreign origin or conflicting requested ID fails before any browser action',async()=>{
 const f=fixture();await assert.rejects(captureV2InternalDraft(f.tab,{...request,url:'https://example.com/lstng?draftId=5290761669820'}));
 await assert.rejects(captureV2InternalDraft(f.tab,{...request,draftId:'999'}));assert.deepEqual(f.calls,[]);
});
test('redirected draft cannot become same-ID observation or verification',async()=>{
 const f=fixture({wrongId:true});await assert.rejects(captureV2InternalDraft(f.tab,request),/same-ID/);
});
test('interrupted read retains failed step without retry, save or completion',async()=>{
 const f=fixture({failAX:true}),failures=[];await assert.rejects(captureV2InternalDraft(f.tab,request,{retainFailure:async value=>failures.push(value)}),/unavailable/);
 assert.equal(f.calls.filter(c=>Array.isArray(c)&&c[0]==='ax').length,1);assert.ok(!f.calls.includes('dom'));assert.equal(failures.length,1);assert.equal(failures[0].trace.at(-1).status,'failed');
});
test('missing Features control persists a failed observation instead of guessing its state',async()=>{
 const f=fixture({expanded:null}),failures=[];await assert.rejects(captureV2InternalDraft(f.tab,request,{retainFailure:async value=>failures.push(value)}),/control missing/);assert.equal(failures[0].trace.at(-1).status,'failed');assert.ok(!f.calls.includes('expand'));
});

test('asynchronous specifics must be visible before native capture; incomplete load is not a saved-field defect',async()=>{
 const f=fixture({notReady:true}),retained=[],failures=[];
 await assert.rejects(captureV2InternalDraft(f.tab,{...request,expandFeatures:false},{retain:async r=>retained.push(r),retainFailure:async r=>failures.push(r)}),/still loading/);
 assert.equal(retained.length,0);assert.equal(f.calls.filter(c=>Array.isArray(c)&&c[0]==='ax').length,0);
 assert.equal(failures[0].trace.at(-1).step,'browser-editor-ready');assert.equal(failures[0].trace.at(-1).status,'failed');
});

test('ready controls are awaited within existing deadline without fixed sleeps or expected-value writes',async()=>{
 const f=fixture();await captureV2InternalDraft(f.tab,request);const ready=f.calls.filter(c=>Array.isArray(c)&&c[0]==='ready');
 assert.equal(ready.length,3);assert.ok(ready.every(c=>c[2].state==='visible'&&c[2].timeoutMs>0&&c[2].timeoutMs<=12000));
 assert.ok(f.calls.findIndex(c=>Array.isArray(c)&&c[0]==='ready')<f.calls.findIndex(c=>Array.isArray(c)&&c[0]==='ax'));
});
