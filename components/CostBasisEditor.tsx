"use client";

import { useState } from "react";

type CostBasis = { unitAcquisitionCost: number | null; unitGradingCost: number | null; unitSuppliesCost: number | null; unitOutboundPostageCost: number | null; unitOtherCost: number | null; notes: string | null };
const labels: Array<[keyof CostBasis, string]> = [
  ["unitAcquisitionCost", "Acquisition"], ["unitGradingCost", "Grading"], ["unitSuppliesCost", "Supplies"],
  ["unitOutboundPostageCost", "Postage"], ["unitOtherCost", "Other"],
];

export default function CostBasisEditor({ listingId, initial }: { listingId: string; initial: CostBasis }) {
  const [values, setValues] = useState(initial);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  async function save() {
    setState("saving");
    const response = await fetch(`/api/listings/${encodeURIComponent(listingId)}/cost-basis`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) });
    setState(response.ok ? "saved" : "error");
  }
  return <details><summary style={{ cursor: "pointer", color: "var(--gold-hover)", fontSize: 12, minHeight: 40, display: "flex", alignItems: "center" }}>Enter per-unit costs</summary><div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(90px,1fr))", gap: 7, marginTop: 8 }}>
    {labels.map(([field, label]) => <label key={field} style={{ fontSize: 11, color: "var(--text-secondary)" }}>{label}<input type="number" min="0" step="0.01" value={values[field] ?? ""} onChange={(event) => setValues((current) => ({ ...current, [field]: event.target.value === "" ? null : Number(event.target.value) }))} style={{ width: "100%", boxSizing: "border-box", padding: 6, marginTop: 2 }}/></label>)}
    <label style={{ gridColumn: "1 / -1", fontSize: 11, color: "var(--text-secondary)" }}>Notes<input value={values.notes ?? ""} maxLength={500} onChange={(event) => setValues((current) => ({ ...current, notes: event.target.value }))} style={{ width: "100%", boxSizing: "border-box", padding: 6, marginTop: 2 }}/></label>
    <button className="btn-primary" type="button" onClick={save} disabled={state === "saving"} style={{ padding: "7px 10px", cursor: "pointer" }}>{state === "saving" ? "Saving…" : "Save costs"}</button><span style={{ fontSize: 11, alignSelf: "center", color: state === "error" ? "var(--danger)" : "var(--success)" }}>{state === "saved" ? "Saved" : state === "error" ? "Save failed" : ""}</span>
  </div></details>;
}
