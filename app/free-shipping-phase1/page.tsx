"use client";

import { useState } from "react";

type Row={
  itemId:string;title:string|null;currentPrice:number|null;currentShipping:number|null;proposedPrice:number|null;
  currentDelivered:number|null;proposedDelivered:number|null;shippingProfileId:string|null;adRate:number|null;
  ready:boolean;blockers:string[];
};
type Result={
  experiment:string;mode:string;providerWrites:boolean;selected:number;persistedListingsFound:number;missing:string[];
  ready:number;completed:number;blocked:number;completedItemIds:string[];freePolicyCandidates:Array<{storeId:string;policies:Array<{fulfillmentPolicyId:string|null;name:string|null;handlingTime:unknown|null}>}>;
  rows:Row[];
};
type ExecResult={
  phase:"canary"|"remaining";requested:number;verified:number;failed:number;
  results:Array<{itemId:string;status:string;executionId?:string;error?:string;beforePrice?:number;afterPrice?:number;beforeShipping?:number|null;afterShipping?:number|null}>;
};

const APPROVAL="I APPROVE FREE SHIPPING PHASE 1";
const usd=(value:number|null|undefined)=>value==null?"—":new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(value);

export default function FreeShippingPhase1Page(){
  const [result,setResult]=useState<Result|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [running,setRunning]=useState(false);
  const [executing,setExecuting]=useState<"canary"|"remaining"|null>(null);
  const [execution,setExecution]=useState<ExecResult|null>(null);
  const [runHistory,setRunHistory]=useState<ExecResult[]>([]);

  async function run(options:{preserveError?:boolean}={}){
    setRunning(true);if(!options.preserveError)setError(null);
    try{
      const response=await fetch("/api/free-shipping-phase1/dry-run",{method:"POST",cache:"no-store"});
      const body=await response.json();
      if(!response.ok)throw new Error(body.error??"Dry run failed");
      setResult(body);
    }catch(err){
      setError(err instanceof Error?err.message:"Dry run failed");
    }finally{setRunning(false);}
  }

  async function executePhase(phase:"canary"|"remaining"){
    setExecuting(phase);setError(null);
    const response=await fetch("/api/free-shipping-phase1/execute",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({phase,approvalText:APPROVAL})});
    const body=await response.json();
    if(!response.ok)throw new Error(body.error??"Execution failed");
    setExecution(body);setRunHistory(current=>[...current,body]);
    return body as ExecResult;
  }

  async function executeApprovedPhase1(){
    setExecution(null);setRunHistory([]);
    try{
      const canary=await executePhase("canary");
      if(canary.failed!==0||canary.verified!==canary.requested)throw new Error("Canary did not verify cleanly. Remaining 70 were not attempted.");
      const remaining=await executePhase("remaining");
      if(remaining.failed!==0||remaining.verified!==remaining.requested)throw new Error("Remaining cohort stopped before full verification.");
      await run();
    }catch(err){
      setError(err instanceof Error?err.message:"Execution failed");
      await run({preserveError:true}).catch(()=>undefined);
    }finally{setExecuting(null);}
  }

  return <main className="page" style={{maxWidth:1500}}>
    <section style={{display:"flex",justifyContent:"space-between",gap:20,alignItems:"end",flexWrap:"wrap",marginBottom:24}}>
      <div><div className="eyebrow">eBay experiment</div><h1 style={{margin:"6px 0 8px"}}>Free Shipping Phase 1</h1>
        <p style={{maxWidth:820,margin:0}}>Live validation and governed execution for the fixed 75-listing treatment cohort. Price increases exactly by current shipping while the approved free-shipping policy replaces the paid policy.</p></div>
      <button type="button" onClick={()=>run()} disabled={running} style={{padding:"12px 18px",fontWeight:700}}>
        {running?"Checking live eBay state…":"Run live dry check"}
      </button>
    </section>

    {error&&<section className="panel" style={{borderLeft:"4px solid var(--danger)",marginBottom:18}}><strong>Action stopped</strong><div style={{marginTop:8}}>{error}</div></section>}

    {result&&<>
      <section className="panel" style={{marginBottom:18}}>
        <div className="eyebrow">Summary</div>
        <div className="metric-grid">
          <div><div className="confidence-value">{result.selected}</div><div>Selected</div></div>
          <div><div className="confidence-value">{result.ready}</div><div>Ready</div></div>
          <div><div className="confidence-value">{result.completed}</div><div>Completed</div></div><div><div className="confidence-value">{result.blocked}</div><div>Blocked</div></div>
          <div><div className="confidence-value">{result.persistedListingsFound}</div><div>Found in Legends</div></div>
        </div>
        <p style={{marginBottom:0}}>Mode: <strong>{result.mode}</strong> · Provider writes: <strong>{String(result.providerWrites)}</strong></p>
      </section>

      <section className="panel" style={{marginBottom:18}}>
        <div className="eyebrow">Free-shipping fulfillment policies</div>
        <h2>Candidate policies</h2>
        {result.freePolicyCandidates.flatMap(group=>group.policies.map(policy=><div key={group.storeId+String(policy.fulfillmentPolicyId)} style={{padding:"8px 0",borderBottom:"1px solid var(--border)"}}>
          <strong>{policy.name??"Unnamed policy"}</strong> · ID {policy.fulfillmentPolicyId??"—"}
        </div>))}
        {result.freePolicyCandidates.every(group=>group.policies.length===0)&&<p>No free-shipping fulfillment policy was detected.</p>}
      </section>

      <section className="panel" style={{marginBottom:18,borderLeft:"4px solid var(--warning)"}}>
        <div className="eyebrow">Production execution</div>
        <h2>Canary first, then remaining cohort</h2>
        <p>The execution path revalidates each listing immediately before writing, changes only price + shipping policy, verifies the 5.0% promoted rate is unchanged, reads the listing back from eBay, and stops the batch on the first mismatch.</p>
        <p><strong>Canary:</strong> first 5 treatment listings. <strong>Remaining:</strong> 70 listings only after the canary is provider-verified.</p>
        <button type="button" disabled={result.ready+result.completed!==75||result.blocked!==0||executing!==null} onClick={executeApprovedPhase1} style={{padding:"11px 16px",fontWeight:700}}>
          {executing==="canary"?"Executing and verifying 5-item canary…":executing==="remaining"?"Canary passed — executing remaining 70…":"Execute approved Phase 1"}
        </button>
        <p style={{fontSize:12,opacity:.8}}>This approval was already given for the fixed 75-listing cohort. The remaining 70 proceed automatically only after all 5 canary listings verify cleanly.</p>
      </section>

      {runHistory.length>0&&<section className="panel" style={{marginBottom:18}}>
        <div className="eyebrow">Execution result</div>
        <h2>{runHistory.map(run=>`${run.phase==="canary"?"Canary":"Remaining"} ${run.verified}/${run.requested}`).join(" · ")}</h2>
        <p>Failures: {runHistory.reduce((sum,run)=>sum+run.failed,0)}</p>
        <div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
          <thead><tr style={{textAlign:"left",borderBottom:"2px solid var(--border)"}}><th>Item</th><th>Status</th><th>Price</th><th>Shipping</th><th>Error</th></tr></thead>
          <tbody>{runHistory.flatMap(run=>run.results).map(row=><tr key={row.itemId} style={{borderBottom:"1px solid var(--border)"}}>
            <td style={{padding:"8px 6px"}}>{row.itemId}</td><td>{row.status}</td>
            <td>{usd(row.beforePrice)} → {usd(row.afterPrice)}</td><td>{usd(row.beforeShipping)} → {usd(row.afterShipping)}</td><td>{row.error??"—"}</td>
          </tr>)}</tbody>
        </table></div>
      </section>}

      <section className="panel" style={{overflowX:"auto"}}>
        <div className="eyebrow">Listing validation</div><h2>75-listing treatment cohort</h2>
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
          <thead><tr style={{textAlign:"left",borderBottom:"2px solid var(--border)"}}>
            <th>Status</th><th>Item</th><th>Title</th><th>Current</th><th>Shipping</th><th>Delivered</th><th>Proposed price</th><th>Ad rate</th><th>Shipping policy</th><th>Blockers</th>
          </tr></thead>
          <tbody>{result.rows.map(row=><tr key={row.itemId} style={{borderBottom:"1px solid var(--border)",verticalAlign:"top"}}>
            <td style={{padding:"8px 6px"}}><strong>{result.completedItemIds.includes(row.itemId)?"COMPLETED":row.ready?"READY":"BLOCKED"}</strong></td>
            <td style={{padding:"8px 6px"}}>{row.itemId}</td>
            <td style={{padding:"8px 6px",minWidth:280}}>{row.title??"—"}</td>
            <td style={{padding:"8px 6px"}}>{usd(row.currentPrice)}</td>
            <td style={{padding:"8px 6px"}}>{usd(row.currentShipping)}</td>
            <td style={{padding:"8px 6px"}}>{usd(row.currentDelivered)}</td>
            <td style={{padding:"8px 6px"}}>{usd(row.proposedPrice)}</td>
            <td style={{padding:"8px 6px"}}>{row.adRate==null?"—":`${row.adRate.toFixed(1)}%`}</td>
            <td style={{padding:"8px 6px"}}>{row.shippingProfileId??"—"}</td>
            <td style={{padding:"8px 6px",minWidth:260}}>{result.completedItemIds.includes(row.itemId)?"Provider-verified Phase 1 conversion":row.blockers.length?row.blockers.join("; "):"—"}</td>
          </tr>)}</tbody>
        </table>
      </section>
    </>}
  </main>;
}
