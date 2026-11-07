"use client";
import { useEffect, useState } from "react";
import { approvedAskingPrice, draftAskingPrice, type WorkflowSnapshot } from "@/lib/card-workflow";
import { draftFields } from "@/lib/card-draft-fields";
import { quantityPlan } from "@/lib/card-quantity-plan";
import type { reusablePricing } from "@/lib/card-pricing-library";
import styles from "./CardBatchReviewGrid.module.css";
type Library=Record<string,Partial<ReturnType<typeof reusablePricing>>>;
const money=(n:number|null|undefined)=>n==null?"Pending":new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(n);
export default function CardBatchReviewGrid({ids,snapshot,onSnapshot,onRefresh}:{ids:string[];snapshot:WorkflowSnapshot;onSnapshot:(s:WorkflowSnapshot)=>void;onRefresh:()=>void}){
  const [library,setLibrary]=useState<Library>({}),[busy,setBusy]=useState(""),[error,setError]=useState(""),[confirmed,setConfirmed]=useState<Record<string,boolean>>({});
  const selection=ids.join(",");
  useEffect(()=>{
    const controller=new AbortController();setLibrary({});setConfirmed({});
    // The server bounds each evidence read to 50 captures. Larger batches must
    // not silently lose their entire reuse library to a rejected request.
    void (async()=>{
      const selected=selection.split(",");
      for(let offset=0;offset<selected.length;offset+=50){
        const response=await fetch(`/api/listing-factory/pricing-library?cards=${encodeURIComponent(selected.slice(offset,offset+50).join(","))}`,{signal:controller.signal});
        if(!response.ok)throw Error("Saved pricing evidence unavailable; refresh to retry.");
        const chunk=await response.json();if(!controller.signal.aborted)setLibrary(previous=>({...previous,...chunk}));
      }
    })().catch(e=>{if(!controller.signal.aborted)setError(String(e));});
    return()=>controller.abort();
  },[selection,snapshot.asOf]);
  async function reuse(id:string,sourceId:string,token:string){
    if(busy||!confirmed[token])return;setBusy(id);setError("");
    try{const r=await fetch("/api/listing-factory/pricing-library",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({cardId:id,sourceId,token,confirmed:true})});const data=await r.json();if(!r.ok)throw Error(data.error);onRefresh();}catch(e){setError(String(e));}finally{setBusy("");}
  }
  return <section aria-label="Batch photo and price review" className={styles.review}>
    <h3>Photos, draft prices and matching copies</h3><p>Current validated prices proceed to draft. Review prices in eBay after saving; missing evidence and explicit holds remain visible.</p>
    {error?<p role="alert">{error}</p>:null}
    <div className={styles.scroll}><table><thead><tr><th scope="col">Original pair</th><th scope="col">Identity and draft fields</th><th scope="col">Draft price</th><th scope="col">Copies and remaining checks</th></tr></thead><tbody>{ids.map(id=>{
      const card=snapshot.cards.find(c=>c.id===id);if(!card)return <tr key={id}><td colSpan={4}>Current evidence unavailable for {id}</td></tr>;
      const review=snapshot.workflow[id],approved=approvedAskingPrice(card,review),draftPrice=draftAskingPrice(card,review),price=draftPrice??card.proposal,fields=draftFields(card.identity),quantity=quantityPlan(card,snapshot.cards),evidence=library[id];
      const blockers=[review?.holdReason,...card.issues,...card.holds,...fields.missing].filter(Boolean);
      return <tr key={id}><td><div className={styles.photos}>{(["front","back"] as const).map(side=>{const url=`/api/listing-factory/photo?card=${encodeURIComponent(id)}&side=${side}`;return <a key={side} href={url} target="_blank" rel="noreferrer" aria-label={`Inspect ${card.identity.player||"card"} ${side}`}><img loading="lazy" src={url} alt={`${card.identity.player||"Card"} ${side}`}/><small>{side}</small></a>;})}</div></td>
        <td><strong>{card.identity.player||card.title}</strong><p>{[card.identity.season,card.identity.set,card.identity.cardNumber,card.identity.parallel,card.identity.serial].filter(Boolean).join(" · ")}</p><small>{card.skus[0]} · {card.identity.condition} · {card.identity.language||"Language not recorded"}</small><details><summary>Draft fields · {fields.title.length}/80 characters</summary><p>{fields.title}</p><p>{fields.category??"Category unresolved"}</p><p>{fields.description}</p><dl>{Object.entries(fields.specifics).map(([k,v])=><div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl></details>
        <details><summary>Saved pricing evidence {evidence?.options?.length?`· ${evidence.options.length} reusable sources`:""}</summary><p>{evidence?.reason??"Loading saved evidence…"}</p>{Array.isArray(evidence?.completed?.comps)?<p>{evidence.completed.comps.length} retained sales support this proposal. Evidence review and price approval remain separate.</p>:null}{evidence?.options?.map(o=><div key={o.token}><p>From {o.sourceIdentity?.player} · {o.sourceId} · {String(o.basis)} · {o.comps.length} sales</p><ul>{o.comps.map(c=><li key={c.saleId}><a href={c.sourceUrl} target="_blank" rel="noreferrer">{c.soldDate} · {money(c.itemPrice)}</a></li>)}</ul><label><input type="checkbox" checked={!!confirmed[o.token]} onChange={e=>setConfirmed(s=>({...s,[o.token]:e.target.checked}))}/> I checked this copy’s originals, variant, language, condition and acquisition exclusions.</label><button disabled={!!busy||!confirmed[o.token]||!!approved} onClick={()=>void reuse(id,o.sourceId,o.token)}>Reuse evidence and calculate proposal</button></div>)}</details></td>
        <td><strong>{money(price?.item)}</strong><p>Shipping: {money(price?.shipping)}<br/>Buyer total: {price&&price.shipping!==null?money(price.item+price.shipping):"Pending"}</p><p>{approved?"Seller-set / previously approved":draftPrice?"Review in eBay draft":"Pricing evidence required"}</p>{price?.reviewNotes?.length ? <ul aria-label="Pricing review notes">{price.reviewNotes.map(note=><li key={note}>{note}</li>)}</ul> : null}</td>
        <td><strong>{quantity.route.replaceAll("-"," ")}</strong><p>{quantity.proposedNewQuantity?`Proposed quantity ${quantity.proposedNewQuantity}`:quantity.proposedAdditionalQuantity?`${quantity.proposedAdditionalQuantity} new captures to reconcile`:"Quantity not changed"}</p><small>{quantity.note}</small>{quantity.existingIds.length?<p>Retain IDs: {quantity.existingIds.join(", ")}</p>:null}<ul>{blockers.map((b,i)=><li key={i}>{b}</li>)}</ul><small>Fresh inventory, shipping policy, upright photos and saved-draft verification still required.</small></td>
      </tr>;
    })}</tbody></table></div>
  </section>;
}
