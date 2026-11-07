import { CONDITION_DEFAULT_POLICY } from "./card-condition-default.ts";
import { randomUUID } from 'node:crypto';
import { existingReceipt, fingerprint, reviewedIdentity, matchKey, hasCompleteIdentity, type QueueState } from './card-orchestrator.ts';
import { requireDraftWriter, draftBinding, observeDraft } from './card-draft-lifecycle.ts';
import { PRICING_SOURCE_FIRST } from './pricing-source-policy.ts';
import { BATCH_REVIEW_POLICY } from './card-batch-audit.ts';
import { z } from 'zod';

export const bulkCheckpointSchema=z.object({
 observationId:z.string().uuid(),
 phase:z.enum(['upload-started','generation-started','stalled','recovery-started','recovery-failed']),
 observedAt:z.iso.datetime(),evidence:z.string().min(10),reason:z.string().min(10),retrospective:z.literal(true).optional(),
}).strict();
export type BulkCheckpoint=z.infer<typeof bulkCheckpointSchema> & {evidenceHash:string;recordedAt:string};

export type BulkAiSubmission={id:string;cardIds:string[];startedAt:string;evidence:string;
  originals:Record<string,string>;results:Record<string,{draftId:string;evidence:string;observedAt:string}>;
  checkpoints?:BulkCheckpoint[]};
const originalKey=(s:QueueState,id:string)=>fingerprint(s.cards[id].input.photos.map(p=>[p.side,p.sha256.toLowerCase()]));
/** Scoped initial generation only. Existing card queue remains the sole inventory and receipt owner. */
export function beginBulkAi(s:QueueState,ids:string[],owner:string,token:string,evidence:string,now=new Date().toISOString()){
 if(!ids.length||ids.length>50||new Set(ids).size!==ids.length||evidence.trim().length<20)throw Error('Select 1–50 distinct captures with reviewed pairing/access evidence');
 for(const id of ids){
  const w=requireDraftWriter(s,owner,token,id,now),c=s.cards[id];
  if(!c||w.creationAuthority?.bindings[id]!==draftBinding(c))throw Error('Exact capture creation authority required');
  if(c.input.sourceHold||existingReceipt(c)||c.draftLifecycle?.draftId)throw Error('Hold or existing receipt: resume existing work');
  if(c.jobs.photos.state!=='done')throw Error('Original photo verification required');
  if(Object.values(s.bulkAiSubmissions??{}).some(x=>x.cardIds.includes(id)))throw Error('Prior upload intent exists: reconcile it, never resubmit');
 }
 // Native bulk AI creates one draft per pair. Reviewed matching copies must be routed to quantity grouping first.
 const reviewedKey=(id:string)=>{const i=reviewedIdentity(s.cards[id]);return i&&hasCompleteIdentity(i)&&i.language?fingerprint([matchKey(i,true),i.language,i.condition,i.autograph,i.patch,i.artwork??'']):null;};
 const keys=ids.map(id=>reviewedKey(id)).filter((k):k is string=>!!k);
 if(new Set(keys).size!==keys.length)throw Error('Matching reviewed copies require one quantity draft per exact variant; do not upload separate pairs as duplicate drafts');
 for(const id of ids){const key=reviewedKey(id);if(key&&s.cards[id].pricingDeferral?.reason!=='seller-request'&&Object.keys(s.cards).some(other=>other!==id&&reviewedKey(other)===key&&(existingReceipt(s.cards[other])||s.cards[other].draftLifecycle?.draftId)))throw Error('Matching reviewed existing listing/draft found; reconcile and increase its quantity, never create another draft');}
 const submission:BulkAiSubmission={id:randomUUID(),cardIds:ids,startedAt:now,evidence,originals:Object.fromEntries(ids.map(id=>[id,originalKey(s,id)])),results:{}};
 (s.bulkAiSubmissions??={})[submission.id]=submission;
 s.events.push({at:now,cardId:'*',kind:'draft',event:'bulk-ai-intent',detail:submission.id});
 return {...submission,uploadOrder:ids.flatMap(id=>['front','back'].map(side=>({cardId:id,sku:s.cards[id].input.sku,...s.cards[id].input.photos.find(p=>p.side===side)!}))),conditionPolicy:CONDITION_DEFAULT_POLICY,processControls:BULK_PROCESS_CONTROLS,canPublish:false};
}

export const BULK_PROCESS_CONTROLS={
 priorLearning:['docs/bulk-ai-cactus-11-results-2026-10-25.md','docs/next-batch-controls-2026-10-25.md','docs/bowman-rcca-2026-10-28.md'],
 grouping:'Before upload, group reviewed identical variants and reconcile against existing live listings and drafts. Native one-pair-per-draft generation rejects known matching copies. Unknown AI identities still require grouping review before any publication.',
 correctionPilot:'Apply shared fields first. Native-click, select all, type, then Tab/Enter. Save and reopen one actual draft and compare SKU/title/number/parallel/price/shipping before repeating edits across the batch. DOM fill or paste appearance is not a committed result.',
 timing:'Record actual upload/generation/checkpoint timestamps for this submission; never reconstruct missing timestamps or treat elapsed wall time as operator effort.',
 recovery:'Capture the current workspace and observed IDs before one focused recovery. A failed recovery holds only unresolved captures; preserve successful IDs and continue independent cards. No resubmission, guessed IDs or stock increments.',
 canPublish:false,canResubmit:false,
} as const;

/** Evidence-backed incident history, not a browser retry or an absence certificate. */
export function checkpointBulkAi(s:QueueState,id:string,raw:unknown,evidenceHash:string,owner:string,token:string,now=new Date().toISOString()){
 const b=s.bulkAiSubmissions?.[id];if(!b)throw Error('Unknown bulk intent');
 for(const cardId of b.cardIds)requireDraftWriter(s,owner,token,cardId,now);
 const p=bulkCheckpointSchema.parse(raw);
 if(!/^[a-f0-9]{64}$/i.test(evidenceHash)||Date.parse(p.observedAt)<Date.parse(b.startedAt)||Date.parse(p.observedAt)>Date.parse(now))throw Error('Retained evidence hash and actual submission-bounded timestamp required');
 const previous=b.checkpoints??[],same=previous.find(x=>x.observationId===p.observationId);
 if(same){if(fingerprint({...p,evidenceHash})!==fingerprint({...same,recordedAt:undefined}))throw Error('Observation ID already bound to different evidence');return bulkAiStatus(s,id);}
 if(Object.keys(b.results).length===b.cardIds.length)throw Error('All draft IDs are mapped; no generation recovery needed');
 const last=previous.at(-1);
 if(last&&Date.parse(p.observedAt)<Date.parse(last.observedAt))throw Error('Checkpoint timestamps cannot move backwards');
 const allowed:Record<string,string[]>={initial:['upload-started','generation-started','stalled'],'upload-started':['generation-started','stalled'],'generation-started':['stalled'],stalled:['recovery-started'],'recovery-started':['recovery-failed'],'recovery-failed':[]};
 const retainedFailure=p.retrospective&&p.phase==='recovery-failed'&&(!last||last.phase==='stalled');
 if(p.retrospective&&!retainedFailure)throw Error('Retrospective evidence may only record an already failed recovery; never reconstruct start times');
 if(!retainedFailure&&!allowed[last?.phase??'initial'].includes(p.phase))throw Error('Unsupported recovery transition; retain the hold and reconcile existing IDs');
 if(b.cardIds.some(cardId=>b.originals[cardId]!==originalKey(s,cardId)))throw Error('Original capture binding changed');
 (b.checkpoints??=[]).push({...p,evidenceHash,recordedAt:now});
 s.events.push({at:now,cardId:'*',kind:'draft',event:'bulk-ai-checkpoint',detail:JSON.stringify({submission:id,observationId:p.observationId,phase:p.phase,evidence:p.evidence})});
 return bulkAiStatus(s,id);
}
/** Mapping must come from inspecting each generated pair, never row order alone. */
export function observeBulkAi(s:QueueState,submissionId:string,rows:{cardId:string;draftId:string;url:string;photosMatched:boolean;evidence:string}[],owner:string,token:string,now=new Date().toISOString()){
 const b=s.bulkAiSubmissions?.[submissionId];if(!b||!rows.length)throw Error('Existing upload intent and observed rows required');
 const seen=new Set<string>();
 for(const r of rows){
  requireDraftWriter(s,owner,token,r.cardId,now);
  if(!b.cardIds.includes(r.cardId)||b.originals[r.cardId]!==originalKey(s,r.cardId)||!r.photosMatched||!/^\d+$/.test(r.draftId)||r.evidence.trim().length<20)throw Error('Verified exact original-to-draft mapping required');
  if(seen.has(r.cardId)||Object.entries(b.results).some(([id,v])=>id!==r.cardId&&v.draftId===r.draftId)||rows.some(o=>o!==r&&o.draftId===r.draftId))throw Error('Duplicate draft mapping');
  if(b.results[r.cardId]&&b.results[r.cardId].draftId!==r.draftId)throw Error('Previously observed ID must be retained');
  seen.add(r.cardId);
 }
 for(const r of rows){
  const c=s.cards[r.cardId];
  observeDraft(s,{observationId:randomUUID(),seller:s.seller,cardId:r.cardId,sku:c.input.sku,binding:draftBinding(c),draftId:r.draftId,url:r.url,state:'saved',observedAt:now,evidence:r.evidence},now);
  b.results[r.cardId]={draftId:r.draftId,evidence:r.evidence,observedAt:now};
 }
 return bulkAiStatus(s,submissionId);
}
export function bulkAiStatus(s:QueueState,id:string){
 const b=s.bulkAiSubmissions?.[id];if(!b)throw Error('Unknown bulk intent');
 const originalUnresolved=b.cardIds.filter(id=>!b.results[id]);
 const recovered=originalUnresolved.filter(cid=>Object.values(s.draftGroupRecoveries??{}).some(g=>g.packet.submissionId===id&&g.completedAt&&g.packet.members.includes(cid)&&g.draftId===s.cards[cid]?.input.knownDraft));
 const unresolved=originalUnresolved.filter(cid=>!recovered.includes(cid)),phase=b.checkpoints?.at(-1)?.phase;
 const state=!unresolved.length?'mapped':phase==='recovery-failed'?'held':phase==='recovery-started'?'recovery-in-progress':phase==='stalled'?'reconcile-stall':'awaiting-observation';
 return {submission:b,confirmedDrafts:Object.keys(b.results).length,unresolved,originalUnresolved,recoveredViaGroups:recovered,
  recovery:{state,canResubmit:false,maxFocusedRecoveries:1,action:state==='held'?'Keep unresolved captures held. Inspect existing saved IDs if new evidence arrives; do not resubmit. Continue independent cards.':state==='reconcile-stall'?'Preserve workspace, observed IDs and photos; reconcile Seller Hub before one focused recovery.':state==='mapped'?'Resume and verify mapped IDs; generation mapping is not saved-field readiness.':'Observe the existing operation; no new upload intent.'},
  processControls:BULK_PROCESS_CONTROLS,
  readyToPublish:0,conditionPolicy:CONDITION_DEFAULT_POLICY,canPublish:false,pricing:PRICING_SOURCE_FIRST,reviewPolicy:BATCH_REVIEW_POLICY,
  next:'Review every critical identity field through normal claim/complete, retain acceptable eBay titles, validate shipping/offers/price and save/reopen existing IDs. Saved draft existence is not publication readiness.'};
}

