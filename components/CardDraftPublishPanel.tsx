"use client";

import {useEffect,useRef,useState} from 'react';
import {manualDraftPrice} from '@/lib/card-draft-publication-client';
import styles from './CardProcessingPriceReport.module.css';

type Draft={draftId:string;title:string;quantity?:number;currentItemCents:number|null;shippingCents:number|null;flags:string[]};
type Receipt={requestId?:string;status?:string;message?:string;error?:string;job?:{id:string;status:string;phase?:string;result?:{published?:unknown[];exceptions?:unknown[]}}};
const dollars=(cents:number|null|undefined)=>typeof cents==='number'?new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(cents/100):'Unknown';

export default function CardDraftPublishPanel({reportId,rows,manualPrices,onClear,onPendingChange}:{reportId:string;rows:Draft[];manualPrices:Record<string,string>;onClear:()=>void;onPendingChange?:(pending:boolean)=>void}){
 const [connection,setConnection]=useState<{transportReady:boolean;reason:string}>({transportReady:false,reason:'Checking publishing connection…'});
 const [review,setReview]=useState(false),[submitting,setSubmitting]=useState(false),[message,setMessage]=useState('');
 const [activeRequest,setActiveRequest]=useState<string|null>(null);
 const requestId=useRef<string|null>(null),frozen=useRef<{rows:Draft[];prices:Record<string,string>;signature:string}|null>(null);
 const signature=JSON.stringify(rows.map(row=>({id:row.draftId,price:manualPrices[row.draftId]??''})));
 useEffect(()=>{onPendingChange?.(submitting||Boolean(activeRequest));return()=>onPendingChange?.(false);},[submitting,activeRequest,onPendingChange]);
 useEffect(()=>{if(review&&frozen.current?.signature!==signature){setReview(false);frozen.current=null;requestId.current=null;setMessage('Selection or prices changed. Review the current selection before publishing.');}},[signature,review]);
 useEffect(()=>{const c=new AbortController(),timeout=setTimeout(()=>c.abort(),12000);let mounted=true;void fetch('/api/card-processing-v2/publication',{cache:'no-store',signal:c.signal}).then(async r=>{if(!r.ok)throw Error();const x=await r.json();if(!mounted)return;setConnection({transportReady:x.transportReady===true,reason:typeof x.reason==='string'?x.reason:'Publishing connection unavailable.'});if(x.job&&['QUEUED','RUNNING'].includes(x.job.status)&&typeof x.job.id==='string')setActiveRequest(x.job.id);}).catch(()=>{if(mounted)setConnection({transportReady:false,reason:'Publishing connection unavailable. Selection and price previews remain available.'});}).finally(()=>clearTimeout(timeout));return()=>{mounted=false;clearTimeout(timeout);c.abort();};},[]);
 useEffect(()=>{
  if(!activeRequest)return;const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  async function poll(){try{const response=await fetch(`/api/card-processing-v2/publication?requestId=${encodeURIComponent(activeRequest!)}`,{cache:'no-store',signal:controller.signal});const data=await response.json() as Receipt;if(!response.ok)throw Error();const status=data.job?.status??data.status;
    if(status==='COMPLETE'||status==='REVIEW_REQUIRED'||status==='ARCHIVE_REVIEW'||status==='STOPPED'){
     const published=data.job?.result?.published?.length??0,exceptions=data.job?.result?.exceptions?.length??0;
     setMessage(status==='COMPLETE'?`${published} selected drafts published.`:status==='ARCHIVE_REVIEW'?`${published} drafts published; photo archival needs recovery. Do not publish them again.`:`Request ${status==='STOPPED'?'stopped':'needs review'}: ${published} published, ${exceptions} exceptions. No automatic resubmission.`);setActiveRequest(null);return;
    }
    setMessage(`Selected request ${status==='RUNNING'?'is running':'is queued'}${data.job?.phase?` · ${data.job.phase}`:''}. No replacement request will be sent.`);
   }catch{if(controller.signal.aborted)return;setMessage('Request status is temporarily unavailable. The original request is retained; no replacement was submitted.');}
   if(!controller.signal.aborted)timer=setTimeout(()=>void poll(),5000);
  }
  void poll();return()=>{controller.abort();if(timer)clearTimeout(timer);};
 },[activeRequest]);
 const invalid=rows.some(row=>Boolean(manualDraftPrice(manualPrices[row.draftId]??'').error));
 const incomplete=rows.filter(row=>row.currentItemCents===null||row.shippingCents===null||!Number.isSafeInteger(row.quantity)||!row.quantity).length;
 function openReview(){requestId.current=crypto.randomUUID();frozen.current={rows:rows.map(row=>({...row})),prices:{...manualPrices},signature};setMessage('');setReview(true);}
 async function publish(){
  if(submitting||!frozen.current||!requestId.current)return;
  if(frozen.current.signature!==signature){setReview(false);setMessage('Selection or prices changed. Review the current selection before publishing.');return;}
  onPendingChange?.(true);setSubmitting(true);setMessage('');const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),20000);let answered=false;
  try{const response=await fetch('/api/card-processing-v2/publication',{method:'POST',headers:{'Content-Type':'application/json'},signal:controller.signal,body:JSON.stringify({action:'publish-selected',requestId:requestId.current,reportId,rows:frozen.current.rows.map(row=>{const cents=manualDraftPrice(frozen.current!.prices[row.draftId]??'').itemCents;return{draftId:row.draftId,...(cents===undefined?{}:{manualItemCents:cents})};}),reviewAcknowledged:true})});const data=await response.json() as Receipt;answered=true;if(!response.ok)throw Error(data.error||'Publishing request was not accepted.');setReview(false);const acceptedId=data.requestId??data.job?.id??requestId.current;setActiveRequest(acceptedId);setMessage(data.message||`Request ${acceptedId} accepted. Publication is pending the runner’s result; this is not a completed listing.`);}
  catch(error){if(!answered){setReview(false);setActiveRequest(requestId.current);setMessage('Request outcome is unknown. Checking the original request; no replacement will be submitted.');}else setMessage(error instanceof Error?error.message:'Publishing request was not accepted.');}
  finally{clearTimeout(timeout);setSubmitting(false);}
 }
 return <div className={styles.publication} aria-label="Selected draft publishing">
  <div><strong aria-live="polite" aria-atomic="true">{rows.length} drafts selected</strong><small title={connection.reason}>{connection.transportReady?'Publisher connected.':'Publishing unavailable until the signed-in runner is connected.'}</small></div>
  <button type="button" onClick={openReview} disabled={!rows.length||invalid||incomplete>0||!connection.transportReady||submitting||review||Boolean(activeRequest)}>Publish selected ({rows.length})</button>
  <button type="button" onClick={()=>{onClear();setReview(false);frozen.current=null;}} disabled={!rows.length||submitting||Boolean(activeRequest)}>Clear selection</button>
  {message&&<p role="status">{message}</p>}
  {incomplete>0&&<p className={styles.flag}>{incomplete} selected drafts have unknown saved price, shipping or quantity. Choose complete rows before publishing.</p>}
  {review&&frozen.current&&<section aria-label="Review selected drafts before publishing">
   <h3>Publish {frozen.current.rows.length} selected drafts</h3>
   <p>This publishes the exact selected drafts, applies only the manual item prices shown below, and preserves shipping. You are approving the displayed comparison exceptions for this selection; no other drafts are included.</p>
   <p>By publishing, you accept the <a href="https://www.ebay.com/help/policies/member-behaviour-policies/user-agreement?id=4259" target="_blank" rel="noopener noreferrer">eBay User Agreement</a>, <a href="https://pages.ebay.com/payment/2.0/terms.html" target="_blank" rel="noopener noreferrer">Payment Terms</a> and <a href="https://pages.ebay.com/sell-pl/termsofservice" target="_blank" rel="noopener noreferrer">Marketing Terms</a> for this exact selection. Submission stops if estimated listing fees exceed $0.00; standard final-value fees apply when items sell.</p>
   <ul>{frozen.current.rows.map(row=><li key={row.draftId}><strong>{row.title}</strong> · Draft {row.draftId} · {manualDraftPrice(frozen.current!.prices[row.draftId]??'').itemCents!==undefined?`Manual item price ${dollars(manualDraftPrice(frozen.current!.prices[row.draftId]??'').itemCents)}`:`Keep item price ${dollars(row.currentItemCents)}`} · Shipping {dollars(row.shippingCents)}{row.flags.length?` · Review: ${row.flags.join(', ')}`:''}</li>)}</ul>
   <button type="button" onClick={()=>void publish()} disabled={submitting}>{submitting?'Submitting exact selection…':'Publish reviewed selection'}</button>
   <button type="button" onClick={()=>setReview(false)} disabled={submitting}>Cancel</button>
  </section>}
 </div>;
}
