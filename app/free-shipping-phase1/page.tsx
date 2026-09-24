"use client";

import { useState } from "react";

type Row={
  itemId:string;title:string|null;currentPrice:number|null;currentShipping:number|null;proposedPrice:number|null;
  currentDelivered:number|null;proposedDelivered:number|null;shippingProfileId:string|null;adRate:number|null;
  ready:boolean;blockers:string[];
};
type Result={
  experiment:string;mode:string;providerWrites:boolean;selected:number;persistedListingsFound:number;missing:string[];
  ready:number;blocked:number;freePolicyCandidates:Array<{storeId:string;policies:Array<{fulfillmentPolicyId:string|null;name:string|null;handlingTime:unknown|null}>}>;
  rows:Row[];
};

const usd=(value:number|null)=>value==null?"—":new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(value);

export default function FreeShippingPhase1Page(){
  const [result,setResult]=useState<Result|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [running,setRunning]=useState(false);

  async function run(){
    setRunning(true);setError(null);
    try{
      const response=await fetch("/api/free-shipping-phase1/dry-run",{method:"POST",cache:"no-store"});
      const body=await response.json();
      if(!response.ok)throw new Error(body.error??"Dry run failed");
      setResult(body);
    }catch(err){
      setError(err instanceof Error?err.message:"Dry run failed");
    }finally{setRunning(false);}
  }

  return <main className="page" style={{maxWidth:1500}}>
    <section style={{display:"flex",justifyContent:"space-between",gap:20,alignItems:"end",flexWrap:"wrap",marginBottom:24}}>
      <div><div className="eyebrow">eBay experiment</div><h1 style={{margin:"6px 0 8px"}}>Free Shipping Phase 1</h1>
        <p style={{maxWidth:800,margin:0}}>Read-only live validation for the fixed 75-listing treatment cohort. This page does not change eBay listings.</p></div>
      <button type="button" onClick={run} disabled={running} style={{padding:"12px 18px",fontWeight:700}}>
        {running?"Checking live eBay state…":"Run live dry check"}
      </button>
    </section>

    {error&&<section className="panel" style={{borderLeft:"4px solid var(--danger)",marginBottom:18}}><strong>Dry run failed</strong><div style={{marginTop:8}}>{error}</div></section>}

    {result&&<>
      <section className="panel" style={{marginBottom:18}}>
        <div className="eyebrow">Summary</div>
        <div className="metric-grid">
          <div><div className="confidence-value">{result.selected}</div><div>Selected</div></div>
          <div><div className="confidence-value">{result.ready}</div><div>Ready</div></div>
          <div><div className="confidence-value">{result.blocked}</div><div>Blocked</div></div>
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

      <section className="panel" style={{overflowX:"auto"}}>
        <div className="eyebrow">Listing validation</div><h2>75-listing treatment cohort</h2>
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
          <thead><tr style={{textAlign:"left",borderBottom:"2px solid var(--border)"}}>
            <th>Status</th><th>Item</th><th>Title</th><th>Current</th><th>Shipping</th><th>Delivered</th><th>Proposed price</th><th>Ad rate</th><th>Shipping policy</th><th>Blockers</th>
          </tr></thead>
          <tbody>{result.rows.map(row=><tr key={row.itemId} style={{borderBottom:"1px solid var(--border)",verticalAlign:"top"}}>
            <td style={{padding:"8px 6px"}}><strong>{row.ready?"READY":"BLOCKED"}</strong></td>
            <td style={{padding:"8px 6px"}}>{row.itemId}</td>
            <td style={{padding:"8px 6px",minWidth:280}}>{row.title??"—"}</td>
            <td style={{padding:"8px 6px"}}>{usd(row.currentPrice)}</td>
            <td style={{padding:"8px 6px"}}>{usd(row.currentShipping)}</td>
            <td style={{padding:"8px 6px"}}>{usd(row.currentDelivered)}</td>
            <td style={{padding:"8px 6px"}}>{usd(row.proposedPrice)}</td>
            <td style={{padding:"8px 6px"}}>{row.adRate==null?"—":`${row.adRate.toFixed(1)}%`}</td>
            <td style={{padding:"8px 6px"}}>{row.shippingProfileId??"—"}</td>
            <td style={{padding:"8px 6px",minWidth:260}}>{row.blockers.length?row.blockers.join("; "):"—"}</td>
          </tr>)}</tbody>
        </table>
      </section>
    </>}
  </main>;
}
