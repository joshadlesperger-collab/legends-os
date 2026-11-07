import { z } from 'zod';
import { fingerprint, type QueueState } from './card-orchestrator.ts';

const hash=z.string().regex(/^[a-f0-9]{64}$/), itemId=z.string().regex(/^\d{12}$/), text=z.string().min(1).max(2000);
const sourceSchema=z.object({kind:z.enum(['state','active','orders']),file:text,sha256:hash,modifiedAt:z.string().datetime(),exportDateFromFilename:z.string().nullable()});
const matchSchema=z.object({itemId,sku:z.string().max(500),title:z.string().max(1000),quantity:z.number().int().nonnegative().nullable(),basis:z.enum(['retained-item-id','exact-sku'])});
const reportSchema=z.object({schemaVersion:z.literal(1),generatedAt:z.string().datetime(),sourceRevision:z.number().int().nonnegative(),
  provenance:z.array(sourceSchema).length(3),records:z.array(z.object({cardId:text,sku:z.string().max(500),identity:z.record(z.string(),z.unknown()),
    disposition:z.enum(['active-match','historical-order-match','review-conflict','not-found-in-reports']),conflicts:z.array(z.string().max(200)),
    activeMatches:z.array(matchSchema),orderItemIds:z.array(itemId)})).max(10000)});
export type CardReportFinding={cardId:string;sku:string;identityKey:string;photoKey:string;disposition:string;conflicts:string[];
  activeMatches:z.infer<typeof matchSchema>[];orderItemIds:string[];draftClearance:false;archiveAuthority:false};
export type CardReportEvidence={id:string;reportSha256:string;importedAt:string;reconciledAt:string;sourceRevision:number;
  sources:z.infer<typeof sourceSchema>[];findings:CardReportFinding[];freshLiveObservation:false;grantsDraftClearance:false;grantsArchiveAuthority:false};
export type ReportEvidenceQueue=QueueState & {reportEvidence?:Record<string,CardReportEvidence>};
export const parseCardReconciliationReport=(raw:unknown)=>reportSchema.parse(raw);

/** Evidence intake only. It never changes jobs, exclusions, draft operations, receipts or archives. */
export function recordCardReportEvidence(state:ReportEvidenceQueue,raw:unknown,proof:{reportSha256:string;currentStateSha256:string},now=new Date().toISOString()) {
  hash.parse(proof.reportSha256);hash.parse(proof.currentStateSha256);z.string().datetime().parse(now);
  const report=reportSchema.parse(raw),id=proof.reportSha256,prior=state.reportEvidence?.[id];
  if(prior){if(prior.reportSha256!==id)throw Error('Report evidence identity conflict');return {recorded:false,id,findings:prior.findings.length};}
  const kinds=report.provenance.map(p=>p.kind);
  if(new Set(kinds).size!==3||report.provenance.find(p=>p.kind==='state')!.sha256!==proof.currentStateSha256
    ||state.revision!==report.sourceRevision||Date.parse(report.generatedAt)>Date.parse(now))throw Error('Report source snapshot changed or provenance is invalid');
  if(state.seller!=='imaydit58'||report.records.length!==Object.keys(state.cards).length)throw Error('Seller or complete card coverage mismatch');
  const seen=new Set<string>();
  const findings=report.records.map((r: z.infer<typeof reportSchema>['records'][number])=>{
    const c=state.cards[r.cardId];
    if(!c||seen.has(r.cardId)||c.input.sku!==r.sku)throw Error('Missing, duplicate or changed card/SKU');seen.add(r.cardId);
    const identity=(c.jobs.identity.state==='done'?(c.jobs.identity.result?.identity??c.input.identity):c.input.identity)??{};
    if(fingerprint(identity)!==fingerprint(r.identity))throw Error('Reviewed identity changed');
    const ids=[c.input.knownLive?.itemId,c.draftLifecycle?.liveItemId,c.exclusion?.itemId,...(c.input.savedReceipts??[]).filter(x=>x.disposition==='live').map(x=>x.itemId)];
    if(r.activeMatches.some(m=>m.basis==='retained-item-id'?!ids.includes(m.itemId):!r.sku||m.sku!==r.sku))throw Error('Active report match lacks exact retained binding');
    if(r.disposition==='active-match'&&(!r.activeMatches.length||r.conflicts.length)
      ||r.disposition==='historical-order-match'&&(!r.orderItemIds.length||r.activeMatches.length||r.conflicts.length)
      ||r.disposition==='not-found-in-reports'&&(r.activeMatches.length||r.orderItemIds.length||r.conflicts.length)
      ||r.disposition==='review-conflict'&&!r.conflicts.length)throw Error('Inconsistent report disposition');
    return {cardId:r.cardId,sku:r.sku,identityKey:fingerprint(identity),photoKey:fingerprint(c.input.photos),disposition:r.disposition,
      conflicts:r.conflicts,activeMatches:r.activeMatches,orderItemIds:r.orderItemIds,draftClearance:false as const,archiveAuthority:false as const};
  });
  // Publish the complete validated entry atomically only after every card passes.
  const entry:CardReportEvidence={id,reportSha256:id,importedAt:now,reconciledAt:report.generatedAt,sourceRevision:report.sourceRevision,
    sources:report.provenance,findings,freshLiveObservation:false,grantsDraftClearance:false,grantsArchiveAuthority:false};
  state.reportEvidence??={};state.reportEvidence[id]=entry;
  state.events.push({at:now,cardId:'*',kind:'reconcile',event:'historical-reports-recorded',detail:JSON.stringify({id,sourceRevision:report.sourceRevision,findings:findings.length,grantsDraftClearance:false})});
  return {recorded:true,id,findings:findings.length};
}

/** Conservative new-create routing guard, never a live receipt or absence clearance.
 * Historical matches do not retire work or affect same-ID repair and archiving. */
export function reportDraftBlockers(state:ReportEvidenceQueue,cardId:string) {
  const card=state.cards[cardId];if(!card)return [];
  const identity=(card.jobs.identity.state==='done'?(card.jobs.identity.result?.identity??card.input.identity):card.input.identity)??{};
  return Object.values(state.reportEvidence??{}).flatMap(report=>report.findings.filter(f=>f.cardId===cardId&&f.sku===card.input.sku
    &&f.identityKey===fingerprint(identity)&&f.photoKey===fingerprint(card.input.photos)&&f.disposition!=='not-found-in-reports')
    .map(f=>({reportId:report.id,disposition:f.disposition,reason:'Report match/conflict requires supported physical-copy reconciliation before another draft; historical evidence only'})));
}
