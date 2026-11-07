import test from 'node:test';import assert from 'node:assert/strict';
import {correctV2InternalDraft,applyV2ObservedCommonGroups} from '../lib/card-processing-v2-internal-completion.mjs';
const request={draftId:'5291694246821',url:'https://www.ebay.com/lstng?draftId=5291694246821&mode=AddItem',sku:'V2-ec695987836ab6b6abfffdc8',observedAt:new Date().toISOString(),defects:[{field:'location',expected:'75167',observed:'United States',evidence:{path:'artifacts/actual-observation.json',sha256:'a'.repeat(64)}}],expandFeatures:false};
// UI labels and location summary are retained from the actual Wiggins repair.
function fixture({settles=true,wrongSku=false,priceChanged=false,saveFails=false}={}){
 let page=request.url,phase='editor',zip='',city='',dialogReads=0,done=false,saved=0,inputs=0;const actions=[];
 const protectedFields=()=>[{name:'customLabel',value:wrongSku?'foreign':request.sku},{name:'quantity',value:'1'},{name:'price',value:priceChanged&&done?'9.99':''},{name:'shippingPolicyId',value:''}];
 const ax=()=>phase==='dialog'?`1 AXWebArea eBay\n2 container Your settings, ID: dialog-sidepane\n7 button Done\n13 text field (settable) ZIP Code${zip?', Value: '+zip:''}, ID: zip\n15 text field (settable) City, State${city?', Value: '+city:''}, ID: city\n19 combo box (collapsed) Return policy`:
  '1 AXWebArea eBay\n2 button Your settings - edit\n3 button Save for later\n'+(done?'4 text Item location 75167 (Waxahachie, Texas, United States) Return policy : No Return Accepted (248164940010)':'4 text Item location United States')+'\n'+('Actual native saved fields '.repeat(7));
 const tab={url:async()=>page,goto:async value=>{actions.push('goto');page=value;phase='editor';},getAXState:async()=>{if(phase==='dialog'&&zip){dialogReads++;if(settles&&dialogReads>=2)city='Waxahachie, Texas';}return ax();},
  click:async index=>{actions.push(['click',index]);if(index===2)phase='dialog';else if(index===7){phase='editor';done=true;}else if(index===3){saved++;if(saveFails)throw Error('save outcome unavailable');page='https://www.ebay.com/sh/lst/drafts';}},
  pressKey:async(_index,key)=>{actions.push(['key',key]);},typeText:async(index,text)=>{assert.equal(index,13);inputs++;zip=text;},
  playwright:{locator:()=>({first:()=>({waitFor:async()=>{}})}),evaluate:async source=>source.includes('collectV2CorrectionGuard')?{url:page,fields:protectedFields()}:{url:page,observedAt:new Date().toISOString(),dom:{fields:[{name:'customLabel',value:request.sku}],category:[],photos:[]}}}};
 return {tab,actions,status:()=>({saved,inputs,done})};
}
test('actual location mismatch uses native ZIP lookup, confirms summary, saves once and reads same ID once',async()=>{
 const f=fixture(),retained=[];const r=await correctV2InternalDraft(f.tab,request,{retain:async x=>retained.push(x)});assert.equal(f.status().saved,1);assert.equal(f.status().inputs,1);assert.equal(r.savedOnce,true);assert.equal(r.verificationPerformed,false);assert.equal(r.archivePerformed,false);assert.equal(retained.length,1);assert.equal(r.readback.observation.draftId,request.draftId);assert.equal(r.priceWrites,false);assert.equal(f.actions.filter(x=>x==='goto').length,1,'only same-ID reopen after save');
});
test('unsettled ZIP lookup stops before Done or Save, retains exact failure without retry',async()=>{
 const f=fixture({settles:false}),fail=[];await assert.rejects(correctV2InternalDraft(f.tab,request,{retainFailure:async x=>fail.push(x)}),/ZIP lookup/);assert.deepEqual(f.status(),{saved:0,inputs:1,done:false});assert.equal(fail[0].saveAttempted,false);
});
test('foreign current SKU refuses all correction actions',async()=>{
 const f=fixture({wrongSku:true});await assert.rejects(correctV2InternalDraft(f.tab,request),/ownership/);assert.deepEqual(f.actions,[]);assert.equal(f.status().saved,0);
});
test('price or shipping drift prevents saving',async()=>{
 const f=fixture({priceChanged:true});await assert.rejects(correctV2InternalDraft(f.tab,request),/Protected draft/);assert.equal(f.status().saved,0);
});
test('ambiguous save outcome is retained as attempted; never automatically repeated',async()=>{
 const f=fixture({saveFails:true}),fail=[];await assert.rejects(correctV2InternalDraft(f.tab,request,{retainFailure:async x=>fail.push(x)}),/unavailable/);assert.equal(f.status().saved,1);assert.equal(fail[0].saveAttempted,true);assert.equal(fail[0].trace.at(-1).status,'failed');
});
test('missing evidence, stale observation, unsupported repairs and foreign URL fail before actions',async()=>{
 for(const change of [{observedAt:new Date(Date.now()-3600001).toISOString()},{url:'https://example.com/lstng?draftId='+request.draftId},{defects:[{...request.defects[0],field:'title'}]},{defects:[{field:'location',expected:'75167'}]}]){const f=fixture();await assert.rejects(correctV2InternalDraft(f.tab,{...request,...change}));assert.deepEqual(f.actions,[]);}
});
test('each observed compatible bulk group executes once and duplicate groups fail closed',async()=>{
 const batch={field:'location',expected:'75167',targets:[{draftId:request.draftId,sku:request.sku,evidence:request.defects[0].evidence}]},seen=[];
 const r=await applyV2ObservedCommonGroups([batch],async b=>{seen.push(b);return{actual:'retained-by-caller'};});assert.equal(r.groupsApplied,1);assert.equal(seen.length,1);assert.equal(r.verificationPerformed,false);
 let attempted=0;await assert.rejects(applyV2ObservedCommonGroups([batch,batch],async()=>{attempted++;}),/Unique exact/);assert.equal(attempted,0,'all group validation precedes external actions');
});
