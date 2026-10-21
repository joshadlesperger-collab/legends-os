import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { claimJob, completeJob, fingerprint, kinds, localReviewListings, quarantineImport, queueSummary, retryHeld, upsertCard, type JobKind, type QueueState } from "../lib/card-orchestrator.ts";
import { readQueue, withQueue } from "../lib/card-orchestrator-store.ts";
import { applySavedReceipts, importLegacyCard, savedReceiptDependencies, type SavedReceiptRow } from "../lib/card-orchestrator-import.ts";
import { flowPacket, flowHtml, pricingContext } from "../lib/card-orchestrator-flow.ts";

const root=process.cwd(),directory=path.join(root,"artifacts/card-orchestrator");
const [command="status",...args]=process.argv.slice(2);
function option(name:string,fallback="") {const i=args.indexOf(`--${name}`);return i<0?fallback:args[i+1]??"";}
const limit=Number(option("limit","10"));
if(!Number.isInteger(limit)||limit<1||limit>50)throw new Error("Use a batch limit from 1 to 50");
const worker=option("worker",`local-${os.hostname()}`);
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
  const files=directories.filter(d=>d.isDirectory()&&/^(?:batch-\d+|bulk-photo-pilot-\d{8})$/.test(d.name)).map(d=>`artifacts/${d.name}/manifest.json`).sort();
  files.push("artifacts/bulk-draft-pilot/manifest.json","artifacts/one-piece-processing.json");
  const rows:SavedReceiptRow[]=[];
  for(const source of files) {
    const data=await json(source,true);if(!data)continue;
    const entries=source.endsWith("one-piece-processing.json")?data.groups:data.cards;
    if(!Array.isArray(entries))throw new Error(`Saved listing manifest schema changed: ${source}`);
    rows.push(...entries.map((data:unknown)=>({source,data})));
  }
  return rows;
}
async function sync() {
  const [identities,pricing,pilot,receipts]=await Promise.all([json("artifacts/identity-queue/cards.json"),json("artifacts/pricing-queue/queue-state.json"),json("artifacts/bulk-listing-test-20261018/preflight-result.json",true),savedReceiptRows()]);
  if(!Array.isArray(identities?.cards)||!Array.isArray(pricing?.cards)||!Array.isArray(pricing?.comps))throw new Error("Legacy queue schema changed; stop instead of guessing");
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
    const sourceKey=(id:string)=>fingerprint(["per-card-receipts-v1",identityMap.get(id)??null,prices.get(id)??null,savedReceiptDependencies(identityMap.get(id),receipts)]);
    // Upgrade only a legacy cache entry proven to match the current source snapshot; never assume a changed hold is unchanged.
    const legacyReceiptGeneration=fingerprint(receipts);
    for(const [id,rejected] of Object.entries(state.rejectedImports??{})) {
      const legacyKey=fingerprint([identityMap.get(id)??null,prices.get(id)??null,legacyReceiptGeneration]);
      if(rejected.inputKey===legacyKey)rejected.inputKey=sourceKey(id);
    }
    const proposed=initial&&observations.size?Array.from(observations.keys()):args.includes("--new")?identities.cards.map((i:any)=>String(i.card_id)).filter((id:string)=>!state.cards[id]&&state.rejectedImports?.[id]?.inputKey!==sourceKey(id)):[];
    const ids=Array.from(new Set<string>([...existing,...proposed.slice(0,limit)]));
    const result={examined:ids.length,changed:0,skipped:[] as {id:string;reason:string}[]};
    for(const id of ids){try{
      const input=applySavedReceipts(importLegacyCard(identityMap.get(id),prices.get(id),comps.get(id)??[],observations.get(id)),receipts);
      if(upsertCard(state,input))result.changed++;
      if(state.rejectedImports)delete state.rejectedImports[id];
    }catch(error){const reason=error instanceof Error?error.message:String(error);result.skipped.push({id,reason});quarantineImport(state,id,reason);state.rejectedImports??={};state.rejectedImports[id]={inputKey:sourceKey(id),reason,...sourceLabel(id)};}}
    await fs.writeFile(path.join(directory,"last-sync.json"),JSON.stringify({...result,at:new Date().toISOString(),sourceGeneration:identities.generation},null,2));
    return result;
  });
}
async function automatic(kind:"photos"|"listing") {
  let completed=0,held=0;
  for(let n=0;n<limit;n++){
    const claim=await withQueue(directory,s=>claimJob(s,worker,kind,option("card")||undefined));
    if(!claim)break;
    let result:unknown;
    try {
      result=kind==="photos"?{outcome:"done",data:{hashes:await Promise.all(claim.card.photos.map(async p=>({side:p.side,sha256:createHash("sha256").update(await fs.readFile(p.path)).digest("hex")}))),evidence:"Read retained original files and independently recomputed SHA-256; no image files changed."}}:{outcome:"done",data:{prepare:true}};
      await withQueue(directory,s=>completeJob(s,claim.card.id,kind,claim.job.lease!.token,result));completed++;
    }catch(error){
      const reason=error instanceof Error?error.message:String(error);
      // A stale lease must fail, not overwrite the newer worker's result.
      await withQueue(directory,s=>completeJob(s,claim.card.id,kind,claim.job.lease!.token,{outcome:"held",reason}));held++;
    }
  }
  return {kind,completed,held};
}
const escape=(v:unknown)=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
async function reports(state:QueueState) {
  const summary=queueSummary(state);
  const importHtml=summary.importExceptions.length?summary.importExceptions.map(x=>`<p><strong>${escape(x.player||x.sku||x.id)}</strong>${x.sku?` · ${escape(x.sku)}`:""}<br>${escape(x.reason)}</p>`).join(""):"<p>None</p>";
  const reviews=localReviewListings(state,summary.asOf);
  const draftHtml=`<section><h2>Prepared for your review</h2>${reviews.length?reviews.map((r:any)=>`<article><h3>${escape(r.title)}</h3><p>${r.pricing?`Proposed item $${Number(r.pricing.item).toFixed(2)} · Buyer shipping $${Number(r.pricing.shipping).toFixed(2)} · ${r.priceBasis==="related-print-run"?"Related numbered-parallel estimate; price approval required":r.reviewEstimate?"Review estimate; sold evidence or condition differs":"Price approval required"}`:"Price awaiting defensible sold evidence"}</p>${r.priceBasis==="related-print-run"?(r.priceBasisDetails??[]).map((b:any)=>`<p><small>Source sold item $${Number(b.itemPrice).toFixed(2)} × ${escape(b.sourcePrintRun)}/${escape(b.targetPrintRun)} = $${Number(b.adjustedItemPrice).toFixed(4)} before premium and rounding · <a href="${escape(b.sourceUrl)}">Source sale ${escape(b.saleId)}</a></small></p>`).join(""):""}<p>${escape(r.description)}</p><small>SKU ${escape(r.sku)} · Quantity 1 · ${escape(r.condition)} · Shipping eligibility and final inventory reconciliation must be confirmed.</small></article>`).join(""):"<p>No local listing drafts yet.</p>"}</section>`;
  const rows=summary.cards.map(c=>{
    const handoff=c.pricingHandoff;
    const pricing=handoff?`<div><b>Pricing agent:</b> ${escape(handoff.status)}${handoff.item!==null?` · proposed item $${handoff.item.toFixed(2)} · buyer shipping ${handoff.shipping===null?"unknown":`$${handoff.shipping.toFixed(2)}`} · unapproved, not an eBay price`:" · no usable price supplied"}<small>${escape(handoff.reason)}</small><small>Source updated ${escape(handoff.updatedAt||"unknown")} · ${escape(handoff.policyVersion||"policy not recorded")} · ${escape(handoff.source)}</small></div>`:"<div><b>Pricing agent:</b> no handoff found</div>";
    const jobs=c.jobs.filter(j=>!c.existingReceipt||j.kind==="pricing").map(j=>`<div><b>${escape(j.kind)}</b>: ${escape(j.state)} ${j.reason?`— ${escape(j.reason)}`:""}${j.blockers.length?`<small>${escape(j.blockers.join("; "))}</small>`:""}</div>`).join("");
    const receipt=c.existingReceipt?`Saved ${escape(c.existingReceipt.disposition)} receipt ${escape(c.existingReceipt.itemId)}; excluded from new listings${c.receiptConflicts.length?`<small>Receipt ${escape(c.receiptConflicts.join(", "))} is also recorded for another card. Verify the current draft identity before resuming; no new listing.</small>`:""}`:"";
    return `<tr><td><strong>${escape(c.player)}</strong><br>${escape(c.serial)}<br><small>${escape(c.sku)}</small></td><td>${receipt}${pricing}${jobs}</td></tr>`;
  }).join("");
  const html=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Card workflow status</title><style>body{font:16px/1.6 system-ui;max-width:1050px;margin:40px auto;padding:0 24px;background:#f5f7fa;color:#182634}h1{line-height:1.2}section{background:white;padding:24px;border-radius:14px;margin:20px 0}table{width:100%;border-collapse:collapse}td,th{text-align:left;vertical-align:top;padding:16px;border-bottom:1px solid #dfe5ec}small{display:block;color:#526272}b{font-weight:600}.stats{display:flex;gap:28px;flex-wrap:wrap}.stats strong{font-size:32px;display:block}</style><h1>Your card workflow</h1><p>Saved ${escape(summary.asOf)} · Local preparation · Seller imaydit58</p><section class="stats">${[[summary.counts.cards,"cards in pilot"],[summary.counts.alreadyListed,"existing listings / drafts"],[summary.counts.localListingsPrepared,"local listing drafts"],[summary.counts.heldJobs,"held tasks"],[summary.counts.importExceptions,"import holds"],[0,"ready to upload"]].map(([n,l])=>`<div><strong>${n}</strong>${l}</div>`).join("")}</section><section><h2>What runs automatically</h2><p>Import changes → check original files → queue visual and comp reviews → prepare listing text → record results. A stopped worker can resume; a completed task is reused until its evidence changes.</p><p>Visual identification and sold-comp research are performed by Codex using the original images and supported research tools. There is no unattended image-recognition or sold-data service connected.</p><h2>Current limits</h2><ul>${summary.globalHolds.map(h=>`<li>${escape(h)}</li>`).join("")}</ul><p>Review export: review-listings.json. Every action is blank; no upload or publication is possible through this runner.</p></section><section><h2>Card queue</h2><table><thead><tr><th>Card</th><th>Progress and exceptions</th></tr></thead><tbody>${rows}</tbody></table></section><section><h2>Import exceptions</h2><p>Unresolved source records remain here until corrected; unchanged holds are not retried.</p>${importHtml}</section></html>`;
  await fs.writeFile(path.join(directory,"status.json"),JSON.stringify(summary,null,2));
  await fs.writeFile(path.join(directory,"review-listings.json"),JSON.stringify({mode:state.mode,canUpload:false,canPublish:false,listings:reviews},null,2));
  await fs.writeFile(path.join(directory,"status.html"),html.replace("</html>",`${draftHtml}</html>`));
  return {counts:summary.counts,globalHolds:summary.globalHolds,report:path.join(directory,"status.html")};
}
async function main() {
  switch(command){
    case "sync":return sync();
    case "status":case "export-review":return withQueue(directory,reports);
    case "claim":return withQueue(directory,s=>{
      const claim=claimJob(s,worker,kindOption(),option("card")||undefined);
      return claim?{...claim,pricingContext:claim.job.kind==="pricing"?pricingContext(s,claim.card.id):undefined}:null;
    });
    case "pricing-context":{
      if(!option("card"))throw new Error("--card is required");
      await sync();return withQueue(directory,s=>pricingContext(s,option("card")));
    }
    case "preflight":{
      const ids=option("cards",option("card")).split(",").map(id=>id.trim()).filter(Boolean);
      if(!ids.length)throw new Error("Select exact card IDs with --card or --cards; no implicit whole-inbox batch");
      await sync();
      return withQueue(directory,async s=>{
        const approvalFile=await json("artifacts/card-orchestrator/asking-price-approvals.json",true);
        const packet=flowPacket(s,ids,new Date().toISOString(),approvalFile?.approvals??[]);
        await fs.writeFile(path.join(directory,"handoff.json"),JSON.stringify(packet,null,2));
        await fs.writeFile(path.join(directory,"handoff.html"),flowHtml(packet));
        return packet;
      });
    }
    case "complete":{
      const kind=kindOption(true)!;if(!option("result"))throw new Error("--result JSON file required");
      const result=await json(option("result"));
      return withQueue(directory,s=>{completeJob(s,option("card"),kind,option("token"),result);return {completed:option("card"),kind};});}
    case "retry":return withQueue(directory,s=>{retryHeld(s,option("card"),kindOption(true)!,option("evidence"));return {requeued:option("card")};});
    case "audit-photos":return automatic("photos");
    case "prepare":return automatic("listing");
    case "run":return {sync:await sync(),photos:await automatic("photos"),listings:await automatic("listing"),status:await withQueue(directory,reports)};
    case "doctor":return {host:os.hostname(),queueRevision:(await readQueue(directory)).revision,lock:await json(path.join(directory,"queue.lock"),true),mode:"local-preparation-only",apiCalls:0};
    default:throw new Error("Commands: run, sync [--new], status, pricing-context --card ID, preflight --cards ID,ID, claim, complete, retry, audit-photos, prepare, export-review, doctor");
  }
}
main().then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
