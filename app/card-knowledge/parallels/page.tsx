import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { cardCatalog } from "@/lib/card-knowledge-store";
import { collectSellerSales, loadSellerReviews } from "@/lib/card-parallel-sales-store";
import { prepareSellerEvidence, buildSellerRelationships } from "@/lib/card-parallel-intake";
import styles from "../page.module.css";

export const dynamic = "force-dynamic";
async function sellerEvidence() {
  try {
    if (!process.env.DATABASE_URL) return null;
    const [snapshot, reviews] = await Promise.all([collectSellerSales(prisma), loadSellerReviews()]);
    const evidence = prepareSellerEvidence(snapshot, reviews, cardCatalog);
    return { ...evidence, relationships: buildSellerRelationships(evidence.accepted) };
  } catch { return null; }
}
async function studies() {
  if (!process.env.DATABASE_URL) return { state: "unavailable", rows: [] } as const;
  try {
    const rows = await prisma.knowledgeParallelStudy.findMany({ where: { productId: cardCatalog.product.id }, orderBy: { asOf: "desc" }, take: 20,
      select: { id: true, section: true, baseline: true, target: true, condition: true, currency: true, status: true, playerCount: true, saleCount: true, multiplier: true, ratioLow: true, ratioHigh: true, confidence: true, asOf: true, expiresAt: true } });
    return { state: "ready", rows } as const;
  } catch { return { state: "unavailable", rows: [] } as const; }
}
export default async function ParallelPage({ searchParams }: { searchParams: Promise<Record<string,string|string[]|undefined>> }) {
  const [data, params, seller] = await Promise.all([studies(), searchParams, sellerEvidence()]);
  const amount = typeof params.amount === "string" ? Number(params.amount) : 10;
  const premium = typeof params.premium === "string" ? Number(params.premium) : 15;
  const valid = Number.isFinite(amount) && amount > 0 && amount <= 1000000 && Number.isFinite(premium) && premium > -100 && premium <= 10000;
  return <main className={styles.page}>
    <header><div className="eyebrow">Sell / Card intelligence</div><h1>Parallel relationships</h1><p>{cardCatalog.product.name}</p></header>
    <nav className={styles.paging} aria-label="Card knowledge views"><Link href="/card-knowledge">Checklist</Link><Link href="/card-knowledge/parallels" aria-current="page">Parallel relationships</Link><Link href="/card-knowledge/sources">Sources and audit</Link></nav>
    <section className={styles.panel}><h2>Our sales evidence · free sources</h2><p>Existing eBay order records supply actual transaction amounts. Checklist and exact parallel, raw condition, single-card contents and ordinary-copy status must be reviewed before a sale trains a relationship. Title matches are suggestions only.</p>
      {!seller ? <p>Sales evidence is unavailable: the order database or review file could not be read. This does not mean there are no sales. The intake is ready; no subscription is required.</p> : <>
        <p>{seller.rows.length} recent Topps Chrome candidate transactions · {seller.accepted.length} verified sales · {seller.heldCount} held for review. {seller.truncated ? "Limited to the newest 200 matches; this is partial coverage." : "Includes title matches from other sports and seasons until checklist review."}</p>
        <p><a href="/api/card-knowledge/seller-sales">Download sales evidence for review</a> · <Link href="/sales">Sales and performance</Link></p>
        <div className={styles.table}><table><thead><tr><th>Sale</th><th>Suggested checklist match</th><th>Evidence status</th></tr></thead><tbody>{seller.rows.slice(0,50).map(r=><tr key={`${r.key}-${r.fingerprint}`}><td>{r.sourceUrl ? <a href={r.sourceUrl}>{r.title}</a> : r.title}<small className={styles.range}>{r.soldAt.slice(0,10)}</small></td><td>{r.suggestions.length ? r.suggestions.map(s=>`${s.player} · ${s.section} #${s.cardNumber}`).join("; ") : "Needs manual catalog match"}</td><td>{r.blockers.length ? r.blockers.join(" · ") : "Verified for research"}</td></tr>)}</tbody></table></div>
        <h3>Relationships from our reviewed sales</h3>{!seller.relationships.length ? <p>No reviewed parallel sales yet. Premiums remain unknown.</p> : seller.relationships.map(({result},i)=><p key={i}><strong>{result.scope.target.parallel} / {result.scope.baseline.parallel}</strong> · {result.scope.section} · {result.scope.language} · {result.scope.condition} · {result.scope.currency}: {result.status === "research-estimate" ? `${result.premiumPercent!.toFixed(1)}% research premium` : "Unknown — insufficient evidence"}. {result.playerCount} matched players, {result.saleCount} paired sales. {result.blockers.join(" ")}</p>)}
      </>}
      <p>Refunds, cancellation requests, unpaid orders, unresolved shipping or discounts, and multi-quantity lines are held. One transaction is never expanded into several independent comps. Estimates and asking prices cannot train the model.</p>
    </section>
    <section className={styles.panel}><h2>Measured premiums</h2><p>Compare the same card in two parallels, then combine player-level price ratios. Each relationship stays within its product, checklist section, language, condition and currency. Numbering and finish are part of each parallel’s identity.</p>
      {data.state === "unavailable" ? <p>Saved studies are unavailable: database access or the required migration is not ready. No measured premium is shown.</p> : !data.rows.length ? <p>No saved studies yet. Verified paired sales are needed before a premium can be calculated.</p> :
        <div className={styles.table}><table><thead><tr><th>Comparison</th><th>Scope</th><th>Measured premium</th><th>Evidence</th><th>Status</th><th>As of</th></tr></thead><tbody>{data.rows.map(r => <tr key={r.id}>
          <td>{r.target} / {r.baseline}</td><td>{r.section} · {r.condition} · {r.currency}</td>
          <td>{r.multiplier === null ? "Unknown" : `${((r.multiplier-1)*100).toFixed(1)}%`}{r.ratioLow !== null && r.ratioHigh !== null && <small className={styles.range}>Middle half: {((r.ratioLow-1)*100).toFixed(1)}%–{((r.ratioHigh-1)*100).toFixed(1)}%</small>}</td><td>{r.playerCount} players · {r.saleCount} sales</td><td>{r.expiresAt.getTime() < Date.now() ? "Expired — refresh evidence" : r.status}<small className={styles.range}>Confidence: {r.confidence}</small></td><td>{r.asOf.toISOString().slice(0,10)}</td>
        </tr>)}</tbody></table></div>}
      <p>A research estimate requires at least 3 players, with at least 3 baseline and 3 parallel sales per matched card within a shared 14-day window. Sales must be within 90 days. Wide variation across players holds the fallback for review. The middle-half range describes observed player variation; it is not a statistical confidence interval. Confidence labels use provisional evidence-count rules.</p>
    </section>
    <section className={styles.panel}><h2>Try a hypothetical premium</h2><p>RayWave +15% is an example, not a verified relationship. This calculator does not save a model or approve a price.</p>
      <form className={styles.search} action="/card-knowledge/parallels"><label>Baseline buyer total ($)<input type="number" name="amount" min="0.01" max="1000000" step="0.01" defaultValue={Number.isFinite(amount) ? amount : 10} required /></label><label>Hypothetical premium (%)<input type="number" name="premium" min="-99.99" max="10000" step="0.01" defaultValue={Number.isFinite(premium) ? premium : 15} required /></label><button type="submit">Calculate example</button></form>
      {valid ? <p><strong>Hypothetical buyer total: ${(Math.round(amount*(1+premium/100)*100)/100).toFixed(2)}</strong> = ${amount.toFixed(2)} × {(1+premium/100).toFixed(4)}. Includes buyer-paid shipping; excludes tax.</p> : <p>Enter a positive baseline and a premium greater than −100% within the shown limits.</p>}
    </section>
    <section className={styles.panel}><h2>Fallback calculated field</h2><p>Verified direct comps take precedence. If none exist, the research calculation uses this card’s verified baseline sales × the measured parallel multiplier. The priced card is excluded when learning that multiplier. Missing evidence leaves the value blank.</p><p>The result is an estimated buyer total, not a listing item price. Shipping, seller pricing policy and approval still require review. Odds, asking prices, historical estimates and special serial-number premiums do not train this model.</p></section>
  </main>;
}
