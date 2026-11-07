import { z } from 'zod';
import { V2_BROWSER_DRAFT_INFO } from './card-processing-v2-transport.ts';
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const reference=z.object({path:z.string().min(1).max(500),sha256:hash}).strict();
export const v2FutureBatchPlanSchema=z.object({
 groups:z.array(z.object({key:hash,captureIds:z.array(hash).min(1),draftId:z.string().regex(/^\d+$/).optional(),
  fieldMismatches:z.array(z.string().min(1).max(200)).max(100),
  priceObservation:z.object({value:z.string().max(100),reportedSource:z.enum(['unknown','grok','seller-set']),sourceEvidence:reference.optional()}).strict()
   .refine(p=>p.reportedSource==='unknown'||!!p.sourceEvidence,'An attributed source requires retained provenance evidence').optional(),
 }).strict()).min(1).max(100),pricingDeferred:z.literal(true),
}).strict();
/** Read-only workplan, not a verification/pricing receipt or a browser writer.
 * Observed amounts are never changed or attributed by inference. Evidence refs
 * are reported provenance only; this planner does not establish their truth. */
export function planV2FutureBatch(raw:unknown){
 const input=v2FutureBatchPlanSchema.parse(raw),keys=new Set<string>(),captures=new Set<string>(),drafts=new Set<string>();
 for(const group of input.groups){if(keys.has(group.key)||new Set(group.captureIds).size!==group.captureIds.length||group.captureIds.some(c=>captures.has(c))||group.draftId&&drafts.has(group.draftId))throw Error('Ambiguous group/capture/draft ownership; reconcile before work');keys.add(group.key);group.captureIds.forEach(c=>captures.add(c));if(group.draftId)drafts.add(group.draftId);}
 return {version:1,selectedCaptureIds:Array.from(captures),newFxDraftWritesAllowed:false,browserTemplateFirstLine:V2_BROWSER_DRAFT_INFO,
  automaticWrites:[] as string[],canPublish:false,pricingDeferred:true,pricingGenerationAllowed:false,
  groups:input.groups.map(group=>{
   const observed=group.priceObservation,blank=observed?.value.trim()==='',nonblank=!!observed&&!blank;
   return {key:group.key,captureIds:group.captureIds,draftId:group.draftId??null,
    route:group.draftId?'same-id-nonprice-review':'fresh-four-scope-reconciliation-before-browser-handoff',
    nonPriceReview:group.draftId?'eligible-same-id':'requires-imported-id',
    deferredPriceFields:group.fieldMismatches.filter(field=>/price|pricing|shipping amount|postage/i.test(field)),
    fieldRepairs:group.fieldMismatches.filter(field=>!/price|pricing|shipping amount|postage/i.test(field)).map(field=>({field,action:'repair-and-save-reopen-same-id',allowedToChangePrice:false})),
    price:{observedValue:observed?.value??null,reportedSource:observed?.reportedSource??'unknown',sourceEvidence:observed?.sourceEvidence??null,sourceVerified:false,
     preserveCurrentValue:true,allowedWrites:[] as string[],nextOwner:'Pricing reconciliation',
     disposition:nonblank?'deferred-preserve-nonblank':blank?'deferred-observed-blank':'deferred-observation-missing'},
    fullUnpricedVerification:nonblank?'blocked-nonblank-preserve-and-reconcile':blank?'requires-independent-full-saved-readback':'blocked-price-observation-missing',
    completionReceipt:'separate-nonprice-checkpoint-only-until-full-supported-verification',
    sourceFirst:'Before any future authorized Grok proposal, consume saved active/sold/knowledge evidence and required independent bound reviews. No pricing generation in this deferred run.'};
  })};
}
