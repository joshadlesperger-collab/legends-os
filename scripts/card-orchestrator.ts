import { recoverInventoryAccessHold } from '../lib/card-inventory-access-recovery.ts';
import { admitDraftModelWorkflow, claimDraftModelStage, completeDraftModelStage, authorizeDraftModelPrice, beginDraftModelSave, finishDraftModelSave, draftModelStatus } from "../lib/draft-model-workflow.ts";
import { runDraftModelStage, configureDraftModelBudget } from "../lib/draft-model-runner.ts";
import { beginGroupRecovery, observeGroupRecovery, finishGroupRecovery } from "../lib/card-group-recovery.ts";
import { beginDraftAppend, finishDraftAppend } from "../lib/card-draft-append.ts";
import { beginDraftConsolidation, finishDraftConsolidation } from "../lib/card-draft-consolidation.ts";
import {reconcileActiveSerial} from '../lib/card-active-serial-recovery.ts';
import fs from "node:fs/promises";
import {savedSourceCandidates} from '../lib/card-saved-source-index.ts';
import {applyDraftHandoffHolds} from '../lib/card-batch-audit.ts';
import { beginBulkAi, observeBulkAi, bulkAiStatus, checkpointBulkAi, bulkCheckpointSchema } from '../lib/card-bulk-ai.ts';
import { deferDraftPricing, verifyUnpricedDraft } from "../lib/card-draft-lifecycle.ts";
import { configureDraftWriter, claimDraftWriter, releaseDraftWriter, requireDraftWriter, observeDraft, draftBinding, beginDraftWrite, beginDraftGroup, observeDraftGroup, verifyDraft, holdDraft, recoverDraft } from "../lib/card-draft-lifecycle.ts";
import { archiveCopyOnly, preparePhotoMove, finishPhotoMove } from "../lib/card-photo-archive.ts";
import { recoverExpiredIdentity, recoverPhotoWriteFailure, reopenIdentityReview } from "../lib/card-orchestrator.ts";
import { recordKnownInventoryObservation } from "../lib/card-orchestrator.ts";
import path from "node:path";
import os from "node:os";
import {pipelineWorkPlan} from "../lib/engineering-pipeline.ts";
import { createHash, randomUUID } from "node:crypto";
import { admitPricingEvidence, claimJob, completeJob, correctSavedPrices, fingerprint, kinds, quarantineImport, queueSummary, recordInventoryAccess, recordVerifiedReceipt, recordQuantityReceiptGroup, retryHeld, setHoldRecovery, upsertCard, type JobKind, type QueueState } from "../lib/card-orchestrator.ts";
import { readQueue, withQueue as storeWithQueue } from "../lib/card-orchestrator-store.ts";
// CLI invocations tolerate bounded concurrent preparation; callbacks are never replayed.
const withQueue: typeof storeWithQueue = (directory,fn,options) => storeWithQueue(directory,fn,{lockWaitMs:30000,...options});
import { writeQueueReport, type ReportSnapshot } from "../lib/card-orchestrator-report.ts";
import { applySavedReceipts, importLegacyCard, partialIdentityRejectionReasons, prepareSavedReceipts, receiptManifestPaths, receiptManifestRows, savedReceiptDependencies, type SavedReceiptRow } from "../lib/card-orchestrator-import.ts";
import { flowPacket, flowHtml, pricingContext, reportHandoff, workflowDecisions, type AskingPriceApproval, type WorkflowDecision } from "../lib/card-orchestrator-flow.ts";
import { completeAutomaticJob, runAutomaticBatch } from "../lib/card-orchestrator-worker.ts";
import { readReviews, withWorkflow } from "../lib/card-workflow-store.ts";
import { defaultCardInbox, loadCardBacklog } from "../lib/card-backlog-store.ts";

const root=process.cwd(),directory=path.join(root,"artifacts/card-orchestrator");
const [command="status",...args]=process.argv.slice(2);
function option(name:string,fallback="") {const i=args.indexOf(`--${name}`);return i<0?fallback:args[i+1]??"";}
const limit=Number(option("limit","10"));
if(!Number.isInteger(limit)||limit<1||limit>50)throw new Error("Use a batch limit from 1 to 50");
const worker=option("worker",`local-${os.hostname()}`);
const timings:Record<string,{calls:number;milliseconds:number}>={};
async function timed<T>(name:string,action:()=>Promise<T>):Promise<T> {
  if(!args.includes("--timings"))return action();
  const started=performance.now();
  try{return await action();}finally{const row=timings[name]??={calls:0,milliseconds:0};row.calls++;row.milliseconds+=performance.now()-started;}
}
const photoSourceRoots=()=>[defaultCardInbox(),process.env.CARD_SCANNER_PATH||(process.platform==="win32"?"C:\\CardScans":"")].filter(Boolean);
async function movePhotos(observation:{cardId:string;soldItemId?:string;liveItemId?:string;draftId?:string;sku:string;observedAt:string;seller:string;source:string},copyOnly=false){
  // Separate transactions: the verified receipt and archive mapping must be durable before unlink.
  const prepared=await withReviewedQueue([observation.cardId],(s,r)=>{
    // A disposable draft test's copy-only policy must not disable live archives.
    copyOnly=archiveCopyOnly(s,observation,copyOnly);
    const roots=photoSourceRoots();
    const root=roots.find(root=>s.cards[observation.cardId].input.photos.every(p=>{
      const relative=path.relative(path.resolve(root),path.resolve(p.path));
      return relative!==".."&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative);
    }))??defaultCardInbox();
    return preparePhotoMove({state:s,observation,sellerHold:r.holds[observation.cardId],manualPriceApproved:!!r.decisions[observation.cardId]?.manualPrice,
      sourceRoot:defaultCardInbox(),sourceRoots:roots,archiveRoot:path.join(root,observation.soldItemId?"Sold":observation.liveItemId?"Listed":"Drafted")});
  });
  if(copyOnly)return {...prepared,sourceRemoval:"not attempted; originals retained"};
  return withReviewedQueue([observation.cardId],(s,r)=>finishPhotoMove(s,observation.cardId,photoSourceRoots(),r.holds[observation.cardId],!!r.decisions[observation.cardId]?.manualPrice));
}
async function recoverArchives(){
  const state=await readQueue(directory),results=[];
  const selected=option('cards').split(',').filter(Boolean);
  const receipts=new Map(Object.values(state.verifiedReceipts??{}).filter(r=>r.liveItemId||r.draftId).sort((a,b)=>a.observedAt.localeCompare(b.observedAt)).map(r=>[r.cardId,r]));
  for(const [cardId,r] of Array.from(receipts)){
    if(results.length>=limit)break;
    if(selected.length&&!selected.includes(cardId))continue;
    if(state.cards[cardId]?.exclusion?.disposition==="sold")continue;
    const entry=state.photoArchives?.[cardId];
    if(entry?.status==="moved"&&(r.liveItemId?entry.liveItemId===r.liveItemId:!!entry.draftId))continue;
    // An unchanged failure is an exception, not a reason to retry every run.
    if(state.photoArchiveFailures?.[cardId]&&Date.parse(state.photoArchiveFailures[cardId].at)>=Date.parse(r.observedAt))continue;
    if(Date.now()-Date.parse(r.observedAt)>3600000&&!entry)continue;
    try{results.push({cardId,archive:await movePhotos({cardId,...(r.liveItemId?{liveItemId:r.liveItemId}:{draftId:r.draftId}),sku:r.sku,seller:r.seller,observedAt:r.observedAt,source:r.liveItemId?`https://www.ebay.com/itm/${r.liveItemId}`:`https://www.ebay.com/sl/list?draft_id=${r.draftId}`})});}
    catch(error){const reason=error instanceof Error?error.message:String(error);await withQueue(directory,s=>{s.photoArchiveFailures??={};s.photoArchiveFailures[cardId]={at:new Date().toISOString(),reason};});results.push({cardId,error:reason});}
  }
  const sold=new Map(Object.values(state.knownInventoryObservations??{}).filter(r=>r.disposition==="sold").map(r=>[r.cardId,r]));
  for(const [cardId,r] of Array.from(sold)){
    if(results.length>=limit)break;
    if(selected.length&&!selected.includes(cardId))continue;
    const entry=state.photoArchives?.[cardId];
    if(entry?.status==="moved")continue;
    if(state.photoArchiveFailures?.[cardId]&&Date.parse(state.photoArchiveFailures[cardId].at)>=Date.parse(r.observedAt))continue;
    if(Date.now()-Date.parse(r.observedAt)>3600000&&!entry)continue;
    try{results.push({cardId,archive:await movePhotos({cardId,soldItemId:r.itemId,sku:r.sku,seller:r.seller,observedAt:r.observedAt,source:r.source})});}
    catch(error){const reason=error instanceof Error?error.message:String(error);await withQueue(directory,s=>{s.photoArchiveFailures??={};s.photoArchiveFailures[cardId]={at:new Date().toISOString(),reason};});results.push({cardId,error:reason});}
  }
  return results;
}
async function workflowHandoff(selected?:string[]) {
  const state=await readQueue(directory),history=await readReviews();
  const approvals:AskingPriceApproval[]=(await json("artifacts/card-orchestrator/asking-price-approvals.json",true))?.approvals??[];
  if(!Array.isArray(approvals))throw new Error("Invalid asking-price approvals");
  const ids=selected??Object.keys(state.cards),reviewStamp=fingerprint(history);
  const captures=new Set(ids.map(id=>`capture:${state.cards[id]?.input.photos.find(p=>p.side==="front")?.sha256.toLowerCase()}`));
  let decisions:Record<string,WorkflowDecision>={};
  // Source-bound review only; no inventory-wide photo hashing or network calls.
  if(history.events.some(e=>e.action!=="note"&&captures.has(e.cardId))) {
    const backlog=await timed("review.loadBacklog",()=>loadCardBacklog({scans:[]}));
    const snapshot=await timed("review.applyWorkflow",()=>withWorkflow(backlog));
    const required=["artifacts/identity-queue/cards.json","artifacts/pricing-queue/queue-state.json","artifacts/card-orchestrator/state.json"];
    if(snapshot.sources.some(source=>source.status==="invalid")||required.some(file=>!snapshot.sources.some(source=>source.path===file&&source.status==="loaded")))throw new Error("Workflow source is missing, changed or invalid; refresh before continuing");
    decisions=await timed("review.decisions",async()=>workflowDecisions(state,snapshot,ids));
  }
  const holds=Object.fromEntries(Object.entries(decisions).flatMap(([id,d])=>d.holdReason?[[id,d.holdReason]]:[]));
  return {decisions,holds,approvals,approvalStamp:fingerprint(approvals),revision:state.revision,reviewStamp};
}
class WorkflowHandoffConflict extends Error {}
async function reviewIsCurrent(review:Awaited<ReturnType<typeof workflowHandoff>>) {
  return fingerprint(await readReviews())===review.reviewStamp
    && fingerprint((await json("artifacts/card-orchestrator/asking-price-approvals.json",true))?.approvals??[])===review.approvalStamp;
}
async function withReviewedQueue<T>(ids:string[]|undefined,fn:(state:QueueState,review:Awaited<ReturnType<typeof workflowHandoff>>)=>Promise<T>|T) {
  for(let attempt=0;;attempt++) {
    const review=await timed("review.handoff",()=>workflowHandoff(ids));
    try {
      return await withQueue(directory,async state=>{
        if(state.revision!==review.revision)throw new WorkflowHandoffConflict("Queue changed during workflow handoff; refresh again");
        if(fingerprint(await readReviews())!==review.reviewStamp)throw new WorkflowHandoffConflict("Workflow decision changed during handoff; refresh again");
        if(fingerprint((await json("artifacts/card-orchestrator/asking-price-approvals.json",true))?.approvals??[])!==review.approvalStamp)throw new WorkflowHandoffConflict("Asking-price approval changed during handoff; refresh again");
        return fn(state,review);
      });
    } catch(error) {if(!(error instanceof WorkflowHandoffConflict)||attempt>=2)throw error;}
  }
}
function reviewedPricingContext(state:QueueState,id:string,review:Awaited<ReturnType<typeof workflowHandoff>>) {
  const now=new Date().toISOString(),card=flowPacket(state,[id],now,review.approvals,{},review.decisions).cards[0];
  return {...pricingContext(state,id,now),savedSourceCandidates:savedSourceCandidates(id,card.identity??undefined),manualAskingPrice:card.pricing.manualOverride,
    approvedAskingPrice:card.pricing.approvedProposal,draftAskingPrice:card.pricing.draftProposal,priceReviewStage:card.pricing.reviewStage,sellerHold:card.sellerHold};
}
function requireNoSellerHold(ids:string[],holds:Record<string,string>) {
  for(const id of ids)if(holds[id])throw new Error(`Seller hold for ${id}: ${holds[id]}`);
}
function kindOption(required=false):JobKind|undefined {
  const value=option("kind");if(!value&&!required)return undefined;
  if(!kinds.includes(value as JobKind))throw new Error("kind must be photos, identity, reconcile, pricing or listing");return value as JobKind;
}
async function json(file:string,optional=false):Promise<any> {
  try{return JSON.parse(await fs.readFile(path.resolve(root,file),"utf8"));}
  catch(error){if(optional&&(error as NodeJS.ErrnoException).code==="ENOENT")return null;throw error;}
}
async function savedReceiptRows():Promise<SavedReceiptRow[]> {
  const directories=await fs.readdir(path.join(root,"artifacts"),{withFileTypes:true});
  const files=receiptManifestPaths(directories.filter(d=>d.isDirectory()).map(d=>d.name));
  const rows:SavedReceiptRow[]=[];
  for(const source of files) {
    const data=await json(source,true);if(!data)continue;
    rows.push(...receiptManifestRows(data,source));
  }
  return rows;
}
async function sync() {
  const [identities,pricing,pilot,receipts]=await Promise.all([json("artifacts/identity-queue/cards.json"),json("artifacts/pricing-queue/queue-state.json"),json("artifacts/bulk-listing-test-20261018/preflight-result.json",true),savedReceiptRows()]);
  if(!Array.isArray(identities?.cards)||!Array.isArray(pricing?.cards)||!Array.isArray(pricing?.comps))throw new Error("Legacy queue schema changed; stop instead of guessing");
  const receiptIndex=prepareSavedReceipts(receipts);
  const identityMap=new Map<string,unknown>(identities.cards.map((i:any)=>[i.card_id,i]));
  const prices=new Map<string,unknown>(pricing.cards.map((i:any)=>[i.card_id,i]));
  const observations=new Map<string,unknown>((pilot?.records??[]).map((i:any)=>[i.cardId,i]));
  const comps=new Map<string,unknown[]>();
  for(const c of pricing.comps){const a=comps.get(c.card_id)??[];a.push(c);comps.set(c.card_id,a);}
  const sourceLabel=(id:string)=>{
    const source=identityMap.get(id) as Record<string,unknown>|undefined;
    return {sku:typeof source?.source_key==="string"?source.source_key:undefined,player:typeof source?.player==="string"?source.player:undefined};
  };
  return withQueue(directory,async state=>{
    // Refresh this queue's existing cards first. New imports are bounded; the first run seeds the reviewed ten-card pilot.
    const initial=Object.keys(state.cards).length===0;
    const existing=Object.keys(state.cards);
    // Backfill display metadata without retrying or clearing the underlying hold.
    for(const [id,rejected] of Object.entries(state.rejectedImports??{}))if(identityMap.has(id))Object.assign(rejected,sourceLabel(id));
    const sourceKey=(id:string)=>fingerprint(["per-card-receipts-v1",identityMap.get(id)??null,prices.get(id)??null,savedReceiptDependencies(identityMap.get(id),receiptIndex)]);
    // Upgrade only a legacy cache entry proven to match the current source snapshot; never assume a changed hold is unchanged.
    const legacyReceiptGeneration=fingerprint(receipts);
    for(const [id,rejected] of Object.entries(state.rejectedImports??{})) {
      const legacyKey=fingerprint([identityMap.get(id)??null,prices.get(id)??null,legacyReceiptGeneration]);
      if(rejected.inputKey===legacyKey)rejected.inputKey=sourceKey(id);
    }
    // The intake capability changed only for incomplete identities. Other unchanged exceptions stay cached.
    const eligible=(id:string)=>!state.cards[id]&&(state.rejectedImports?.[id]?.inputKey!==sourceKey(id)
      ||partialIdentityRejectionReasons.includes(state.rejectedImports?.[id]?.reason??""));
    const requested=command==="sync"?option("cards").split(",").map(id=>id.trim()).filter(Boolean):[];
    if(requested.length && (!args.includes("--new") || requested.length>limit || new Set(requested).size!==requested.length || requested.some(id=>!identityMap.has(id))))throw new Error("Targeted sync requires --new and distinct source card IDs within --limit");
    const proposed=requested.length?requested.filter(eligible):initial&&observations.size?Array.from(observations.keys()).filter(eligible):args.includes("--new")?identities.cards.map((i:any)=>String(i.card_id)).filter(eligible):[];
    const ids=Array.from(new Set<string>([...existing,...proposed.slice(0,limit)]));
    const result={examined:ids.length,changed:0,skipped:[] as {id:string;reason:string}[]};
    for(const id of ids){try{
      // Scanner captures have no legacy row; retain their input while still adopting saved receipts.
      const scannerInput=!identityMap.has(id)&&state.cards[id]?.input.source.startsWith("scanner-intake:")?state.cards[id].input:undefined;
      const input=applySavedReceipts(scannerInput??importLegacyCard(identityMap.get(id),prices.get(id),comps.get(id)??[],observations.get(id)),receiptIndex);
      if(upsertCard(state,input))result.changed++;
      if(state.rejectedImports)delete state.rejectedImports[id];
    }catch(error){const reason=error instanceof Error?error.message:String(error);result.skipped.push({id,reason});quarantineImport(state,id,reason);state.rejectedImports??={};state.rejectedImports[id]={inputKey:sourceKey(id),reason,...sourceLabel(id)};}}
    await fs.writeFile(path.join(directory,"last-sync.json"),JSON.stringify({...result,at:new Date().toISOString(),sourceGeneration:identities.generation},null,2));
    return result;
  });
}
async function automatic(kind:"photos"|"listing") {
  return runAutomaticBatch(kind,limit,{
    claim:excludeIds=>timed(`${kind}.claim`,()=>withReviewedQueue(option("card")?[option("card")]:undefined,(s,r)=>claimJob(s,worker,kind,option("card")||undefined,new Date().toISOString(),r.holds,excludeIds))),
    prepare:claim=>timed(`${kind}.prepare`,async()=>kind==="photos"?{hashes:await Promise.all(claim.card.photos.map(async p=>({side:p.side,sha256:createHash("sha256").update(await fs.readFile(p.path)).digest("hex")}))),evidence:"Read retained original files and independently recomputed SHA-256; no image files changed."}:{prepare:true}),
    complete:(claim,result)=>timed(`${kind}.complete`,()=>withReviewedQueue([claim.card.id],(s,r)=>completeAutomaticJob(s,claim,result,new Date().toISOString(),r.holds))),
  });
}
const escape=(v:unknown)=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
function renderReports(state:QueueState,review:Awaited<ReturnType<typeof workflowHandoff>>,reportSnapshot:ReportSnapshot) {
  const now=reportSnapshot.asOf,handoff=reportHandoff(state,now,review.approvals,review.decisions);
  const summary=queueSummary(state,now,review.holds,handoff.cards.filter(c=>c.pricing.approved).map(c=>c.id));
  const byId=new Map(handoff.cards.map(card=>[card.id,card]));
  const importHtml=summary.importExceptions.length?summary.importExceptions.map(x=>`<p><strong>${escape(x.player||x.sku||x.id)}</strong>${x.sku?` · ${escape(x.sku)}`:""}<br>${escape(x.reason)}</p>`).join(""):"<p>None</p>";
  const reviews=handoff.listings;
  const draftHtml=`<section><h2>Prepared for your review</h2>${reviews.length?reviews.map((r:any)=>`<article><h3>${escape(r.title)}</h3><p>${r.pricing?`Proposed item $${Number(r.pricing.item).toFixed(2)} · Buyer shipping $${Number(r.pricing.shipping).toFixed(2)} · ${r.manualAskingPrice?"Seller-entered asking price; sold evidence unchanged":!r.pricingEvidenceValidated?"Sold evidence validation remains incomplete":r.priceBasis==="seller-asking"?"Current seller asking price (not sold evidence)":r.priceBasis==="active-lowest"?"Active-listing estimate":r.priceBasis==="related-print-run"?"Related numbered-parallel estimate":r.reviewEstimate?"Review estimate; sold evidence or condition differs":"Validated sold evidence"} · ${r.priceNeedsReview?"Review price in eBay draft":"Asking price approved"}`:"Price awaiting defensible sold evidence"}</p>${r.priceBasis==="related-print-run"?(r.priceBasisDetails??[]).map((b:any)=>`<p><small>Source sold item $${Number(b.itemPrice).toFixed(2)} × ${escape(b.sourcePrintRun)}/${escape(b.targetPrintRun)} × ${Number(b.premiumMultiplier??1)} feature adjustment = $${Number(b.adjustedItemPrice).toFixed(4)} before premium and rounding · <a href="${escape(b.sourceUrl)}">Source sale ${escape(b.saleId)}</a></small></p>`).join(""):""}<p>${escape(r.description)}</p><small>SKU ${escape(r.sku)} · Quantity 1 · ${escape(r.condition)} · Shipping eligibility and final inventory reconciliation must be confirmed.</small></article>`).join(""):"<p>No local listing drafts yet.</p>"}</section>`;
  const rows=summary.cards.map(c=>{
    const decision=byId.get(c.id)!,p=decision.pricing;
    const asking=(p.approvedProposal??p.validatedProposal??p.agentProposal) as {item:number;shipping:number|null}|null;
    const pricing=`<div><b>${p.approved?"Approved asking price":"Price proposal"}:</b> ${asking?`item $${asking.item.toFixed(2)} · buyer shipping ${asking.shipping===null?"unknown":`$${asking.shipping.toFixed(2)}`}`:"No usable price supplied"}<small>${escape(p.reason)}</small><small>Next: ${escape(decision.nextOwner)} · ${escape(decision.nextAction)}</small><small>${escape(p.savedOnEbay)}</small><small>${escape(decision.blockers.join("; "))}</small></div>`;
    const jobs=c.jobs.filter(j=>!c.existingReceipt||j.kind==="pricing").map(j=>`<div><b>${escape(j.kind)}</b>: ${escape(j.state)} ${j.reason?`— ${escape(j.reason)}`:""}${j.blockers.length?`<small>${escape(j.blockers.join("; "))}</small>`:""}</div>`).join("");
    const receipt=c.existingReceipt?`Saved ${escape(c.existingReceipt.disposition)} receipt ${escape(c.existingReceipt.itemId)}; excluded from new listings${c.receiptConflicts.length?`<small>Receipt ${escape(c.receiptConflicts.join(", "))} is also recorded for another card. Verify the current draft identity before resuming; no new listing.</small>`:""}`:"";
    return `<tr><td><strong>${escape(c.player)}</strong><br>${escape(c.serial)}<br><small>${escape(c.sku)}</small></td><td>${receipt}${pricing}${jobs}</td></tr>`;
  }).join("");
  const html=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Card workflow status</title><style>body{font:16px/1.6 system-ui;max-width:1050px;margin:40px auto;padding:0 24px;background:#f5f7fa;color:#182634}h1{line-height:1.2}section{background:white;padding:24px;border-radius:14px;margin:20px 0}table{width:100%;border-collapse:collapse}td,th{text-align:left;vertical-align:top;padding:16px;border-bottom:1px solid #dfe5ec}small{display:block;color:#526272}b{font-weight:600}.stats{display:flex;gap:28px;flex-wrap:wrap}.stats strong{font-size:32px;display:block}</style><h1>Your card workflow</h1><p>Saved ${escape(summary.asOf)} · Local preparation · Seller imaydit58</p><section class="stats">${[[summary.counts.cards,"cards in pilot"],[summary.counts.alreadyListed,"existing listings / drafts"],[summary.counts.localListingsPrepared,"local listing drafts"],[summary.counts.heldJobs,"held tasks"],[summary.counts.importExceptions,"import holds"],[0,"ready to upload"]].map(([n,l])=>`<div><strong>${n}</strong>${l}</div>`).join("")}</section><section><h2>What runs automatically</h2><p>Import changes → check original files → queue visual and comp reviews → prepare listing text → record results. A stopped worker can resume; a completed task is reused until its evidence changes.</p><p>Visual identification and sold-comp research are performed by Codex using the original images and supported research tools. There is no unattended image-recognition or sold-data service connected.</p><p>Eligible work: ${summary.execution.automaticLocal} automatic local jobs · ${summary.execution.identityReview} identity reviews · ${summary.execution.pricingReview} pricing reviews · ${summary.execution.inventoryReview} inventory reviews · ${summary.execution.recoverableInventoryHolds} recoverable inventory holds. These counts do not imply connected external automation.</p><h2>Current limits</h2><ul>${summary.globalHolds.map(h=>`<li>${escape(h)}</li>`).join("")}</ul><p>Review export: review-listings.json. Every action is blank; no upload or publication is possible through this runner.</p></section><section><h2>Card queue</h2><table><thead><tr><th>Card</th><th>Progress and exceptions</th></tr></thead><tbody>${rows}</tbody></table></section><section><h2>Import exceptions</h2><p>Unresolved source records remain here until corrected; unchanged holds are not retried.</p>${importHtml}</section></html>`;
  return {files:{
    "status.json":JSON.stringify({...summary,reportSnapshot,cards:summary.cards.map(card=>({...card,pricing:byId.get(card.id)!.pricing,nextOwner:byId.get(card.id)!.nextOwner,nextAction:byId.get(card.id)!.nextAction,draft:byId.get(card.id)!.draft,handoffBlockers:byId.get(card.id)!.blockers}))},null,2),
    "review-listings.json":JSON.stringify({mode:state.mode,reportSnapshot,canUpload:false,canPublish:false,listings:reviews},null,2),
    "status.html":html.replace("</html>",`${draftHtml}</html>`).replace("<h1>Your card workflow</h1>",`<h1>Your card workflow</h1><p>Queue revision ${reportSnapshot.queueRevision} · Report ${escape(reportSnapshot.reportId)}</p>`),
  },result:{counts:summary.counts,globalHolds:summary.globalHolds,report:path.join(directory,"status.html")}};
}
async function reports() {
  const {result,...publication}=await writeQueueReport(directory,{read:()=>workflowHandoff(),isCurrent:reviewIsCurrent},renderReports);
  return {...result,...publication};
}
async function main() {
  switch(command){
    case "bulk-ai-begin":return withReviewedQueue(option("cards").split(','),(s,r)=>{
      const ids=option("cards").split(',');requireNoSellerHold(ids,r.holds);
      return beginBulkAi(s,ids,worker,option("token"),option("evidence"));
    });
    case "bulk-ai-observe":{
      const rows=await json(option('file'));
      return withQueue(directory,s=>observeBulkAi(s,option('submission'),rows,worker,option('token')));
    }
    case "bulk-ai-status":return bulkAiStatus(await readQueue(directory),option('submission'));
    case "bulk-ai-checkpoint":{
      const checkpoint=bulkCheckpointSchema.parse(await json(option('file')));
      const bytes=await fs.readFile(path.resolve(root,checkpoint.evidence));
      if(!bytes.length)throw Error('Bulk checkpoint requires retained nonempty evidence');
      const hash=createHash('sha256').update(bytes).digest('hex');
      return withQueue(directory,s=>checkpointBulkAi(s,option('submission'),checkpoint,hash,worker,option('token')));
    }
    case "prepare-unpriced-batch": {
      const ids=option("cards").split(",").filter(Boolean),inventory=await json(option("file"));
      if(!args.includes("--seller-request")||!ids.length||ids.length>50||new Set(ids).size!==ids.length||option("evidence").length<20)throw Error("Explicit seller request, evidence and 1–50 distinct cards required");
      return withReviewedQueue(ids,(s,r)=>{
        requireNoSellerHold(ids,r.holds);
        return ids.map(id=>{
          const c=s.cards[id];if(!c||c.input.knownDraft||c.input.knownLive||c.exclusion)throw Error("New reviewed captures only; resume existing receipts separately");
          deferDraftPricing(s,id,"",option("evidence"),new Date().toISOString(),true);
          for(const kind of ["reconcile","listing"] as const){
            if(c.jobs[kind].state==="done")continue;
            const claim=c.jobs[kind].state==="leased"&&c.jobs[kind].lease?.owner===worker?{job:c.jobs[kind]}:claimJob(s,worker,kind,id,new Date().toISOString(),r.holds);
            if(!claim?.job.lease)throw Error("No owned "+kind+" claim for "+id);
            completeJob(s,id,kind,claim.job.lease.token,{outcome:"done",data:kind==="reconcile"?inventory:{prepare:true}},new Date().toISOString(),r.holds);
          }
          return {id,pricing:"seller-requested blank",reconcile:c.jobs.reconcile.state,listing:c.jobs.listing.state};
        });
      });
    }
    case "pricing-defer":return withReviewedQueue([option("card")],(s,r)=>{
      requireNoSellerHold([option("card")],r.holds);
      return deferDraftPricing(s,option("card"),option("started-at"),option("evidence"),new Date().toISOString(),args.includes("--seller-request"));
    });
    case "draft-group-begin": {
      const ids=option("cards").split(",").filter(Boolean);
      return withReviewedQueue(ids,(s,r)=>{
        const packet=flowPacket(s,ids,new Date().toISOString(),r.approvals,{},r.decisions);
        const contexts=Object.fromEntries(packet.cards.map(c=>[c.id,{approved:c.pricing.approved,draftAuthorized:c.pricing.draftAuthorized,price:c.pricing.draftProposal as {item:number;shipping:number|null}|null,sellerHold:c.sellerHold}]));
        return beginDraftGroup(s,option("group"),ids,worker,option("token"),contexts,option("evidence"),new Date().toISOString(),process.argv.includes("--representative-photos"));
      });
    }
    case "draft-group-observe": {
      const observation=await json(option("file"));
      return withQueue(directory,s=>observeDraftGroup(s,option("group"),observation,worker,option("token")));
    }
    case "writer-configure":return withQueue(directory,s=>configureDraftWriter(s,worker,option("cards").split(",").filter(Boolean),option("evidence"),new Date().toISOString(),{allowCreate:args.includes("--allow-create"),authority:option("authority"),archiveMode:args.includes("--move-originals")?"move":"copy-only"}));
    case "writer-claim":return withQueue(directory,s=>claimDraftWriter(s,worker,option("token")||undefined));
    case "writer-release":return withQueue(directory,s=>{releaseDraftWriter(s,worker,option("token"));return {released:true};});
    case "authorize-draft-archives":return withQueue(directory,s=>{const authority=option("authority");if(authority.trim().length<20)throw Error("Explicit draft photo move authority required");if(s.draftWriter?.lease&&Date.parse(s.draftWriter.lease.expiresAt)>Date.now())throw Error("Active writer lease; retry after its handoff");s.draftArchiveAuthority={evidence:authority,at:new Date().toISOString()};s.events.push({at:new Date().toISOString(),cardId:"*",kind:"draft",event:"draft-archive-authorized",detail:authority});return s.draftArchiveAuthority;});
    case "finish-archive":return withReviewedQueue([option("card")],async(s,r)=>{
      const id=option("card");requireDraftWriter(s,worker,option("token"),id);
      if(option("authority").trim().length<20)throw Error("Explicit seller source-removal authority required");
      const result=await finishPhotoMove(s,id,photoSourceRoots(),r.holds[id],!!r.decisions[id]?.manualPrice);
      s.events.push({at:new Date().toISOString(),cardId:id,kind:"draft",event:"archive-move-authorized",detail:option("authority")});return result;
    });
    case "draft-observe":{
      const raw=await json(option("file")),observations=Array.isArray(raw)?raw:[raw];
      if(!observations.length||observations.length>50)throw Error("Observe 1–50 exact drafts");
      return withQueue(directory,s=>observations.map(observation=>({cardId:observation.cardId,recorded:observeDraft(s,observation)})));
    }
    case "draft-bindings":{
      const s=await readQueue(directory);return option("cards").split(",").map(id=>({id,sku:s.cards[id]?.input.sku,binding:draftBinding(s.cards[id])}));
    }
    case "draft-next":case "draft-dispatch":{
      const ids=option("cards").split(",").filter(Boolean);
      return withReviewedQueue(ids.length?ids:undefined,(s,r)=>{
        const selected=ids.length?ids:s.draftWriter?.scope??[];
        const packet=flowPacket(s,selected,new Date().toISOString(),r.approvals,{},r.decisions);
        if(command==="draft-dispatch"){
          for(const id of selected)requireDraftWriter(s,worker,option("token"),id);
          const actionable=packet.cards.filter(c=>c.draft&&!["seller-hold","excluded-existing-inventory","held-until-new-evidence","outside-reliability-batch","draft-complete-awaiting-publication-handoff","unpriced-draft-awaiting-seller-review"].includes(c.draft.action));
          const next=actionable.find(c=>c.draft?.action==="reconcile-write-outcome")??actionable[0];
          return {task:next?{...next,binding:draftBinding(s.cards[next.id])}:null,
            remaining:actionable.length,sellerDecisions:packet.cards.filter(c=>c.draft?.action==="seller-hold").map(c=>({id:c.id,price:c.pricing.draftProposal,blockers:c.blockers})),
            canPublish:false,instruction:"Execute only the returned action. Before browser edits call draft-begin. Store generated/saved IDs immediately via draft-observe. Verify with draft-verify; record verified photo receipts and finish archives. One focused recovery, then draft-hold and dispatch the next card. Never recreate, publish, broaden scope, or repeat an unchanged hold."};
        }
        return {writer:s.draftWriter,canPublish:false,cards:packet.cards.map(c=>({id:c.id,sku:c.sku,approvedPrice:c.pricing.approvedProposal,priceApproved:c.pricing.approved,draftPrice:c.pricing.draftProposal,priceReviewStage:c.pricing.reviewStage,...c.draft})),learning:s.draftLearning??{}};
      });
    }
    case "draft-begin":case "draft-verify":case "draft-verify-unpriced":{
      const id=option("card"),expected=command==="draft-verify"?await json(option("expected")):null,capture=command!=="draft-begin"?await json(option("capture")):null;
      if(capture?.visual){
        if(!option("screenshot"))throw Error("--screenshot is required for visual verification");
        if(createHash("sha256").update(await fs.readFile(path.resolve(root,option("screenshot")))).digest("hex")!==capture.visual.screenshotSha256)throw Error("Visual screenshot hash mismatch");
      }
      const result=await withReviewedQueue([id],(s,r)=>{
        const c=flowPacket(s,[id],new Date().toISOString(),r.approvals,{},r.decisions).cards[0];
        const context={approved:c.pricing.approved,draftAuthorized:c.pricing.draftAuthorized,price:c.pricing.draftProposal?{item:(c.pricing.draftProposal as {item:number}).item,shipping:(c.pricing.draftProposal as {shipping:number|null}).shipping}:null,sellerHold:c.sellerHold};
        if(command==="draft-begin"&&s.draftModelWorkflows?.[id])return beginDraftModelSave(s,id,worker,option("token"),c.sellerHold,(c.pricing.manualOverride??c.pricing.workflowApproval??s.cards[id].input.override??null) as {item:number;shipping:number|null}|null);
        if(s.draftModelWorkflows?.[id]&&!c.pricing.draftAuthorized)throw Error("Independent draft pricing reviews and authorization remain incomplete");
        if(command==="draft-verify")requireDraftWriter(s,worker,option("token"),id);
        if(command==="draft-verify-unpriced") {requireDraftWriter(s,worker,option("token"),id);return verifyUnpricedDraft(s,id,capture,context,option("evidence",option("capture")));}
        return command==="draft-begin"?beginDraftWrite(s,id,worker,option("token"),context):verifyDraft(s,id,expected,capture,context,option("evidence",option("capture")));
      });
      if("photoIdentityVerified" in result&&result.photoIdentityVerified&&!args.includes("--verify-only")){
        const source=option("capture"),evidence=`Saved original-photo/identity check ${result.captureHash}; ${source}`;
        const saved=await readQueue(directory),prior=Object.values(saved.verifiedReceipts??{}).find(v=>v.cardId===id&&v.draftId===result.draftId&&v.evidence===evidence);
        const captureSku=saved.cards[id].input.sku;
        const observation=prior??{observationId:randomUUID(),seller:"imaydit58",cardId:id,sku:captureSku,
          frontHash:result.expected.originalHashes[0],backHash:result.expected.originalHashes[1],identityKey:result.identityKey,
          draftId:result.draftId,observedAt:capture.capturedAt,photosVerified:true,source,evidence};
        await withQueue(directory,s=>recordVerifiedReceipt(s,observation));
        try{return {...result,archive:await movePhotos({cardId:id,draftId:result.draftId,sku:captureSku,seller:"imaydit58",observedAt:observation.observedAt,source:`https://www.ebay.com/sl/list?draft_id=${result.draftId}`},args.includes("--copy-only"))};}
        catch(error){const reason=error instanceof Error?error.message:String(error);await withQueue(directory,s=>{s.photoArchiveFailures??={};s.photoArchiveFailures[id]={at:new Date().toISOString(),reason};});return {...result,archive:"pending",archiveError:reason};}
      }
      return result;
    }
    case "draft-hold":return withQueue(directory,s=>{holdDraft(s,option("card"),worker,option("token"),option("reason"),option("evidence"));return {held:option("card")};});
    case "draft-recover":return withQueue(directory,s=>{recoverDraft(s,option("card"),option("evidence"));return {recovered:option("card")};});
    case "pricing-evidence": {
      const evidence=await json(option("file"));
      return withReviewedQueue([option("card")],(s,r)=>{requireNoSellerHold([option("card")],r.holds);return admitPricingEvidence(s,option("card"),evidence);});
    }
    case "correct-prices": {
      const ids=option("cards",option("card")).split(",").map(id=>id.trim()).filter(Boolean);
      const authority=option("authority"),apply=args.includes("--apply");
      return withReviewedQueue(ids,(s,r)=>{if(apply)requireNoSellerHold(ids,r.holds);return correctSavedPrices(s,ids,authority,apply);});
    }
    case "sync":return sync();
    case "work-plan": {
      const review=await workflowHandoff(),state=await readQueue(directory);
      if(state.revision!==review.revision || !await reviewIsCurrent(review))throw Error("Queue/review changed; refresh work plan");
      const handoff=reportHandoff(state,new Date().toISOString(),review.approvals,review.decisions);
      const summary=queueSummary(state,new Date().toISOString(),review.holds,handoff.cards.filter(c=>c.pricing.approved).map(c=>c.id));
      const engineering=await json("artifacts/engineering-mission/work-queue.json",true);
      return pipelineWorkPlan(state,summary,engineering?.tasks??[],limit);
    }
    case "status":case "export-review":return reports();
    case "claim":return withReviewedQueue(option("card")?[option("card")]:undefined,(s,r)=>{
      const now=new Date().toISOString();
      // Resolve approvals only for otherwise eligible recovery candidates, not the whole inventory per claim.
      const claim=claimJob(s,worker,kindOption(),option("card")||undefined,now,r.holds,[],
        card=>flowPacket(s,[card.input.id],now,r.approvals,{},r.decisions).cards[0].pricing.approved);
      return claim?{...claim,pricingContext:claim.job.kind==="pricing"?reviewedPricingContext(s,claim.card.id,r):undefined}:null;
    });
    case "archive-photos":{
      if(!option("file"))throw new Error("--file containing a fresh live observation is required");
      const observation=await json(option("file"));
      return movePhotos(observation);
    }
    case "model-pricing-budget":{
      const raw=await json(option("file")),engineering=await json("artifacts/engineering-mission/work-queue.json");
      const instruction=engineering.instructions?.find((i:{id:string})=>i.id===raw?.authority);
      return withQueue(directory,s=>configureDraftModelBudget(s,raw,instruction));
    }
    case "model-pricing-admit":case "model-pricing-status":case "model-pricing-claim":case "model-pricing-result":case "model-pricing-authorize":case "model-pricing-finish":case "model-pricing-run":{
      const id=option("card"),raw=option("file")?await json(option("file")):null;
      const transact=<T>(fn:(s:QueueState,ctx:{sellerHold?:string|null;sellerPrice?:{item:number;shipping:number|null}|null})=>T)=>withReviewedQueue([id],(s,r)=>{
        const c=flowPacket(s,[id],new Date().toISOString(),r.approvals,{},r.decisions).cards[0];
        if(!c)throw Error("Unknown card");
        const sellerPrice=(c.pricing.manualOverride??c.pricing.workflowApproval??s.cards[id].input.override??null) as {item:number;shipping:number|null}|null;
        return fn(s,{sellerHold:c.sellerHold,sellerPrice});
      });
      if(command==="model-pricing-run"){
        const nextEnv=await import("@next/env"); nextEnv.default.loadEnvConfig(process.cwd());
        return runDraftModelStage(id,option("role") as "proposal"|"muse",worker,transact);
      }
      return transact((s,ctx)=>{
        const {sellerHold,sellerPrice}=ctx,role=option("role") as "proposal"|"muse"|"baxter";
        if(command==="model-pricing-admit")return admitDraftModelWorkflow(s,id,raw,sellerHold,sellerPrice);
        if(command==="model-pricing-status")return draftModelStatus(s,id,sellerHold,sellerPrice);
        if(command==="model-pricing-claim"){
          if(role!=="baxter")throw Error("Grok and Muse dispatch through model-pricing-run with durable budget admission");
          if(!s.baxterReviewConnection)throw Error("Baxter return path is unverified; retain waiting state");
          return claimDraftModelStage(s,id,role,worker,sellerHold,sellerPrice);
        }
        if(command==="model-pricing-result"){
          if(role!=="baxter")throw Error("API results must come through the guarded model runner");
          return completeDraftModelStage(s,id,role,option("token"),raw?.finding,raw?.provenance,sellerHold,sellerPrice);
        }
        if(command==="model-pricing-authorize")return authorizeDraftModelPrice(s,id,sellerHold,sellerPrice);
        return finishDraftModelSave(s,id,worker,option("token"),sellerHold,sellerPrice);
      });
    }
    case "pricing-context":{
      if(!option("card"))throw new Error("--card is required");
      await sync();
      return withReviewedQueue([option("card")],(s,r)=>reviewedPricingContext(s,option("card"),r));
    }
    case "preflight":{
      const ids=option("cards",option("card")).split(",").map(id=>id.trim()).filter(Boolean);
      if(!ids.length)throw new Error("Select exact card IDs with --card or --cards; no implicit whole-inbox batch");
      await sync();
      return withReviewedQueue(ids,async (s,r)=>{
        const packet=applyDraftHandoffHolds(flowPacket(s,ids,new Date().toISOString(),r.approvals,{},r.decisions),
          await json('artifacts/card-orchestrator/draft-handoff-holds.json'));
        await fs.writeFile(path.join(directory,"handoff.json"),JSON.stringify(packet,null,2));
        await fs.writeFile(path.join(directory,"handoff.html"),flowHtml(packet));
        return packet;
      });
    }
    case "complete":{
      const kind=kindOption(true)!;if(!option("result"))throw new Error("--result JSON file required");
      const result=await json(option("result"));
      return withReviewedQueue([option("card")],(s,r)=>{completeJob(s,option("card"),kind,option("token"),result,new Date().toISOString(),r.holds);return {completed:option("card"),kind};});}
    case "recover-photo-write": {
      const id=option("card");if(!id)throw new Error("--card is required");
      const snapshot=await readQueue(directory),c=snapshot.cards[id];if(!c)throw new Error("Unknown card");
      const observed={inputKey:c.jobs.photos.inputKey,reason:c.jobs.photos.reason,hashes:await Promise.all(c.input.photos.map(async p=>({side:p.side,sha256:createHash("sha256").update(await fs.readFile(p.path)).digest("hex")})))};
      return withReviewedQueue([id],(s,r)=>{recoverPhotoWriteFailure(s,id,observed,new Date().toISOString(),r.holds);return {recovered:id,kind:"photos"};});
    }
    case "recover-expired-identity": {
      const id=option("card"),snapshot=await readQueue(directory),c=snapshot.cards[id];
      if(!c||!option("snapshot")||!option("result"))throw Error("--card, --snapshot and --result required");
      const observed={snapshot:option("snapshot"),result:await json(option("result")),hashes:await Promise.all(c.input.photos.map(async p=>({side:p.side,sha256:createHash("sha256").update(await fs.readFile(p.path)).digest("hex")})))};
      return withReviewedQueue([id],(s,r)=>{recoverExpiredIdentity(s,id,observed,new Date().toISOString(),r.holds);return {recovered:id,kind:"identity"};});
    }
    case "reopen-identity":return withReviewedQueue([option("card")],(s,r)=>{reopenIdentityReview(s,option("card"),option("snapshot"),option("evidence"),new Date().toISOString(),r.holds,option("draft")||undefined);return {reopened:option("card")};});
    case "retry":return withReviewedQueue([option("card")],(s,r)=>{requireNoSellerHold([option("card")],r.holds);retryHeld(s,option("card"),kindOption(true)!,option("evidence"));return {requeued:option("card")};});
    case "recover-inventory-access": { const packet=await json(option("file"));return withReviewedQueue([option("card")],(s,r)=>recoverInventoryAccessHold(s,option("card"),packet,new Date().toISOString(),r.holds)); }
    case "classify-hold": {
      const result=await json(option("file"));
      return withReviewedQueue([option("card")],(s,r)=>{setHoldRecovery(s,option("card"),result,new Date().toISOString(),r.holds);return {classified:option("card")};});
    }
    case "inventory-access": {
      const observation=await json(option("file"));
      return withQueue(directory,s=>({recorded:recordInventoryAccess(s,observation)}));
    }
    case "record-known-inventory": {
      const observation=await json(option("file"));
      const recorded=await withQueue(directory,s=>({recorded:recordKnownInventoryObservation(s,observation)}));
      if(observation.disposition!=="sold")return recorded;
      try{return {...recorded,archive:await movePhotos({cardId:observation.cardId,soldItemId:observation.itemId,sku:observation.sku,seller:observation.seller,observedAt:observation.observedAt,source:observation.source})};}
      catch(error){const reason=error instanceof Error?error.message:String(error);await withQueue(directory,s=>{s.photoArchiveFailures??={};s.photoArchiveFailures[observation.cardId]={at:new Date().toISOString(),reason};});return {...recorded,archive:"pending",archiveError:reason};}
    }
    case "reconcile-active-serial": {
      const packet=await json(option("file"));
      return withReviewedQueue([packet.cardId],(s,r)=>reconcileActiveSerial(s,packet,new Date().toISOString(),r.holds));
    }
    case "group-recovery-begin": case "group-recovery-observe": case "group-recovery-finish": {
      const raw=await json(option('file')),snapshot=await readQueue(directory),ids=command==='group-recovery-begin'?raw.members:snapshot.draftGroupRecoveries?.[option('id')]?.packet.members;
      if(!ids?.length)throw Error('Exact group required');
      return withReviewedQueue(ids,(s,r)=>{requireNoSellerHold(ids,r.holds);return command==='group-recovery-begin'?beginGroupRecovery(s,raw,worker,option('token')):command==='group-recovery-observe'?observeGroupRecovery(s,option('id'),raw,worker,option('token')):finishGroupRecovery(s,option('id'),raw,worker,option('token'));});
    }
    case "draft-append-begin": case "draft-append-finish": {
      const raw=await json(option('file')),snapshot=await readQueue(directory),p=command==='draft-append-begin'?raw:snapshot.draftAppends?.[option('id')]?.packet;
      if(!p)throw Error('Append intent required');const ids=[...p.existing,...p.added];
      return withReviewedQueue(ids,(s,r)=>{requireNoSellerHold(ids,r.holds);return command==='draft-append-begin'?beginDraftAppend(s,raw,worker,option('token')):finishDraftAppend(s,option('id'),raw,worker,option('token'));});
    }
    case "draft-consolidation-begin": {
      const packet=await json(option('file'));
      return withReviewedQueue(packet.groups.flatMap((g:{members:{cardId:string}[]})=>g.members.map(m=>m.cardId)),(s,r)=>{if(Object.values(r.holds).some(Boolean))throw Error('Seller hold blocks consolidation');return beginDraftConsolidation(s,packet,worker,option('token'));});
    }
    case "draft-consolidation-finish": {
      const proof=await json(option('file'));
      return withQueue(directory,s=>({completed:finishDraftConsolidation(s,option('id'),proof,worker,option('token'))}));
    }
    case "record-quantity-group": {
      const observation=await json(option("file"));
      const recorded=await withQueue(directory,s=>({recorded:recordQuantityReceiptGroup(s,observation)}));
      const archives=[];
      for(const member of observation.members) {
        try {archives.push({cardId:member.cardId,archive:await movePhotos({cardId:member.cardId,liveItemId:observation.liveItemId,sku:member.sku,seller:observation.seller,observedAt:observation.observedAt,source:observation.source})});}
        catch(error){const reason=error instanceof Error?error.message:String(error);await withQueue(directory,s=>{s.photoArchiveFailures??={};s.photoArchiveFailures[member.cardId]={at:new Date().toISOString(),reason};});archives.push({cardId:member.cardId,archive:'pending',reason});}
      }
      return {...recorded,archives};
    }
    case "record-receipt": {
      if(!option("file"))throw new Error("--file verified receipt JSON required");
      const observation=await json(option("file"));
      const recorded=await withQueue(directory,s=>({recorded:recordVerifiedReceipt(s,observation),cardId:observation.cardId}));
      try{return {...recorded,archive:await movePhotos({cardId:observation.cardId,liveItemId:observation.liveItemId,
        ...(!observation.liveItemId?{draftId:observation.draftId}:{}),
        sku:observation.sku,observedAt:observation.observedAt,seller:observation.seller,source:observation.liveItemId?`https://www.ebay.com/itm/${observation.liveItemId}`:`https://www.ebay.com/sl/list?draft_id=${observation.draftId}`})};}
      catch(error){const reason=error instanceof Error?error.message:"Archive failed; verified live receipt retained";
        await withQueue(directory,s=>{s.photoArchiveFailures??={};if(s.photoArchiveFailures[observation.cardId]?.reason!==reason)s.photoArchiveFailures[observation.cardId]={at:new Date().toISOString(),reason};});
        return {...recorded,archive:"pending",archiveError:reason};}
    }
    case "audit-photos":return automatic("photos");
    case "prepare":return automatic("listing");
    case "recover-archives":return recoverArchives();
    case "run":return {sync:await timed("sync",()=>sync()),archives:await timed("archives",()=>recoverArchives()),photos:await timed("photos",()=>automatic("photos")),listings:await timed("listings",()=>automatic("listing")),status:await timed("reports",()=>reports())};
    case "doctor":return {host:os.hostname(),queueRevision:(await readQueue(directory)).revision,lock:await json(path.join(directory,"queue.lock"),true),mode:"local-preparation-only",apiCalls:0};
    default:throw new Error("Commands: run, sync [--new], status, pricing-context --card ID, preflight --cards ID,ID, writer-configure, writer-claim, writer-release, draft-observe, draft-next, draft-dispatch, draft-begin, draft-verify, draft-hold, draft-recover, finish-archive, claim, complete, retry, classify-hold --card ID --file FILE, inventory-access --file FILE, audit-photos, prepare, export-review, doctor");
  }
}
timed("total",()=>main()).then(result=>console.log(JSON.stringify(args.includes("--timings")?{result,timings}:result,null,2))).catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});


