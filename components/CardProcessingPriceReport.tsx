"use client";

import {useCallback,useEffect,useId,useMemo,useRef,useState} from 'react';
import type {PriceCheckRow} from '@/lib/card-processing-v2-price-check';
import {draftDeliveredDelta,manualDraftPrice} from '@/lib/card-draft-publication-client';
import CardDraftPublishPanel from './CardDraftPublishPanel';
import styles from './CardProcessingPriceReport.module.css';

type MarketSummary={minDeliveredCents:number|null;maxDeliveredCents:number|null;medianDeliveredCents:number|null;matchedListingCount:number|null;independentSellerCount:number|null;bounded:true};
type Row=PriceCheckRow&{sku?:string;quantity?:number;marketSummary?:MarketSummary};
type Report={reportId:string;mode:'preview';canPublish:false;status:'complete';startedAt:string;endedAt:string;snapshotObservedAt:string;totalDrafts:number;completedDrafts:number;elapsedMs:number;marketRequestCount:number;aiRequests:number;rows:Row[];unpublishedMembership?:{observedAt:string;sourceDraftCount:number;excludedDraftIds:string[]}};
type View='matched'|'within'|'over'|'ready'|'unmatched'|'all';
const money=(value:number|null|undefined)=>typeof value==='number'?new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(value/100):'—';
const signed=(value:number|null)=>value===null?'—':(value>0?'+':'')+money(value);
const when=(value:string)=>new Date(value).toLocaleString('en-US',{timeZone:'America/Chicago'})+' CT';
const known=(value:number|null|undefined):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const matched=(row:Row)=>Boolean(row.lowestComp&&known(row.lowestComp.totalCents));
const ready=(row:Row)=>matched(row)&&known(row.shippingCents);
function gapGroup(row:Row){const low=row.lowestComp?.totalCents;if(!known(row.ourTotalCents)||!known(low)||low===0)return null;return Math.abs(row.ourTotalCents-low)*10000<=low*1000?'within':'over';}
const reasons=['no-comp','comp-uncertain','unknown-price','provider-error','identity-conflict','below-item-floor','watcher-floor'];
const reasonNames:Record<string,string>={'no-comp':'No matching price','comp-uncertain':'Comp needs review','unknown-price':'Unknown price/shipping','provider-error':'Market connection','identity-conflict':'Identity conflict','below-item-floor':'Below minimum price','watcher-floor':'Watcher below minimum'};
function compUrl(value:string){try{const u=new URL(value);return u.protocol==='https:'&&['ebay.com','www.ebay.com'].includes(u.hostname)&&!u.username&&!u.password?u.href:undefined;}catch{return undefined;}}
function compCondition(row:Row){return row.lowestComp?.identityProof.some(proof=>/raw near mint/i.test(proof))?'NM':'—';}

export default function CardProcessingPriceReport(){
 const [report,setReport]=useState<Report|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState('');
 const [view,setView]=useState<View>('matched'),[reason,setReason]=useState(''),[search,setSearch]=useState(''),[page,setPage]=useState(0),[discount,setDiscount]=useState(''),[discountMessage,setDiscountMessage]=useState('');
 const [deltaSort,setDeltaSort]=useState<'none'|'ascending'|'descending'>('none'),[selected,setSelected]=useState<Record<string,boolean>>({}),[manualPrices,setManualPrices]=useState<Record<string,string>>({});
 const alive=useRef(true),request=useRef<AbortController|null>(null),heading=useId();
 const load=useCallback(async()=>{
  request.current?.abort();const controller=new AbortController();request.current=controller;const timer=setTimeout(()=>controller.abort(),20000);setLoading(true);setError('');
  try{const response=await fetch('/api/card-processing-v2/price-check/report',{cache:'no-store',signal:controller.signal}),data=await response.json() as Report&{error?:string};if(!response.ok)throw Error(data.error||'Could not load the saved report.');if(data.mode!=='preview'||data.canPublish!==false||data.status!=='complete'||!Array.isArray(data.rows))throw Error('The saved report is incomplete.');if(alive.current&&request.current===controller){setReport(data);setPage(0);setSelected({});setManualPrices({});setDiscountMessage('');}}
  catch(e){if(alive.current&&request.current===controller)setError(controller.signal.aborted?'Report load timed out. Try refresh.':e instanceof Error?e.message:'Could not load the report.');}
  finally{clearTimeout(timer);if(alive.current&&request.current===controller)setLoading(false);}
 },[]);
 useEffect(()=>{alive.current=true;void load();return()=>{alive.current=false;request.current?.abort();};},[load]);
 const counts=useMemo(()=>{const rows=report?.rows??[];return{matched:rows.filter(matched).length,ready:rows.filter(ready).length,within:rows.filter(r=>gapGroup(r)==='within').length,over:rows.filter(r=>gapGroup(r)==='over').length,unmatched:rows.filter(r=>!matched(r)).length,all:rows.length};},[report]);
 const filtered=useMemo(()=>{const q=search.trim().toLowerCase();return(report?.rows??[]).filter(r=>(view==='all'||view==='matched'&&matched(r)||view==='ready'&&ready(r)||view==='within'&&gapGroup(r)==='within'||view==='over'&&gapGroup(r)==='over'||view==='unmatched'&&!matched(r))&&(!reason||r.flags.includes(reason))&&(!q||(r.title+' '+r.draftId).toLowerCase().includes(q)));},[report,view,reason,search]);
 const sorted=useMemo(()=>deltaSort==='none'?filtered:filtered.slice().sort((a,b)=>{const x=draftDeliveredDelta(a.ourTotalCents,a.lowestComp?.totalCents),y=draftDeliveredDelta(b.ourTotalCents,b.lowestComp?.totalCents);if(x===null||y===null)return x===null?(y===null?0:1):-1;return(deltaSort==='ascending'?x-y:y-x)||a.draftId.localeCompare(b.draftId);}),[filtered,deltaSort]);
 const selectedRows=(report?.rows??[]).filter(r=>selected[r.draftId]);
 const allSelected=filtered.length>0&&filtered.every(r=>selected[r.draftId]),someSelected=filtered.some(r=>selected[r.draftId]);
 function selectFiltered(checked:boolean){setSelected(prior=>{const next={...prior};for(const row of filtered){if(checked)next[row.draftId]=true;else delete next[row.draftId];}return next;});}
 const pages=Math.max(1,Math.ceil(filtered.length/25)),currentPage=Math.min(page,pages-1),visible=sorted.slice(currentPage*25,currentPage*25+25);
 const discountValid=/^\d{1,3}(?:\.\d{1,2})?$/.test(discount.trim())&&Number(discount)>=0&&Number(discount)<=100;
 function fillDiscount(){if(!discountValid)return;const basisPoints=Math.round(Number(discount)*100);let filled=0;const values:Record<string,string>={};for(const row of filtered){if(!ready(row))continue;const item=Math.round(row.lowestComp!.totalCents*(10000-basisPoints)/10000)-row.shippingCents!;if(item<149)continue;values[row.draftId]=(item/100).toFixed(2);filled++;}setManualPrices(prior=>({...prior,...values}));setDiscountMessage(`${filled} manual prices filled; ${filtered.length-filled} unavailable or below minimum. Preview only.`);}
 function filter(next:View){setView(next);setReason('');setPage(0);setDiscountMessage('');}
 return <section className={styles.panel} aria-labelledby={heading}>
  <header className={styles.heading}><h2 id={heading}>Draft price report</h2><button type="button" onClick={()=>void load()} disabled={loading}>{loading?'Loading…':'Refresh saved report'}</button></header>
  <span role="status">{loading?'Loading saved report…':report?`${report.totalDrafts} unpublished drafts loaded`:'Report unavailable'}</span>
  {error&&<p className={styles.error} role="alert">{error}</p>}
  {report&&<>
   <details className={styles.reportDetails}><summary>Report details</summary>
    {report.unpublishedMembership&&<p>Unpublished membership checked {when(report.unpublishedMembership.observedAt)}; {report.unpublishedMembership.excludedDraftIds.length} published or removed drafts excluded.</p>}
    <p>Price observations: {when(report.unpublishedMembership?.observedAt??report.snapshotObservedAt)}. Market checks: {when(report.startedAt)} – {when(report.endedAt)}. Prices and comparisons are saved observations, not a new market scan.</p>
    <p>Original run: {report.unpublishedMembership?.sourceDraftCount??report.totalDrafts} drafts, {(report.elapsedMs/1000).toFixed(1)}s, {(report.elapsedMs/(report.unpublishedMembership?.sourceDraftCount??report.totalDrafts)/1000).toFixed(2)}s/draft; {report.marketRequestCount} market requests, {report.aiRequests} AI calls. Provider cost unavailable.</p>
    <p>Listed count and range describe matching active listings observed in a bounded search, not all eBay inventory. NM means raw Near Mint condition was confirmed in retained comparison evidence. Missing information shows —.</p>
   </details>
   <CardDraftPublishPanel key={report.reportId} reportId={report.reportId} rows={selectedRows} manualPrices={manualPrices} onClear={()=>setSelected({})}/>
   <div className={styles.tabs} aria-label="Draft groups">{([['matched','Has matching price'],['within','Within 10%'],['over','Over 10%'],['ready','Ready for calculation'],['unmatched','No matching price'],['all','All drafts']] as [View,string][]).map(([key,text])=><button type="button" key={key} aria-pressed={view===key} onClick={()=>filter(key)}>{text} <strong>{counts[key]}</strong></button>)}</div>
   <div className={styles.controls}>
    <label>Find draft<input type="search" placeholder="Card or draft ID" value={search} onChange={event=>{setSearch(event.target.value);setPage(0);}}/></label>
    <label>Exception<select value={reason} onChange={event=>{setReason(event.target.value);setPage(0);}}><option value="">All</option>{reasons.map(flag=><option key={flag} value={flag}>{reasonNames[flag]} ({report.rows.filter(r=>r.flags.includes(flag)).length})</option>)}</select></label>
    <label>Discount from lowest total (%)<input type="text" inputMode="decimal" placeholder="0–100" value={discount} onChange={event=>setDiscount(event.target.value)} aria-invalid={discount!==''&&!discountValid}/></label>
    <button type="button" disabled={!discountValid} onClick={fillDiscount}>Fill manual prices</button>
   </div>
   {discountMessage&&<p role="status" className={styles.muted}>{discountMessage}</p>}
   <div className={styles.selection}><label><input type="checkbox" aria-label="Select all filtered drafts" checked={allSelected} ref={node=>{if(node)node.indeterminate=someSelected&&!allSelected;}} onChange={event=>selectFiltered(event.target.checked)}/> Select all {filtered.length} filtered drafts</label><span>Blank manual BIN keeps the current price. Prices are not saved until reviewed publishing.</span></div>
   <div className={styles.pager}><button type="button" disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}>Previous 25</button><span role="status">{filtered.length} drafts · Page {currentPage+1} of {pages}</span><button type="button" disabled={currentPage>=pages-1} onClick={()=>setPage(currentPage+1)}>Next 25</button></div>
   <div className={styles.scroll}><table><caption>Delivered totals include shipping. Difference = our total − lowest total; negative means we are cheaper.</caption>
    <thead><tr><th scope="col">Select</th><th scope="col">Card</th><th scope="col">Our BIN</th><th scope="col">Our S&amp;H</th><th scope="col">Our total</th><th scope="col">Lowest total</th><th scope="col">Condition</th><th scope="col" title="Matching active listings observed, not the total number on eBay">Listed*</th><th scope="col">Landed range</th><th scope="col" aria-sort={deltaSort}><button type="button" onClick={()=>{setDeltaSort(v=>v==='ascending'?'descending':'ascending');setPage(0);}}>Difference ($) {deltaSort==='ascending'?'↑':deltaSort==='descending'?'↓':'↕'}</button></th><th scope="col">Manual BIN</th></tr></thead>
    <tbody>{visible.map(row=>{const value=manualPrices[row.draftId]??'',parsed=manualDraftPrice(value),proposedTotal=parsed.itemCents!==undefined&&known(row.shippingCents)?parsed.itemCents+row.shippingCents:null;return <tr key={row.draftId}>
     <td><input type="checkbox" aria-label={`Select draft ${row.draftId}: ${row.title}`} checked={Boolean(selected[row.draftId])} onChange={event=>setSelected(prior=>({...prior,[row.draftId]:event.target.checked}))}/></td>
     <td><strong>{row.title}</strong><details><summary>Details</summary><small>Draft {row.draftId} · Qty {row.quantity??'—'}</small><small>{row.flags.map(flag=>reasonNames[flag]??flag).join('; ')}</small>{row.lowestComp&&<><a href={compUrl(row.lowestComp.url)} target="_blank" rel="noopener noreferrer">Comparable listing</a><small>{row.lowestComp.identityProof.join('; ')}</small><small>{row.limitations.join('; ')}</small></>}</details></td>
     <td>{money(row.currentItemCents)}</td><td>{money(row.shippingCents)}</td><td><strong>{money(row.ourTotalCents)}</strong></td>
     <td>{money(row.lowestComp?.totalCents)}</td><td>{compCondition(row)}</td><td>{row.marketSummary?.matchedListingCount??row.compCount}</td>
     <td>{row.marketSummary?.minDeliveredCents==null?'—':`${money(row.marketSummary.minDeliveredCents)}–${money(row.marketSummary.maxDeliveredCents)}`}</td>
     <td>{signed(draftDeliveredDelta(row.ourTotalCents,row.lowestComp?.totalCents))}</td>
     <td><input className={styles.priceInput} type="text" inputMode="decimal" aria-label={`Manual item price for draft ${row.draftId}`} placeholder="Keep" value={value} onChange={event=>setManualPrices(prior=>({...prior,[row.draftId]:event.target.value}))} aria-invalid={Boolean(parsed.error)}/>{parsed.error?<small className={styles.flag}>{parsed.error}</small>:parsed.itemCents!==undefined&&<small title="Proposed delivered total and difference">{money(proposedTotal)} total · {signed(draftDeliveredDelta(proposedTotal,row.lowestComp?.totalCents))}</small>}</td>
    </tr>;})}{!visible.length&&<tr><td colSpan={11}>No drafts match.</td></tr>}</tbody>
   </table></div>
  </>}
 </section>;
}

