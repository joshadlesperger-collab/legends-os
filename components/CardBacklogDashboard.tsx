"use client";
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import { BACKLOG_STATES, reconcileScans, type BacklogSnapshot, type BacklogState } from "@/lib/card-backlog";
import type { ScanFile } from "@/lib/scan-folder";
import ScanFolderReader from "./ScanFolderReader";
import styles from "./ListingFactory.module.css";

const money = (n?: number | null) => n == null ? "Unknown" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
function exportSnapshot(snapshot: BacklogSnapshot) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" }));
  const a = document.createElement("a"); a.href = url; a.download = "card-backlog-evidence.json"; a.click(); URL.revokeObjectURL(url);
}
export default function CardBacklogDashboard({ onManualQueue }: { onManualQueue: () => void }) {
  const [snapshot, setSnapshot] = useState<BacklogSnapshot>();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [search, setSearch] = useState(""), [state, setState] = useState<BacklogState | "all">("all");
  const [identity, setIdentity] = useState("all"), [scope, setScope] = useState("all"), [page, setPage] = useState(0), [selected, setSelected] = useState("");
  const query = useDeferredValue(search.toLowerCase());
  const refresh = useCallback(async (signal?: AbortSignal) => {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/listing-factory/backlog", { cache: "no-store", signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Backlog refresh failed");
      if (!signal?.aborted) setSnapshot(data);
    } catch (e) { if (!signal?.aborted) setError(e instanceof Error ? e.message : "Unable to load local backlog"); }
    finally { if (!signal?.aborted) setBusy(false); }
  }, []);
  useEffect(() => { const controller = new AbortController(); void refresh(controller.signal); return () => controller.abort(); }, [refresh]);
  const filtered = useMemo(() => (snapshot?.cards ?? []).filter(c => (state === "all" || c.state === state)
    && (identity === "all" || c.identityStatus === identity)
    && (scope === "all" || scope === "captures" && c.physicalUnits > 0 || scope === "no-receipt" && c.physicalUnits > 0 && !c.excludedFromNewListing || scope === "inbox" && c.inboxPaths.some(p => !/[\\/]Listed[\\/]/i.test(p)))
    && `${c.title} ${c.aliases.join(" ")} ${c.skus.join(" ")} ${c.receipts.map(r => r.id).join(" ")}`.toLowerCase().includes(query)), [snapshot, state, identity, scope, query]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / 50)), currentPage = Math.min(page, pageCount - 1);
  const card = snapshot?.cards.find(c => c.id === selected);
  function matchFolder(files: ScanFile[]) {
    setSnapshot(previous => {
      if (!previous) return previous;
      const cards = previous.cards.map(c => ({ ...c }));
      return { ...previous, cards, scan: reconcileScans(cards, files) };
    });
  }
  return <main className={`page ${styles.factory}`}>
    <header className={styles.header}><div><div className="eyebrow">Sell / Listing factory</div><h1>Your card backlog</h1><p>Original captures, saved work and eBay receipts reconciled in one view.</p></div><div className={styles.actions}>
      <button disabled={busy} onClick={() => void refresh()}>{busy ? "Reading local evidence…" : "Refresh local backlog"}</button>
      <button disabled={!snapshot} onClick={() => snapshot && exportSnapshot(snapshot)}>Export evidence snapshot</button><button onClick={onManualQueue}>Open manual snapshot queue</button>
    </div></header>
    {error ? <p role="alert" className={styles.error}>{error}{snapshot ? " The previous snapshot remains visible." : ""}</p> : null}
    <p role="status">{snapshot ? `Local snapshot: ${new Date(snapshot.asOf).toLocaleString()}. ${snapshot.sources.filter(s => s.status === "loaded").length} evidence files loaded.` : busy ? "Reading saved identities, receipts and original photo hashes…" : "No local evidence loaded."}</p>
    {snapshot ? <>
      <div className="card-info"><strong>Read-only local backlog · seller imaydit58</strong><p>{snapshot.marketplace.note}</p><p>Price approval, validated evidence and saved eBay prices are separate. Historical scanned quantity is not current available stock. This page cannot upload, publish or revise listings.</p></div>
      <div className="metric-grid">{[
        ["Distinct original captures", snapshot.counts.physicalCaptures, "One physical capture per original front hash"],
        ["Captures without a receipt", snapshot.counts.withoutReceipt, "Unverified listing status; not permission to create"],
        ["Saved asking-price approvals", snapshot.counts.withApprovedPrice, "Exact snapshot approvals and explicit overrides"],
        ["Evidence conflicts", snapshot.counts.conflicting, "Retained for reconciliation"],
      ].map(([label, value, detail]) => <div className="metric" key={label}><div className="metric-label">{label}</div><div className="metric-value">{value}</div><div className="metric-detail">{detail}</div></div>)}</div>
      <section className="panel" style={{ marginTop: 20 }}><h2>Identification coverage</h2><p>Saved review status across all records. Marketplace receipts without capture mappings remain unknown.</p><div className="metric-grid">{[
        ["identified", "Identified", snapshot.counts.identified], ["not-identified", "Not identified", snapshot.counts.notIdentified], ["needs-review", "Needs identity review", snapshot.counts.needsIdentityReview], ["unknown", "Unknown", snapshot.counts.unknownIdentity],
      ].map(([value, label, count]) => <button key={value} className={styles.gate} aria-pressed={identity === value} onClick={() => { setIdentity(identity === value ? "all" : String(value)); setPage(0); }}><span>{label}</span><strong>{count}</strong></button>)}</div></section>
      <div className={styles.pipeline}>{BACKLOG_STATES.map(s => <button key={s} className={styles.gate} aria-pressed={state === s} onClick={() => { setState(state === s ? "all" : s); setPage(0); }}><span>{s.replaceAll("-", " ")}</span><strong>{snapshot.counts.states[s]}</strong></button>)}</div>
      <ScanFolderReader onRead={matchFolder} />
      <section className="panel"><h2>Photo reconciliation</h2><p>{snapshot.scan.imageFiles} files · {snapshot.scan.uniqueImages} distinct image contents · {snapshot.scan.duplicateFiles} byte-identical copies · {snapshot.scan.mappedImages} mapped images · {snapshot.scan.capturedCardsPresent} original fronts present.</p><p>{snapshot.scan.unmatched.length} distinct images need a side/card mapping. Unmatched images are not assumed to be pairs.</p>
        <details><summary>Unmatched original images</summary><ul>{snapshot.scan.unmatched.slice(0,100).map(f => <li key={f.hash}>{f.paths.join(" · ")}</li>)}</ul>{snapshot.scan.unmatched.length > 100 ? <p>First 100 shown; export contains all unmatched paths and hashes.</p> : null}</details>
      </section>
      <section className="panel"><div className={styles.section}><h2>Reconciled records</h2><div className={styles.filters}>
        <label>Search<input value={search} placeholder="Player, SKU, card or receipt ID" onChange={e => { setSearch(e.target.value); setPage(0); }} /></label>
        <label>Scope<select value={scope} onChange={e => { setScope(e.target.value); setPage(0); }}><option value="all">All evidence</option><option value="captures">Physical captures</option><option value="inbox">In inbox / processed</option><option value="no-receipt">Captures without receipts</option></select></label>
        <button onClick={() => { setState("all"); setIdentity("all"); setScope("all"); setSearch(""); setPage(0); }}>Clear filters</button>
      </div></div><p>{filtered.length} matching records · {snapshot.counts.distinctDraftReceipts} distinct draft IDs · {snapshot.counts.distinctLiveReceipts} live IDs · {snapshot.counts.distinctSoldReceipts} sold IDs. Historical draft IDs may now be live.</p>
        <div className={styles.table}><table><thead><tr><th>Card / capture</th><th>Progress</th><th>Asking price</th><th>Marketplace receipts</th><th>Next action</th></tr></thead><tbody>{filtered.slice(currentPage*50,currentPage*50+50).map(c => {
          const asking = c.approvedPrice || c.override || c.proposal;
          return <tr key={c.id}><td><button className={styles.cardButton} aria-expanded={selected === c.id} onClick={() => setSelected(selected === c.id ? "" : c.id)}>{c.title}</button><small>{c.skus.join(" · ") || c.aliases.join(" · ")}</small><small>{c.physicalUnits ? "1 distinct capture" : "Capture quantity unresolved"}{c.recordedQuantity && c.recordedQuantity > 1 ? ` · recorded group qty ${c.recordedQuantity}` : ""}</small></td>
            <td>{c.state.replaceAll("-", " ")}<small>Identity: {c.identityStatus}</small><small>{c.textPrepared ? "Local text prepared" : ""}</small></td>
            <td>{money(asking?.item)}<small>Shipping {money(asking?.shipping)}</small><small>{c.override ? "Explicit override retained" : c.approvedPrice ? "Asking price approved locally" : asking ? "Proposal; unapproved" : "No usable proposal"}</small>{asking?.stale ? <small className={styles.warning}>Source date stale / invalid</small> : null}</td>
            <td>{Array.from(new Set(c.receipts.map(r => `${r.disposition}: ${r.id}`))).map(r => <small key={r}>{r}</small>)}{!c.receipts.length ? "Unverified" : <small>Excluded from new listing</small>}</td>
            <td>{c.nextOwner}<small>{c.nextAction}</small>{c.issues.length ? <small className={styles.warning}>{c.issues.length} conflict(s)</small> : null}</td></tr>;
        })}</tbody></table></div>
        <div className={styles.section}><button disabled={!currentPage} onClick={() => setPage(currentPage-1)}>Previous</button><span>Page {currentPage+1} of {pageCount}</span><button disabled={currentPage+1 >= pageCount} onClick={() => setPage(currentPage+1)}>Next</button></div>
        {card ? <section className={styles.detail} aria-live="polite"><div className={styles.section}><h3>{card.title}</h3><button onClick={() => setSelected("")}>Close details</button></div><p>{card.aliases.join(" · ")}<br />{card.captureId}</p>
          <div className={styles.detailGrid}><div><h3>Identity and originals</h3><dl>{Object.entries(card.identity).map(([k,v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>{card.originalPaths.map(p => <p style={{overflowWrap:"anywhere"}} key={p}>{p}</p>)}<p>Back hashes: {card.backHashes.join(" · ")}</p></div>
            <div><h3>Saved prices</h3>{card.prices.map((p,i) => <p key={i}>{money(p.item)} + {money(p.shipping)} shipping<br />{p.source}<br />{p.updatedAt || "Date unknown"} · {p.policy || "Policy not recorded"}</p>)}<h3>Seller overrides and decisions</h3>{card.overrides.map((o,i) => <div key={i}><small>{o.source}</small><pre style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{JSON.stringify(o.values,null,2)}</pre></div>)}</div>
            <div><h3>Receipts and blockers</h3>{card.receipts.map((r,i) => <p key={i}><a target="_blank" rel="noreferrer" href={r.disposition === "draft" ? `https://www.ebay.com/lstng?draftId=${r.id}` : `https://www.ebay.com/itm/${r.id}`}>{r.disposition} {r.id}</a><br />{r.observedAt || "Observation date unknown"}<br />Saved item {money(r.item)} · shipping {money(r.shipping)} · quantity {r.quantity ?? "unknown"}</p>)}<ul>{[...card.issues,...card.holds].map((i,n) => <li key={n}>{i}</li>)}</ul><h3>Sources</h3>{card.sources.map(s => <p key={s}>{s}</p>)}</div></div>
        </section> : null}
      </section><section className="panel"><h2>Source coverage</h2><ul>{snapshot.warnings.map(w => <li key={w}>{w}</li>)}</ul><details><summary>{snapshot.sources.length} source files</summary><ul>{snapshot.sources.map(s => <li key={s.path}>{s.path} — {s.status}, {s.records} records {s.updatedAt || ""}</li>)}</ul></details></section>
    </> : null}
  </main>;
}
