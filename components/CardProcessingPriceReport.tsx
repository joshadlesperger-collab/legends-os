"use client";

import {useCallback,useEffect,useId,useMemo,useRef,useState} from 'react';
import {priceCheckMath,PRICE_CHECK_POLICY} from '@/lib/card-processing-v2-price-check';
import type {PriceCheckRow} from '@/lib/card-processing-v2-price-check';
import styles from './CardProcessingPriceReport.module.css';

type PublicationAssessment={status:'eligible'|'review'|'blocked';gapBasisPoints:number|null;reasons:string[];permission:'authorized';transportReady:boolean};
type MarketSummary={minDeliveredCents:number|null;maxDeliveredCents:number|null;medianDeliveredCents:number|null;matchedListingCount:number|null;independentSellerCount:number|null;observedSearchResultCount?:number;reportedSearchTotal?:number;bounded:true};
type Row=PriceCheckRow&{quantity?:number;publicationAssessment?:PublicationAssessment;marketSummary?:MarketSummary};
type Report={mode:'preview';canPublish:false;status:'complete';startedAt:string;endedAt:string;snapshotObservedAt:string;totalDrafts:number;completedDrafts:number;elapsedMs:number;marketRequestCount:number;aiRequests:number;rows:Row[];publicationPolicy?:{version:string;thresholdPercent:10;manualControl:true;transportReady:boolean;reason:string}};
type View='matched'|'within'|'over'|'ready'|'unmatched'|'all';
const money=(value:number|null|undefined)=>value===null||value===undefined?'Unknown':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(value/100);
const when=(value:string)=>new Date(value).toLocaleString('en-US',{timeZone:'America/Chicago'})+' CT';
const known=(value:number|null|undefined):value is number=>Number.isSafeInteger(value)&&value!==null&&value!==undefined&&value>=0;
const matched=(row:Row)=>Boolean(row.lowestComp&&known(row.lowestComp.totalCents));
const ready=(row:Row)=>matched(row)&&known(row.shippingCents);
function gapGroup(row:Row){const low=row.lowestComp?.totalCents;if(!known(row.ourTotalCents)||!known(low)||low===0)return null;return Math.abs(row.ourTotalCents-low)*10000<=low*1000?'within':'over';}
const names:Record<string,string>={'within-band':'Price-band check passed','below-band':'Below price band','above-band':'Above price band','no-comp':'No matching active price','comp-uncertain':'Comp evidence uncertain','unknown-price':'Our item price or shipping unknown','provider-error':'Market connection incomplete','identity-conflict':'Identity conflict','below-item-floor':'Item below $1.49 floor','watcher-floor':'Watcher item below $1.49 floor'};
const label=(value:string)=>names[value]??value.replaceAll('-',' ');
const reasons=['no-comp','comp-uncertain','unknown-price','provider-error','identity-conflict','below-item-floor','watcher-floor'];
function compUrl(value:string){try{const url=new URL(value);return url.protocol==='https:'&&['ebay.com','www.ebay.com'].includes(url.hostname)&&!url.username&&!url.password?url.href:undefined;}catch{return undefined;}}
function Prices({item,shipping,total}:{item:number|null;shipping:number|null;total:number|null}){return <><strong>{money(item)} item</strong><small>{money(shipping)} shipping</small><strong>{money(total)} delivered</strong></>;}
function MarketRange({row}:{row:Row}){
 const summary=row.marketSummary;
 return <div className={styles.marketRange}><small>Observed delivered range: {money(summary?.minDeliveredCents)} – {money(summary?.maxDeliveredCents)}</small><small>Observed median: {money(summary?.medianDeliveredCents)}</small><small>{summary?.matchedListingCount??'Unknown'} matched active listings observed · {summary?.independentSellerCount??'Unknown'} independent sellers</small><small>Bounded sample, not the total number of cards listed on eBay.</small></div>;
}
function Assessment({row}:{row:Row}){
 const assessment=row.publicationAssessment,group=gapGroup(row);
 return <><strong className={styles.flag}>{assessment?.status==='eligible'?'Confirmed eligible for manual publishing':assessment?.status==='blocked'?'Publishing blocked':'Keep in review'}</strong><small>{group==='within'?'Within 10% numerically':group==='over'?'More than 10% from the lowest matching ask':'Percentage gap unavailable'}{assessment?.gapBasisPoints!==null&&assessment?.gapBasisPoints!==undefined?` · ${(assessment.gapBasisPoints/100).toFixed(2)}% gap`:''}</small><small>{(assessment?.reasons??['Current publishing assessment is unavailable.']).map(label).join('; ')}</small><small>{(row.flags??[]).filter(flag=>!['below-band','above-band','within-band'].includes(flag)).map(label).join('; ')}</small><details><summary>Historical 5%/$1 check</summary><small>This saved check used the previous rule; the current rule is 10%.</small><small>{row.reason}</small><small>Legacy allowed delivered gap: {money(row.allowanceCents)}</small></details></>;
}
function Proposal({row,basisPoints}:{row:Row;basisPoints:number|null}){
 if(basisPoints===null)return <span className={styles.muted}>Discount preview off</span>;
 if(!ready(row))return <span className={styles.flag}>Unavailable: {matched(row)?'our shipping is unknown':'no matching active price'}</span>;
 const total=Math.round(row.lowestComp!.totalCents*(10000-basisPoints)/10000),item=total-row.shippingCents!,flags=(row.flags??[]).filter(flag=>['comp-uncertain','provider-error','identity-conflict','no-comp'].includes(flag)).map(label);
 if(item<0)return <><strong>{money(total)} proposed delivered</strong><small className={styles.flag}>Invalid: proposed total does not cover our shipping. No eligible item price.</small></>;
 const math=priceCheckMath(item,row.shippingCents,row.lowestComp!.totalCents);
 if(item<PRICE_CHECK_POLICY.minimumItemCents)flags.push('Proposed item below $1.49 floor');
 if(math.watcherItemCents!<PRICE_CHECK_POLICY.minimumItemCents)flags.push('Proposed watcher item below $1.49 floor');
 const low=row.lowestComp!.totalCents;
 if(low===0)flags.push('Cannot calculate a percentage gap against a zero comp price');
 else if(Math.abs(total-low)*10000>low*1000)flags.push('Proposed delivered price is more than 10% from the lowest matching ask');
 return <><Prices item={item} shipping={row.shippingCents} total={total}/><small>Proposed 8% watcher: {money(math.watcherItemCents)} item / {money(math.watcherTotalCents)} delivered</small><small className={styles.flag}>{flags.length?flags.join('; '):'Within 10% numerically — local calculation only'}</small><small>Does not change the original price or publishing assessment.</small></>;
}

export default function CardProcessingPriceReport(){
 const [report,setReport]=useState<Report|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState('');
 const [view,setView]=useState<View>('matched'),[reason,setReason]=useState(''),[search,setSearch]=useState(''),[page,setPage]=useState(0),[discount,setDiscount]=useState('');
 const alive=useRef(true),request=useRef<AbortController|null>(null),heading=useId();
 const load=useCallback(async()=>{
  request.current?.abort();const controller=new AbortController();request.current=controller;const timer=setTimeout(()=>controller.abort(),20000);setLoading(true);setError('');
  try{const response=await fetch('/api/card-processing-v2/price-check/report',{cache:'no-store',signal:controller.signal}),data=await response.json() as Report&{error?:string};if(!response.ok)throw Error(data.error||'Could not load the saved price report.');if(data.mode!=='preview'||data.canPublish!==false||data.status!=='complete'||!Array.isArray(data.rows))throw Error('The complete saved report is not available.');if(alive.current&&request.current===controller){setReport(data);setPage(0);}}
  catch(reason){if(alive.current&&request.current===controller)setError(controller.signal.aborted?'The saved report took too long to load. Refresh to try again.':reason instanceof Error?reason.message:'Could not load the saved report.');}
  finally{clearTimeout(timer);if(alive.current&&request.current===controller)setLoading(false);}
 },[]);
 useEffect(()=>{alive.current=true;void load();return()=>{alive.current=false;request.current?.abort();};},[load]);
 const counts=useMemo(()=>{const rows=report?.rows??[];return{matched:rows.filter(matched).length,ready:rows.filter(ready).length,within:rows.filter(row=>gapGroup(row)==='within').length,over:rows.filter(row=>gapGroup(row)==='over').length,unmatched:rows.filter(row=>!matched(row)).length,all:rows.length};},[report]);
 const filtered=useMemo(()=>{const query=search.trim().toLowerCase();return(report?.rows??[]).filter(row=>(view==='all'||view==='matched'&&matched(row)||view==='ready'&&ready(row)||view==='within'&&gapGroup(row)==='within'||view==='over'&&gapGroup(row)==='over'||view==='unmatched'&&!matched(row))&&(!reason||(row.flags??[]).includes(reason))&&(!query||(row.title+' '+row.draftId).toLowerCase().includes(query)));},[report,view,reason,search]);
 const pages=Math.max(1,Math.ceil(filtered.length/25)),currentPage=Math.min(page,pages-1),visible=filtered.slice(currentPage*25,currentPage*25+25),eligible=filtered.filter(ready);
 const discountValid=discount.trim()===''||/^\d{1,3}(?:\.\d{1,2})?$/.test(discount.trim())&&Number(discount)>=0&&Number(discount)<=100;
 const basisPoints=discount.trim()===''||!discountValid?null:Math.round(Number(discount)*100);
 function filter(next:View){setView(next);setReason('');setPage(0);}
 return <section className={styles.panel} aria-labelledby={heading}>
  <header className={styles.heading}><div><span className={styles.kicker}>Saved market comparison</span><h2 id={heading}>Draft price report</h2></div><span className={styles.badge}>Local preview only</span></header>
  <p>Choose drafts with a matching active price and try a discount. These are frozen observations; this page does not change prices or listings. Active asking prices are not completed-sale prices.</p>
  <div className={styles.toolbar}><button type="button" onClick={()=>void load()} disabled={loading}>{loading?'Loading saved report…':'Refresh saved report'}</button><span role="status" aria-live="polite">{loading?'Reading the saved report — no new market check.':report?`${report.completedDrafts} of ${report.totalDrafts} saved checks loaded`:'Report unavailable'}</span></div>
  {error&&<p className={styles.error} role="alert">{error}</p>}
  {report&&<>
   <p className={styles.muted}>Draft snapshot: {when(report.snapshotObservedAt)}. Market checks: {when(report.startedAt)} – {when(report.endedAt)}. Current prices below are unchanged observations from that run.</p>
   <div className={styles.metrics}><span><strong>{(report.elapsedMs/1000).toFixed(1)}s</strong> total elapsed</span><span><strong>{(report.elapsedMs/report.totalDrafts/1000).toFixed(2)}s</strong> throughput / draft</span><span><strong>{(report.totalDrafts*3600000/report.elapsedMs).toFixed(1)}</strong> drafts / hour</span><span><strong>{report.marketRequestCount}</strong> market requests in saved run</span><span><strong>{report.aiRequests}</strong> AI/model calls in saved run</span><span>Provider API cost / draft: <strong>Unavailable</strong></span></div>
   <p className={styles.muted}>Elapsed includes snapshot and concurrent market work; throughput per draft is not individual latency. Provider API charges are unavailable, not zero. Reading this saved report does not start market or AI calls.</p>
   <div className={styles.publication}>
    <div><strong>Current rule: within 10% of the lowest matching delivered ask</strong><p>Use the manual publishing button only after confirmed matches meet the rule. Every uncertain match stays in review, including prices within 10% numerically.</p><p>{report.rows.filter(row=>row.publicationAssessment?.status==='eligible').length} confirmed eligible drafts. {report.publicationPolicy?.reason??'Native saved-draft publishing is not connected. Saved assessments are unavailable.'}</p></div>
    <button type="button" disabled aria-describedby={`${heading}-publisher`}>Publish eligible drafts</button>
    <small id={`${heading}-publisher`}>Disabled: no verified publishing handoff is available from this report. No automatic publishing.</small>
   </div>
   <div className={styles.tabs} aria-label="Draft groups">{([['matched','Has matching active price'],['within','Within 10% — numeric only'],['over','Over 10% — review'],['ready','Ready for calculation'],['unmatched','No matching active price'],['all','All drafts']] as [View,string][]).map(([key,text])=><button type="button" key={key} aria-pressed={view===key} onClick={()=>filter(key)}>{text} <strong>{counts[key]}</strong></button>)}</div>
   <div className={styles.controls}><label>Find draft<input type="search" placeholder="Title or draft ID" value={search} onChange={event=>{setSearch(event.target.value);setPage(0);}}/></label><label>Exception reason<select value={reason} onChange={event=>{setReason(event.target.value);setPage(0);}}><option value="">All reasons</option>{reasons.map(flag=><option key={flag} value={flag}>{label(flag)} ({report.rows.filter(row=>(row.flags??[]).includes(flag)).length})</option>)}</select></label><label>Optional discount from lowest delivered price (%)<input type="text" inputMode="decimal" placeholder="Off" value={discount} onChange={event=>setDiscount(event.target.value)} aria-invalid={!discountValid} aria-describedby={`${heading}-discount`}/></label></div>
   <p id={`${heading}-discount`} className={!discountValid?styles.error:styles.muted}>{discountValid?'Blank turns the calculator off. Enter 0–100% with up to two decimal places. Shipping stays unchanged; watcher offers take 8% off item price only. The current rule uses a 10% delivered-price gap; the discount is an optional local scenario, not a prescribed price. Uncertain matches stay in review.':'Enter a discount from 0 to 100%, with no more than two decimal places.'}</p>
   <p className={styles.muted} role="status">Calculator scope: {eligible.length} calculation-ready drafts in the current {filtered.length}-draft filtered view. The same local discount applies across its pages; rows without a comp or known shipping remain unavailable.</p>
   <div className={styles.pager}><button type="button" disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}>Previous 25</button><span role="status">{filtered.length} drafts · Page {currentPage+1} of {pages}</span><button type="button" disabled={currentPage>=pages-1} onClick={()=>setPage(currentPage+1)}>Next 25</button></div>
   <div className={styles.scroll}><table><caption>Original prices and optional discount scenarios are separate. The local discount applies to this filtered view across all pages.</caption><thead><tr><th scope="col">Draft</th><th scope="col">Our original price</th><th scope="col">Lowest matching active price found</th><th scope="col">Original 8% watcher offer</th><th scope="col">Current 10% rule / review</th><th scope="col">Optional proposed price</th></tr></thead><tbody>{visible.map(row=><tr key={row.draftId}><td><strong>{row.title}</strong><small>Draft {row.draftId} · Quantity {row.quantity??'Unknown'}</small>{!ready(row)&&<small className={styles.flag}>{matched(row)?'Our shipping is unknown':'No matching active price'}</small>}</td><td><Prices item={row.currentItemCents} shipping={row.shippingCents} total={row.ourTotalCents}/><small>Source: {row.current?.source??'Unavailable'}</small>{row.current?.observedAt&&<small>{when(row.current.observedAt)}</small>}</td><td>{row.lowestComp?<><Prices item={row.lowestComp.itemCents} shipping={row.lowestComp.shippingCents} total={row.lowestComp.totalCents}/><MarketRange row={row}/><details><summary>Comp evidence and limitations</summary><p><a href={compUrl(row.lowestComp.url)} target="_blank" rel="noopener noreferrer">{row.lowestComp.title}</a></p><small>Confidence: {row.lowestComp.confidence??'Unspecified'}. Seller: {row.lowestComp.seller}. Source: eBay active asking-price observation, {when(row.lowestComp.observedAt)}.</small><small>{row.lowestComp.identityProof.join('; ')}</small><small>{(row.lowestComp.warnings??[]).join('; ')}</small><small>{row.limitations.join('; ')}</small></details></>:<><span className={styles.flag}>No matching active price found</span><MarketRange row={row}/></>}</td><td><Prices item={row.watcherItemCents} shipping={row.shippingCents} total={row.watcherTotalCents}/></td><td><Assessment row={row}/></td><td><Proposal row={row} basisPoints={basisPoints}/></td></tr>)}{!visible.length&&<tr><td colSpan={6}>No drafts match these filters.</td></tr>}</tbody></table></div>
   <p className={styles.boundary}>Original prices, draft quantities and photos remain unchanged. Conditional publishing is authorized through a manual button only; this saved report does not publish automatically. Local discount calculations do not approve a listing or change its price.</p>
  </>}
 </section>;
}
