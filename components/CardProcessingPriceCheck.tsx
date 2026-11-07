"use client";

import {useCallback,useEffect,useId,useMemo,useRef,useState} from 'react';
import type {PriceCheckCandidate,PriceCheckRun,PriceCheckRow} from '@/lib/card-processing-v2-price-check';
import {PRICE_CHECK_POLICY} from '@/lib/card-processing-v2-price-check';
import styles from './CardProcessingPriceCheck.module.css';

const endpoint='/api/card-processing-v2/price-check';
const money=(cents:number|null|undefined)=>cents===null||cents===undefined?'Unknown':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(cents/100);
const when=(value:string|null|undefined)=>value?new Date(value).toLocaleString('en-US',{timeZone:'America/Chicago',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})+' CT':'Observation time unavailable';
const duration=(ms:number)=>`${Math.floor(ms/60000)}m ${Math.floor(ms/1000)%60}s`;
function compUrl(value:string){try{const url=new URL(value);return url.protocol==='https:'&&['www.ebay.com','ebay.com'].includes(url.hostname)&&!url.username&&!url.password?url.href:undefined;}catch{return undefined;}}
function cents(value:string){
 const text=value.trim();if(!/^\d+(?:\.\d{1,2})?$/.test(text))throw Error('Enter dollars with no more than two decimal places.');
 const [whole,fraction='']=text.split('.'),parsed=Number(whole)*100+Number(fraction.padEnd(2,'0'));
 if(!Number.isSafeInteger(parsed)||parsed>100_000_000)throw Error('Enter a supported nonnegative price.');return parsed;
}
const labels:Record<string,string>={
 'within-band':'Price-band check passed', 'below-band':'Below the price band', 'above-band':'Above the price band',
 'no-comp':'No valid comp found','unknown-price':'Current price or shipping unknown','comp-uncertain':'Comparable evidence is uncertain',
 'provider-error':'Market connection needs attention','identity-conflict':'Identity evidence needs attention',
 'watcher-floor':'Watcher offer falls below the item-price floor','below-item-floor':'Item price falls below the price floor',
};
const label=(status:string)=>labels[status]??status.replaceAll('-',' ');
type Choice='keep'|'match-low'|'custom'|'leave-draft';
type CandidateResponse={mode:'preview';canPublish:false;candidates:PriceCheckCandidate[];latestRun:PriceCheckRun|null};

function Difference({row}:{row:PriceCheckRow}){
 if(row.ourTotalCents===null||!row.lowestComp)return <span>Unknown</span>;
 const gap=row.ourTotalCents-row.lowestComp.totalCents;
 return <span>{money(Math.abs(gap))} {gap<0?'below':gap>0?'above':'difference'}<small>{row.lowestComp.totalCents>0?`${(Math.abs(gap)*100/row.lowestComp.totalCents).toFixed(1)}% ${gap<0?'below':gap>0?'above':'difference'}`:'Percentage unavailable'}</small></span>;
}

export default function CardProcessingPriceCheck(){
 const [candidates,setCandidates]=useState<PriceCheckCandidate[]>([]),[run,setRun]=useState<PriceCheckRun|null>(null);
 const [opened,setOpened]=useState(false),[loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[decisionBusy,setDecisionBusy]=useState<string|null>(null);
 const [selected,setSelected]=useState<string[]>([]),[search,setSearch]=useState(''),[page,setPage]=useState(0);
 const [manual,setManual]=useState<Record<string,{item:string;shipping:string}>>({}),[newPrices,setNewPrices]=useState<Record<string,string>>({});
 const [error,setError]=useState(''),[feedback,setFeedback]=useState(''),[tick,setTick]=useState(Date.now());
 const alive=useRef(true),pendingRead=useRef(false),started=useRef<number|null>(null),scope=useRef<string[]>([]),generation=useRef(0),activeRunId=useRef<string|null>(null);
 const headingId=useId(),statusId=useId();
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;generation.current++;};},[]);
 const read=useCallback(async(poll=false)=>{
  if(pendingRead.current)return;pendingRead.current=true;if(!poll)setLoading(true);
  const current=generation.current;
  try{
   const response=await fetch(poll&&activeRunId.current?`${endpoint}?runId=${encodeURIComponent(activeRunId.current)}`:endpoint,{cache:'no-store',signal:AbortSignal.timeout(20000)}),data=await response.json() as CandidateResponse&{error?:string;run?:PriceCheckRun|null};
   if(!response.ok)throw Error(data.error||'Could not read saved draft prices.');
   if(data.mode!=='preview'||data.canPublish!==false)throw Error('The preview response was not recognized. No listing was changed.');
   if(!alive.current||current!==generation.current)return;
   if(poll){if(data.run?.id===activeRunId.current)setRun(data.run);return;}
   if(!Array.isArray(data.candidates))throw Error('The saved draft response was not recognized.');
   setCandidates(data.candidates);setOpened(true);setRun(data.latestRun);setSelected(current=>current.filter(id=>data.candidates.some(c=>c.draftId===id)));setPage(0);setError('');setFeedback(data.latestRun?`Loaded the saved preview from ${when(data.latestRun.endedAt??data.latestRun.startedAt)}. No new market check has started.`:'Saved draft observations loaded. No market check has started.');
  }catch(reason){if(alive.current&&!poll)setError(reason instanceof Error?reason.message:'Could not load the preview.');}
  finally{pendingRead.current=false;if(alive.current&&!poll)setLoading(false);}
 },[]);
 useEffect(()=>{
  if(!busy)return;const clock=setInterval(()=>setTick(Date.now()),1000),poll=setInterval(()=>{if(document.visibilityState==='visible')void read(true);},2500);
  return()=>{clearInterval(clock);clearInterval(poll);};
 },[busy,read]);
 const filtered=useMemo(()=>{const query=search.trim().toLowerCase();return candidates.filter(c=>!query||`${c.title} ${c.draftId}`.toLowerCase().includes(query));},[candidates,search]);
 const pages=Math.max(1,Math.ceil(filtered.length/20)),visible=filtered.slice(Math.min(page,pages-1)*20,(Math.min(page,pages-1)+1)*20);
 const updateManual=(id:string,key:'item'|'shipping',value:string)=>setManual(current=>({...current,[id]:{item:current[id]?.item??'',shipping:current[id]?.shipping??'',[key]:value}}));
 function select(id:string,checked:boolean){setError('');setSelected(current=>checked?current.includes(id)?current:current.length<20?[...current,id]:current:current.filter(value=>value!==id));}
 async function preview(){
  setError('');setFeedback('');if(!selected.length||selected.length>20){setError('Select between 1 and 20 saved drafts.');return;}
  let overrides:Array<{draftId:string;itemCents:number;shippingCents:number}>;
  try{overrides=selected.flatMap(draftId=>{const values=manual[draftId];if(!values||!values.item.trim()&&!values.shipping.trim())return[];if(!values.item.trim()||!values.shipping.trim())throw Error('Enter both the manual preview item price and shipping, or leave both blank to use the saved observation.');const itemCents=cents(values.item),shippingCents=cents(values.shipping);if(itemCents<1)throw Error('A manual preview item price must be greater than zero.');return[{draftId,itemCents,shippingCents}];});}
  catch(reason){setError(reason instanceof Error?reason.message:'Check the preview prices.');return;}
  const current=++generation.current;started.current=Date.now();scope.current=selected.slice();activeRunId.current=crypto.randomUUID();setTick(Date.now());setBusy(true);setRun(null);
  try{
   const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'preview',runId:activeRunId.current,draftIds:scope.current,...(overrides.length?{overrides}:{})}),signal:AbortSignal.timeout(180000)}),data=await response.json() as PriceCheckRun&{error?:string};
   if(!response.ok)throw Error(data.error||'The price preview could not finish.');
   if(data.mode!=='preview'||data.canPublish!==false||!Array.isArray(data.rows))throw Error('The preview response was not recognized. No listing was changed.');
   if(alive.current&&current===generation.current){setRun(data);setFeedback('Price preview saved locally. No eBay price, quantity or listing was changed.');}
  }catch(reason){if(alive.current&&current===generation.current)setError(reason instanceof Error?reason.message:'The preview could not finish.');}
  finally{if(alive.current&&current===generation.current)setBusy(false);}
 }
 async function decision(row:PriceCheckRow,choice:Choice){
  if(!run)return;setError('');setFeedback('');let itemCents:number|undefined;
  try{if(choice==='custom'){itemCents=cents(newPrices[row.draftId]??'');if(itemCents<1)throw Error('Enter a preview item price greater than zero.');}}
  catch(reason){setError(reason instanceof Error?reason.message:'Enter a valid preview price.');return;}
  generation.current++;setDecisionBusy(row.draftId);
  try{
   const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'decision',runId:run.id,draftId:row.draftId,choice,...(itemCents===undefined?{}:{itemCents})}),signal:AbortSignal.timeout(20000)}),data=await response.json() as PriceCheckRun&{error?:string};
   if(!response.ok)throw Error(data.error||'The preview choice could not be saved.');
   if(data.mode!=='preview'||data.canPublish!==false)throw Error('The preview response was not recognized.');
   if(alive.current){setRun(data);setFeedback('Preview choice saved locally. The actual eBay draft is unchanged.');}
  }catch(reason){if(alive.current)setError(reason instanceof Error?reason.message:'Could not save the preview choice.');}
  finally{if(alive.current)setDecisionBusy(null);}
 }
 const locked=busy||loading||decisionBusy!==null,elapsed=busy&&started.current!==null?Math.max(0,tick-started.current):run?.elapsedMs??0;
 return <section className={styles.panel} aria-labelledby={headingId}>
  <header className={styles.heading}><div><span className={styles.kicker}>After draft creation · Commercial preview</span><h2 id={headingId}>Price check</h2></div><span className={styles.previewBadge}>Preview only · publishing disabled</span></header>
  <p>Compare selected saved drafts with the lowest matching active asking price. Sold comps are not connected in this preview; active asking prices are the fallback, not completed-sale evidence. A gap up to <strong>5% or $1, whichever is smaller</strong>, is the price-band tolerance—not an instruction to discount every card.</p>
  <p className={styles.note}>Totals include known shipping. The watcher forecast takes 8% off the item price only; shipping stays unchanged. The existing {money(PRICE_CHECK_POLICY.minimumItemCents)} item-price floor and pricing approvals still apply. A watcher forecast below the floor is flagged, not silently raised. No card identification or photo inspection is repeated.</p>
  <div className={styles.toolbar}><button type="button" disabled={locked} onClick={()=>{void read();}}>{loading?'Reading saved drafts…':opened?'Refresh saved drafts':'Load drafts for price preview'}</button>{opened&&<span>{candidates.length} saved drafts available · choose up to 20 per preview</span>}</div>
  {error&&<p className={styles.error} role="alert">{error}</p>}
  {feedback&&<p className={styles.feedback} role="status">{feedback}</p>}
  {opened&&<>
   <div className={styles.selectionTools}><label>Find a saved draft<input type="search" value={search} maxLength={160} placeholder="Card title or draft ID" disabled={busy} onChange={event=>{setSearch(event.target.value);setPage(0);}}/></label><div><button type="button" disabled={locked||!visible.length} onClick={()=>setSelected(visible.slice(0,20).map(c=>c.draftId))}>Select this page</button><button type="button" disabled={locked||!selected.length} onClick={()=>setSelected([])}>Clear selection</button></div></div>
   <details className={styles.selector} open={!run}><summary>Select saved drafts · {selected.length}/20 selected</summary><div className={styles.tableScroll}><table><caption>Saved draft observations; missing prices and shipping remain unknown</caption><thead><tr><th scope="col">Select</th><th scope="col">Card / draft</th><th scope="col">Our item price</th><th scope="col">Shipping</th><th scope="col">Price source / optional preview input</th></tr></thead><tbody>{visible.map(candidate=><tr key={candidate.draftId}><td><input type="checkbox" aria-label={`Select ${candidate.title} draft ${candidate.draftId}`} checked={selected.includes(candidate.draftId)} disabled={locked||selected.length>=20&&!selected.includes(candidate.draftId)} onChange={event=>select(candidate.draftId,event.target.checked)}/></td><td><strong>{candidate.title}</strong><small>Draft {candidate.draftId}</small></td><td>{money(candidate.current?.itemCents)}</td><td>{money(candidate.current?.shippingCents)}</td><td><small>{candidate.current?.source==='retained-ebay-observation'?'Retained eBay observation':candidate.current?.source==='manual-preview'?'Manual preview input':'No usable price observation'} · {when(candidate.current?.observedAt)}</small><details><summary>Manual preview prices</summary><p className={styles.note}>Optional local test input. It does not edit eBay. Leave both blank to use the saved observation.</p><div className={styles.inputPair}><label>Item price<input inputMode="decimal" maxLength={12} value={manual[candidate.draftId]?.item??''} placeholder="Unknown" disabled={locked} aria-label={`Manual preview item price for draft ${candidate.draftId}`} onChange={event=>updateManual(candidate.draftId,'item',event.target.value)}/></label><label>Shipping<input inputMode="decimal" maxLength={12} value={manual[candidate.draftId]?.shipping??''} placeholder="Unknown" disabled={locked} aria-label={`Manual preview shipping for draft ${candidate.draftId}`} onChange={event=>updateManual(candidate.draftId,'shipping',event.target.value)}/></label></div></details></td></tr>)}</tbody></table>{!visible.length&&<p>No saved drafts match this search.</p>}</div><nav className={styles.pagination} aria-label="Price-preview draft pages"><button type="button" disabled={locked||page===0} onClick={()=>setPage(n=>Math.max(0,n-1))}>Previous drafts</button><span>Page {Math.min(page,pages-1)+1} of {pages}</span><button type="button" disabled={locked||page+1>=pages} onClick={()=>setPage(n=>Math.min(pages-1,n+1))}>Next drafts</button></nav></details>
   <div className={styles.runBar}><span>{selected.length}/20 drafts selected</span><button type="button" className={styles.primary} disabled={locked||!selected.length} aria-describedby={statusId} aria-busy={busy} onClick={()=>{void preview();}}>{busy?'Checking prices — preview…':'Check selected prices — preview'}</button></div>
  </>}
  <p id={statusId} role="status" aria-live="polite" aria-atomic="true" className={styles.progress}>{busy?`Started · ${run?.progress?`${run.progress.phase} · ${run.progress.completed}/${run.progress.total} drafts checked`:`requesting market evidence for ${scope.current.length} selected drafts`} · ${duration(elapsed)} elapsed`:run?`${run.status==='complete'?'Preview complete':run.status==='failed'?'Preview needs attention':'Saved preview checkpoint'} · ${run.rows.length}/${run.draftIds.length} drafts · ${duration(run.elapsedMs)} recorded processing time · ${(run.elapsedMs/1000/Math.max(1,run.draftIds.length)).toFixed(1)}s per selected draft`:'No market check starts until you select drafts and click the preview button.'}</p>
  {run&&<div className={styles.results}>
   <div className={styles.resultHeading}><h3>Price-check results</h3><span>{when(run.endedAt??run.startedAt)} · {run.requestCount} market requests</span></div>
   <p className={styles.note}>API/account cost: {run.cost.amountUsd===null?'Unavailable':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:4}).format(run.cost.amountUsd)}. {run.cost.source}. This preview does not establish approval to publish.</p>
   <div className={styles.tableScroll}><table className={styles.resultTable}><caption>Actual saved observations and local preview choices are shown separately</caption><thead><tr><th scope="col">Card</th><th scope="col">Our price</th><th scope="col">Lowest matching active ask</th><th scope="col">After 8% watcher offer</th><th scope="col">Gap / allowed band</th><th scope="col">Result</th><th scope="col">Price options · preview only</th></tr></thead><tbody>{run.rows.map(row=>{const choosing=decisionBusy===row.draftId;return <tr key={row.draftId}><td><strong>{row.title}</strong><small>Draft {row.draftId}</small></td><td><strong>{money(row.currentItemCents)} item</strong><small>+ {money(row.shippingCents)} shipping</small><small>{money(row.ourTotalCents)} delivered</small></td><td>{row.lowestComp?<><a href={compUrl(row.lowestComp.url)} target="_blank" rel="noreferrer">{money(row.lowestComp.totalCents)} delivered ↗</a><small>{money(row.lowestComp.itemCents)} item + {money(row.lowestComp.shippingCents)} shipping</small><small>{row.lowestComp.title}</small><small>{row.lowestComp.confidence==='title-supported'?'Title-supported match · missing seller specifics flagged':'Structured identity match'} · active asking price</small>{row.lowestComp.warnings?.map((warning,index)=><small key={index}>{warning}</small>)}<small>{row.lowestComp.seller} · {when(row.lowestComp.observedAt)}</small></>:<span>Unknown</span>}<small>{row.compCount} matching asks · {row.excludedCompCount} excluded</small></td><td><strong>{money(row.watcherItemCents)} item</strong><small>+ {money(row.shippingCents)} unchanged shipping</small><small>{money(row.watcherTotalCents)} delivered</small></td><td><Difference row={row}/><small>Allowance: {money(row.allowanceCents)}</small><small>Band: {money(row.minQualifyingTotalCents)}–{money(row.maxQualifyingTotalCents)} delivered</small></td><td><span className={row.status==='within-band'?styles.passed:styles.flagged}>{label(row.status)}</span><p>{row.reason}</p>{row.flags?.length>0&&<ul>{row.flags.map((flag,index)=><li key={`${flag}-${index}`}>{label(flag)}</li>)}</ul>}{row.limitations.length>0&&<details><summary>Evidence limits</summary><ul>{row.limitations.map((limit,index)=><li key={index}>{limit}</li>)}</ul></details>}</td><td><div className={styles.options}><button type="button" disabled={busy||decisionBusy!==null||row.currentItemCents===null||row.shippingCents===null} onClick={()=>{void decision(row,'keep');}}>Keep our price · preview</button><button type="button" disabled={busy||decisionBusy!==null||!row.lowestComp||row.shippingCents===null||row.lowestComp.totalCents-row.shippingCents<PRICE_CHECK_POLICY.minimumItemCents} onClick={()=>{void decision(row,'match-low');}}>Match lowest · preview</button><label>New item price<input inputMode="decimal" maxLength={12} value={newPrices[row.draftId]??''} disabled={busy||decisionBusy!==null} placeholder="Enter price" aria-label={`New preview item price for draft ${row.draftId}`} onChange={event=>setNewPrices(values=>({...values,[row.draftId]:event.target.value}))}/></label><button type="button" disabled={busy||decisionBusy!==null||row.shippingCents===null||!newPrices[row.draftId]?.trim()} onClick={()=>{void decision(row,'custom');}}>Use new price · preview</button><button type="button" disabled={busy||decisionBusy!==null} onClick={()=>{void decision(row,'leave-draft');}}>Leave in draft · preview</button>{choosing&&<small role="status">Saving local preview choice…</small>}{row.decision&&<p className={styles.choice}><strong>Local preview:</strong> {row.decision.choice==='leave-draft'?'Leave in draft':`${money(row.decision.itemCents)} item · ${money(row.decision.totalCents)} delivered`}<small>8% watcher: {money(row.decision.watcherItemCents)} item · {money(row.decision.watcherTotalCents)} delivered</small><small>{label(row.decision.status)}</small></p>}</div></td></tr>;})}</tbody></table></div>
  </div>}
  <p className={styles.boundary}>Preview only. This tool saves checks and choices locally; it cannot publish, change an eBay price, change quantities, or move photos.</p>
 </section>;
}
