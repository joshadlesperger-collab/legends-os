"use client";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { BacklogCard } from "@/lib/card-backlog";
import { cardListingTitle, approvedAskingPrice, draftAskingPrice, nextWork, selectableWork, orderedWork, stageWork, workflowStage, workflowOverview, workAttention, ATTENTION_LABELS, WORK_STAGES, workHandoff, workLane, WORK_LANES, type ReviewAction, type WorkflowSnapshot, type WorkflowStage, type WorkAttention } from "@/lib/card-workflow";
import {blockerCause,blockerPareto,causeDefinition,type CauseCode} from "@/lib/card-blocker-causes";
import CardBlockerPareto from "./CardBlockerPareto";
import CardManualPrice from "./CardManualPrice";
import CardBatchPanel from "./CardBatchPanel";
import {canSetManualPrice,workHolds,type ManualPrice,type ReviewCommand} from "@/lib/card-workflow";
import styles from "./CardWorkflow.module.css";

const money=(n?:number|null)=>n==null ? "Unknown" : new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(n);
function OriginalPhoto({card,side}:{card:BacklogCard;side:"front"|"back"}) {
  const [failed,setFailed]=useState(false);
  const [rotation,setRotation]=useState(0),[exportError,setExportError]=useState("");
  const available=side==="front" ? card.frontHash : card.backHashes.length===1;
  const url=`/api/listing-factory/photo?card=${encodeURIComponent(card.id)}&side=${side}`;
  async function exportPhoto(){try{setExportError("");const image=new Image();image.src=url;await image.decode();const canvas=document.createElement("canvas"),swap=rotation%180!==0;canvas.width=swap?image.naturalHeight:image.naturalWidth;canvas.height=swap?image.naturalWidth:image.naturalHeight;const ctx=canvas.getContext("2d");if(!ctx)throw Error("Photo export unavailable");ctx.translate(canvas.width/2,canvas.height/2);ctx.rotate(rotation*Math.PI/180);ctx.drawImage(image,-image.naturalWidth/2,-image.naturalHeight/2);const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(Error("Photo export failed")),"image/png"));const link=document.createElement("a"),download=URL.createObjectURL(blob);link.href=download;link.download=`${(card.skus[0]||card.id).replace(/[^a-zA-Z0-9_-]/g,"_")}-${side==="front"?"01-front":"02-back"}-${rotation}deg.png`;link.click();URL.revokeObjectURL(download);}catch{setExportError("Could not export photo. Original remains unchanged.");}}
  return <figure className={styles.photo}><figcaption>{side === "front" ? "Original front" : "Original back"}</figcaption>{available && !failed ? <><a href={url} target="_blank" rel="noreferrer" aria-label={`Open full-size original ${side}`}><img src={url} style={{transform:`rotate(${rotation}deg)`,maxHeight:340,objectFit:"contain"}} alt={`${card.identity.player || "Card"} original ${side}`} onError={()=>setFailed(true)} /></a><button onClick={()=>setRotation(r=>(r+90)%360)}>Rotate {side} preview 90°</button><button onClick={()=>void exportPhoto()}>Download prepared {side}</button><small>Preview rotation {rotation}°. Export preserves full resolution; original unchanged. Confirm upright before upload.</small>{exportError?<p role="alert">{exportError}</p>:null}</> : <div className={styles.noPhoto}>Original preview unavailable.<br />Retained paths are in the evidence panel.</div>}</figure>;
}
export default function CardWorkflow({snapshot,busy,onSnapshot,onRefresh,onAudit}:{snapshot:WorkflowSnapshot;busy:boolean;onSnapshot:(next:WorkflowSnapshot)=>void;onRefresh:()=>void;onAudit:()=>void}) {
  const [initial]=useState(()=>nextWork(snapshot));
  const [stage,setStage]=useState<WorkflowStage>(initial ? workflowStage(initial,snapshot.workflow[initial.id]) : "identify");
  const [attention,setAttention]=useState<WorkAttention|"all">("all");
  const [tableStage,setTableStage]=useState<WorkflowStage|"all">("all");
  const [causeFilter,setCauseFilter]=useState<CauseCode|"">("");
  const [selected,setSelected]=useState(initial?.id || ""),[search,setSearch]=useState(""),[note,setNote]=useState("");
  const [saving,setSaving]=useState(false),[error,setError]=useState(""),[message,setMessage]=useState(""),[processed,setProcessed]=useState(0);
  const [skipped,setSkipped]=useState<string[]>([]),[limit,setLimit]=useState(20);
  const [active,setActive]=useState(false),[hasResume,setHasResume]=useState(false);
  const [cursorLoaded,setCursorLoaded]=useState(false);
  const initialCards=useRef(snapshot.cards);
  const pending=useRef<ReviewCommand>();
  const query=useDeferredValue(search);
  const queue=useMemo(()=>stageWork(snapshot,stage,attention,query).filter(c=>!causeFilter||blockerCause(c,snapshot.workflow[c.id])?.primary===causeFilter),[snapshot,stage,attention,query,causeFilter]);
  const card=snapshot.cards.find(c=>c.id===selected) || queue.find(c=>!skipped.includes(c.id)&&selectableWork(c,snapshot.workflow[c.id],attention));
  const review=card ? snapshot.workflow[card.id] : undefined;
  const approved=card ? approvedAskingPrice(card,review) : null;
  const draftPrice=card ? draftAskingPrice(card,review) : null;
  const asking=draftPrice || card?.proposal;
  const holds=card?workHolds(card,review):[];
  const overview=useMemo(()=>workflowOverview(snapshot),[snapshot]);
  const {milestones,buckets}=overview;
  const scopeCards=useMemo(()=>tableStage==="all"?orderedWork(snapshot).filter(c=>c.physicalUnits):stageWork(snapshot,tableStage),[snapshot,tableStage]);
  const causeSummary=useMemo(()=>blockerPareto(scopeCards,snapshot.workflow),[scopeCards,snapshot.workflow]);
  const tableCards=useMemo(()=>{
    const q=query.trim().toLowerCase();
    return scopeCards.filter(c=>(attention==="all"||workAttention(c,snapshot.workflow[c.id])===attention)&&(!causeFilter||blockerCause(c,snapshot.workflow[c.id])?.primary===causeFilter)&&`${cardListingTitle(c)} ${c.skus.join(" ")} ${c.aliases.join(" ")} ${c.receipts.map(r=>r.id).join(" ")}`.toLowerCase().includes(q));
  },[scopeCards,snapshot.workflow,attention,causeFilter,query]);
  const cardCause=card?blockerCause(card,review):null;
  const draft=card?.receipts.find(r=>r.disposition==="draft");
  const live=card?.receipts.find(r=>["live","sold","scheduled"].includes(r.disposition));
  const lane=card?workLane(card,review):undefined;
  const currentStage=card?workflowStage(card,review):stage;
  useEffect(()=>{
    try { const cursor=JSON.parse(localStorage.getItem("legends.card-workflow.cursor.v1")||"null");
      if(cursor && initialCards.current.some(c=>c.id===cursor.id) && WORK_STAGES.some(s=>s.id===cursor.stage)){setSelected(cursor.id);setStage(cursor.stage);setHasResume(true);}
    } catch { /* An unavailable browser cursor never hides server evidence. */ }
    setCursorLoaded(true);
  },[]);
  useEffect(()=>{if(active && cursorLoaded && card)try{localStorage.setItem("legends.card-workflow.cursor.v1",JSON.stringify({id:card.id,stage:currentStage}));}catch{}},[active,cursorLoaded,card?.id,currentStage]);
  useEffect(()=>{setNote("");pending.current=undefined;},[card?.id,review?.token]);
  useEffect(()=>{if(selected && card && currentStage!==stage){setStage(currentStage);setAttention("all");}},[selected,card?.id,currentStage,stage]);
  function chooseStage(next:WorkflowStage|"all",filter:WorkAttention|"all"="all") {if(next!=="all")setStage(next);setTableStage(next);setAttention(filter);setCauseFilter("");setSelected("");setSearch("");setNote("");setError("");setLimit(20);setSkipped([]);setActive(false);}
  function filterCause(code:CauseCode|""){setCauseFilter(code);setAttention(code?"blocked":"all");setSearch("");setLimit(20);}
  function openCard(next:BacklogCard){setSelected(next.id);setStage(workflowStage(next,snapshot.workflow[next.id]));setNote("");setError("");setActive(true);}
  function advance(nextSnapshot:WorkflowSnapshot,completedId:string) {
    const exclusions=[...skipped,completedId],next=stageWork(nextSnapshot,stage,attention).find(c=>!exclusions.includes(c.id)&&selectableWork(c,nextSnapshot.workflow[c.id],attention)&&(!causeFilter||blockerCause(c,nextSnapshot.workflow[c.id])?.primary===causeFilter));
    setSkipped(exclusions);setSearch("");setNote("");
    setSelected(next?.id||"");
  }
  async function save(action:ReviewAction,goNext:boolean,price?:ManualPrice) {
    if(!card||!review||saving)return;
    setSaving(true);setError("");setMessage("");
    const values={cardId:card.id,token:review.token,action,note:note.trim(),...(price?{price}:{})};
    const {requestId:_requestId,...previous}=pending.current??{};
    if(!pending.current || JSON.stringify(previous)!==JSON.stringify(values)) pending.current={...values,requestId:crypto.randomUUID()};
    try {
      const response=await fetch("/api/listing-factory/workflow",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(pending.current)});
      const data=await response.json();if(!response.ok)throw new Error(data.error||"Review was not saved");
      pending.current=undefined;onSnapshot(data);setProcessed(n=>n+1);
      setMessage(action==="set-price" ? "Manual price saved. This card is now in Listing review; remaining checks are still visible." : action==="approve-price" ? "Asking price approved. Listing and inventory checks remain." : action==="hold" ? "Blocker saved in this stage’s Blocked bucket." : action==="resume" ? "Local hold removed. Any source requirements remain." : "Review note saved with this capture.");
      if(action==="set-price"){setStage("listing");setTableStage("listing");setAttention("all");setCauseFilter("");setSearch("");}
      if(goNext)advance(data,card.id);else setNote("");
    }catch(e){setError(e instanceof Error?e.message:"Save failed. Retry to safely recover the same decision.");}finally{setSaving(false);}
  }
  async function copyHandoff() {
    if(!card)return;
    try{await navigator.clipboard.writeText(workHandoff(card,review));setMessage("Work request copied. Paste it into the card workflow chat to continue this exact card.");}catch{setError("Clipboard unavailable. The work request is available in the evidence panel below.");}
  }
  return <main className={`page ${styles.workflow}`}>
    <header className={styles.header}><div><div className="eyebrow">Sell / Card workflow</div><h1>Your cards, from scan to listing.</h1><p>See what’s done, what needs you, and where work is blocked.</p></div><div className={styles.headerActions}>{active?<button disabled={saving} onClick={()=>setActive(false)}>Back to card list</button>:null}<button disabled={busy||saving} onClick={onRefresh}>{busy?"Refreshing…":"Refresh work"}</button><button disabled={saving} onClick={onAudit}>Source audit</button></div></header>
    <CardBatchPanel snapshot={snapshot} onSnapshot={onSnapshot} onRefresh={onRefresh}/>
    <section className={styles.milestones} aria-label="Card progress overview">{([
      ["scanned","Scanned","Distinct original captures"],
      ["identified","Identified","Saved card identities"],
      ["priced","Priced","Saved asking prices"],
      ["listed","Listed","Saved live or sold receipts"],
    ] as const).map(([key,label,detail],i)=><div key={key}><span>{String(i+1).padStart(2,"0")} · {label}</span><strong>{milestones[key].toLocaleString()}</strong><div className={styles.progressTrack}><span style={{width:`${milestones.scanned?100*milestones[key]/milestones.scanned:0}%`}}/></div><small>{detail}</small></div>)}</section>
    <details className={styles.countNote}><summary>Counts reflect saved evidence · {new Date(snapshot.asOf).toLocaleString()}</summary><p>Milestones overlap; prices are reviewed in saved eBay drafts. Listed counts captures with live or sold receipts, not current available stock. Drafts and scheduled listings are separate. Missing receipts need verification. Each capture appears in one queue below; unmapped records do not add inventory.</p></details>
    {!active?<section className={styles.stageChoices} aria-label="Choose a workflow stage">{WORK_STAGES.slice(0,3).map((s,i)=><section key={s.id}>
      <div className={styles.stageTitle}><span className={styles.stageNumber}>0{i+1}</span><h2>{s.label}</h2><strong>{buckets[s.id].total.toLocaleString()}<small>left in this stage</small></strong></div>
      <div className={styles.bucketBreakdown}>{(["review","work","blocked"] as const).map(a=><button key={a} onClick={()=>chooseStage(s.id,a)}><span data-status={a}>{ATTENTION_LABELS[a]}</span><strong>{buckets[s.id][a]}</strong></button>)}</div>
      <button className={styles.enter} onClick={()=>chooseStage(s.id)}>Open {s.label.toLowerCase()} queue →</button>
    </section>)}</section>:null}
    <div className={styles.queueHeading}><div><h2>{active?"Work a card":"Card details"}</h2><p>{overview.remaining.toLocaleString()} in preparation queues · {buckets.listed.total} with saved live, sold or scheduled receipts · {processed} decisions this session</p></div>{!active&&hasResume&&card?<button onClick={()=>setActive(true)}>Resume last card →</button>:null}</div>
    <nav aria-label="Card stage tabs" className={styles.tabs}><button disabled={saving} aria-current={!active&&tableStage==="all"?"page":undefined} onClick={()=>chooseStage("all")}>All cards <span>{milestones.scanned}</span></button>{WORK_STAGES.map(s=><button disabled={saving} key={s.id} aria-current={(active?stage:tableStage)===s.id?"page":undefined} onClick={()=>chooseStage(s.id)}>{s.label} <span>{buckets[s.id].total}</span></button>)}</nav>
    <div role="status" className={styles.feedback}>{message || (busy ? "Refreshing saved work…" : "Local review decisions are saved. eBay changes still use the existing listing handoff.")}</div>
    {error ? <div className={styles.error} role="alert">{error} <button disabled={saving||busy} onClick={onRefresh}>Refresh current evidence</button></div>:null}
    {!active?<><CardBlockerPareto cards={scopeCards} snapshot={snapshot} summary={causeSummary} selected={causeFilter} onSelect={filterCause}/><section className={styles.cardTable} aria-label="Card details list"><div className={styles.tableToolbar}><label>Find a card<input value={search} onChange={e=>{setSearch(e.target.value);setLimit(20);}} placeholder="Listing title, SKU or receipt"/></label><label>Current status<select value={attention} onChange={e=>{setAttention(e.target.value as WorkAttention|"all");setCauseFilter("");setLimit(20);}}><option value="all">All statuses</option>{Object.entries(ATTENTION_LABELS).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label><label>Primary cause<select value={causeFilter} onChange={e=>filterCause(e.target.value as CauseCode|"")}><option value="">All causes</option>{causeSummary.rows.map(c=><option key={c.code} value={c.code}>{c.code} · {c.label} ({c.count})</option>)}</select></label><span>{tableCards.length.toLocaleString()} cards in this view</span></div><div className={styles.tableScroll}><table><thead><tr><th>Card / listing title</th><th>Stage</th><th>Current status / blocker</th><th>Cause</th><th>Next action</th><th><span className={styles.srOnly}>Open details</span></th></tr></thead><tbody>{tableCards.slice(0,limit).map(c=>{
      const r=snapshot.workflow[c.id],s=workflowStage(c,r),a=workAttention(c,r),reason=r?.holdReason||c.issues[0]||workHolds(c,r)[0];
      const next=a==="blocked"?"Resolve the saved requirement":s==="price"?"Continue saved price research":s==="identify"?"Review original photos and identity":s==="listing"?(c.receipts.some(x=>x.disposition==="draft")?"Resume saved draft and checks":"Complete listing checks"):s==="listed"?"Inspect saved receipt and status":"Match evidence to its original capture";
      const title=cardListingTitle(c),cause=blockerCause(c,r);
      const statusText=cause?.evidence.find(e=>e.code===cause.primary)?.reason||reason|| (s==="listed"?Array.from(new Set(c.receipts.map(x=>`Saved ${x.disposition}`))).join(" · "):s==="price"?"Price evidence incomplete":s==="identify"?"Identity not yet confirmed":"Price review in eBay draft; listing checks remain");
      return <tr key={c.id}><td><button className={styles.cardName} title={title} onClick={()=>openCard(c)}>{title}</button></td><td title={WORK_STAGES.find(x=>x.id===s)?.label}>{WORK_STAGES.find(x=>x.id===s)?.label}</td><td><div className={styles.rowStatus}><span className={styles.statusBadge} data-status={a}>{ATTENTION_LABELS[a]}</span><span title={statusText}>{statusText}</span></div></td><td>{cause?<button className={styles.causeCode} onClick={()=>filterCause(cause.primary)} title={`${causeDefinition(cause.primary).label}; filter matching cards`}>{cause.primary}</button>:"—"}</td><td title={next}>{next}</td><td><button className={styles.rowOpen} onClick={()=>openCard(c)} aria-label={`View card: ${title}`} title="Open card details">→</button></td></tr>;
    })}</tbody></table>{!tableCards.length?<p className={styles.empty}>No cards match this stage and status.</p>:null}</div>{tableCards.length>limit?<button className={styles.loadMore} onClick={()=>setLimit(n=>n+50)}>Show 50 more cards</button>:null}</section></>:<div className={styles.workspace}>
      <aside className={styles.queue}><h2>{WORK_STAGES.find(s=>s.id===stage)?.label}</h2><p>{WORK_STAGES.find(s=>s.id===stage)?.description}</p><label>Find a card<input disabled={saving} value={search} onChange={e=>{setSearch(e.target.value);setSelected("");setNote("");setLimit(20);}} placeholder="Player, SKU or receipt" /></label><small>{queue.length} in this view · {attention==="all"?"All statuses":ATTENTION_LABELS[attention]}</small>
        <div className={styles.queueList}>{queue.slice(0,limit).map(c=><button key={c.id} disabled={saving} aria-current={card?.id===c.id?"true":undefined} onClick={()=>{setSelected(c.id);setNote("");setError("");}}><strong>{c.identity.player||c.title}</strong><span>{[c.identity.parallel,c.identity.serial].filter(Boolean).join(" · ")||c.title}</span><small>{c.skus[0]||"Capture mapping needed"}{c.receipts.some(r=>r.disposition==="draft")?" · Saved draft":""}</small></button>)}</div>
        {queue.length>limit?<button onClick={()=>setLimit(n=>n+20)}>Show 20 more</button>:null}
      </aside>
      {card?<article className={styles.workbench} aria-label="Current card workbench">
        <div className={styles.cardHeading}><div><span className={styles.step}>{WORK_LANES.find(l=>l.id===lane)?.label} · {ATTENTION_LABELS[workAttention(card,review)]}</span><h2>{cardListingTitle(card)}</h2><p>{card.skus.join(" · ")} · {card.identity.condition || "Condition unresolved"} · {card.physicalUnits?"1 original capture":"Capture mapping unresolved"}</p></div><button disabled={saving} onClick={()=>advance(snapshot,card.id)}>Skip for now →</button></div>
        <ol className={styles.steps} aria-label="Card progress"><li data-done={card.identityStatus==="identified"}>1 · Identity <small>{card.identityStatus==="identified"?"Reviewed":"Needs review"}</small></li><li data-done={!!draftPrice}>2 · Draft price <small>{approved?"Seller-set / approved":draftPrice?"Review in eBay draft":"Needs evidence"}</small></li><li>3 · Listing checks <small>{card.textPrepared?"Text prepared; checks remain":"Review required"}</small></li><li data-done={!!live}>4 · eBay receipt <small>{live?`Saved ${live.disposition}`:draft?"Existing draft":"Not verified"}</small></li></ol>
        <div className={styles.cardBody}><div className={styles.photoPair}><OriginalPhoto key={`${card.id}:front`} card={card} side="front"/><OriginalPhoto key={`${card.id}:back`} card={card} side="back"/></div><div className={styles.decision}>
          <h3>{lane==="review-price"?"Review the saved asking price":lane==="listing-checks"?"Finish the remaining listing checks":lane==="identify"?"Resolve the identity gap":lane==="research"?"Continue from the saved price evidence":lane==="blocked"?"Resolve this card’s blocker":"Retain the existing listing"}</h3>
          <dl className={styles.identity}><div><dt>Card</dt><dd>{card.identity.cardNumber||"Unknown"}</dd></div><div><dt>Set / year</dt><dd>{[card.identity.season,card.identity.set].filter(Boolean).join(" ")||"Unknown"}</dd></div><div><dt>Parallel / serial</dt><dd>{[card.identity.parallel,card.identity.serial].filter(Boolean).join(" · ")||"Unknown"}</dd></div><div><dt>Language</dt><dd>{card.identity.language||"Unknown"}</dd></div></dl>
          <div className={styles.price}><div><small>{approved?"Approved asking price":"Saved proposal"}</small><strong>{money(asking?.item)}</strong></div><div><small>Buyer shipping</small><strong>{money(asking?.shipping)}</strong></div><p>{approved?"Approval retained. Inventory, shipping eligibility and listing checks still apply.":asking?"Current validated prices proceed to draft without another approval. Review the price in the saved eBay draft; no publication is authorized.":"No usable price is supplied. Continue from the retained research before setting an asking price."}</p></div>
          {asking?.reviewNotes?.length ? <ul aria-label="Pricing review notes">{asking.reviewNotes.map(note=><li key={note}>{note}</li>)}</ul> : null}
          {asking?.premiumReasons?.length?<p><strong>Premium features:</strong> {asking.premiumReasons.join(" · ")}. A 15% adjustment applies to mathematical estimates when the matching feature is absent from sold evidence.</p>:null}
          {asking?.colorMatchReviewed===false?<p>Color match has not been visually reviewed. No color-match premium has been assumed.</p>:null}
          {review?.manualPrice?<p><strong>Your manual price is saved.</strong> Automated estimates will not replace it.</p>:null}
          {canSetManualPrice(card)?<CardManualPrice key={`${card.id}:${review?.manualPrice?.updatedAt??review?.token}`} card={card} asking={asking} busy={saving} inPricing={currentStage==="price"} onSave={price=>save("set-price",false,price)}/>:null}
          {cardCause?<details className={styles.requirements} open><summary>{cardCause.primary} · {causeDefinition(cardCause.primary).label}</summary><p>Rule-based blocker category; root cause unconfirmed. Suggested owner: {causeDefinition(cardCause.primary).owner}.</p><p><b>Corrective action to investigate:</b> {causeDefinition(cardCause.primary).correction}</p><p><b>Prevention to investigate:</b> {causeDefinition(cardCause.primary).prevention}</p><ul>{cardCause.evidence.map((e,i)=><li key={i}><b>{e.code}</b> · {e.reason}</li>)}</ul></details>:card.issues.length||holds.length||review?.holdReason?<details className={styles.requirements} open={lane==="blocked"||lane==="identify"||lane==="research"}><summary>{card.issues.length+holds.length+(review?.holdReason?1:0)} open requirements</summary><ul>{[review?.holdReason,...card.issues,...holds].filter(Boolean).map((r,i)=><li key={i}>{r}</li>)}</ul></details>:null}
          <div className={styles.primaryActions}>
            
            {review?.holdReason?<button className={styles.primary} disabled={saving} onClick={()=>void save("resume",false)}>Return to workflow</button>:null}
            {draft && !live && !card.issues.length?<a className={styles.linkButton} href={`https://www.ebay.com/lstng?draftId=${draft.id}`} target="_blank" rel="noreferrer">Open recorded draft ↗</a>:null}
            {live?<a className={styles.linkButton} href={`https://www.ebay.com/itm/${live.id}`} target="_blank" rel="noreferrer">View recorded {live.disposition} listing ↗</a>:null}
            <button disabled={saving} onClick={()=>void copyHandoff()}>Copy work request</button>
          </div>
          <label className={styles.note}>Review note or blocker<textarea disabled={saving} value={note} maxLength={2000} onChange={e=>setNote(e.target.value)} placeholder={lane==="identify"?"Record the exact identity correction or missing detail…":"What needs to happen before this card can move on?"} /></label>
          <div className={styles.noteActions}><button disabled={saving||note.trim().length<3} onClick={()=>void save("note",false)}>Save note</button><button disabled={saving||note.trim().length<3} onClick={()=>void save("hold",true)}>Hold & next →</button></div>
        </div></div>
        <details className={styles.evidence}><summary>Saved evidence, decisions & receipt history</summary><h3>Recent decisions</h3>{review?.history.length?<ul>{[...review.history].reverse().map(e=><li key={e.requestId}>{new Date(e.at).toLocaleString()} · {e.action.replaceAll("-"," ")}{(e.action==="set-price"?e.at!==review.manualPrice?.updatedAt:e.action==="approve-price"&&e.token!==review.token)?" · superseded by changed source evidence":""}{e.price?` · ${money(e.price.item)} + ${money(e.price.shipping)} shipping`:""}{e.note?` — ${e.note}`:""}</li>)}</ul>:<p>No workflow decisions saved for this capture yet.</p>}<h3>Retained research requirements</h3>{card.holds.map((reason,i)=><p key={i}>{reason}</p>)}<h3>Retained prices</h3>{card.prices.map((p,i)=><p key={i}>{money(p.item)} + {money(p.shipping)} shipping · {p.updatedAt||"Date unknown"} · {p.source}</p>)}<h3>Saved receipts</h3><p>{Array.from(new Set(card.receipts.map(r=>`${r.disposition}: ${r.id}`))).join(" · ")||"No receipt recorded. Listing status remains unverified."}</p><h3>Originals and source files</h3><p>{card.captureId}</p>{[...card.originalPaths,...card.sources].map(p=><p key={p}>{p}</p>)}<h3>Work request</h3><pre>{workHandoff(card,review)}</pre></details>
      </article>:<section className={styles.empty}><h2>This stage is clear for this pass</h2><p>Choose another step or review skipped cards. Cards with saved receipts and unresolved mappings remain in their own queues.</p><button onClick={()=>setActive(false)}>Choose another stage</button><button onClick={()=>{setSearch("");setSkipped([]);setSelected("");}}>Review skipped cards</button></section>}
    </div>}
  </main>;
}
