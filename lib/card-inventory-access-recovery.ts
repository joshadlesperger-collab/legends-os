import { z } from 'zod';
import { existingReceipt, fingerprint, reviewedIdentity, type QueueState } from './card-orchestrator.ts';

/** Fresh four-scope evidence reopens only a historical access-failure hold.
 * It grants no clearance: normal claim/complete and writer gates still apply. */
export function recoverInventoryAccessHold(s:QueueState,id:string,raw:unknown,now=new Date().toISOString(),holds:Record<string,string>={}) {
  const p=z.object({snapshot:z.string().min(1),binding:z.string().min(1),checks:z.array(z.object({scope:z.enum(['active','drafts','scheduled','sold']),checkedAt:z.iso.datetime(),evidence:z.string().min(20).max(2000)}).strict()).length(4)}).strict().parse(raw);
  const c=s.cards[id],j=c?.jobs.reconcile;
  if(!c||!j||j.state!=='held'||fingerprint(j)!==p.snapshot)throw Error('Held snapshot changed');
  if(holds[id]||c.input.sourceHold||c.exclusion||existingReceipt(c)||c.draftLifecycle||Object.values(c.jobs).some(j=>j.state==='leased'))throw Error('Hold, receipt or operation prevents recovery');
  if(c.jobs.photos.state!=='done'||c.jobs.identity.state!=='done'||fingerprint({identity:reviewedIdentity(c),photos:c.input.photos})!==p.binding)throw Error('Current reviewed identity/photos required');
  if(!/SellerHub.*(?:stalled|unavailable)|inventory access unavailable/i.test(j.reason??''))throw Error('Only a historical access failure may recover');
  const held=s.events.findLast(e=>e.cardId===id&&e.kind==='reconcile'&&e.event==='held');
  if(!held||held.detail!==j.reason||!Number.isFinite(Date.parse(held.at)))throw Error('Exact dated hold evidence required');
  if(new Set(p.checks.map(c=>c.scope)).size!==4||p.checks.some(c=>Date.parse(c.checkedAt)<=Date.parse(held.at)||Date.parse(c.checkedAt)>Date.parse(now)||Date.parse(now)-Date.parse(c.checkedAt)>60*60*1000))throw Error('Four distinct fresh checks after the hold required');
  const access=s.inventoryAccess;
  if(!access?.available||Date.parse(access.at)<=Date.parse(held.at)||Date.parse(access.at)>Date.parse(now)||Date.parse(now)-Date.parse(access.at)>60*60*1000)throw Error('Fresh successful seller access required');
  const previous=structuredClone(j);
  j.state='todo';j.attemptsSinceClearance=0;j.reason='Fresh four-scope observations reopened historical access failure';delete j.recovery;
  s.events.push({at:now,cardId:id,kind:'reconcile',event:'fresh-access-evidence-admitted',detail:JSON.stringify({previous,checks:p.checks,binding:p.binding,accessObservation:access.observationId})});
  return {reopened:id,clearanceGranted:false,lifetimeAttempts:j.attempts};
}
