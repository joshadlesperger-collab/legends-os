"use client";
import { useEffect, useMemo, useState } from "react";
import { BATCH_STAGES, batchTiming, batchWorkPlan, type BatchStage, type TimedBatch } from "@/lib/card-batch";
import { cardListingTitle, type WorkflowSnapshot } from "@/lib/card-workflow";
import CardBatchReviewGrid from "./CardBatchReviewGrid";
const labels:Record<BatchStage,string>={photos:"Photo preparation",identity:"Identification",research:"Price research","approval-wait":"Waiting for seller decision","inventory-shipping":"Inventory and shipping","ebay-entry":"eBay draft entry",verification:"Saved draft verification",archive:"Photo archive verification","service-wait":"External service wait",recovery:"Retry and recovery",upload:"Photo upload",generation:"AI generation",correction:"Targeted corrections",save:"Commit and save",engineering:"Engineering (excluded from operator time)"};
export default function CardBatchPanel({snapshot,onSnapshot,onRefresh}:{snapshot:WorkflowSnapshot;onSnapshot:(s:WorkflowSnapshot)=>void;onRefresh:()=>void}){
  const [upright,setUpright]=useState(false),[mediaProgress,setMediaProgress]=useState("");
  const [batch,setBatch]=useState<TimedBatch|null>(null),[selected,setSelected]=useState<string[]>([]),[busy,setBusy]=useState(true),[error,setError]=useState(""),[query,setQuery]=useState(""),[now,setNow]=useState(Date.now());
  useEffect(()=>{setUpright(false);setMediaProgress("");},[batch?.id]);
  useEffect(()=>{fetch("/api/listing-factory/batch").then(async r=>{if(!r.ok)throw Error("Could not load batch");setBatch(await r.json());}).catch(e=>setError(e.message)).finally(()=>setBusy(false));},[]);
  useEffect(()=>{setNow(Date.now());if(!batch?.intervals.at(-1)||batch.intervals.at(-1)?.end)return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[batch]);
  const eligible=useMemo(()=>snapshot.cards.filter(c=>c.physicalUnits&&c.frontHash&&c.backHashes.length===1&&!c.receipts.length&&!c.excludedFromNewListing&&!c.issues.length&&!snapshot.workflow[c.id]?.holdReason),[snapshot]);
  async function save(stage?:BatchStage|null,finish=false){setBusy(true);setError("");try{const r=await fetch("/api/listing-factory/batch",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(batch?{revision:batch.revision,batchId:batch.id,stage:stage??null,finish}:{revision:0,cardIds:selected})});const data=await r.json();if(!r.ok)throw Error(data.error);setBatch(data);}catch(e){setError(String(e));}finally{setBusy(false);}}
  async function download(packet:boolean){setError("");try{const r=await fetch(`/api/listing-factory/batch${packet?"?packet=1":""}`);const data=await r.json();if(!r.ok)throw Error(data.error);const metrics=packet?null:await fetch("/api/listing-factory/batch?metrics=1").then(r=>r.json());const value=packet?data:{...data,summary:batchTiming(data),metrics};const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:"application/json"}));const a=document.createElement("a");a.href=url;a.download=packet?"card-draft-packet.json":"card-stage-times.json";a.click();URL.revokeObjectURL(url);}catch(e){setError(String(e));}}
  async function downloadBulk(){setError("");try{
    const r=await fetch("/api/listing-factory/batch/bulk");const data=await r.json();
    if(!r.ok)throw Error(data.error);if(!data.ready)throw Error(data.blockers.slice(0,8).join("; ")+(data.blockers.length>8?` (+${data.blockers.length-8} more)`:""));
    for(const [name,content,type] of [["ebay-drafts.csv",data.csv,"text/csv"],["ebay-draft-verification.json",JSON.stringify({...data,csv:undefined},null,2),"application/json"]]){
      const url=URL.createObjectURL(new Blob([content],{type}));const a=document.createElement("a");a.href=url;a.download=name;a.click();URL.revokeObjectURL(url);
    }
  }catch(e){setError(String(e));}}
  async function hostPhotos(){if(!batch||!upright)return;setBusy(true);setError("");try{
    for(let i=0;i<50;i++){
      const r=await fetch("/api/listing-factory/batch/media",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({batchId:batch.id,revision:batch.revision,originalsUprightReviewed:true})});
      const data=await r.json();if(!r.ok)throw Error(data.error);
      setMediaProgress(`${data.cached+data.uploaded} photos hosted · ${data.remaining} remaining`);
      if(data.errors.length)throw Error(data.errors.join("; "));
      if(!data.remaining)return;
    }
    throw Error("Upload chunk limit reached; successful images are retained. Resume to finish.");
  }catch(e){setError(String(e));}finally{setBusy(false);}}
  const plan=useMemo(()=>batch?batchWorkPlan(batch,snapshot):null,[batch,snapshot]);
  const timing=batch?batchTiming(batch,now):null,last=batch?.intervals.at(-1),running=last&&!last.end?last.stage:null;
  return <details style={{padding:20,border:"1px solid #ccd5df",borderRadius:12,marginBlock:20}}><summary><strong>Card batch · preparation and stage timing</strong></summary>
    <p>Prepare photos and fields with current pricing rules. Review prices in the saved eBay drafts. Fresh inventory checks and final save/reopen verification remain required; nothing is published here.</p>
    {error?<p role="alert">{error}</p>:null}
    {!batch?<><label>Find new captures <input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Player or scan SKU"/></label><button disabled={busy} onClick={()=>setSelected(eligible.filter(c=>`${cardListingTitle(c)} ${c.skus.join(" ")}`.toLowerCase().includes(query.toLowerCase())).slice(0,500).map(c=>c.id))}>Select matching captures (up to 500)</button><button disabled={busy} onClick={()=>setSelected([])}>Clear selection</button><p>{selected.length}/500 selected. Existing drafts and live receipts are excluded.</p><div style={{maxHeight:260,overflow:"auto"}}>{eligible.filter(c=>`${cardListingTitle(c)} ${c.skus.join(" ")}`.toLowerCase().includes(query.toLowerCase())).slice(0,500).map(c=><label key={c.id} style={{display:"block",padding:6}}><input type="checkbox" checked={selected.includes(c.id)} disabled={busy||(!selected.includes(c.id)&&selected.length===500)} onChange={e=>setSelected(s=>e.target.checked?[...s,c.id]:s.filter(id=>id!==c.id))}/>{cardListingTitle(c)} · {c.skus[0]}</label>)}</div><button disabled={busy||selected.length<1} onClick={()=>void save()}>Save selected batch</button></>:<>
      <p>Batch retained across reloads. Start a stage when work begins; pause for interruptions. Switching stages stops the previous timer. Approval and external-service waiting are counted separately. Photo hosting and export operations are timed automatically. Running timers include time away until paused.</p>
      <p>{plan?.readyIds.length} captures ready for draft · {plan?.existingIds.length} existing captures to reconcile · {plan?.exceptions.reduce((n,e)=>n+e.cardIds.length,0)} exceptions. Ready groups proceed without resetting holds or splitting matching copies.</p><details><summary>Batch exceptions</summary><ul>{plan?.exceptions.map(e=><li key={e.cardIds.join(",")}>{e.cardIds.length} capture(s): {e.reason}</li>)}</ul></details>
      <CardBatchReviewGrid ids={batch.cardIds} snapshot={snapshot} onSnapshot={onSnapshot} onRefresh={onRefresh}/>
      <table><thead><tr><th>Stage</th><th>Elapsed minutes</th><th>Timer</th></tr></thead><tbody>{BATCH_STAGES.map(s=><tr key={s}><td>{labels[s]}</td><td>{((timing?.seconds[s]??0)/60).toFixed(1)}</td><td><button disabled={busy||running===s} onClick={()=>void save(s)}>{running===s?"Running":"Start stage"}</button></td></tr>)}</tbody></table>
      <p>Target: 30–60 seconds/card. Elapsed: {((timing?.elapsedSeconds??0)/60).toFixed(1)} min · Service wait: {((timing?.serviceWaitSeconds??0)/60).toFixed(1)} min · Working time: {((timing?.workSeconds??0)/60).toFixed(1)} min · Approval wait: {((timing?.approvalWaitSeconds??0)/60).toFixed(1)} min · Batch work/card: {timing?.workSecondsPerCard.toFixed(1)} seconds (includes unfinished cards).</p>
      <button disabled={busy||!running} onClick={()=>void save(null)}>Pause timer</button> <button onClick={()=>void download(false)}>Download timing report</button> <button onClick={()=>void download(true)}>Download draft packet</button>
      <p><label><input type="checkbox" checked={upright} disabled={busy} onChange={e=>setUpright(e.target.checked)}/> I reviewed the selected originals: front/back are paired correctly and upright.</label></p>
      <button disabled={busy||!upright} onClick={()=>void hostPhotos()}>Host batch photos on eBay</button>
      <p role="status">{mediaProgress}</p>
      <button disabled={busy} onClick={()=>void downloadBulk()}>Download ready groups as eBay draft CSV</button>
      <button disabled={busy||!!running} onClick={()=>void save(null,true)}>Archive measurement</button>
      <p>Archiving ends this measurement and keeps its history; it does not mark cards complete.</p>
      <p>The full packet requires current validated or seller-set prices. Review prices in the saved eBay drafts. Bulk CSV includes only ready groups and reports excluded captures; quantity groups stay together. It includes category-specific fields, descriptions, shipping, offers and capture-bound quantity plans. Matching copies produce one proposed draft; existing matches require a quantity check. The separate eBay draft CSV requires upright, unexpired hosted photos. Complete shipping and remaining specifics in eBay’s bulk editor; verify saved drafts before archiving originals.</p>
    </>}
  </details>;
}
