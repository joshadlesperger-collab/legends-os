import {schedulerState,SCHEDULER_VERSION} from "@/lib/legends-scheduler";
export const dynamic="force-dynamic";
const rows=[
  ["Inventory + order sensing","Every 2 hours","Read-only / enqueue"],
  ["Velocity opportunity scan","Every 4 hours","Read-only"],
  ["Seller offers","9:00 AM + 6:00 PM CT target","Write-gated"],
  ["Stale listing refresh","7:30 AM CT target","Write-gated · canary first"],
  ["Title optimization","Daily ~7:45 AM CT target","Write-gated · 3-item canary · 10/day"],
  ["Title / completeness / image diagnostics","Daily ~6:00 AM CT","Read-only"],
  ["Closed-loop outcome learning","Daily ~5:30 AM CT","Read-only · 90-day learning window"],
  ["Durable job worker","Every 5 minutes","Existing bounded worker"],
] as const;
export default function AutomationPage(){
  const state=schedulerState();
  return <main className="page" style={{maxWidth:1300}}>
    <section className="health-hero"><div><div className="eyebrow">System · scheduled operations</div><h1>Legends Scheduler</h1><p className="health-intro">Sense frequently, act selectively, and preserve enough observation time to learn what improves profitable sales velocity.</p></div><div className="health-score"><strong>{state.paused?"PAUSED":"ON"}</strong><span> scheduler</span><small>{SCHEDULER_VERSION}</small></div></section>
    <section className="metric-grid">
      <Metric label="Read-only sensing" value={state.paused?"Paused":"Enabled"}/>
      <Metric label="Scheduled eBay writes" value={state.writesEnabled&&!state.paused?"Enabled":"Locked"}/>
      <Metric label="Global pause" value={state.paused?"Active":"Off"}/>
    </section>
    <section className="panel" style={{marginTop:18}}>
      <div className="eyebrow">Operating rhythm</div><h2>Automation cadence</h2>
      <p>Scheduled write routes fail closed unless <code>LEGENDS_AUTOPILOT_WRITES_ENABLED=explicitly-approved</code>. The first controlled live Velocity batch should be verified before that gate is enabled.</p>
      <div className="pareto-table"><div className="pareto-row pareto-head"><span>Job</span><span>Cadence</span><span>Mode</span><span>Guardrail</span></div>{rows.map(([job,cadence,mode])=><div className="pareto-row" key={job}><strong>{job}</strong><span>{cadence}</span><span>{mode}</span><span>{job==="Seller offers"?"8% max · under-$25 unknown-cost exception · 10/24h · 7-day cooldown":job==="Stale listing refresh"?"90+ days · ≤5 views · 0 watchers · 0 sales · <$100 · 3-item canary":job==="Title optimization"?"Proven non-destructive title policy · 30-day cooldown · provider verification":"No marketplace mutation"}</span></div>)}</div>
    </section>
    <section className="panel" style={{marginTop:18}}>
      <div className="eyebrow">Kill switches</div><h2>Fail-closed controls</h2>
      <p><code>LEGENDS_AUTOPILOT_PAUSED=true</code> stops all new Scheduler work. Removing the scheduled-write approval value locks all eBay mutations while leaving read-only sensing available.</p>
    </section>
  </main>;
}
function Metric({label,value}:{label:string;value:string}){return <div className="metric"><div className="metric-label">{label}</div><div className="metric-value" style={{fontSize:24}}>{value}</div></div>}