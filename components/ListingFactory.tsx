"use client";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { FACTORY_STAGES, STAGE_LABELS, factoryMetrics, parseFactoryManifest, type FactoryCard, type FactoryStage } from "@/lib/listing-factory";
import styles from "./ListingFactory.module.css";
const STORAGE_KEY = "legends.factory.manifest.v1";
const money = (n?: number) => n === undefined ? "Unknown" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(n);
const wait = (ms: number | null) => ms === null ? "—" : ms < 3600000 ? `${Math.floor(ms/60000)}m` : ms < 86400000 ? `${Math.floor(ms/3600000)}h` : `${Math.floor(ms/86400000)}d`;
const basis = { "exact-sold": "Exact sold", "serial-math": "Serial math", "active-only": "Active market", "saved-estimate": "Saved estimate" };
function download(cards: FactoryCard[]) {
  const url = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, cards }, null, 2)], { type: "application/json" }));
  const a = document.createElement("a"); a.href = url; a.download = "listing-factory-queue.json"; a.click(); URL.revokeObjectURL(url);
}
export default function ListingFactory() {
  const [cards, setCards] = useState<FactoryCard[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [stage, setStage] = useState<FactoryStage | "all">("all");
  const [status, setStatus] = useState("all");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const [page, setPage] = useState(0);
  const [now, setNow] = useState(0);
  const query = useDeferredValue(search.toLowerCase());
  useEffect(() => {
    setNow(Date.now());
    try { const saved = localStorage.getItem(STORAGE_KEY); if (saved) { setCards(parseFactoryManifest(JSON.parse(saved)).cards); setMessage("Restored this browser’s saved queue."); } }
    catch { setError("Saved queue could not be read. Import a valid queue export to recover it."); }
    setLoaded(true);
    const timer = setInterval(()=>setNow(Date.now()),60000); return ()=>clearInterval(timer);
  }, []);
  const filtered = useMemo(()=>cards.filter(c=>(stage === "all" || c.stage === stage) && (status === "all" || c.status === status) && `${c.title} ${c.id} ${c.definitionId}`.toLowerCase().includes(query)),[cards,stage,status,query]);
  const pageCount = Math.max(1, Math.ceil(filtered.length/50));
  const currentPage = Math.min(page,pageCount-1);
  const visible = filtered.slice(currentPage*50,(currentPage+1)*50);
  const selected = filtered.find(c=>c.id === selectedId);
  const costs = cards.filter(c=>c.apiCostUsd !== undefined);
  const measuredCost = costs.reduce((n,c)=>n+(c.apiCostUsd??0),0);
  const held = cards.filter(c=>c.status === "held").length;
  const metrics = FACTORY_STAGES.map(s=>({ stage:s, ...factoryMetrics(cards,s,now) }));
  async function importFile(file?: File) {
    if (!file) return;
    setError("");
    try {
      if (file.size > 5*1024*1024) throw new Error("Queue file must be under 5 MB. Photos stay at their original URLs.");
      const manifest = parseFactoryManifest(JSON.parse(await file.text()));
      // Persist before replacing the visible queue, so storage errors never imply a saved import.
      localStorage.setItem(STORAGE_KEY, JSON.stringify(manifest));
      setCards(manifest.cards); setPage(0); setSelectedId(undefined);
      setMessage(`Loaded and saved ${manifest.cards.length} card records in this browser. The imported snapshot replaces the previous snapshot.`);
    } catch(e) { setError(e instanceof Error ? e.message : "Import failed; previous queue preserved."); }
  }
  return <main className={`page ${styles.factory}`}>
    <header className={styles.header}><div><div className="eyebrow">Sell / Listing factory</div><h1>Card listing pipeline</h1><p>Scans → identity → price → bulk upload → verified drafts. Josh reviews and publishes.</p></div><div className={styles.actions}><label className={styles.import}>Import queue snapshot<input type="file" accept="application/json,.json" disabled={!loaded} onChange={e=>{void importFile(e.target.files?.[0]);e.target.value="";}}/></label><button disabled={!loaded || !cards.length} onClick={()=>download(cards)}>Export queue</button></div></header>
    <div className="card-info"><strong>Browser queue · shared backlog not connected</strong><p>Import a version 1 queue snapshot. Records are saved in this browser only; export for recovery or transfer. Import replaces the snapshot. Photos are referenced, not uploaded. No eBay upload or publication runs from this page.</p><a href="/listing-factory-example.json" download>Download example format (sample records)</a></div>
    {error ? <p role="alert" className={styles.error}>{error}</p> : null}<p role="status">{message}</p>
    <div className="metric-grid">
      <div className="metric"><div className="metric-label">Card records / units</div><div className="metric-value">{cards.length} / {cards.reduce((n,c)=>n+c.quantity,0)}</div><div className="metric-detail">Pairs counted once by card ID</div></div>
      <div className="metric"><div className="metric-label">Verified · last 24h</div><div className="metric-value">{metrics[4].hasHistory ? metrics[4].completed : "—"}</div><div className="metric-detail">Imported history · coverage {cards.filter(c=>c.history !== undefined).length}/{cards.length}</div></div>
      <div className="metric"><div className="metric-label">Held across gates</div><div className="metric-value">{held}</div><div className="metric-detail">Filter held to inspect next actions</div></div>
      <div className="metric"><div className="metric-label">Recorded API cost / card</div><div className="metric-value">{costs.length ? money(measuredCost/costs.length) : "—"}</div><div className="metric-detail">{costs.length}/{cards.length} records measured · excludes unrecorded spend</div></div>
    </div>
    <div className={styles.section}><h2>Workflow health</h2><button aria-pressed={stage === "all"} onClick={()=>{setStage("all");setPage(0);}}>All stages</button></div>
    <div className={styles.pipeline}>{metrics.map((m,i)=><button key={m.stage} className={styles.gate} aria-pressed={stage===m.stage} onClick={()=>{setStage(m.stage);setPage(0);setSelectedId(undefined);}}><span>{i+1}. {STAGE_LABELS[m.stage]}</span><strong>{m.records}</strong><small>{m.queued} queued · {m.processing} processing · {m.held} held</small><small>Median stage age {wait(m.medianWaitMs)}</small><small>Recorded / 24h: {m.hasHistory ? m.completed : "—"}</small></button>)}</div>
    <section className="panel"><div className={styles.section}><h2>{stage === "all" ? "All cards" : STAGE_LABELS[stage]}</h2><div className={styles.filters}><label>Search<input value={search} onChange={e=>{setSearch(e.target.value);setPage(0);}} placeholder="Player, card or record ID"/></label><label>Status<select value={status} onChange={e=>{setStatus(e.target.value);setPage(0);}}><option value="all">All statuses</option>{["queued","processing","held","complete"].map(s=><option key={s}>{s}</option>)}</select></label></div></div>
      <p>{filtered.length} matching records · {new Set(cards.map(c=>c.definitionId)).size} card definitions</p>
      <div className={styles.breakdown}>{Object.entries(basis).map(([key,label])=><span key={key}>{label}: <b>{filtered.filter(c=>c.evidenceBasis === key).length}</b></span>)}{["low","medium","high"].map(c=><span key={c}>{c} confidence: <b>{filtered.filter(r=>r.confidence===c).length}</b></span>)}</div>
      {!loaded ? <p>Loading saved queue…</p> : !filtered.length ? <div className="empty-state">{cards.length ? "No cards match these filters." : "No scanned backlog loaded. Import a queue snapshot to see actual cards, stage counts and pricing evidence."}</div> : <div className={styles.table}><table><thead><tr><th>Card / quantity</th><th>Stage / status</th><th>Evidence / confidence</th><th>Item / shipping / total</th><th>Age / next action</th><th>API cost</th></tr></thead><tbody>{visible.map(c=><tr key={c.id}><td><div className={styles.identity}>{c.photos?.[0] ? <img src={c.photos[0]} alt={`${c.title} front`} loading="lazy" referrerPolicy="no-referrer"/> : <span className={styles.noPhoto}>No photo</span>}<div><button className={styles.cardButton} aria-expanded={selectedId===c.id} onClick={()=>setSelectedId(selectedId===c.id ? undefined : c.id)}>{c.title}</button><small>{c.id} · qty {c.quantity}</small></div></div></td><td>{STAGE_LABELS[c.stage]}<small>{c.status}</small>{c.holdReason ? <small className={styles.warning}>{c.holdReason}</small> : null}</td><td>{c.evidenceBasis ? basis[c.evidenceBasis] : "Not researched"}<small>{c.compCount === undefined ? "Unknown comp count" : `${c.compCount} comps`} · {c.confidence ?? "unrated"}</small></td><td>{money(c.itemPrice)}<small>Shipping {money(c.shipping)}</small><small>Total {c.itemPrice !== undefined && c.shipping !== undefined ? money(c.itemPrice+c.shipping) : "Unknown"}</small></td><td>{wait(Math.max(0,now-Date.parse(c.enteredAt)))}<small>{c.nextAction}</small></td><td>{money(c.apiCostUsd)}</td></tr>)}</tbody></table></div>}
      {filtered.length > 50 ? <div className={styles.section}><button disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}>Previous</button><span>Page {currentPage+1} of {pageCount}</span><button disabled={currentPage>=pageCount-1} onClick={()=>setPage(currentPage+1)}>Next</button></div> : null}
      {selected ? <section className={styles.detail} aria-live="polite"><div className={styles.section}><h3>{selected.title} · {selected.id}</h3><button onClick={()=>setSelectedId(undefined)}>Close details</button></div><div className={styles.detailGrid}><div><h3>Pricing evidence</h3><p>{selected.evidenceNotes ?? "No decision rationale recorded."}</p><p>Target buyer total: {money(selected.targetTotal)}<br/>Range: {money(selected.rangeLow)} – {money(selected.rangeHigh)}<br/>Policy: {selected.policyVersion ?? "Not recorded"}<br/>Evidence date: {selected.evidenceAt ?? "Unknown"}</p>{selected.evidenceUrls?.map(url=><p key={url}><a href={url} target="_blank" rel="noreferrer">Evidence: {new URL(url).hostname}</a></p>)}</div><div><h3>Handoff</h3><p>{selected.nextAction}</p><p>{selected.holdReason ?? "No hold recorded."}</p>{selected.draftUrl ? <a href={selected.draftUrl} target="_blank" rel="noreferrer">Open recorded draft reference</a> : <p>No draft reference recorded.</p>}<p>Verification: {selected.verifiedAt ?? "Not recorded"}</p><p>Imported verification is not a fresh eBay readback.</p></div><div><h3>Photos & history</h3><div className={styles.photos}>{selected.photos?.map((url,i)=><a href={url} target="_blank" rel="noreferrer" key={`${url}-${i}`}><img src={url} alt={`${selected.title} photo ${i+1}`} loading="lazy" referrerPolicy="no-referrer"/></a>)}</div>{selected.history?.map((h,i)=><p key={i}>{STAGE_LABELS[h.stage]} completed · {h.completedAt}</p>) ?? <p>No completion history recorded.</p>}</div></div></section> : null}
    </section>
  </main>;
}
