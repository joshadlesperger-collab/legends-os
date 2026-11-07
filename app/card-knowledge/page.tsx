import Link from "next/link";
import { cardCatalog, recoverySummary } from "@/lib/card-knowledge-store";
import { searchCatalog } from "@/lib/card-knowledge";
import { reviewedKnowledge } from "@/lib/card-reviewed-knowledge";
import { readQueue } from "@/lib/card-orchestrator-store";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";
export default async function CardKnowledgePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const q = typeof params.q === "string" ? params.q.slice(0, 120) : "";
  const section = typeof params.section === "string" ? params.section.slice(0, 160) : "";
  const offset = typeof params.offset === "string" ? Number(params.offset) : 0;
  const result = searchCatalog(cardCatalog, q, section, offset);
  const recovered = await recoverySummary();
  let reviewed:ReturnType<typeof reviewedKnowledge>|null=null;
  try {reviewed=reviewedKnowledge(await readQueue("artifacts/card-orchestrator"),q,Number(params.reviewOffset??0),25);} catch { /* Keep the independent manufacturer catalog available. */ }
  const reviewHref=(start:number)=>`/card-knowledge?${new URLSearchParams({q,section,offset:String(result.offset),reviewOffset:String(start)})}#reviewed-copies`;
  const sections = Array.from(new Set(cardCatalog.cards.map(c => c.section)));
  const href = (start: number) => `/card-knowledge?${new URLSearchParams({ q, section, offset: String(start) })}`;
  return <main className={styles.page}>
    <header><div className="eyebrow">Sell / Card intelligence</div><h1>Card knowledge</h1><p>A source-backed catalog for identifying cards and reusing research.</p><Link href="/card-knowledge/market-review">Market evidence review</Link></header>
    <nav className={styles.paging} aria-label="Card knowledge views"><Link href="/card-knowledge" aria-current="page">Checklist</Link><Link href="/card-knowledge/parallels">Parallel relationships</Link><Link href="/card-knowledge/sources">Sources and audit</Link></nav>
    <div className={styles.metrics}>
      <div><strong>{cardCatalog.cards.length.toLocaleString()}</strong><span>Checklist entries</span></div>
      <div><strong>{cardCatalog.product.expectedBaseCards}</strong><span>Base cards</span></div>
      <div><strong>{cardCatalog.odds.length}</strong><span>Odds rows retained</span></div>
      <div><strong>{recovered.summary?.counts.source_records.toLocaleString() ?? "Unavailable"}</strong><span>Historical inventory records</span></div>
    </div>
    <section className={styles.panel}><h2>{cardCatalog.product.name}</h2>
      <p>Season {cardCatalog.product.season} · Printed product year {cardCatalog.product.printedYear} · Manufacturer checklist imported</p>
      <p>Browse the catalog locally. PostgreSQL import is prepared and has not been run by this recovery workflow. Historical inventory records are not newly confirmed stock.</p>
      <form className={styles.search} action="/card-knowledge">
        <label>Player, team or card number<input name="q" defaultValue={q} maxLength={120} placeholder="Try Cooper Flagg or 251" /></label>
        <label>Checklist section<select name="section" defaultValue={section}><option value="">All sections</option>{sections.map(s => <option key={s}>{s}</option>)}</select></label>
        <button type="submit">Search catalog</button>
      </form>
      <p>{result.total} matching entries · Showing {result.cards.length ? result.offset + 1 : 0}–{result.offset + result.cards.length}</p>
      <p>Recommended titles describe the checklist entry. Review the physical card before adding its parallel, numbering, condition or grade.</p>
      <div className={styles.table}><table><thead><tr><th>Card</th><th>Player</th><th>Team on card</th><th>Section</th><th>Recommended eBay title</th><th>Evidence</th></tr></thead>
        <tbody>{result.cards.map(c => <tr key={c.id}><td>{c.cardNumber}</td><td>{c.player}{c.rookie ? " · Rookie" : ""}</td><td>{c.team ?? "Not supplied"}</td><td>{c.section}</td><td className={styles.title}>{c.recommendedEbayTitle}<small>{c.recommendedEbayTitle.length}/80 characters</small></td><td><a href={`${cardCatalog.sources.find(s => s.id === c.sourceId)!.url}#page=${c.sourcePage}`} target="_blank" rel="noreferrer">Topps, p. {c.sourcePage}</a></td></tr>)}</tbody></table></div>
      {!result.cards.length && <p>No matching checklist entries. This does not prove a card does not exist.</p>}
      <nav className={styles.paging} aria-label="Checklist pages">{result.offset > 0 && <Link href={href(Math.max(0, result.offset - result.limit))}>Previous</Link>}{result.offset + result.limit < result.total && <Link href={href(result.offset + result.limit)}>Next</Link>}</nav>
    </section>
    <section id="reviewed-copies" className={styles.panel}><h2>Reviewed inventory copies</h2>
      <p>Completed local photo and identity reviews, using the search above. These reviews do not establish pricing approval or listing readiness.</p>
      {reviewed ? <><p>{reviewed.total} matching copies · Showing {reviewed.records.length?reviewed.offset+1:0}–{reviewed.offset+reviewed.records.length}</p>
        <div className={styles.table}><table><thead><tr><th>Player</th><th>Product</th><th>Card and parallel</th><th>Serial</th><th>Review evidence</th></tr></thead>
          <tbody>{reviewed.records.map(r=><tr key={r.cardId}><td>{r.identity.player}</td><td>{r.identity.season} {r.identity.set}</td><td>#{r.identity.cardNumber} · {r.identity.parallel}</td><td>{r.identity.serial||"Unnumbered"}</td><td><details><summary>Copy review</summary><p>{r.evidence}</p><small>{r.cardId}</small></details></td></tr>)}</tbody></table></div>
        {reviewed.exceptions.length>0&&<p>{reviewed.exceptions.length} records need evidence repair and are excluded from these results.</p>}
        <nav className={styles.paging} aria-label="Reviewed copy pages">{reviewed.offset>0&&<Link href={reviewHref(Math.max(0,reviewed.offset-25))}>Previous copies</Link>}{reviewed.offset+25<reviewed.total&&<Link href={reviewHref(reviewed.offset+25)}>Next copies</Link>}</nav>
      </>:<p>Local copy reviews are unavailable. The manufacturer catalog remains available above.</p>}
    </section>
    <section className={styles.panel}><h2>Connected knowledge</h2><p>Product → checklist entry → player, with every connection linked to its source page. Player identities currently stay within each product until aliases are reviewed.</p>
      <a href={`/api/card-knowledge?${new URLSearchParams({ view: "graph", q, section })}`}>Inspect graph for this search (up to 50 entries)</a>
    </section>
    <section className={styles.panel}><h2>Recovery and remaining work</h2>
      {recovered.summary ? <><p>Recovered {recovered.summary.counts.card_variants} candidate variants from the offline pricing pilot. It contains {recovered.summary.counts.market_observations} individual market observations. Saved estimates cannot yet support verified pricing.</p>
        <details><summary>Products in the recovered pilot</summary><ul>{recovered.summary.productGroups.map((g, i) => <li key={i}>{g.season || "Unknown season"} {g.product || "Unknown product"}: {g.candidateVariants} candidate variants</li>)}</ul></details></> : <p>{recovered.state === "invalid" ? "Local recovery summary failed validation; rerun recovery before using it." : "The private recovered database is not available on this host. It is intentionally excluded from deployment bundles."}</p>}
      <p>The original extraction notes below are retained for provenance. Box-format columns have since been audited: <Link href="/card-knowledge/sources">see current source findings and mapped odds</Link>. Serial print runs and unresolved section applicability still require evidence.</p>
      <ul>{cardCatalog.limitations.map(item => <li key={item}>{item}</li>)}</ul>
      <details><summary>{cardCatalog.unresolved.length} checklist lines need review</summary><ul>{cardCatalog.unresolved.map((r, i) => <li key={i}>Page {r.page}: {r.raw} — {r.reason}</li>)}</ul></details>
      <details><summary>Browse retained odds evidence</summary><p>These rows include several box formats. Column mapping and serial print runs require review before comparing parallels.</p><ul>{cardCatalog.odds.filter(o => !q || o.label.toLowerCase().includes(q.toLowerCase())).slice(0, 60).map(o => <li key={o.id}>{o.label} — <a href={`${cardCatalog.sources[1].url}#page=${o.sourcePage}`}>Topps odds, p. {o.sourcePage}</a></li>)}</ul></details>
    </section>
  </main>;
}
