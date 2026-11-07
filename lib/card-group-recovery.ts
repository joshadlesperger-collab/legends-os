import { z } from 'zod';
import { fingerprint, reviewedIdentity, identityReviewIsCurrent, type QueueState } from './card-orchestrator.ts';
import { draftBinding, requireDraftWriter } from './card-draft-lifecycle.ts';
import { parseSavedDraftAX } from './card-saved-draft-check.ts';
const schema=z.object({id:z.string().min(10),submissionId:z.string().uuid(),members:z.array(z.string()).min(1).max(12),primary:z.string(),existingDraftId:z.string().regex(/^\d+$/).optional(),beforeQuantity:z.number().int().nonnegative(),evidence:z.string().min(30),clearance:z.object({observedAt:z.iso.datetime(),draftsAx:z.string().min(100),active:z.string().min(30),scheduled:z.string().min(30),sold:z.string().min(30),noExactConflict:z.literal(true)}).strict()}).strict();
export type GroupRecovery={packet:z.infer<typeof schema>;bindings:Record<string,string>;startedAt:string;draftId?:string;url?:string;observedAt?:string;completedAt?:string;proofHash?:string;previous:Record<string,unknown>};
const fresh=(at:string,now:string)=>Date.parse(at)<=Date.parse(now)&&Date.parse(now)-Date.parse(at)<=3600000;
function inventory(ax:string){const ids=Array.from(ax.matchAll(/ID: shui-dt-checkone-(\d+)/g),m=>m[1]);const n=/Results:\s*1-(\d+) of (\d+)/.exec(ax);if(!n||n[1]!==n[2]||new Set(ids).size!==+n[2])throw Error('Complete draft inventory required');return ids;}
function validate(s:QueueState,p:z.infer<typeof schema>,owner:string,token:string,now:string){
 const b=s.bulkAiSubmissions?.[p.submissionId];if(!b||b.checkpoints?.at(-1)?.phase!=='recovery-failed')throw Error('Retained failed recovery required');
 if(!p.members.includes(p.primary)||new Set(p.members).size!==p.members.length)throw Error('Invalid group membership');
 const keys=new Set<string>(),fronts=new Set<string>();let represented=0;
 for(const id of p.members){const c=s.cards[id],w=requireDraftWriter(s,owner,token,id,now),i=c&&reviewedIdentity(c);
  if(!i||!identityReviewIsCurrent(c)||c.jobs.photos.state!=='done'||i.serial||i.printRun||!i.language||i.autograph===null||c.input.sourceHold||c.input.knownLive||c.exclusion&&c.exclusion.disposition!=='draft'||['live','sold','scheduled'].includes(String(c.jobs.reconcile.result?.disposition)))throw Error('Current reviewed unnumbered captures required');
  keys.add(fingerprint({...i,colorMatch:undefined}));fronts.add(c.input.photos.find(p=>p.side==='front')!.sha256.toLowerCase());
  const known=c.input.knownDraft??c.draftLifecycle?.draftId;
  if(known){if(known!==p.existingDraftId)throw Error('Resume known draft');represented++;}
  else if(!b.cardIds.includes(id)||b.results[id]||b.originals[id]!==fingerprint(c.input.photos.map(p=>[p.side,p.sha256.toLowerCase()]))||w.creationAuthority?.bindings[id]!==draftBinding(c))throw Error('Exact unresolved capture and scoped authority required');
 }
 if(keys.size!==1||fronts.size!==p.members.length||represented!==p.beforeQuantity||!!p.existingDraftId!==!!represented)throw Error('Variant, capture or starting quantity mismatch');
 const outsiders=Object.values(s.cards).filter(c=>!p.members.includes(c.input.id)&&(c.input.knownDraft||c.input.knownLive||c.exclusion));
 if(outsiders.some(c=>{const i=reviewedIdentity(c);return i&&keys.has(fingerprint({...i,colorMatch:undefined}));}))throw Error('Reconcile matching existing inventory first');
}
/** New reviewed group operation, not a claim that the original asynchronous job was cancelled. */
export function beginGroupRecovery(s:QueueState,raw:unknown,owner:string,token:string,now=new Date().toISOString()){
 const p=schema.parse(raw),old=s.draftGroupRecoveries?.[p.id];if(old){if(fingerprint(old.packet)!==fingerprint(p))throw Error('Operation ID conflict');return {...old,canCreate:false,next:'Resume recorded operation; never repeat creation'};}
 if(!fresh(p.clearance.observedAt,now))throw Error('Fresh four-scope reconciliation required');const ids=inventory(p.clearance.draftsAx);
 if(p.existingDraftId&&!ids.includes(p.existingDraftId))throw Error('Existing draft missing');
 validate(s,p,owner,token,now);
 if(Object.values(s.draftGroupRecoveries??{}).some(g=>g.packet.members.some(id=>p.members.includes(id))))throw Error('Capture already reserved; resume existing operation');
 const g:GroupRecovery={packet:p,bindings:Object.fromEntries(p.members.map(id=>[id,draftBinding(s.cards[id])])),startedAt:now,previous:Object.fromEntries(p.members.map(id=>[id,structuredClone(s.cards[id].draftLifecycle??null)])),...(p.existingDraftId?{draftId:p.existingDraftId}:{})};
 (s.draftGroupRecoveries??={})[p.id]=g;s.events.push({at:now,cardId:'*',kind:'draft',event:'group-recovery-begin',detail:p.id});return {...g,canCreate:!p.existingDraftId,canPublish:false};
}
export function observeGroupRecovery(s:QueueState,id:string,raw:unknown,owner:string,token:string,now=new Date().toISOString()){
 const g=s.draftGroupRecoveries?.[id];if(!g)throw Error('Group intent missing');
 const o=z.object({draftId:z.string().regex(/^\d+$/),url:z.string().url(),observedAt:z.iso.datetime(),evidence:z.string().min(30)}).strict().parse(raw),u=new URL(o.url);
 if(!fresh(o.observedAt,now)||Date.parse(o.observedAt)<Date.parse(g.startedAt)||u.origin!=='https://www.ebay.com'||(u.searchParams.get('draft_id')??u.searchParams.get('draftId'))!==o.draftId||g.draftId&&g.draftId!==o.draftId)throw Error('Conflicting or stale observed ID');
 for(const cid of g.packet.members){requireDraftWriter(s,owner,token,cid,now);if(draftBinding(s.cards[cid])!==g.bindings[cid])throw Error('Capture changed');}
 if(Object.values(s.cards).some(c=>!g.packet.members.includes(c.input.id)&&[c.input.knownDraft,c.draftLifecycle?.draftId].includes(o.draftId)))throw Error('ID belongs to another capture');
 if(g.completedAt)return {id,draftId:g.draftId,canCreate:false,canPublish:false};
 g.draftId=o.draftId;g.url=o.url;g.observedAt=o.observedAt;
 for(const cid of g.packet.members){const c=s.cards[cid];c.input.knownDraft=o.draftId;c.exclusion={disposition:'draft',itemId:o.draftId,evidence:o.evidence};c.draftLifecycle={binding:g.bindings[cid],draftId:o.draftId,url:o.url,state:'unknown',observedAt:o.observedAt,evidence:o.evidence};}
 s.events.push({at:now,cardId:'*',kind:'draft',event:'group-recovery-id',detail:JSON.stringify({id,...o})});return {id,draftId:g.draftId,canCreate:false,canPublish:false};
}
export function finishGroupRecovery(s:QueueState,id:string,raw:unknown,owner:string,token:string,now=new Date().toISOString()){
 const g=s.draftGroupRecoveries?.[id];if(!g?.draftId)throw Error('Observed draft required');
 const p=z.object({savedAt:z.iso.datetime(),reopenedAt:z.iso.datetime(),observedAt:z.iso.datetime(),url:z.string().url(),ax:z.string().min(100),evidence:z.string().min(30),photosMatched:z.literal(true),identityMatched:z.literal(true),photoCount:z.number().int().min(2),price:z.number().nonnegative().nullable(),bulk:z.object({draftId:z.string().regex(/^\d+$/),photoAX:z.string().min(100)}).strict().optional()}).strict().parse(raw);
 if(g.completedAt){if(g.proofHash!==fingerprint(p))throw Error('Completion evidence changed');return false;}
 const u=new URL(p.url),primary=s.cards[g.packet.primary];
 let sku:string|undefined,quantity:string|undefined,title:string|undefined,price:string|undefined,photoCount:number;
 if(p.bulk){
  if(u.pathname!=='/bulksell'||!u.searchParams.get('workspaceId')||p.bulk.draftId!==g.draftId||!p.ax.split(/\r?\n/)[0].includes('URL: "'+p.url+'"'))throw Error('Observed bulk workspace and draft ID required');
  const matches=p.ax.split(/\n(?=\s*\d+ row(?:\r?\n|$))/).filter(r=>r.includes('ID: draft-checkbox-'+g.draftId+'\n'));
  if(matches.length!==1)throw Error('Unique saved bulk row required');
  const lines=matches[0].split(/\r?\n/);
  const field=(label:string)=>{const hit=lines.filter(l=>l.includes(') '+label+', '));if(hit.length!==1)return undefined;return hit[0].includes(', Value: ')?hit[0].split(', Value: ')[1].split(', ID:')[0]:'';};
  sku=field('Custom label (SKU)');quantity=field('Available quantity');title=field('Title');price=field('Buy It Now');
  const counts=Array.from(p.bulk.photoAX.matchAll(/photoCountLabelA11y.*?"numImage":"(\d+)"/g),m=>Number(m[1]));
  if(!p.bulk.photoAX.includes('ID: draft-checkbox-'+g.draftId+'\n')||counts.length!==1)throw Error('Retained photo dialog required');
  photoCount=counts[0];
 }else{
  if((u.searchParams.get('draft_id')??u.searchParams.get('draftId'))!==g.draftId)throw Error('Observed single editor ID required');
  const a=parseSavedDraftAX(p.ax);sku=a.field('Custom label (SKU)');quantity=a.field('Quantity');title=a.field('Item title');price=a.field('Item price');photoCount=a.photoCount;
 }
 if(u.origin!=='https://www.ebay.com'||Date.parse(p.savedAt)<Date.parse(g.startedAt)||Date.parse(p.savedAt)>=Date.parse(p.reopenedAt)||Date.parse(p.reopenedAt)>Date.parse(p.observedAt)||!fresh(p.observedAt,now)||sku!==primary.input.sku||Number(quantity)!==g.packet.members.length||!title||photoCount!==p.photoCount||(p.price===null?price!=='':price===undefined||Number(price)!==p.price))throw Error('Saved/reopened SKU, quantity, photos or price mismatch');
 for(const cid of g.packet.members){requireDraftWriter(s,owner,token,cid,now);const c=s.cards[cid];if(draftBinding(c)!==g.bindings[cid]||c.input.knownDraft!==g.draftId)throw Error('Changed capture or ID');}
 g.completedAt=now;g.proofHash=fingerprint(p);
 for(const cid of g.packet.members){const d=s.cards[cid].draftLifecycle!;d.state='saved';d.evidence=p.evidence;d.observedAt=p.observedAt;}
 s.events.push({at:now,cardId:'*',kind:'draft',event:'group-recovery-saved',detail:id});return true;
}
