import { prisma } from "@/lib/prisma";
import Link from "next/link";
import CostBasisEditor from "@/components/CostBasisEditor";
import { calculateKnownCapital } from "@/lib/profitability";

export const dynamic = "force-dynamic";

export default async function InventoryPage() {
  const [listings, activeCount, activeValue, missingCostCount, capitalListings] = await Promise.all([prisma.listing.findMany({
    where: { listingStatus: "active" },
    orderBy: [{ currentPrice: "desc" }, { watchers: "desc" }, { views: "desc" }],
    take: 100,
    include: {
      store: { select: { ebaySellerUsername: true } },
      costBasis: true,
      _count: { select: { saleEvents: { where: { provider: "ebay-fulfillment", status: { not: "cancelled" } } } } },
      saleEvents: { where: { provider: "ebay-fulfillment", status: { not: "cancelled" } }, orderBy: { soldAt: "desc" }, take: 1, select: { soldAt: true, quantity: true, price: true } },
    },
  }), prisma.listing.count({where:{listingStatus:"active"}}), prisma.listing.aggregate({where:{listingStatus:"active"},_sum:{currentPrice:true}}), prisma.listing.count({where:{listingStatus:"active",costBasis:null}}), prisma.listing.findMany({where:{listingStatus:"active",costBasis:{isNot:null}},select:{id:true,quantity:true,startTime:true,costBasis:true}})]);
  const capitalById=new Map(capitalListings.map(row=>[row.id,calculateKnownCapital({quantity:row.quantity,listedAt:row.startTime,costs:{acquisition:row.costBasis!.unitAcquisitionCost==null?null:Number(row.costBasis!.unitAcquisitionCost),grading:row.costBasis!.unitGradingCost==null?null:Number(row.costBasis!.unitGradingCost),supplies:row.costBasis!.unitSuppliesCost==null?null:Number(row.costBasis!.unitSuppliesCost),postage:row.costBasis!.unitOutboundPostageCost==null?null:Number(row.costBasis!.unitOutboundPostageCost),other:row.costBasis!.unitOtherCost==null?null:Number(row.costBasis!.unitOtherCost)}})]));
  const capitalValues=Array.from(capitalById.values());
  const knownCapital=capitalValues.reduce((sum,row)=>sum+(row.knownCapital??0),0);
  const staleCapital=capitalValues.filter(row=>(row.ageDays??0)>90).reduce((sum,row)=>sum+(row.knownCapital??0),0);
  const costCoverage=activeCount?100*(activeCount-missingCostCount)/activeCount:0;

  return (
    <main className="page" style={{ maxWidth: 1200 }}>
      <nav style={{ display: "flex", gap: 14 }}><Link href="/today">Today</Link><Link href="/sales">Sales &amp; Performance</Link><Link href="/reconciliation">Reconciliation</Link><Link href="/cost-basis/import">Import costs</Link><Link href="/stores">Stores</Link><Link href="/">Recommendations</Link></nav>
      <div className="eyebrow">Inventory decisions</div><h1>Inventory</h1>
      <p>Highest-value active inventory first. Use demand, sales evidence, age, and known costs to decide what deserves attention.</p>
      <div className="metric-grid" style={{marginBottom:20}}><div className="metric"><div className="metric-label">Active listings</div><div className="metric-value">{activeCount.toLocaleString()}</div></div><div className="metric"><div className="metric-label">Base listed value</div><div className="metric-value">${Number(activeValue._sum.currentPrice??0).toLocaleString(undefined,{maximumFractionDigits:0})}</div><div className="metric-detail">One unit per listing; quantity exposure is shown per row</div></div><div className="metric"><div className="metric-label">Cost coverage</div><div className="metric-value" style={{color:costCoverage>=50?"var(--success)":"var(--warning)"}}>{costCoverage.toFixed(1)}%</div><div className="metric-detail">{missingCostCount.toLocaleString()} missing · <Link href="/cost-basis">priority queue</Link></div></div><div className="metric"><div className="metric-label">Known capital invested</div><div className="metric-value">{capitalListings.length?`$${knownCapital.toLocaleString(undefined,{maximumFractionDigits:0})}`:"Awaiting costs"}</div><div className="metric-detail">Entered costs × available quantity</div></div><div className="metric"><div className="metric-label">Stale known capital</div><div className="metric-value" style={{color:staleCapital>0?"var(--warning)":"var(--text-primary)"}}>{capitalListings.length?`$${staleCapital.toLocaleString(undefined,{maximumFractionDigits:0})}`:"Awaiting costs"}</div><div className="metric-detail">Known capital in listings older than 90 days</div></div></div>

      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "2px solid #ccc" }}>
            <th>Image</th>
            <th>Title</th>
            <th>Store</th>
            <th>Price</th>
            <th>Qty</th>
            <th>Views</th>
            <th>Watchers</th>
            <th>Condition</th>
            <th>Auth. Sales</th>
            <th>Latest Sale</th>
            <th>Decision signal</th>
            <th>Age</th>
            <th>Known capital</th>
            <th>Known costs</th>
            <th>Last Synced</th>
          </tr>
        </thead>
        <tbody>
          {listings.map((l) => { const capital=capitalById.get(l.id); return (
            <tr key={l.id} style={{ borderBottom: "1px solid #eee" }}>
              <td>
                {l.imageUrls[0] ? (
                  <img
                    src={l.imageUrls[0]}
                    alt={l.title}
                    style={{ width: 60, height: 60, objectFit: "cover" }}
                  />
                ) : (
                  "—"
                )}
              </td>
              <td>{l.title}</td>
              <td>{l.store?.ebaySellerUsername ?? "—"}</td>
              <td>${Number(l.currentPrice).toFixed(2)}</td>
              <td>{l.quantity}</td>
              <td>{l.views}</td>
              <td>{l.watchers}</td>
              <td>{l.condition ?? "—"}</td>
              <td>{l._count.saleEvents}</td>
              <td>{l.saleEvents[0] ? `${l.saleEvents[0].quantity} × $${Number(l.saleEvents[0].price).toFixed(2)} · ${new Date(l.saleEvents[0].soldAt).toLocaleDateString()}` : "No linked sales evidence"}</td>
              <td>{l.watchers>0&&l._count.saleEvents===0?`${l.watchers} watcher${l.watchers===1?"":"s"}, no linked sale`:l._count.saleEvents>0?`${l._count.saleEvents} authoritative sale${l._count.saleEvents===1?"":"s"}`:"Needs demand evidence"}</td>
              <td>{capital?.ageDays==null?"Unknown":`${capital.ageDays}d · ${capital.ageBand}`}</td>
              <td>{capital?.knownCapital==null?"Awaiting costs":`$${capital.knownCapital.toFixed(2)}`}<div style={{fontSize:11,color:"var(--text-secondary)"}}>{capital&&!capital.complete?`Partial · missing ${capital.missingComponents.join(", ")}`:""}</div></td>
              <td><CostBasisEditor listingId={l.id} initial={l.costBasis?{unitAcquisitionCost:l.costBasis.unitAcquisitionCost==null?null:Number(l.costBasis.unitAcquisitionCost),unitGradingCost:l.costBasis.unitGradingCost==null?null:Number(l.costBasis.unitGradingCost),unitSuppliesCost:l.costBasis.unitSuppliesCost==null?null:Number(l.costBasis.unitSuppliesCost),unitOutboundPostageCost:l.costBasis.unitOutboundPostageCost==null?null:Number(l.costBasis.unitOutboundPostageCost),unitOtherCost:l.costBasis.unitOtherCost==null?null:Number(l.costBasis.unitOtherCost),notes:l.costBasis.notes}:{unitAcquisitionCost:null,unitGradingCost:null,unitSuppliesCost:null,unitOutboundPostageCost:null,unitOtherCost:null,notes:null}}/></td>
              <td>{new Date(l.lastSyncedAt).toLocaleString()}</td>
            </tr>
          )})}
          {listings.length === 0 && (
            <tr>
              <td colSpan={15}>
                No listings. Connect a store and run a sync from the{" "}
                <Link href="/stores">Stores</Link> page.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </main>
  );
}
