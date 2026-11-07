import Link from "next/link";
import { readFile } from "node:fs/promises";
import { cardCatalog } from "@/lib/card-knowledge-store";
import { reviewMarketBatch } from "@/lib/card-market-review";
import styles from "../page.module.css";
export const dynamic = "force-dynamic";
export default async function MarketReviewPage() {
  let report: ReturnType<typeof reviewMarketBatch> | null = null;
  try { report = reviewMarketBatch(JSON.parse(await readFile("artifacts/knowledge-graph/saved-market-packet.json", "utf8")), cardCatalog); }
  catch { /* An unavailable or invalid local packet must never look like zero market activity. */ }
  return <main className={styles.page}><header><h1>Market evidence review</h1><Link href="/card-knowledge">Back to checklist</Link></header>
    <p>Local research staging only. No production import or verified pricing evidence. Product groups and checklist matches are proposals.</p>
    {!report ? <p>Review packet unavailable or invalid on this host.</p> : <>
      <p>{report.summary.observations} saved-file observations; {report.summary.titleMatched} unique checklist title matches; {report.summary.outsideCurrentCatalog} outside the current catalog or product/season unresolved; {report.summary.uncertainPrices} uncertain prices. No production import.</p>
      <p>File analyzed {report.observedAt}; capture time is unverified. Original URLs and displayed prices are retained. Redirected product pages do not confirm historical sales.</p>
      {Object.entries(report.summary.products).map(([product, count]) => <section key={product}><h2>{product} ({count})</h2>
        {report.rows.filter(r => r.productHint === product).map(r => <details key={r.rowId}><summary>#{r.n} {r.title} — {r.price ?? "Price unavailable"} — {r.priceStatus}</summary>
          <p>{r.sourceUrl ? <a href={r.sourceUrl} target="_blank" rel="noreferrer">Original listing {r.sourceUrl.split("/").pop()}</a> : "Listing URL unavailable"}</p>
          <p>{r.listingCheck ?? "Listing-level review pending."}</p>
          <p>Checklist ID: {r.checklistEntryId ?? "Unresolved"} — {r.checklistMatchStatus}. Parallel, grade and condition remain separate from this checklist ID.</p>
          <p>{r.proposedEntries.length ? r.proposedEntries.map(e => `${e.player}, ${e.section} #${e.cardNumber} (Topps p. ${e.sourcePage})`).join("; ") : "No matching entry in the current product catalog."}</p>
          <p>Holds: {r.blockers.join(", ")}</p><p>Original observation: {r.text}</p>
        </details>)}
      </section>)}
    </>}
  </main>;
}
