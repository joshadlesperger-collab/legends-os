import { z } from 'zod';
import { fingerprint, identityReviewIsCurrent, reviewedIdentity, type QueueState } from './card-orchestrator.ts';
import { draftBinding, requireDraftWriter } from './card-draft-lifecycle.ts';
import { parseSavedDraftAX } from './card-saved-draft-check.ts';
const snapshot=z.object({url:z.string().url(),ax:z.string().min(100),observedAt:z.iso.datetime()}).strict();
const packet=z.object({id:z.string().min(10),draftId:z.string().regex(/^\d+$/),primary:z.string(),representativePhotos:z.literal(true).optional(),existing:z.array(z.string()).min(1),added:z.array(z.string()).min(1),evidence:z.string().min(30),before:snapshot,clearance:z.object({observedAt:z.iso.datetime(),draftsAx:z.string().min(100),active:z.string().min(30),sold:z.string().min(30),scheduled:z.string().min(30),noExactConflict:z.literal(true)}).strict()}).strict();
const proof=snapshot.extend({savedAt:z.iso.datetime(),reopenedAt:z.iso.datetime(),evidence:z.string().min(30),screenshotSha256:z.string().regex(/^[a-f0-9]{64}$/),photos:z.array(z.object({cardId:z.string(),frontHash:z.string(),backHash:z.string(),frontPosition:z.number().int().positive(),backPosition:z.number().int().positive(),upright:z.literal(true),identityMatches:z.literal(true)}).strict())}).strict();
export type DraftAppend={packet:z.infer<typeof packet>;bindings:Record<string,string>;startedAt:string;price:string;title:string;photoCount:number;previous:Record<string,unknown>;completedAt?:string;proofHash?:string};
const fresh=(at:string,now:string)=>Date.parse(at)<=Date.parse(now)&&Date.parse(now)-Date.parse(at)<=3600000;
function editor(raw:z.infer<typeof snapshot>,id:string,now:string){const u=new URL(raw.url);if(u.origin!=='https://www.ebay.com'||!['/lstng','/sl/list'].includes(u.pathname)||(u.searchParams.get('draftId')??u.searchParams.get('draft_id'))!==id||!raw.ax.split(/\r?\n/)[0].includes('URL: "'+raw.url+'"')||!fresh(raw.observedAt,now))throw Error('Fresh exact saved editor required');return parseSavedDraftAX(raw.ax);}
function validate(s:QueueState,p:z.infer<typeof packet>,owner:string,token:string,now:string){
 const ids=[...p.existing,...p.added];if(ids.length>12||new Set(ids).size!==ids.length||!p.existing.includes(p.primary))throw Error('Invalid append membership');
 const fronts=new Set<string>(),keys=new Set<string>();
 for(const id of ids){requireDraftWriter(s,owner,token,id,now);const c=s.cards[id],i=c&&reviewedIdentity(c);if(!i||!identityReviewIsCurrent(c)||c.jobs.photos.state!=='done'||i.serial||i.printRun||!i.language||i.autograph===null||c.input.sourceHold||c.input.knownLive||c.exclusion&&c.exclusion.disposition!=='draft'||['live','sold','scheduled'].includes(String(c.jobs.reconcile.result?.disposition)))throw Error('Current reviewed unnumbered captures required');
  keys.add(fingerprint({...i,colorMatch:undefined}));fronts.add(c.input.photos.find(x=>x.side==='front')!.sha256.toLowerCase());
  const known=[c.input.knownDraft,c.draftLifecycle?.draftId,c.exclusion?.itemId,...(c.input.savedReceipts??[]).map(r=>r.itemId)].filter(Boolean);
  if(p.existing.includes(id)?!known.length||known.some(x=>x!==p.draftId):known.length>0)throw Error('Existing ownership or new capture mismatch');
 }
 if(keys.size!==1||fronts.size!==ids.length)throw Error('Distinct exact matching captures required');
 if(Object.values(s.cards).some(c=>!ids.includes(c.input.id)&&([c.input.knownDraft,c.draftLifecycle?.draftId,c.exclusion?.itemId,...(c.input.savedReceipts??[]).map(r=>r.itemId)].includes(p.draftId)||c.input.photos.some(x=>x.side==='front'&&fronts.has(x.sha256.toLowerCase())))))throw Error('Unrepresented owner or duplicate capture');
 return ids;
}
export function beginDraftAppend(s:QueueState,raw:unknown,owner:string,token:string,now=new Date().toISOString()){
 const p=packet.parse(raw),prior=s.draftAppends?.[p.id];if(prior){if(fingerprint(prior.packet)!==fingerprint(p))throw Error('Append ID conflict');for(const id of [...p.existing,...p.added])requireDraftWriter(s,owner,token,id,now);return {...prior,canCreate:false,canPublish:false,resume:true};}
 const ids=validate(s,p,owner,token,now);if(!fresh(p.clearance.observedAt,now))throw Error('Fresh four-scope clearance required');
 const found=Array.from(p.clearance.draftsAx.matchAll(/ID: shui-dt-checkone-(\d+)/g),m=>m[1]),total=/Results:\s*1-(\d+) of (\d+)/.exec(p.clearance.draftsAx);if(!total||total[1]!==total[2]||new Set(found).size!==+total[2]||!found.includes(p.draftId))throw Error('Complete draft inventory required');
 if(Object.values(s.draftAppends??{}).some(g=>!g.completedAt&&[...g.packet.existing,...g.packet.added].some(id=>ids.includes(id))))throw Error('Resume existing append');
 const a=editor(p.before,p.draftId,now),price=a.field('Item price'),title=a.field('Item title');if(a.field('Custom label (SKU)')!==s.cards[p.primary].input.sku||Number(a.field('Quantity'))!==p.existing.length||(p.representativePhotos?a.photoCount<2:a.photoCount!==p.existing.length*2)||price===undefined||!title)throw Error('Starting SKU, quantity, photos or price mismatch');
 const g:DraftAppend={packet:p,startedAt:now,price,title,photoCount:p.representativePhotos?a.photoCount:ids.length*2,bindings:Object.fromEntries(ids.map(id=>[id,draftBinding(s.cards[id])])),previous:Object.fromEntries(ids.map(id=>[id,structuredClone(s.cards[id].draftLifecycle??null)]))};(s.draftAppends??={})[p.id]=g;s.events.push({at:now,cardId:'*',kind:'draft',event:'append-started',detail:p.id});return {...g,canCreate:false,canPublish:false,resume:false};
}
export function finishDraftAppend(s:QueueState,id:string,raw:unknown,owner:string,token:string,now=new Date().toISOString()){
 const g=s.draftAppends?.[id];if(!g)throw Error('Append intent required');const p=proof.parse(raw),ids=[...g.packet.existing,...g.packet.added];for(const cid of ids){requireDraftWriter(s,owner,token,cid,now);if(draftBinding(s.cards[cid])!==g.bindings[cid])throw Error('Capture changed');}
 if(g.completedAt){if(g.proofHash!==fingerprint(p))throw Error('Completion evidence changed');return false;}
 validate(s,g.packet,owner,token,now);const a=editor(p,g.packet.draftId,now);
 if(Date.parse(p.savedAt)<Date.parse(g.startedAt)||Date.parse(p.savedAt)>=Date.parse(p.reopenedAt)||Date.parse(p.reopenedAt)>Date.parse(p.observedAt)||a.field('Custom label (SKU)')!==s.cards[g.packet.primary].input.sku||Number(a.field('Quantity'))!==ids.length||a.photoCount!==g.photoCount||a.field('Item price')!==g.price||a.field('Item title')!==g.title||p.photos.length!==(g.packet.representativePhotos?1:ids.length))throw Error('Saved quantity, photos, title, SKU or preserved price mismatch');
 (g.packet.representativePhotos?[g.packet.primary]:ids).forEach((cid,n)=>{const v=p.photos[n],c=s.cards[cid];if(v.cardId!==cid||v.frontPosition!==n*2+1||v.backPosition!==n*2+2||v.frontHash!==c.input.photos.find(x=>x.side==='front')!.sha256||v.backHash!==c.input.photos.find(x=>x.side==='back')!.sha256)throw Error('Ordered original gallery proof required');});
 // All evidence validates before adopting added copies; old receipts and archives stay intact.
 for(const cid of ids){const c=s.cards[cid];c.input.knownDraft=g.packet.draftId;c.exclusion={disposition:'draft',itemId:g.packet.draftId,evidence:p.evidence};c.draftLifecycle={binding:g.bindings[cid],draftId:g.packet.draftId,url:p.url,state:'saved',observedAt:p.observedAt,evidence:p.evidence};}
 g.completedAt=now;g.proofHash=fingerprint(p);s.events.push({at:now,cardId:'*',kind:'draft',event:'append-completed',detail:id});return true;
}
