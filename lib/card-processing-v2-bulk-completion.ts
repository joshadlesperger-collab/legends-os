import { z } from 'zod';
import { assessV2Description, factualV2Description } from './card-processing-v2-description.ts';
import { payloadSchema } from './card-processing-v2.ts';
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const input=z.object({id:hash,groups:z.array(z.object({groupId:z.string().min(1),cardIds:z.array(z.string().min(1)).min(1),payload:payloadSchema}).passthrough()).min(1).max(20)}).passthrough();
/** Operator plan only. Previously observed policy/location values are candidates,
 * never fresh UI authority. This function cannot edit, import or verify a draft. */
export function planV2BulkCompletion(raw:unknown,mode:"new-import"|"existing-draft-repair"="new-import"){
 const job=input.parse(raw),skus=job.groups.map(g=>g.payload.sku),captures=job.groups.flatMap(g=>g.payload.captureIds);
 if(new Set(skus).size!==skus.length||new Set(captures).size!==captures.length)throw Error('Exact unique selected SKU/capture ownership required');
 const conditions=new Map<string,{categoryId:string;conditionId:string;descriptorName:string;descriptorValue:string;label:string;skus:string[]}>();
 for(const {payload:p} of job.groups){const key=JSON.stringify([p.categoryId,p.conditionId,p.conditionDescriptorName,p.conditionDescriptorValue]);let group=conditions.get(key);if(!group){group={categoryId:p.categoryId,conditionId:p.conditionId,descriptorName:p.conditionDescriptorName,descriptorValue:p.conditionDescriptorValue,label:p.condition,skus:[]};conditions.set(key,group);}group.skus.push(p.sku);}
 const repairSequence=[
   'Audit actual saved observations first. Apply common condition only to cards with a proven observed condition defect, grouped once by compatible category/condition; save/reopen only changed IDs.',
   'Correct only observed policy/location defects using freshly confirmed seller choices, grouped once. Preserve already-correct fields, every price and shipping amount/policy.'
 ];
 return {version:1,jobId:job.id,mode,firstSaveCompletion:mode==='new-import'?{required:true,fields:['item location','card condition','return policy','payment policy'],locationPostalCode:'75167',returnsPolicy:{id:'248164940010',label:'No Return Accepted',alternativesAllowed:false},requiresActualNativeValues:true,missingSharedFieldsPermitSave:false,readbackPasses:1}:null,phase:'same-imported-IDs-before-readback',selectedSkus:skus,selectedCaptureIds:captures,
  status:'requires-fresh-internal-browser-observation',auditRequiredBeforeCorrection:true,defaultEditorAction:'none',automaticWritesAllowed:false,complete:false,canPublish:false,
  commonRepairs:{conditionBatches:Array.from(conditions.values()),
   policyCandidates:{paymentId:'248164941010',returnsId:'248164940010',locationPostalCode:'75167',source:'Previously observed seller settings; re-observe current visible UI controls before applying',freshAuthority:false}},
  sequence:[
   'Map the actual returned DraftIDs to this exact selected SKU set. Open only that Complete listings workspace; verify its entire selected set before bulk edits.',
   'Measure and retain a fresh internal-browser observation of current condition and seller policy/location choices. Do not substitute this plan for current visible controls.',
   ...(mode==='existing-draft-repair'?repairSequence:[
    'Before the FIRST Save in this new imported Complete listings workspace, fill observed missing location, category-specific Near mint or better Card Condition, No Return Accepted return policy and the actual seller payment policy once for the exact compatible selection. CSV acceptance and generic Ungraded do not prove these fields.',
    'Wait for native ZIP settlement and actual location75167 summary. Confirm the current selected No Return Accepted policy248164940010 and payment binding; do not substitute a returns-accepted policy. Preserve already-correct fields, prices and shipping.',
    'Save the same imported IDs once after required shared fields are complete, then perform the existing strict saved readback once. Another save requires an actual persisted mismatch; no separate editor-inspection loop.'
   ]),
   'Review item specifics, actual front/back photos and descriptions per copy. Use eBay AI descriptions only when an actual supported editor action exists; fact-check and retain actual generation/review evidence.',
   'Preserve all acceptable titles/specifics/descriptions. Valid saved observations go directly to supported verify-ready/archive without editor writes; incomplete cards remain held. Reopen only changed drafts to verify repairs. Ready for pricing requires actual moved photo receipts.'
  ],deferredUntouched:['item price','shipping amount','shipping policy'],
  timingBoundaries:['fresh-ui-read','bulk-condition-edit-save','bulk-policy-location-edit-save','per-copy-specifics-photos-description','same-ID-save-reopen-readback','photo-archive'],
  persistenceWarning:'The actual12-card upload omitted saved condition, returns and location despite local completeness. CSV acceptance is not saved-field completeness; no guessed policy columns were added.'};
}

import { digest, consolidationKey, type V2State } from './card-processing-v2.ts';
import { observedV2DraftId, observedV2NearMintCondition, observedV2NoReturnsPolicy } from './card-processing-v2-observation-values.ts';
import { assertV2NonpriceObservation, assertV2ObservedCategory, observedV2Autographed, observedV2FeaturesWithSemantic } from './card-processing-v2-nonprice-review.ts';
import {isV2BatchRowObservation,buildV2BatchNonpriceReview} from './card-processing-v2-batch-observation.ts';
const auditRef=z.object({path:z.string().min(1),sha256:hash}).strict();
const observedSchema=z.object({kind:z.literal('saved-reopened-draft-nonprice-observation'),draftId:z.string(),url:z.string().url(),observedAt:z.string().datetime(),scope:z.literal('non-price-fields; pricing left untouched per seller'),priceWritePerformed:z.literal(false),ax:z.string().min(100),dom:z.object({fields:z.array(z.object({name:z.string().optional(),value:z.string().optional(),checked:z.boolean().optional()}).passthrough()),category:z.array(z.object({text:z.string()}).passthrough()),photos:z.array(z.object({background:z.string()}).passthrough())}).passthrough(),features:z.object({ax:z.string()}).passthrough()}).passthrough();
export type V2BulkAuditObservation={cardId:string;evidence:z.infer<typeof auditRef>;observation:unknown};
type Defect={field:string;observed:unknown;expected:unknown;evidence:z.infer<typeof auditRef>;freshUiRequired:boolean};
const equal=(a:unknown,b:unknown)=>digest(a)===digest(b);
const imageResource=(s:string)=>/\/(?:z|images\/g)\/([^/]+)\//.exec(s)?.[1];
/** Read-only first pass. Only actual observed differences are correction targets.
 * Missing/ambiguous/unsafe evidence produces a hold, never a guessed value fill.
 * Passing rows still require the existing strict report/archive operation. */
export function auditV2BulkCompletion(rawJob:unknown,state:V2State,observations:V2BulkAuditObservation[],now=Date.now()){
 const job=input.parse(rawJob),selected=job.groups.flatMap(g=>g.cardIds);
 if(observations.length>20||observations.some(o=>!selected.includes(o.cardId)))throw Error('Audit observations must belong only to the selected browser job');
 const rows=job.groups.flatMap(group=>[group.cardIds.find(id=>state.cards[id]?.sku===group.payload.sku)??group.cardIds[0]].map(cardId=>{
  const card=state.cards[cardId],entries=observations.filter(o=>o.cardId===cardId),holds:string[]=[],defects:Defect[]=[];
  const result={cardId,sku:card?.sku??null,draftId:card?.draftId??null,observedAt:null as string|null,holds,defects,editorWritesAllowed:false,review:null as unknown,route:'hold'};
  const key=typeof group.key==='string'?group.key:undefined,submission=key?state.submissions[key]:undefined;
  if(!card||!card.identity||card.identity.damage||card.identity.graded||!submission||submission.groupId!==group.groupId||!['submitted','verified'].includes(submission.status)||submission.draftId!==card.draftId||!submission.payload.captureIds.includes(card.captureId)||!group.payload.captureIds.includes(card.captureId)||card.issues.length){holds.push('Current exact unheld representative imported ownership is required');return result;}
  if(group.payload.captureIds.length>1){const members=Object.values(state.cards).filter(c=>group.payload.captureIds.includes(c.captureId));if(group.payload.quantity!==members.length||members.length!==group.payload.captureIds.length||new Set(members.map(c=>c.captureId)).size!==members.length||members.some(c=>!c.identity||c.issues.length||c.identity.damage||c.identity.graded||c.draftId!==card.draftId||c.groupId!==group.groupId||c.condition!==card.condition||consolidationKey(c)!==group.groupId)||digest(members.map(c=>c.id).sort())!==digest([...group.cardIds].sort())){holds.push('Exact unheld matching frozen quantity members required');return result;}}
  if(entries.length!==1){holds.push(entries.length?'Ambiguous repeated observation':'Actual observation missing; do not open an editor to rewrite unobserved values');return result;}
  const entry=entries[0];auditRef.parse(entry.evidence);
  if(isV2BatchRowObservation(entry.observation)){
   try{const review=buildV2BatchNonpriceReview(entry.observation,card,group.payload,entry.evidence,now);if(Date.parse(review.observedAt)<Date.parse(submission.at))throw Error('Batch observation predates the exact import');result.observedAt=review.observedAt;result.review=review;result.route='finish-archive-without-editor-writes';}catch(error){holds.push(error instanceof Error?error.message:'Actual saved batch row is incomplete');}
   return result;
  }
  const parsed=observedSchema.safeParse(entry.observation);if(!parsed.success){holds.push('Actual saved/reopened observation is incomplete or unsupported');return result;}const x=parsed.data;
  const age=now-Date.parse(x.observedAt);if(age<0||age>3600000||Date.parse(x.observedAt)<Date.parse(submission.at)||x.draftId!==card.draftId||observedV2DraftId(x.url)!==card.draftId){holds.push('Observation is stale, foreign or not bound to this saved draft');return result;}
  result.observedAt=x.observedAt;
  result.observedAt=x.observedAt;
  const fields=(name:string)=>x.dom.fields.filter(f=>f.name===name),value=(name:string)=>{const found=fields(name);if(found.length!==1||typeof found[0].value!=='string'){holds.push(`Unobserved or ambiguous control: ${name}`);return undefined;}return found[0].value;};
  const defect=(field:string,observed:unknown,expected:unknown,freshUiRequired=false)=>defects.push({field,observed,expected,evidence:entry.evidence,freshUiRequired});
  const sku=value('customLabel'),quantity=value('quantity'),title=value('title');if(sku!==undefined&&sku!==group.payload.sku)holds.push('Observed SKU conflicts with import ownership');if(quantity!==undefined&&quantity!==String(group.payload.quantity))holds.push('Observed quantity differs; quantity edits are prohibited');if(title!==undefined&&title!==group.payload.title){const titleFacts=assessV2Description(title,{...card.identity!,team:''});if(title.trim()&&title.length<=80&&titleFacts.acceptable)holds.push('Factual-equivalent title formatting differs from frozen title; reconcile without a style rewrite');else defect('title',title,group.payload.title);}
  try{assertV2ObservedCategory(x,group.payload.categoryId);}catch{holds.push('Actual category is missing, ambiguous or different; resolve numeric category ownership');}
  const condition=value('condition'),descriptor=value('40001');if(condition!==undefined&&condition!==group.payload.conditionId)defect('condition',condition,group.payload.conditionId,true);if(descriptor!==undefined&&descriptor!=='400010')defect('condition-descriptor',descriptor,'400010',true);if(descriptor==='400010'&&!observedV2NearMintCondition(x.ax))holds.push('Condition control and visible label are inconsistent');
  if(x.dom.photos.length!==2||x.dom.photos.some((p,n)=>!imageResource(p.background)||imageResource(p.background)!==imageResource(group.payload.photos[n].url)))holds.push('Original photo resources/order differ or are unobserved; visual reconciliation required');
  const schedule=fields('scheduleListingSelection');if(schedule.length!==1||schedule[0].checked!==false)holds.push('Scheduling state is missing or enabled');
  const specifics:Record<string,string[]>={},lines=x.ax.split('\n');
  for(const name of Object.keys(group.payload.specifics)){
   const labels=['Features','Autographed'].includes(name)?[]:name==='Event'?['Event','Event/Tournament']:[name],values:string[][]=[];
   for(const label of labels){const controls=fields(`attributes.${label}`);if(controls.length>1){holds.push(`Ambiguous aspect ${name}`);continue;}if(controls.length===1&&typeof controls[0].value==='string'){values.push(controls[0].value?[controls[0].value]:[]);continue;}
    const at=lines.findIndex(l=>l.includes(`button (collapsed) ${label}, ID:`)&&l.includes('item-specific-dropdown-label-'));if(at>=0){const next=lines.slice(at+1).find(l=>/button \(collapsed\)/.test(l));if(next&&!next.includes('item-specific-dropdown-label-')){const found=/button \(collapsed\) (.*), Secondary Actions: Expand/.exec(next)?.[1];if(found!==undefined)values.push(found?[found]:[]);}}
   }
   if(name==='Autographed'){
    const controls=fields('attributes.Autographed'),inline=lines.some(l=>/button \(collapsed\) Autographed, ID:/.test(l)&&l.includes('item-specific-dropdown-label-'));
    if(controls.length>1)holds.push('Ambiguous Autographed controls');
    if(inline){const actual=observedV2Autographed(x.ax);if(actual.length){values.push(actual);if(controls[0]?.value&&!equal(actual,[controls[0].value]))holds.push('Conflicting Autographed observations');}}
    else if(controls.length===1&&typeof controls[0].value==='string')values.push(controls[0].value?[controls[0].value]:[]);
   }
   if(name==='Features'&&!values.length){const actual=observedV2FeaturesWithSemantic(x.features.ax,x.rawSemanticSnapshot);if(actual.observed)values.push(actual.values);}
   if(!values.length){holds.push(`Actual aspect not observed: ${name}`);continue;}if(values.some(v=>!equal(v,values[0]))){holds.push(`Conflicting aspect aliases: ${name}`);continue;}specifics[name]=values[0];if(!equal([...values[0]].sort(),[...group.payload.specifics[name]].sort()))defect(`specifics:${name}`,values[0],group.payload.specifics[name]);
  }
  const description=value('description');if(description!==undefined){const assessed=assessV2Description(description,card.identity!);if(!assessed.acceptable)defect('description',description,{issues:assessed.issues,factualReplacement:factualV2Description(card.identity!,card.condition)});}
  const payment=value('paymentPolicyId');if(payment!==undefined&&!/eBay Managed Payments \(248164941010\)/.test(payment))defect('payment-policy',payment,'248164941010',true);
  if(!observedV2NoReturnsPolicy(x.ax)){const actualReturn=/Return policy[ \t]*:[ \t]*([^\r\n]*)/.exec(x.ax)?.[1];if(/Return policy is not specified/i.test(x.ax)||actualReturn&&/\(\d+\)/.test(actualReturn))defect('return-policy',actualReturn??'Explicit return policy is not specified','248164940010',true);else holds.push('Return policy selection is unobserved');}
  if(!x.ax.includes('(Waxahachie, Texas, United States)')){const actualLocation=/Item location[ \t]+([^\r\n]*)/.exec(x.ax)?.[1];if(/Location missing/i.test(x.ax)||actualLocation&&/\b\d{5}(?:-\d{4})?\b.*\([^)]*\)/.test(actualLocation))defect('location',actualLocation??'Explicit Location missing','75167',true);else holds.push('Actual location is unobserved');}
  const shipping=value('shippingPolicyId');
  if(!holds.length&&!defects.length&&description!==undefined&&shipping!==undefined){
   const review={cardId,captureId:card.captureId,sku:card.sku,draftId:card.draftId!,observedAt:x.observedAt,evidence:entry.evidence,scope:'non-price-fields' as const,checks:Object.fromEntries(['sameId','title','sku','quantity','categoryMatched','specifics','rawCondition','nearMint','exactPhotosInOrder','descriptionReviewed','paymentPresent','returnsPresent','locationPresent','notScheduled'].map(k=>[k,true])),aspectChecks:Object.fromEntries(Object.keys(specifics).map(k=>[k,true])),specifics,description,pricing:{status:'deferred-preserved' as const,owner:'Grok' as const,writesPerformed:false as const,sourceNotInferred:true as const},shipping:{status:'deferred-preserved' as const,observedPolicy:shipping,writesPerformed:false as const},fullUnpricedVerification:false as const,passed:true as const};
   try{assertV2NonpriceObservation(x,review,card,group.payload);result.review=review;result.route='finish-archive-without-editor-writes';}catch(error){const message=error instanceof Error?error.message:'Strict review failed';if(/description/i.test(message))defect('description',description,'Resolve actual factual description defect through supported review');else holds.push(`Strict saved review rejected: ${message}`);}
  }
  if(holds.length)result.route='hold';else if(defects.length)result.route='correct-observed-defects-only';return result;
 }));
 const targets=rows.filter(r=>r.route==='correct-observed-defects-only'),common=new Map<string,{field:string;expected:unknown;freshUiRequired:boolean;targets:Array<{cardId:string;draftId:string;sku:string;evidence:z.infer<typeof auditRef>}>}>();
 for(const row of targets)for(const d of row.defects){const key=JSON.stringify([d.field,d.expected]);let batch=common.get(key);if(!batch){batch={field:d.field,expected:d.expected,freshUiRequired:d.freshUiRequired,targets:[]};common.set(key,batch);}batch.targets.push({cardId:row.cardId,draftId:row.draftId!,sku:row.sku!,evidence:d.evidence});}
 return {version:1,jobId:job.id,readOnly:true,automaticEditorWrites:false,canPublish:false,rows,correctionBatches:Array.from(common.values()),readyForStrictFinish:rows.length>0&&rows.every(r=>r.route==='finish-archive-without-editor-writes'),nextAction:rows.every(r=>r.route==='finish-archive-without-editor-writes')?'Run supported exact-job finish/archive with these actual review fragments; do not save unchanged editors':'Resolve holds by reading actual missing evidence, and correct only proven observed defects. Do not rewrite acceptable values.',unchangedFields:'preserve',priceAndQuantityEditsAllowed:false};
}
