import { z } from 'zod';
import { fingerprint, identityReviewIsCurrent, reviewedIdentity, type QueueState } from './card-orchestrator.ts';
import { draftBinding, requireDraftWriter, type DraftLifecycle } from './card-draft-lifecycle.ts';
import { parseSavedDraftAX } from './card-saved-draft-check.ts';
const packetSchema=z.object({id:z.string().min(10),evidence:z.string().min(20),groups:z.array(z.object({keepCardId:z.string(),members:z.array(z.object({cardId:z.string(),draftId:z.string().regex(/^\d+$/)}).strict()).min(2).max(50)}).strict()).min(1).max(20)}).strict();
export type DraftConsolidation={packet:z.infer<typeof packetSchema>;startedAt:string;bindings:Record<string,string>;previous:Record<string,{knownDraft?:string;exclusion?:QueueState['cards'][string]['exclusion'];lifecycle?:DraftLifecycle}>;completedAt?:string;evidence?:string};
function validate(s:QueueState,p:z.infer<typeof packetSchema>,owner:string,token:string,now:string){
 const ids=p.groups.flatMap(g=>g.members.map(m=>m.cardId)),drafts=p.groups.flatMap(g=>g.members.map(m=>m.draftId));
 if(new Set(ids).size!==ids.length||new Set(drafts).size!==drafts.length)throw Error('Duplicate consolidation membership');
 for(const g of p.groups){
  if(!g.members.some(m=>m.cardId===g.keepCardId))throw Error('Retained capture missing');
  const keys=new Set<string>(),fronts=new Set<string>();
  for(const m of g.members){requireDraftWriter(s,owner,token,m.cardId,now);const c=s.cards[m.cardId],i=reviewedIdentity(c);
   if(!i||!identityReviewIsCurrent(c)||i.serial||i.printRun||!i.language||i.autograph===null||c.input.sourceHold||c.input.knownLive||c.exclusion&&c.exclusion.disposition!=='draft'
     ||c.input.knownDraft!==m.draftId||c.draftLifecycle?.draftId!==m.draftId||['sold','scheduled','live'].includes(String(c.jobs.reconcile.result?.disposition)))throw Error('Only current exact saved drafts can consolidate');
   keys.add(fingerprint({...i,colorMatch:undefined}));fronts.add(c.input.photos.find(p=>p.side==='front')!.sha256);
  }
  if(keys.size!==1||fronts.size!==g.members.length)throw Error('Distinct matching unnumbered captures required');
 }
}
export function beginDraftConsolidation(s:QueueState,raw:unknown,owner:string,token:string,now=new Date().toISOString()){
 const p=packetSchema.parse(raw),prior=s.draftConsolidations?.[p.id];
 if(prior){if(fingerprint(prior.packet)!==fingerprint(p))throw Error('Consolidation ID conflict');return prior;}
 validate(s,p,owner,token,now);
 const ids=p.groups.flatMap(g=>g.members.map(m=>m.cardId));
 if(Object.values(s.draftConsolidations??{}).some(c=>c.packet.groups.some(g=>g.members.some(m=>ids.includes(m.cardId)))))throw Error('Resume existing consolidation');
 const value:DraftConsolidation={packet:p,startedAt:now,bindings:Object.fromEntries(ids.map(id=>[id,draftBinding(s.cards[id])])),previous:Object.fromEntries(ids.map(id=>{const c=s.cards[id];return [id,{knownDraft:c.input.knownDraft,exclusion:c.exclusion,lifecycle:c.draftLifecycle}]}))};
 s.draftConsolidations??={};s.draftConsolidations[p.id]=structuredClone(value);
 s.events.push({at:now,cardId:'*',kind:'draft',event:'consolidation-started',detail:p.id});return value;
}
export function finishDraftConsolidation(s:QueueState,id:string,raw:unknown,owner:string,token:string,now=new Date().toISOString()){
 const c=s.draftConsolidations?.[id];if(!c)throw Error('No consolidation intent');
 const proof=z.object({observedAt:z.string().datetime(),evidence:z.string().min(20),inventoryAx:z.string().min(100),reopened:z.array(z.object({cardId:z.string(),url:z.string().url(),ax:z.string().min(100)}).strict())}).strict().parse(raw);
 if(c.completedAt){if(c.evidence!==fingerprint(proof))throw Error('Completion evidence changed');return false;}
 if(Date.parse(proof.observedAt)<Date.parse(c.startedAt)||Date.parse(proof.observedAt)>Date.parse(now)||Date.parse(now)-Date.parse(proof.observedAt)>3600000)throw Error('Fresh completion proof required');
 validate(s,c.packet,owner,token,now);
 const inventoryIds=Array.from(proof.inventoryAx.matchAll(/ID: shui-dt-checkone-(\d+)/g),m=>m[1]);
 const total=/Results:\s*1-(\d+) of (\d+)/.exec(proof.inventoryAx);
 if(!total||Number(total[1])!==Number(total[2])||new Set(inventoryIds).size!==Number(total[2]))throw Error('Complete draft inventory required');
 for(const g of c.packet.groups){const keep=g.members.find(m=>m.cardId===g.keepCardId)!,r=proof.reopened.find(r=>r.cardId===g.keepCardId),card=s.cards[g.keepCardId];
  if(g.members.some(m=>draftBinding(s.cards[m.cardId])!==c.bindings[m.cardId]))throw Error('Capture changed');
  if(!inventoryIds.includes(keep.draftId)||g.members.some(m=>m!==keep&&inventoryIds.includes(m.draftId)))throw Error('Surplus draft still present or retained draft missing');
  const url=r&&new URL(r.url),parsed=r&&parseSavedDraftAX(r.ax);
  if(!url||url.protocol!=='https:'||url.hostname!=='www.ebay.com'||(url.searchParams.get('draftId')??url.searchParams.get('draft_id'))!==keep.draftId||parsed?.field('Custom label (SKU)')!==card.input.sku||Number(parsed?.field('Quantity'))!==g.members.length)throw Error('Retained draft SKU/quantity not reopened');
 }
 // All evidence validated before changing any card. Historical receipts and archive locations stay intact.
 for(const g of c.packet.groups){const keep=g.members.find(m=>m.cardId===g.keepCardId)!,r=proof.reopened.find(r=>r.cardId===g.keepCardId)!;
  for(const m of g.members){const card=s.cards[m.cardId];card.input.knownDraft=keep.draftId;card.input.savedReceipts=(card.input.savedReceipts??[]).filter(r=>r.disposition!=='draft');
   card.exclusion={disposition:'draft',itemId:keep.draftId,evidence:proof.evidence};
   card.draftLifecycle={binding:draftBinding(card),draftId:keep.draftId,url:r.url,state:'saved',observedAt:proof.observedAt,evidence:'Verified consolidation quantity; full publication-readiness review still required. '+proof.evidence};
  }
 }
 c.completedAt=now;c.evidence=fingerprint(proof);s.events.push({at:now,cardId:'*',kind:'draft',event:'consolidation-completed',detail:id});return true;
}
