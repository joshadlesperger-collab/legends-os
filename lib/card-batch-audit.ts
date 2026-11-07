import { z } from 'zod';

export const BATCH_REVIEW_POLICY = {
  generation: 'ebay-bulk-ai', primaryRecognizer: 'openai', alternateRecognizer: 'claude',
  reviewFields: ['player', 'cardNumber', 'parallel', 'serial', 'originalPhotos'],
  retainAcceptableContent: true, useFourModelsOnlyForExplicitExperiment: true,
  pricing: 'source-first; existing validated policy; 30-second research limit; exact active fallback or unpriced exception',
  commit: 'keyboard Enter or bulk Apply, save, reopen same IDs, compare every planned field',
  canPublish: false,
} as const;
const fields = z.object({ sku:z.string().min(1), title:z.string().min(1).max(80),
  item:z.number().nonnegative().nullable(), shipping:z.number().nonnegative(),
  quantity:z.number().int().positive(), condition:z.string().min(1) }).strict();
const hash=z.string().regex(/^[a-f0-9]{64}$/i);
const serial=z.string().regex(/^\d+\/\d+$/).nullable();
export const draftHoldSchema=z.object({draftId:z.string().regex(/^\d+$/),captureId:z.string().min(1),
  activeItemId:z.string().regex(/^\d+$/),reason:z.string().min(1),evidence:z.string().min(1)});
/** Overlay only; never rewrite original receipts or adopt leftover drafts as inventory. */
export function applyDraftHandoffHolds<T extends {cards:{id:string;blockers:string[];nextOwner:string;nextAction:string}[]}>(packet:T,input:unknown):T {
  const holds=draftHoldSchema.array().parse(input),result=structuredClone(packet);
  for(const card of result.cards){
    const matches=holds.filter(h=>h.captureId===card.id);
    if(!matches.length)continue;
    card.blockers.push(...matches.map(h=>`Draft ${h.draftId}: ${h.reason} Active listing https://www.ebay.com/itm/${h.activeItemId}. Evidence: ${h.evidence}`));
    card.nextOwner='seller';
    card.nextAction='Stale draft held: do not attach photos, publish, recreate or increment stock. Resolve disposition separately; existing live listing is retained.';
  }
  return result;
}
export const batchAuditSchema = z.object({
  captures:z.array(z.object({ id:z.string().min(1), frontHash:hash, backHash:hash.optional(), serial:serial.optional() })).min(1),
  draftHolds:z.array(draftHoldSchema).default([]),
  outcomes:z.array(z.object({ captureId:z.string(), route:z.enum(['draft','quantity-update','exception']),
    targetId:z.string().optional(), evidence:z.string().min(1), reason:z.string().optional(),
    expected:fields.optional(), reopened:fields.optional(), savedAt:z.iso.datetime().optional(),
    reopenedAt:z.iso.datetime().optional(), criticalFieldsVerified:z.boolean().optional(),
    photos:z.object({count:z.number().int().nonnegative(),frontHash:hash,backHash:hash,evidence:z.string().min(1)}).optional(),
    observedSerial:serial.optional(),
    inventory:z.object({checkedAt:z.iso.datetime(),evidence:z.string().min(1),
      scopes:z.array(z.enum(['active','sold','drafts','scheduled'])),
      sameCaptureActiveIds:z.array(z.string()),otherDraftIds:z.array(z.string())}).optional(),
    uncertainFields:z.array(z.string()).default([]) })),
});
/** Read-only reconciliation. Evidence assertions never create receipts or authorize writes. */
export function auditBatch(input:unknown, verifiedGroups:Record<string,{members:string[];sku:string;photoCount?:number}> = {}) {
  const p=batchAuditSchema.parse(input), issues:string[]=[], verified:string[]=[], exceptions:string[]=[];
  if(new Set(p.captures.map(c=>c.id)).size!==p.captures.length) issues.push('Duplicate capture IDs');
  if(new Set(p.captures.map(c=>c.frontHash.toLowerCase())).size!==p.captures.length) issues.push('Repeated original front hash: reconcile copied files');
  for(const o of p.outcomes) if(!p.captures.some(c=>c.id===o.captureId)) issues.push(`Unknown capture ${o.captureId}`);
  for(const c of p.captures) {
    const rows=p.outcomes.filter(o=>o.captureId===c.id);
    if(rows.length!==1){issues.push(`${c.id}: expected exactly one disposition, found ${rows.length}`);continue;}
    const o=rows[0];
    if(o.route==='exception') {if(!o.reason?.trim())issues.push(`${c.id}: exception needs reason`);else exceptions.push(c.id);continue;}
    const before=issues.length;
    const holds=p.draftHolds.filter(h=>h.captureId===c.id||h.draftId===o.targetId);
    if(holds.length)issues.push(`${c.id}: stale draft hold: ${holds.map(h=>h.draftId).join(', ')}`);
    if(!o.targetId || !/^\d+$/.test(o.targetId)) issues.push(`${c.id}: saved target ID required`);
    if(!o.criticalFieldsVerified || o.uncertainFields.length) issues.push(`${c.id}: targeted identity/photo review unresolved`);
    if(!o.savedAt||!o.reopenedAt||Date.parse(o.reopenedAt)<Date.parse(o.savedAt)) issues.push(`${c.id}: save then reopen evidence required`);
    if(!o.photos||o.photos.count<2||!c.backHash||
      o.photos.frontHash.toLowerCase()!==c.frontHash.toLowerCase()||
      o.photos.backHash.toLowerCase()!==c.backHash.toLowerCase())issues.push(`${c.id}: saved front/back photo evidence missing or mismatched`);
    if(c.serial===undefined||o.observedSerial===undefined||c.serial!==o.observedSerial)issues.push(`${c.id}: original/reopened serial unresolved or mismatched`);
    if(c.serial&&o.reopened) {
      const visible=o.reopened.title.match(/\b\d+\/\d+\b/g)??[];
      if(visible.some(s=>s!==c.serial))issues.push(`${c.id}: title serial conflicts with original`);
    }
    const inv=o.inventory;
    if(!inv||['active','sold','drafts','scheduled'].some(s=>!inv.scopes.includes(s as typeof inv.scopes[number]))||
      !o.reopenedAt||Date.parse(inv.checkedAt)>Date.parse(o.reopenedAt)||Date.parse(o.reopenedAt)-Date.parse(inv.checkedAt)>3600000)
      issues.push(`${c.id}: fresh four-scope inventory reconciliation required`);
    if(inv?.otherDraftIds.length)issues.push(`${c.id}: unresolved duplicate drafts: ${inv.otherDraftIds.join(', ')}`);
    if(o.route==='draft'&&inv?.sameCaptureActiveIds.length)issues.push(`${c.id}: original capture already active; do not prepare duplicate`);
    if(o.route==='draft'&&p.outcomes.some(other=>other!==o&&other.targetId===o.targetId)) {
      const group=verifiedGroups[o.targetId!],rows=p.outcomes.filter(r=>r.targetId===o.targetId);
      if(!group||group.members.length!==rows.length||new Set(group.members).size!==rows.length||rows.some(r=>r.route!=='draft'||!group.members.includes(r.captureId)||r.reopened?.sku!==group.sku||r.reopened?.quantity!==group.members.length||r.photos?.count!==(group.photoCount??group.members.length*2)))
        issues.push(c.id+': target draft reused without a complete verified quantity group');
    }
    if(!o.expected||!o.reopened)issues.push(`${c.id}: planned and reopened fields required`);
    else for(const k of Object.keys(o.expected) as (keyof typeof o.expected)[]) if(o.expected[k]!==o.reopened[k]) issues.push(`${c.id}: persisted ${k} mismatch`);
    if(before===issues.length)verified.push(c.id);
  }
  return {accountedFor:issues.length===0,complete:issues.length===0&&exceptions.length===0,
    verified,exceptions,issues,draftHolds:p.draftHolds.filter(h=>p.captures.some(c=>c.id===h.captureId)||p.outcomes.some(o=>o.targetId===h.draftId)),canPublish:false,policy:BATCH_REVIEW_POLICY};
}
