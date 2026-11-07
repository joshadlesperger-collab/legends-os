import {beginV2BrowserAttempt,V2BrowserAttemptError} from './card-processing-v2-browser-watchdog.mjs';
export {inspectV2BrowserAttempt,confirmV2BrowserRecovery,rebindV2BrowserRecovery,V2BrowserAttemptError} from './card-processing-v2-browser-watchdog.mjs';
/** Run only inside the supported ChatGPT internal-browser session. The caller
 * supplies its existing tab. No browser launch, private endpoints or save action. */
export function collectV2InternalEditorFields() {
  const url=new URL(location.href);
  if(url.origin!=='https://www.ebay.com'||!['draftId','draft_id'].some(k=>/^\d+$/.test(url.searchParams.get(k)||'')))throw Error('Actual exact eBay draft editor required');
  const permitted=new Set(['title','customLabel','quantity','condition','40001','description','paymentPolicyId','returnPolicyId','shippingPolicyId','scheduleListingSelection']);
  const fields=Array.from(document.querySelectorAll('input,textarea,select')).filter(e=>permitted.has(e.name)||e.name.startsWith('attributes.')).filter(e=>e.type!=='password'&&e.type!=='hidden').map(e=>({tag:e.tagName,name:e.name,id:e.id,type:e.type,value:e.value,...(['checkbox','radio'].includes(e.type)?{checked:e.checked}:{})}));
  const category=Array.from(document.querySelectorAll('a,button,span')).filter(e=>e.innerText?.trim()==='Trading Card Singles').map(e=>({id:e.id,text:e.innerText.trim()}));
  // Retain actual visible category routes; never construct a category ID from
  // the requested payload or retain unrelated hidden application data.
  for(const e of document.querySelectorAll('a[href]')){const box=e.getBoundingClientRect();if(!box.width||!box.height||!e.innerText?.trim())continue;try{const u=new URL(e.href);if(u.origin==='https://www.ebay.com'&&/^\/b\/[^/]+\/\d+(?:\/|$)/.test(u.pathname))category.push({id:e.id,text:e.innerText.trim(),href:u.href});}catch{}}
  for(const e of document.querySelectorAll('select[name="categoryId"],select[name="primaryCategoryId"]')){const box=e.getBoundingClientRect();if(box.width&&box.height&&/^\d+$/.test(e.value)&&e.selectedOptions?.length===1)category.push({id:e.id,text:e.selectedOptions[0].textContent.trim(),categoryId:e.value,source:'visible-category-select'});}
  const photos=Array.from(document.querySelectorAll('[style]')).flatMap(e=>{const box=e.getBoundingClientRect(),background=getComputedStyle(e).backgroundImage;return box.width>0&&box.height>0&&background.includes('i.ebayimg.com')?[{background}]:[];});
  return{url:location.href,observedAt:new Date().toISOString(),dom:{fields,category,photos}};
}

function draftId(url){const u=new URL(url);if(u.origin!=='https://www.ebay.com'||!['/lstng','/sl/list'].includes(u.pathname))throw Error('Exact eBay editor origin required');const ids=['draftId','draft_id'].flatMap(k=>u.searchParams.getAll(k));if(ids.length!==1||!/^\d+$/.test(ids[0]))throw Error('One exact observed DraftID required');return ids[0];}

/** The Features value button's name was observed on the real editor. Default
 * adaptive capture keeps the proven required-Features path; it skips an unused
 * menu and second tree only when the frozen payload has no Features aspect.
 * The single-expanded-tree experiment remains explicitly opt-in. Never
 * synthesize AX text from expected payloads or replace missing observations. */
export async function captureV2InternalDraft(tab,request,options={}){
  if(!request||!/^\d+$/.test(request.draftId)||draftId(request.url)!==request.draftId)throw Error('Exact observed draft request required');
  if(request.expandFeatures!==undefined&&typeof request.expandFeatures!=='boolean')throw Error('Explicit Features evidence requirement must be boolean');
  if(request.acquisitionMode!==undefined&&!['adaptive','single-expanded-native-AX'].includes(request.acquisitionMode))throw Error('Unsupported readback mode');
  const trace=[],localTrace=[],attempt=beginV2BrowserAttempt(tab,request.draftId,options);
  const measure=async(step,operation,target=trace)=>{
    const startedAt=new Date().toISOString(),start=performance.now();
    try{
      if(options.checkpoint){const ref=await attempt.run('checkpoint:'+step,()=>options.checkpoint({status:'started',attemptId:attempt.attemptId,draftId:request.draftId,step,startedAt,readOnly:true}));attempt.checkpoint(ref);}
      const value=await attempt.run(step,()=>options.measure?options.measure(step,operation):operation());target.push({step,startedAt,endedAt:new Date().toISOString(),durationMs:performance.now()-start,status:'completed'});return value;
    }catch(error){target.push({step,startedAt,endedAt:new Date().toISOString(),durationMs:performance.now()-start,status:'failed'});throw error;}
  };
  try{
  const current=await measure('browser-navigation-check',()=>tab.url());
  let same=false;try{same=draftId(current)===request.draftId;}catch{/* Navigate only to the exact retained URL. */}
  if(!same)await measure('browser-navigation',()=>tab.goto(request.url));
  // A loaded title is not proof that asynchronous item specifics have loaded.
  // Wait within the same bounded attempt, before retaining an incomplete tree.
  // These are actual visible controls, never expected payload values.
  await measure('browser-editor-ready',async()=>{
    for(const selector of ['input[name="title"]','input[name="customLabel"]','button[name^="attributes."], input[name^="attributes."]']){
      await tab.playwright.locator(selector).first().waitFor({state:'visible',timeoutMs:Math.max(1,Math.min(12000,attempt.remaining()))});
    }
  });
  // The all-single-tree candidate did not improve the initial paired live
  // sample. Keep the proven pre-expansion read for required Features by default.
  const initialAx=request.expandFeatures!==false&&request.acquisitionMode!=='single-expanded-native-AX'
    ?await measure('browser-ax-read',()=>tab.getAXState({emit:false,disableDiffing:true})):null;
  // A frozen payload without a Features aspect does not need a menu opened.
  // This flag never changes strict validation: missing required Features still
  // fails against the frozen payload at the supported audit/review boundary.
  if(request.expandFeatures!==false){
    const feature=tab.playwright.locator('button[name="attributes.Features"]');
    const expanded=await measure('browser-control-read',async()=>{const value=await feature.getAttribute('aria-expanded');if(!['true','false'].includes(value))throw Error('Actual Features value control missing; no guessed fallback');return value;});
    if(expanded==='false')await measure('browser-feature-expand',()=>feature.click());
  }
  const featureAx=await measure('browser-ax-read',()=>tab.getAXState({emit:false,disableDiffing:true}));
  const ax=initialAx??featureAx;
  const actual=await measure('browser-dom-read',()=>tab.playwright.evaluate('('+collectV2InternalEditorFields.toString()+')()'));
  await measure('browser-observation-check',async()=>{
    if(draftId(actual.url)!==request.draftId||typeof ax!=='string'||ax.length<100)throw Error('Actual same-ID complete observation required');
    const names=new Set();for(const field of actual.dom.fields){if(!field.name)continue;if(names.has(field.name))throw Error('Ambiguous actual named controls; never choose the expected value');names.add(field.name);}
  });
  const observation={kind:'saved-reopened-draft-nonprice-observation',draftId:request.draftId,url:actual.url,observedAt:actual.observedAt,scope:'non-price-fields; pricing left untouched per seller',priceWritePerformed:false,ax,dom:actual.dom,features:{ax:featureAx}};
  const result={observation,trace,localTrace,attemptId:attempt.attemptId,readbackMode:request.acquisitionMode??'adaptive',savedFieldWrites:0,verificationPerformed:false};
  if(options.afterObservation)await options.afterObservation(result,(step,operation)=>measure(step,operation,localTrace));
  if(options.retain)await measure('browser-evidence-retain',()=>options.retain(result));
  return result;
  }catch(error){
    attempt.fail();const failure={status:'failed',attemptId:attempt.attemptId,draftId:request.draftId,trace,localTrace,watchdog:attempt.snapshot(),reason:'Observation interrupted; native cancellation is unconfirmed. No completion or save claimed.'};
    // A started checkpoint already exists before the native step. If the whole
    // deadline expired, do not initiate another callback or late retention.
    const remaining=attempt.remaining();if(remaining>0&&(options.retainFailure||options.checkpoint)){
      let timer;try{await Promise.race([(async()=>{if(options.retainFailure)await options.retainFailure(failure);if(options.checkpoint)await options.checkpoint(failure);})(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Failure checkpoint deadline reached')),Math.min(remaining,5000));})]);}catch{/* Started checkpoint remains interrupted/unknown; recovery requires retained explicit proof. */}finally{clearTimeout(timer);}
    }
    if(error instanceof V2BrowserAttemptError)error.snapshot=attempt.snapshot();throw error;
  }finally{attempt.finish();}
}

/** Bounded internal-browser call: default one card, never more than three, and
 * at most45seconds for the entire call. Each card is retained and finalized
 * immediately before another is touched. No browser retry or save is automatic. */
export async function captureV2InternalDraftBatch(tab,requests,options={}){
 if(!Array.isArray(requests)||!requests.length||requests.length>3||new Set(requests.map(r=>r?.draftId)).size!==requests.length)throw Error('One to three distinct exact draft requests required');
 if(typeof options.checkpoint!=='function'||typeof options.retain!=='function'||typeof options.finalize!=='function')throw Error('Durable checkpoint, retain and immediate finalize callbacks required');
 const budgetMs=options.budgetMs??45000,maxCards=options.maxCards??1;
 if(!Number.isFinite(budgetMs)||budgetMs<=0||budgetMs>45000||!Number.isInteger(maxCards)||maxCards<1||maxCards>3)throw Error('Bounded45second/three-card maximum required');
 const deadline=performance.now()+budgetMs,results=[];
 for(const request of requests.slice(0,maxCards)){
  if(performance.now()>=deadline)break;
  const result=await captureV2InternalDraft(tab,request,{...options,deadline,retain:undefined,afterObservation:async(result,measure)=>{
   await measure('checkpoint-observed',()=>options.checkpoint({status:'observed',draftId:request.draftId,attemptId:result.attemptId,observedAt:result.observation.observedAt}));
   await measure('browser-evidence-retain',()=>options.retain(result,request));
   await measure('browser-evidence-finalize',()=>options.finalize(result,request));
   await measure('checkpoint-finalized',()=>options.checkpoint({status:'finalized',draftId:request.draftId,attemptId:result.attemptId}));
  }});
  results.push(result);
 }
 return{results,remainingRequests:requests.slice(results.length),stopped:results.length<requests.length,deadlineReached:performance.now()>=deadline,automaticRetries:0,canPublish:false};
}
