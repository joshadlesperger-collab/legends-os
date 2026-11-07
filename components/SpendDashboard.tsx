"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { usePathname } from "next/navigation";
import type { SpendSummary, SpendMetric, SpendProviderId } from "@/lib/spend-dashboard";
import styles from "./SpendDashboard.module.css";

type Provider = SpendSummary["providers"][number];
type Unit = SpendMetric["unit"];
const amounts = ["available", "limit", "used", "reserved"] as const;
const amountLabels = { available: "Remaining", limit: "Total / limit", used: "Used", reserved: "Reserved" };
function amount(value: number | null, unit: Unit) {
  if (value === null || !Number.isFinite(value)) return "Unknown";
  if (unit === "usd") return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
  const text = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
  return unit === "percent" ? `${text}%` : `${text} credits`;
}
function freshness(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return "No observation";
  return new Date(value).toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " CT";
}
function kindLabel(metric: SpendMetric) {
  return metric.kind === "app_budget" ? (metric.id === "card-identification-budget" ? "Card processing budget" : "App budget") : metric.kind === "allowance" ? (metric.unit === "usd" ? "Manual budget" : "Allowance") : "Provider credit";
}
function primary(provider: Provider) {
  return provider.metrics.find(metric => metric.kind === "provider_balance" && metric.available !== null)
    ?? provider.metrics.find(metric => metric.kind === "app_budget")
    ?? provider.metrics[0];
}
function Dial({ metric, small = false }: { metric: SpendMetric; small?: boolean }) {
  const ratio = metric.available !== null && metric.limit !== null && metric.limit > 0 ? Math.min(1, Math.max(0, metric.available / metric.limit)) : null;
  const low = ratio !== null && ratio <= .2;
  return <svg className={`${styles.dial} ${small ? styles.smallDial : ""} ${low ? styles.low : ""}`} viewBox="0 0 40 40" role="img" aria-label={`${metric.label}: ${amount(metric.available, metric.unit)} remaining${ratio !== null ? `, ${Math.round(ratio * 100)}% of recorded limit` : ", total not known"}`}>
    <circle className={styles.track} cx="20" cy="20" r="16" />
    {ratio !== null ? <circle className={styles.fill} cx="20" cy="20" r="16" pathLength="100" strokeDasharray={`${ratio * 100} 100`} transform="rotate(-90 20 20)" /> : <circle className={styles.unknownRing} cx="20" cy="20" r="16" />}
    <text x="20" y="24" textAnchor="middle" aria-hidden="true">{ratio === null ? "?" : `${Math.round(ratio * 100)}`}</text>
  </svg>;
}
function localDateInput() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}T${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

export default function SpendDashboard() {
  const pathname = usePathname();
  const hidden = pathname === "/login";
  const [summary, setSummary] = useState<SpendSummary | null>(null);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [providerId, setProviderId] = useState<SpendProviderId | "other">("chatgpt");
  const [otherToolName, setOtherToolName] = useState("");
  const [unit, setUnit] = useState<Unit>("percent");
  const [values, setValues] = useState({ available: "", limit: "", used: "", reserved: "" });
  const [period, setPeriod] = useState("Current plan period");
  const [observedAt, setObservedAt] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [manualError, setManualError] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const panelId = useId();
  const dialogTitleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++request.current;
    try {
      const response = await fetch("/api/spend-dashboard", { cache: "no-store" });
      if (response.status === 401) { if (current === request.current) setSummary(null); return; }
      if (!response.ok) throw Error("Balances could not be refreshed.");
      const data = await response.json() as SpendSummary;
      if (!Array.isArray(data.providers) || typeof data.updatedAt !== "string") throw Error("Balances could not be refreshed.");
      if (current === request.current) { setSummary(data); setError(""); }
    } catch { if (current === request.current) setError("Refresh unavailable. Previous observations remain shown."); }
  }, []);
  useEffect(() => {
    if (hidden) return;
    void refresh();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 60_000);
    return () => { clearInterval(timer); request.current++; };
  }, [hidden, refresh]);
  useEffect(() => {
    if (manualOpen && !dialog.current?.open) dialog.current?.showModal();
    else if (!manualOpen && dialog.current?.open) dialog.current.close();
  }, [manualOpen]);
  function selectProvider(id: SpendProviderId | "other") {
    setProviderId(id); setOtherToolName(""); setUnit(id === "chatgpt" ? "percent" : "usd"); setPeriod(id === "chatgpt" ? "Current plan period" : id === "other" || id.startsWith("tool-") ? "Current budget period" : "Current account balance");
    setValues({ available: "", limit: "", used: "", reserved: "" }); setNote("");
  }
  function openManual() {
    selectProvider("chatgpt"); setObservedAt(localDateInput()); setManualError(""); setConfirmation(""); setManualOpen(true);
  }
  async function saveManual(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setManualError("");
    try {
      const parsed = Object.fromEntries(amounts.map(key => [key, values[key].trim() === "" ? null : Number(values[key])])) as Record<typeof amounts[number], number | null>;
      if (amounts.some(key => parsed[key] !== null && (!Number.isFinite(parsed[key]) || parsed[key]! < 0))) throw Error("Enter nonnegative values, or leave unknown values blank.");
      if (!observedAt || !Number.isFinite(Date.parse(observedAt))) throw Error("Enter when you observed this balance.");
      if (!period.trim()) throw Error("Describe the balance or allowance period.");
      const slug = otherToolName.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 59).replace(/-+$/g, "");
      const provider = providerId === "other" ? { id: `tool-${slug}` as SpendProviderId, label: otherToolName.trim() } : summary?.providers.find(item => item.id === providerId);
      if (!provider || providerId === "other" && (!slug || !provider.label)) throw Error("Enter a tool name containing letters or numbers.");
      const custom = provider.id.startsWith("tool-");
      const allowance = provider.id === "chatgpt" || custom;
      const response = await fetch("/api/spend-dashboard", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providerId: provider.id, ...(custom ? { providerLabel: provider.label } : {}), metric: { id: allowance ? "allowance" : "provider-balance", kind: allowance ? "allowance" : "provider_balance", label: allowance ? (unit === "usd" ? "Manual budget" : "Plan allowance") : "Provider credit", unit, ...parsed, period: period.trim(), observedAt: new Date(observedAt).toISOString(), ...(note.trim() ? { note: note.trim() } : {}) } }) });
      const result = await response.json();
      if (!response.ok) throw Error(typeof result.error === "string" ? result.error : "The manual snapshot could not be saved.");
      setManualOpen(false); setConfirmation("Manual balance snapshot saved."); await refresh();
    } catch (reason) { setManualError(reason instanceof Error ? reason.message : "The manual snapshot could not be saved."); }
    finally { setSaving(false); }
  }
  if (hidden) return null;
  const visible = summary?.providers.filter(provider => provider.configured || provider.id === "chatgpt" || provider.id === "openai") ?? [];
  return <section className={styles.shell} aria-label="Tool balances and spending budgets">
    <div className={styles.bar}>
      <button type="button" className={styles.toggle} aria-expanded={expanded} aria-controls={panelId} onClick={() => setExpanded(value => !value)}><span>Tools & balances</span><span aria-hidden="true">{expanded ? "⌃" : "⌄"}</span></button>
      <div className={styles.strip}>
        {visible.map(provider => { const metric = primary(provider); return metric ? <div key={provider.id} className={styles.mini} title={`${provider.label} · ${metric.label} · ${metric.source} · ${freshness(metric.observedAt)}${metric.note ? ` · ${metric.note}` : ""}`}><Dial metric={metric} small /><div><span className={styles.providerName}>{provider.label}</span><strong>{amount(metric.available, metric.unit)}</strong><span className={styles.kind}>{kindLabel(metric)} · {metric.source}</span></div></div> : null; })}
        {!summary && <span className={styles.loading} role="status">{error ? "Balances unavailable" : "Checking balances…"}</span>}
      </div>
      {error && <span className={styles.stale} title={error}>Refresh unavailable</span>}
    </div>
    <div className={styles.panel} id={panelId} hidden={!expanded}>
      <div className={styles.panelHeader}><div><h2>Tool balances & budgets</h2><p>Provider credit, plan allowances and local app budgets are separate. Unknown values stay unknown.</p></div><button type="button" onClick={openManual} disabled={!summary}>Record observed balance</button></div>
      {error && <p role="status" className={styles.stale}>{error}</p>}
      <div className={styles.grid}>{summary?.providers.map(provider => <article key={provider.id} className={styles.tool}><header><h3>{provider.label}</h3><span>{provider.id.startsWith("tool-") || provider.id === "chatgpt" ? "Manual tracking" : provider.configured ? "API configured" : "No live balance feed"}</span></header>{provider.metrics.map(metric => <div key={metric.id} className={styles.metric}><Dial metric={metric} /><div className={styles.metricContent}><span className={styles.kind}>{kindLabel(metric)}</span><h4>{metric.label}</h4><strong className={styles.remaining}>{amount(metric.available, metric.unit)} <small>remaining</small></strong><dl><div><dt>Total / limit</dt><dd>{amount(metric.limit, metric.unit)}</dd></div><div><dt>Used</dt><dd>{amount(metric.used, metric.unit)}</dd></div><div><dt>Reserved</dt><dd>{amount(metric.reserved, metric.unit)}</dd></div></dl><p className={styles.provenance}>{metric.period} · {metric.source === "local" ? "Local app records" : metric.source === "manual" ? "Manually recorded" : "Unavailable"} · {freshness(metric.observedAt)}</p>{metric.note && <p className={styles.note}>{metric.note}</p>}</div></div>)}{provider.billingUrl && <a href={provider.billingUrl} target="_blank" rel="noreferrer">Open {provider.label} billing / usage ↗</a>}</article>)}</div>
      {summary && <p className={styles.footer}>Dashboard refreshed {freshness(summary.updatedAt)}. Checks once per minute; each metric keeps its own observation time.</p>}
    </div>
    {confirmation && <p className={styles.confirmation} role="status">{confirmation}</p>}
    <dialog ref={dialog} className={styles.dialog} aria-labelledby={dialogTitleId} onCancel={() => { if (!saving) setManualOpen(false); }} onClose={() => setManualOpen(false)}>
      <form onSubmit={event => { void saveManual(event); }}><header><h2 id={dialogTitleId}>Record an observed balance</h2><button type="button" disabled={saving} aria-label="Close balance snapshot" onClick={() => setManualOpen(false)}>×</button></header><p>Save a balance or allowance you have checked. This records an observation; it does not change provider funds or enforced app budgets.</p>
        <div className={styles.formGrid}><label>Tool<select value={providerId} onChange={event => selectProvider(event.target.value as SpendProviderId | "other")} disabled={saving}>{summary?.providers.map(provider => <option key={provider.id} value={provider.id}>{provider.label}</option>)}<option value="other">Other tool…</option></select></label>{providerId === "other" && <label>Tool name<input value={otherToolName} maxLength={80} required placeholder="For example, Vercel" disabled={saving} onChange={event => setOtherToolName(event.target.value)} /></label>}<label>Unit<select value={unit} onChange={event => setUnit(event.target.value as Unit)} disabled={saving}><option value="usd">US dollars</option><option value="percent">Percent remaining / used</option><option value="credits">Credits</option></select></label>{amounts.map(key => <label key={key}>{amountLabels[key]}<input type="number" min="0" max={unit === "percent" ? 100 : undefined} step="any" inputMode="decimal" value={values[key]} placeholder="Unknown" disabled={saving} onChange={event => setValues(current => ({ ...current, [key]: event.target.value }))} /></label>)}<label>Period / scope<input value={period} maxLength={100} required disabled={saving} onChange={event => setPeriod(event.target.value)} /></label><label>Observed at (your local time)<input type="datetime-local" value={observedAt} required disabled={saving} onChange={event => setObservedAt(event.target.value)} /></label></div><label className={styles.noteInput}>Note (optional)<textarea value={note} maxLength={300} rows={2} disabled={saving} onChange={event => setNote(event.target.value)} /></label><p className={styles.hint}>Leave any unknown amount blank. Percent values describe the recorded allowance, not token counts.</p>{manualError && <p role="alert" className={styles.formError}>{manualError}</p>}<footer><button type="button" disabled={saving} onClick={() => setManualOpen(false)}>Cancel</button><button type="submit" disabled={saving}>{saving ? "Saving…" : "Save snapshot"}</button></footer></form>
    </dialog>
  </section>;
}
