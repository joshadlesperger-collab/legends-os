import {captureV2InternalDraft} from './card-processing-v2-internal-readback.mjs';

const supported=new Set(['condition','condition-descriptor','payment-policy','return-policy','location']);
function exactDraft(url,id){const u=new URL(url);return u.origin==='https://www.ebay.com'&&['/lstng','/sl/list'].includes(u.pathname)&&['draftId','draft_id'].flatMap(k=>u.searchParams.getAll(k)).join()===id;}
function control(ax,pattern){const lines=ax.split('\n').filter(line=>pattern.test(line));if(lines.length!==1)throw Error('One freshly observed correction control required');const index=/^\s*(\d+)\s/.exec(lines[0]);if(!index)throw Error('Native correction control index missing');return Number(index[1]);}
/** Actual visible controls only. No app state, private endpoints or hidden fields. */
export function collectV2CorrectionGuard(){
 const permitted=new Set(['title','customLabel','quantity','price','itemPrice','shippingPolicyId','scheduleListingSelection']);
 return {url:location.href,fields:Array.from(document.querySelectorAll('input,textarea,select')).filter(e=>permitted.has(e.name)&&e.type!=='hidden'&&e.type!=='password').map(e=>({name:e.name,value:e.value,checked:['checkbox','radio'].includes(e.type)?e.checked:undefined}))};
}
/** IAB-only correction executor for a *proven mismatch*. It never scans all editors.
 * Prefer the existing exact bulk workspace and grouped controls where supported;
 * this bounded helper handles changed-row exceptions and the ZIP save failure.
 * Result is actual evidence, never a verification/archive receipt. */
export async function correctV2InternalDraft(tab,request,options={}){
 if(!request||!/^\d+$/.test(request.draftId)||!exactDraft(request.url,request.draftId)||!request.sku||!Array.isArray(request.defects)||!request.defects.length||new Set(request.defects.map(d=>d.field)).size!==request.defects.length||request.defects.some(d=>!supported.has(d.field)||!d.evidence?.path||!/^[a-f0-9]{64}$/.test(d.evidence.sha256)))throw Error('Exact supported persisted mismatch and evidence required');
 const age=Date.now()-Date.parse(request.observedAt);if(!Number.isFinite(age)||age<0||age>3600000)throw Error('Fresh persisted mismatch required');
 const trace=[];let saved=false;
 const measure=async(step,fn)=>{const startedAt=new Date().toISOString(),start=performance.now();try{const value=await fn();trace.push({step,startedAt,endedAt:new Date().toISOString(),durationMs:performance.now()-start,status:'completed'});return value;}catch(e){trace.push({step,startedAt,endedAt:new Date().toISOString(),durationMs:performance.now()-start,status:'failed'});throw e;}};
 const observe=()=>measure('browser-correction-ax-read',()=>tab.getAXState({emit:false,disableDiffing:true}));
 const click=async(pattern)=>{const ax=await observe();await measure('browser-correction-control',()=>tab.click(control(ax,pattern)));};
 const read=()=>measure('browser-correction-guard-read',()=>tab.playwright.evaluate('('+collectV2CorrectionGuard.toString()+')()'));
 const input=async(label,value)=>{const ax=await observe(),index=control(ax,new RegExp('text field[^\\n]*'+label+'(?:,|$)'));await measure('browser-correction-native-input',async()=>{await tab.pressKey(index,'Control_L+a');await tab.typeText(index,value);await tab.pressKey(index,'Tab');});};
 try{
  if(!exactDraft(await tab.url(),request.draftId))await measure('browser-correction-navigation',()=>tab.goto(request.url));
  const before=await read();if(!exactDraft(before.url,request.draftId)||before.fields.filter(f=>f.name==='customLabel'&&f.value===request.sku).length!==1)throw Error('Current exact draft/SKU ownership required');
  let conditionCorrected=false;for(const d of request.defects){
   if(d.field==='condition'||d.field==='condition-descriptor'){
    if(d.field==='condition-descriptor'?d.expected!=='400010':d.expected!=='Near mint or better'&&d.expected!=='4000')throw Error('Unsupported condition correction');
    if(conditionCorrected)continue;conditionCorrected=true;
    let ax=await observe();if(!/Condition type Ungraded:/.test(ax)){await click(/pop up button[^\n]*Condition type /);await click(/Value: Ungraded: Not in original packaging or professionally graded/);}
    await click(/pop up button[^\n]*Card Condition /);await click(/Value: Near mint or better: Comparable to a fresh pack/);
   }else if(d.field==='payment-policy'){
    if(d.expected!=='248164941010')throw Error('Unknown payment choice');await click(/combo box[^\n]*Payment policy/);await click(/Value: eBay Managed Payments \(248164941010\)/);
   }
  }
  if(request.defects.some(d=>['return-policy','location'].includes(d.field))){
   await click(/button Your settings - edit/);
   const location=request.defects.find(d=>d.field==='location');
   if(location){if(location.expected!=='75167')throw Error('Unknown location choice');await input('ZIP Code','75167');
    // eBay resolves city asynchronously. Observe settlement before Done; never
    // type an invented city, save early, or repeat an uncertain save.
    let ax=await observe();if(!/City, State, Value: Waxahachie, Texas,/.test(ax))ax=await observe();
    if(!/ZIP Code, Value: 75167,/.test(ax)||!/City, State, Value: Waxahachie, Texas,/.test(ax))throw Error('ZIP lookup did not settle to the verified seller location');
   }
   const returns=request.defects.find(d=>d.field==='return-policy');if(returns){if(returns.expected!=='248164940010')throw Error('Unknown return choice');await click(/combo box[^\n]*Return policy/);await click(/Value: No Return Accepted \(248164940010\)/);}
   await click(/button Done$/);let ax=await observe();if(/container Your settings, ID: dialog-sidepane/.test(ax))ax=await observe();
   if(/container Your settings, ID: dialog-sidepane/.test(ax))throw Error('Settings dialog did not finish');
   if(location&&!ax.includes('Item location 75167 (Waxahachie, Texas, United States)'))throw Error('Location summary did not persist; no draft save performed');
   if(returns&&!ax.includes('Return policy : No Return Accepted (248164940010)'))throw Error('Return summary did not persist; no draft save performed');
  }
  const after=await read();if(JSON.stringify(before)!==JSON.stringify(after))throw Error('Protected draft identity/price/shipping/quantity changed; do not save');
  saved=true;await click(/button Save for later$/);await observe();
  const readback=await measure('browser-correction-saved-readback',()=>captureV2InternalDraft(tab,{draftId:request.draftId,url:request.url,expandFeatures:request.expandFeatures,acquisitionMode:'adaptive'}));
  const result={draftId:request.draftId,sku:request.sku,correctedFields:request.defects.map(d=>d.field),savedOnce:true,readback,trace,verificationPerformed:false,archivePerformed:false,priceWrites:false,shippingWrites:false,canPublish:false};if(options.retain)await options.retain(result);return result;
 }catch(error){if(options.retainFailure)await options.retainFailure({draftId:request.draftId,trace,saveAttempted:saved,reason:'Correction stopped; inspect same ID before any retry. No verification or archive claimed.'});throw error;}
}

/** Deduplicate common edits before an observed exact-workspace operation.
 * The caller retains actual workspace/selection proof and supplies the observed
 * bulk-control action; this function never guesses a bulk DOM or approves rows. */
export async function applyV2ObservedCommonGroups(batches,applyObservedGroup){
 if(!Array.isArray(batches)||typeof applyObservedGroup!=='function')throw Error('Observed correction groups required');
 const seen=new Set(),results=[];for(const batch of batches){const key=JSON.stringify([batch.field,batch.expected]);if(!supported.has(batch.field)||seen.has(key)||!batch.targets?.length||new Set(batch.targets.map(t=>t.draftId)).size!==batch.targets.length||batch.targets.some(t=>!/^\d+$/.test(t.draftId)||!t.sku||!t.evidence?.path||!/^[a-f0-9]{64}$/.test(t.evidence.sha256)))throw Error('Unique exact observed common group required');seen.add(key);}
 // Validate the entire scope before the first externally visible action.
 for(const batch of batches)results.push(await applyObservedGroup(batch));
 return {groupsApplied:results.length,results,verificationPerformed:false,archivePerformed:false,canPublish:false};
}
