import Link from "next/link";
import { loadSalesVelocity } from "@/lib/sales-velocity";
import { loadListingCompleteness } from "@/lib/listing-completeness-data";
import { buildWeekendTrafficSprint, type WeekendSprintRow } from "@/lib/weekend-traffic-sprint";

export const dynamic = "force-dynamic";
const money = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);

export default async function WeekendTrafficSprintPage() {
  const [velocity, completeness] = await Promise.all([loadSalesVelocity(), loadListingCompleteness()]);
  const analytics = velocity.probes.find((probe) => probe.provider === "analytics-traffic");
  const marketing = velocity.probes.find((probe) => probe.provider === "marketing-campaigns-ads");
  const gated = analytics?.status === "succeeded" && marketing?.status === "succeeded";
  const sprint = gated ? buildWeekendTrafficSprint(velocity.rows, completeness.assessments) : null;
  return <main className="page sales-velocity-page">
    <header className="health-hero"><div><div className="eyebrow">Sales Velocity · read-only experiment design</div><h1>Weekend Traffic Sprint</h1><p className="health-intro">Qualified metadata and advertising tests with deterministic controls. Proposed actions only—no eBay mutation controls exist.</p><p><Link href="/seller-opportunities/sales-velocity">← Sales Velocity</Link></p></div><div className="health-score"><strong>{sprint ? sprint.cohortA.length + sprint.cohortB.length : 0}</strong><span> proposed</span><small>{gated ? "Provider gates passed" : "Provider gate blocked"}</small></div></header>
    <section className="panel velocity-probes"><div className="eyebrow">Required live gates</div><h2>Analytics and Marketing</h2><div>{[analytics, marketing].map((probe) => probe && <span key={probe.provider} className={`card-${probe.status === "succeeded" ? "success" : "danger"}`}><b>{probe.provider}</b><small>{probe.message}</small></span>)}</div></section>
    {!sprint ? <section className="panel"><h2>Pilot blocked</h2><p>Both read-only provider gates must succeed. No cohort was produced.</p></section> : <>
      <section className="metric-grid"><Metric label="Cohort A · metadata" value={sprint.cohortA.length}/><Metric label="Cohort B · +3 ad test" value={sprint.cohortB.length}/><Metric label="Cohort C · controls" value={sprint.cohortC.length}/><Metric label="Total active evidence" value={velocity.rows.length}/></section>
      <Cohort title="Cohort A — safe completeness fixes" rows={sprint.cohortA}/>
      <Cohort title="Cohort B — low-exposure +3-point ad test" rows={sprint.cohortB}/>
      <Cohort title="Cohort C — matched no-intervention controls" rows={sprint.cohortC}/>
      <section className="panel"><div className="eyebrow">Fail-closed exclusions</div><h2>Excluded evidence</h2><p>{Object.entries(sprint.excluded).map(([reason, count]) => `${reason}: ${count.toLocaleString()}`).join(" · ")}</p></section>
    </>}
  </main>;
}
function Metric({ label, value }: { label: string; value: number }) { return <div className="metric"><div className="metric-label">{label}</div><div className="metric-value">{value.toLocaleString()}</div></div>; }
function Cohort({ title, rows }: { title: string; rows: WeekendSprintRow[] }) { return <section className="panel health-section"><div className="eyebrow">Read-only proposed pilot</div><h2>{title}</h2><p>{rows.length} listings. No action has been executed.</p><div style={{ overflowX: "auto" }}><table className="completeness-table"><thead><tr><th>Item</th><th>Price / ad rate</th><th>Traffic</th><th>Proposed action</th><th>Qualification</th><th>Confidence / economics</th></tr></thead><tbody>{rows.map((row) => <tr key={`${row.cohort}-${row.listingId}`}><td><b>{row.title}</b><small>{row.ebayItemId}</small></td><td>{money(row.currentPrice)}<small>{row.currentAdRate == null ? "No current ad rate" : `${row.currentAdRate}% current`}</small></td><td>{row.impressions} impressions · {row.views} views<small>CTR {row.clickThroughRate == null ? "missing" : `${row.clickThroughRate}%`}</small></td><td><b>{row.proposedAction}</b></td><td>{row.why}</td><td><b>{row.confidence}%</b><small>{row.economicsWarning}</small></td></tr>)}</tbody></table></div>{rows.length === 0 && <div className="empty-state">No listings passed every conservative cohort gate.</div>}</section>; }
