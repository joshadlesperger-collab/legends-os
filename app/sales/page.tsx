import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { loadCommerceDashboard } from "@/lib/commerce-dashboard";
import CostBasisEditor from "@/components/CostBasisEditor";

export const dynamic = "force-dynamic";

const colors = { ink: "#f7f3e8", muted: "#a9a69e", border: "#2d3036", panel: "#131519", bg: "#0b0c0e", green: "#55c38a", amber: "#e2b95f", red: "#e07168", blue: "#d6ad55" };
const panel: CSSProperties = { background: colors.panel, border: `1px solid ${colors.border}`, borderRadius: 14, padding: 20, boxShadow: "0 1px 2px rgba(16,24,40,.04)" };
const table: CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: 14 };
const th: CSSProperties = { textAlign: "left", padding: "10px 12px", color: colors.muted, fontSize: 12, textTransform: "uppercase", letterSpacing: ".04em", borderBottom: `1px solid ${colors.border}`, whiteSpace: "nowrap" };
const td: CSSProperties = { padding: "12px", borderBottom: `1px solid ${colors.border}`, verticalAlign: "top" };

function usd(value: number) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value); }
function date(value: Date | null | undefined) { return value ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(value) : "Not available"; }
function pct(value: number) { return `${value.toFixed(1)}%`; }
function Status({ value }: { value: string }) {
  const tone = value.includes("refund") || value === "cancelled" ? colors.red : value === "completed" || value === "confirmed" ? colors.green : colors.amber;
  return <span style={{ display: "inline-block", padding: "3px 8px", borderRadius: 999, color: tone, background: `${tone}12`, fontSize: 12, fontWeight: 700 }}>{value.replaceAll("_", " ")}</span>;
}
function Metric({ label, value, detail, tone = colors.ink }: { label: string; value: ReactNode; detail?: string; tone?: string }) {
  return <div style={panel}><div style={{ color: colors.muted, fontSize: 13 }}>{label}</div><div style={{ color: tone, fontSize: 27, lineHeight: 1.2, fontWeight: 750, marginTop: 7 }}>{value}</div>{detail && <div style={{ color: colors.muted, fontSize: 12, marginTop: 6 }}>{detail}</div>}</div>;
}
function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return <section style={panel}><div style={{ marginBottom: 16 }}><h2 style={{ margin: 0, fontSize: 20 }}>{title}</h2>{subtitle && <p style={{ margin: "5px 0 0", color: colors.muted, fontSize: 13 }}>{subtitle}</p>}</div>{children}</section>;
}

export default async function SalesPage() {
  const data = await loadCommerceDashboard();
  const { summary, coverage } = data;
  return <main className="page" style={{ minHeight: "100vh", background: colors.bg, color: colors.ink }}>
    <div style={{ maxWidth: 1440, margin: "0 auto" }}>
      <header style={{ display: "flex", justifyContent: "space-between", gap: 20, alignItems: "flex-start", flexWrap: "wrap", marginBottom: 24 }}>
        <div><div style={{ color: colors.blue, fontWeight: 700, fontSize: 13, letterSpacing: ".06em", textTransform: "uppercase" }}>Legends OS Commerce</div><h1 style={{ fontSize: 34, margin: "5px 0 6px" }}>Sales & Performance</h1><p style={{ margin: 0, color: colors.muted }}>Authoritative eBay order performance, inventory movement, and data coverage.</p></div>
        <nav style={{ display: "flex", gap: 12, flexWrap: "wrap" }}><Link href="/today">Today</Link><Link href="/">Recommendations</Link><Link href="/inventory">Inventory</Link><Link href="/reconciliation">Reconciliation</Link><Link href="/cost-basis/import">Import costs</Link><Link href="/stores">Stores</Link></nav>
      </header>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: 12, marginBottom: 18 }}>
        <Metric label="Gross sales" value={usd(summary.grossSales)} detail="Provider order totals before refunds" tone={colors.green}/>
        <Metric label="Provider-reported proceeds" value={usd(summary.providerProceeds)} detail={`eBay total due seller on ${summary.providerProceedsOrders} orders; not profit`} />
        <Metric label="Marketplace fees" value={usd(summary.marketplaceFees)} detail={`Provider-reported on ${summary.marketplaceFeeOrders} orders`} tone={colors.amber}/>
        <Metric label="Refunds" value={usd(summary.refunds)} detail={`${summary.refundAmountCount}/${summary.refundCount} refunds have amounts · ${pct(summary.refundRate)} order rate`} tone={colors.red}/>
        <Metric label="Orders" value={summary.orders.toLocaleString()} detail={`${summary.units.toLocaleString()} units sold`} />
        <Metric label="Average selling price" value={usd(summary.averageSellingPrice)} detail="Line revenue per unit" />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: 12, marginBottom: 22 }}>
        <Metric label="Last 7 days" value={usd(summary.sales7)} detail="Non-cancelled order totals" />
        <Metric label="Last 30 days" value={usd(summary.sales30)} detail="Non-cancelled order totals" />
        <Metric label="Available 90 days" value={usd(summary.sales90)} detail={`${date(data.range.earliest)} — ${date(data.range.latest)}`} />
        <Metric label="Inventory sales coverage" value={pct(coverage.linkedPercent)} detail={`${coverage.linkedLines} linked · ${coverage.unlinkedLines} unlinked lines`} tone={coverage.linkedPercent >= 80 ? colors.green : colors.amber}/>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: 12, marginBottom: 22 }}>
        <Metric label="Known-cost margin" value={summary.knownCostMargin == null ? "Awaiting costs" : usd(summary.knownCostMargin)} detail={summary.knownCostMarginPct == null ? "No covered net basis" : `${pct(summary.knownCostMarginPct)} of covered net basis`} tone={summary.knownCostMargin != null && summary.knownCostMargin < 0 ? colors.red : colors.green}/>
        <Metric label="Known-cost ROI" value={summary.aggregateRoi == null ? "Awaiting investment" : pct(summary.aggregateRoi)} detail="Return on entered acquisition + grading cost" tone={summary.aggregateRoi != null && summary.aggregateRoi < 0 ? colors.red : colors.green}/>
        <Metric label="Sales cost coverage" value={pct(coverage.salesDollarCostCoveragePct)} detail={`${coverage.unitsWithCost.toLocaleString()} units · ${pct(coverage.unitCostCoveragePct)} unit coverage`} tone={coverage.salesDollarCostCoveragePct >= 50 ? colors.green : colors.amber}/>
        <Metric label="Known inventory capital" value={data.capital.totalKnownCapital == null ? "Awaiting costs" : usd(data.capital.totalKnownCapital)} detail={`${data.capital.listings.toLocaleString()} active listings with entered costs`}/>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,2fr) minmax(300px,1fr)", gap: 18, marginBottom: 18 }}>
        <Section title="Recent sales" subtitle="Buyer information is intentionally excluded. Fees and proceeds are shown at order level.">
          <div style={{ overflowX: "auto" }}><table style={table}><thead><tr><th style={th}>Sold</th><th style={th}>Card / listing</th><th style={th}>Qty</th><th style={th}>Sale amount</th><th style={th}>Order fees</th><th style={th}>Order proceeds</th><th style={th}>State</th><th style={th}>Inventory</th></tr></thead><tbody>
            {data.recentSales.map((sale) => <tr key={sale.id}><td style={td}>{date(sale.order.creationDate)}</td><td style={{ ...td, minWidth: 240, fontWeight: 650 }}>{sale.listing?.title ?? sale.title}</td><td style={td}>{sale.quantity}</td><td style={td}>{usd(Number(sale.lineItemCost))} {sale.currency}</td><td style={td}>{sale.order.totalMarketplaceFee == null ? "—" : usd(Number(sale.order.totalMarketplaceFee))}</td><td style={td}>{sale.order.totalDueSeller == null ? "—" : usd(Number(sale.order.totalDueSeller))}</td><td style={td}><Status value={sale.saleEvent?.status ?? sale.order.cancelStatus.toLowerCase()}/></td><td style={td}>{sale.listingId ? <span style={{ color: colors.green }}>Linked</span> : <span style={{ color: colors.amber }}>Unlinked</span>}</td></tr>)}
          </tbody></table></div>
        </Section>
        <div style={{ display: "grid", gap: 18, alignContent: "start" }}>
          <Section title="Data quality & sync">
            <div style={{ display: "grid", gap: 12, fontSize: 14 }}>
              <div><strong>{coverage.linkedLines}</strong> of {coverage.lineCount} order lines linked ({pct(coverage.linkedPercent)})</div>
              <div><strong>{coverage.listingsWithSales.toLocaleString()}</strong> listings have authoritative sales evidence</div>
              <div><strong>{coverage.listingsWithoutSales.toLocaleString()}</strong> listings have no linked sales evidence in available history</div>
              <div>Order checkpoint: <strong>{date(data.job?.store.orderSyncCheckpoint)}</strong></div>
              <div>Latest successful order sync: <strong>{date(data.latestSuccessfulSync)}</strong></div>
              <div>Current job: {data.job ? <Status value={data.job.status}/> : "None"}</div>
              {data.job && <div style={{ color: colors.muted }}>Offset {data.job.orderNextOffset} / {data.job.orderTotal ?? "?"} · attempts {data.job.attemptCount} · failures {data.job.failureCount}</div>}
            </div>
          </Section>
          <Section title="Profitability status" subtitle="Known-cost economics remain deliberately partial and fail closed.">
            <div style={{ fontSize: 14, lineHeight: 1.55 }}>Known-cost margin is available for {summary.knownMarginSales} covered sale lines. It uses allocated provider proceeds when available, subtracts refunds and only entered cost components. ROI uses entered acquisition and grading investment only. Missing costs are never treated as zero or estimated.</div>
          </Section>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(420px,1fr))", gap: 18, marginBottom: 18 }}>
        <Section title="Known-margin leaders" subtitle="Covered sale lines ranked by known-cost margin; partial cost coverage is disclosed.">
          <div style={{ overflowX: "auto" }}><table style={table}><thead><tr><th style={th}>Listing</th><th style={th}>Margin</th><th style={th}>ROI</th><th style={th}>Cost status</th></tr></thead><tbody>{data.profitability.winners.map(row=><tr key={row.id}><td style={td}>{row.title}</td><td style={td}>{usd(row.knownCostMargin!)}</td><td style={td}>{row.roi==null?"Not available":pct(row.roi)}</td><td style={td}>{row.complete?"All components entered":`Partial · missing ${row.missingComponents.join(", ")}`}</td></tr>)}</tbody></table>{data.profitability.winners.length===0&&<p style={{color:colors.muted}}>Awaiting entered costs on linked sales.</p>}</div>
        </Section>
        <Section title="Known-margin risks" subtitle="Lowest covered margins first; no missing cost is inferred.">
          <div style={{ overflowX: "auto" }}><table style={table}><thead><tr><th style={th}>Listing</th><th style={th}>Margin</th><th style={th}>Basis</th><th style={th}>Cost status</th></tr></thead><tbody>{data.profitability.losers.map(row=><tr key={row.id}><td style={td}>{row.title}</td><td style={{...td,color:(row.knownCostMargin??0)<0?colors.red:colors.ink}}>{usd(row.knownCostMargin!)}</td><td style={td}>{row.basis==="seller-proceeds"?"Allocated proceeds":"Gross fallback"}</td><td style={td}>{row.complete?"All components entered":`Partial · missing ${row.missingComponents.join(", ")}`}</td></tr>)}</tbody></table>{data.profitability.losers.length===0&&<p style={{color:colors.muted}}>Awaiting entered costs on linked sales.</p>}</div>
        </Section>
      </div>

      <Section title="Inventory capital & aging" subtitle="Known capital uses entered costs × available quantity. It is not an estimate of missing costs.">
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(120px,1fr))",gap:10,marginBottom:16}}>{Object.entries(data.capital.byAge).map(([band,value])=><div key={band} style={{border:`1px solid ${colors.border}`,borderRadius:10,padding:12}}><div style={{color:colors.muted,fontSize:12}}>{band} days</div><strong>{usd(value)}</strong></div>)}</div>
        <div style={{overflowX:"auto"}}><table style={table}><thead><tr><th style={th}>Stale listing</th><th style={th}>Age</th><th style={th}>Known capital</th><th style={th}>Qty</th><th style={th}>Demand</th></tr></thead><tbody>{data.capital.stale.map(row=><tr key={row.id}><td style={td}>{row.title}</td><td style={td}>{row.ageDays==null?"Unknown":`${row.ageDays} days`}</td><td style={td}>{usd(row.knownCapital!)}</td><td style={td}>{row.quantity}</td><td style={td}>{row.watchers} watchers · {row.soldUnits} sold</td></tr>)}</tbody></table>{data.capital.stale.length===0&&<p style={{color:colors.muted}}>No 90+ day active listings currently have entered cost basis.</p>}</div>
      </Section>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(420px,1fr))", gap: 18 }}>
        <Section title="Best sellers" subtitle="Ranked by authoritative line revenue; 30-day units show recent velocity.">
          <div style={{ overflowX: "auto" }}><table style={table}><thead><tr><th style={th}>Card / listing</th><th style={th}>Gross</th><th style={th}>Units</th><th style={th}>30d units</th><th style={th}>Known-cost margin*</th><th style={th}>Latest</th></tr></thead><tbody>{data.bestSellers.map((item) => <tr key={item.key}><td style={{ ...td, fontWeight: 650 }}>{item.title}<div style={{ fontSize: 12, color: item.linked ? colors.green : colors.amber }}>{item.linked ? "Linked inventory" : "Unlinked provider item"}</div>{item.listingId && <CostBasisEditor listingId={item.listingId} initial={item.costBasis ?? { unitAcquisitionCost: null, unitGradingCost: null, unitSuppliesCost: null, unitOutboundPostageCost: null, unitOtherCost: null, notes: null }}/>}</td><td style={td}>{usd(item.gross)}</td><td style={td}>{item.units}</td><td style={td}>{item.units30}</td><td style={td}>{item.knownCostMargin == null ? "Awaiting costs" : usd(item.knownCostMargin)}<div style={{ fontSize: 11, color: colors.muted }}>{item.knownUnitCost == null ? "" : `${usd(item.knownUnitCost)} known cost/unit`}</div></td><td style={td}>{date(item.latestSale)}</td></tr>)}</tbody></table><p style={{ color: colors.muted, fontSize: 11 }}>* Gross line revenue minus entered per-unit costs. Not accounting profit; provider fees and order-level proceeds are not allocated to individual lines.</p></div>
        </Section>
        <Section title="Highest-dollar sales" subtitle="Largest authoritative line-item amounts in available history.">
          <div style={{ overflowX: "auto" }}><table style={table}><thead><tr><th style={th}>Card / listing</th><th style={th}>Sold</th><th style={th}>Qty</th><th style={th}>Amount</th><th style={th}>State</th></tr></thead><tbody>{data.highestSales.map((sale) => <tr key={sale.id}><td style={{ ...td, fontWeight: 650 }}>{sale.title}<div style={{ fontSize: 12, color: sale.listingId ? colors.green : colors.amber }}>{sale.listingId ? "Linked" : "Unlinked"}</div></td><td style={td}>{date(sale.order.creationDate)}</td><td style={td}>{sale.quantity}</td><td style={td}>{usd(Number(sale.lineItemCost))}</td><td style={td}><Status value={sale.saleEvent?.status ?? "unknown"}/></td></tr>)}</tbody></table></div>
        </Section>
      </div>

      <Section title="Order and SaleEvent states" subtitle={`${summary.cancelledOrders} cancelled · ${summary.partiallyRefundedOrders} partially refunded · ${summary.refundedOrders} fully refunded`}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{data.saleStates.map((state) => <span key={state.status} style={{ border: `1px solid ${colors.border}`, padding: "7px 10px", borderRadius: 8 }}><Status value={state.status}/> <strong>{state._count._all}</strong></span>)}</div>
      </Section>
      <Section title="Refunded & cancelled sales" subtitle="Authoritative exceptions requiring operator visibility; buyer details are never shown.">
        <div style={{ overflowX: "auto" }}><table style={table}><thead><tr><th style={th}>Sold</th><th style={th}>Card / listing</th><th style={th}>Amount</th><th style={th}>Refund amount</th><th style={th}>State</th><th style={th}>Inventory</th></tr></thead><tbody>{data.exceptionSales.map((sale) => <tr key={sale.id}><td style={td}>{date(sale.order.creationDate)}</td><td style={{ ...td, fontWeight: 650 }}>{sale.title}</td><td style={td}>{usd(Number(sale.lineItemCost))}</td><td style={td}>{sale.refunds.length ? usd(sale.refunds.reduce((sum, refund) => sum + Number(refund.amount ?? 0), 0)) : "Order-level / unavailable"}</td><td style={td}><Status value={sale.saleEvent?.status ?? "unknown"}/></td><td style={td}>{sale.listingId ? "Linked" : "Unlinked"}</td></tr>)}</tbody></table>{data.exceptionSales.length === 0 && <p style={{ color: colors.muted }}>No refunded or cancelled line items in the available history.</p>}</div>
      </Section>
    </div>
  </main>;
}
