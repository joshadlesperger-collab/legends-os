"use client";

import { useEffect, useMemo, useState } from "react";
import TableDetail from "@/components/TableDetail";

type CohortBand = ">=100" | "50-99.99" | "20-49.99" | "edge-case";

type CohortItem = {
  listingId: string;
  title: string;
  currentPrice: number;
  quantity: number;
  quantitySold: number;
  views: number;
  watchers: number;
  condition: string | null;
  listingFormat: string | null;
  band: CohortBand;
  complexityScore: number;
  expectedDollarImpact: number | null;
};

type CompRow = {
  compKey: string;
  providerId: string;
  providerName: string;
  sourceItemId: string;
  sourceUrl: string | null;
  soldTitle: string;
  soldDate: string;
  soldPrice: number;
  shipping: number | null;
  totalBuyerCost: number | null;
  matchTier: "exact" | "near-exact" | "fallback";
  researchTier: 1 | 2 | 3 | 4 | 5;
  researchTierLabel: string;
  matchScore: number;
  inclusionStatus: "accepted" | "excluded";
  inclusionReason: string;
  exclusionReason: string | null;
};

type ValuationResult = {
  listingId: string;
  listingTitle: string;
  parsedIdentity: Record<string, unknown>;
  provider: {
    mode: "fixture" | "live";
    providerName: string;
    liveReady: boolean;
    requirements: string[];
    notes: string[];
  };
  currentPrice: number;
  targetShipping: number | null;
  targetShippingKnown: boolean;
  recommendedPrice: number | null;
  weightedRecentMarketValue: number | null;
  lowMarketRange: number | null;
  highMarketRange: number | null;
  trendDirection: "up" | "down" | "flat";
  trendPct: number;
  confidenceScore: number;
  confidenceBand: "very-high" | "high" | "moderate" | "low" | "insufficient";
  recommendationType: "raise-price" | "lower-price" | "hold" | "insufficient-data";
  acceptedCompCount: number;
  excludedCompCount: number;
  newestCompDate: string | null;
  oldestCompDate: string | null;
  evidenceSources: string[];
  evidenceWindowDays: number | null;
  medianSoldPrice: number | null;
  meanSoldPrice: number | null;
  priceDispersionPct: number | null;
  exactMatchCount: number;
  nearExactMatchCount: number;
  confidenceComponents: Record<string, number>;
  internalSales?: { source: string; saleCount: number; units: number; medianSoldPrice: number | null; meanSoldPrice: number | null; newestSaleDate: string | null; sales: Array<{ soldAt: string; unitPrice: number; quantity: number; status: string }> };
  comps: CompRow[];
  notes: string[];
};

type CohortResponse = {
  mode: {
    mode: "fixture" | "live";
    providerName: string;
    liveReady: boolean;
    requirements: string[];
    notes: string[];
  };
  cohortCounts: {
    highValue: number;
    midValue: number;
    lowValue: number;
    edgeCases: number;
    total: number;
  };
  cohort: CohortItem[];
  valuationSummaries: Array<{
    listingId: string;
    recommendedPrice: number | null;
    confidenceScore: number;
    confidenceBand: string;
    recommendationType: string;
    acceptedCompCount: number;
    excludedCompCount: number;
    expectedDollarImpact: number | null;
  }>;
  telemetry: Record<string, number>;
};

function money(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) return "Unknown";
  return `$${value.toFixed(2)}`;
}

export default function CompValidationPage() {
  const [cohort, setCohort] = useState<CohortResponse | null>(null);
  const [deepLinkId, setDeepLinkId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [valuation, setValuation] = useState<ValuationResult | null>(null);
  const [loadingCohort, setLoadingCohort] = useState(false);
  const [loadingValuation, setLoadingValuation] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function loadCohort() {
    setLoadingCohort(true);
    setMessage(null);
    try {
      const response = await fetch("/api/comp-validation/cohort");
      if (!response.ok) throw new Error(`Failed to load cohort (${response.status})`);
      const data = (await response.json()) as CohortResponse;
      setCohort(data);
      if (!selectedId && data.cohort.length) {
        setSelectedId(data.cohort[0].listingId);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingCohort(false);
    }
  }

  async function loadValuation(id: string) {
    setLoadingValuation(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/comp-validation/${id}`);
      if (!response.ok) throw new Error(`Failed to load valuation (${response.status})`);
      const data = (await response.json()) as { result: ValuationResult };
      setValuation(data.result);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingValuation(false);
    }
  }

  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      const listingId = url.searchParams.get("listingId");
      if (listingId) {
        setDeepLinkId(listingId);
      }
    } catch {
      setDeepLinkId(null);
    }
  }, []);

  useEffect(() => {
    loadCohort();
  }, []);

  useEffect(() => {
    setValuation(null);
  }, [selectedId]);

  useEffect(() => {
    if (!deepLinkId || !cohort) return;
    setSelectedId(deepLinkId);
    void loadValuation(deepLinkId);
  }, [cohort, deepLinkId]);

  const selectedListing = useMemo(() => cohort?.cohort.find((row) => row.listingId === selectedId) ?? (selectedId ? { listingId: selectedId, title: valuation?.listingTitle ?? "Linked listing", currentPrice: valuation?.currentPrice ?? 0, quantity: 0, quantitySold: 0, views: 0, watchers: 0, condition: null, listingFormat: null, band: "edge-case" as const, complexityScore: 0, expectedDollarImpact: null } : null), [cohort, selectedId, valuation]);
  const selectedSummary = useMemo(
    () => cohort?.valuationSummaries.find((row) => row.listingId === selectedId) ?? null,
    [cohort, selectedId]
  );

  async function updateComp(compKey: string, action: "exclude" | "restore") {
    if (!selectedId) return;
    const reason = action === "exclude" ? window.prompt("Reason for exclusion", "seller rejected comp") ?? "seller rejected comp" : "";

    const response = await fetch(`/api/comp-validation/${selectedId}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ compKey, action, reason }),
    });

    if (!response.ok) {
      setMessage(`Failed to ${action} comp (${response.status})`);
      return;
    }

    const data = (await response.json()) as { result: ValuationResult };
    setValuation(data.result);
    setMessage(action === "exclude" ? "Comp excluded and valuation recalculated." : "Comp restored and valuation recalculated.");
  }

  return (
    <main style={{ maxWidth: 1480, margin: "0 auto", padding: 20 }}>
      <h1>Explain My Comp</h1>
      <p style={{ color: "#444" }}>
        Cohort selection is cache-only. Use View Comps or Refresh Comps to run a live lookup for the selected listing.
      </p>

      {message && (
        <div style={{ marginBottom: 12, padding: 10, borderRadius: 8, background: "#f4f9ff", color: "#124" }}>
          {message}
        </div>
      )}

      {cohort?.mode && (
        <div style={{ marginBottom: 16, border: "1px solid #ccc", borderRadius: 10, padding: 12 }}>
          <strong>Provider Mode:</strong> {cohort.mode.mode.toUpperCase()} ({cohort.mode.providerName})
          <div style={{ marginTop: 6 }}>
            <strong>Live Ready:</strong> {cohort.mode.liveReady ? "Yes" : "No"}
          </div>
          <div style={{ marginTop: 6 }}>
            <strong>Requirements:</strong> {cohort.mode.requirements.join(" | ")}
          </div>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "360px 1fr", gap: 16 }}>
        <section style={{ border: "1px solid #ddd", borderRadius: 10, padding: 12, maxHeight: "78vh", overflow: "auto" }}>
          <h2 style={{ marginTop: 0 }}>50-Listing Cohort</h2>
          <div style={{ fontSize: 12, color: "#555", marginBottom: 8 }}>
            {loadingCohort ? "Loading..." : `Total ${cohort?.cohort.length ?? 0}`}
          </div>
          {(cohort?.cohort ?? []).map((item) => (
            <button
              key={item.listingId}
              type="button"
              onClick={() => setSelectedId(item.listingId)}
              style={{
                width: "100%",
                textAlign: "left",
                border: selectedId === item.listingId ? "2px solid #111" : "1px solid #ddd",
                background: "#fff",
                borderRadius: 8,
                marginBottom: 8,
                padding: 8,
                cursor: "pointer",
              }}
            >
              <div style={{ fontWeight: 600 }}>{item.title}</div>
              <div style={{ fontSize: 12, color: "#555" }}>
                {item.band} | {money(item.currentPrice)} | Qty {item.quantity} | Complexity {item.complexityScore}
              </div>
            </button>
          ))}
        </section>

        <section style={{ border: "1px solid #ddd", borderRadius: 10, padding: 12 }}>
          {!selectedListing && <div>Select a listing to view comps.</div>}
          {selectedListing && (
            <>
              <h2 style={{ marginTop: 0 }}>Comp evidence</h2>
              <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                <button type="button" onClick={() => loadValuation(selectedListing.listingId)} style={btn}>View Comps</button>
                <button type="button" onClick={() => loadValuation(selectedListing.listingId)} style={btn}>Refresh Comps</button>
              </div>

              {!valuation && selectedSummary && (
                <div style={{ marginBottom: 12, background: "#f8f8f8", padding: 10, borderRadius: 8 }}>
                  <strong>Cached Summary</strong>
                  <div>Recommended Price: {money(selectedSummary.recommendedPrice)}</div>
                  <div>Confidence: {selectedSummary.confidenceScore} ({selectedSummary.confidenceBand})</div>
                  <div>Recommendation: {selectedSummary.recommendationType}</div>
                  <div>Expected Dollar Impact: {money(selectedSummary.expectedDollarImpact)}</div>
                </div>
              )}

              {!valuation && !selectedSummary && !loadingValuation && (
                <div style={{ marginBottom: 12, color: "#555" }}>
                  No cached valuation summary is available yet for this listing.
                </div>
              )}

              {valuation && (
                <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(160px, 1fr))", gap: 10, marginBottom: 12 }}>
                <div><strong>Target Listing</strong><div>{valuation.listingTitle}</div></div>
                <div><strong>Current Price</strong><div>{money(valuation.currentPrice)}</div></div>
                <div><strong>Current Shipping</strong><div>{valuation.targetShippingKnown ? money(valuation.targetShipping) : "Unknown"}</div></div>
                <div><strong>Market Value</strong><div>{money(valuation.weightedRecentMarketValue)}</div></div>
                <div><strong>Market Range</strong><div>{money(valuation.lowMarketRange)} - {money(valuation.highMarketRange)}</div></div>
                <div><strong>Recommended Price</strong><div>{money(valuation.recommendedPrice)}</div></div>
                <div><strong>Confidence</strong><div>{valuation.confidenceScore} ({valuation.confidenceBand})</div></div>
                <div><strong>Qualifying Sales</strong><div>{valuation.acceptedCompCount} ({valuation.exactMatchCount} exact, {valuation.nearExactMatchCount} near)</div></div>
                <div><strong>Evidence Window</strong><div>{valuation.evidenceWindowDays ? `${valuation.evidenceWindowDays} days` : "Unavailable"}</div></div>
                <div><strong>Median / Mean</strong><div>{money(valuation.medianSoldPrice)} / {money(valuation.meanSoldPrice)}</div></div>
                <div><strong>Price Dispersion</strong><div>{valuation.priceDispersionPct == null ? "Unavailable" : `${valuation.priceDispersionPct.toFixed(1)}%`}</div></div>
                <div><strong>Comp Dates</strong><div>{valuation.oldestCompDate ? new Date(valuation.oldestCompDate).toLocaleDateString() : "—"} – {valuation.newestCompDate ? new Date(valuation.newestCompDate).toLocaleDateString() : "—"}</div></div>
                <div><strong>Trend</strong><div>{valuation.trendDirection} ({valuation.trendPct.toFixed(1)}%)</div></div>
                <div><strong>Recommendation</strong><div>{valuation.recommendationType}</div></div>
              </div>

              <CompDistribution valuation={valuation} />

              {valuation.internalSales&&<section className="panel" style={{ marginBottom: 12 }}><div className="eyebrow">Legends historical sales</div><h3 style={{ margin: "6px 0" }}>{valuation.internalSales.saleCount} authoritative sales · {valuation.internalSales.units} units</h3><p>Kept separate from external market comps and never used to inflate Comp Confidence.</p><div className="metric-grid"><div className="metric"><div className="metric-label">Internal median</div><div className="metric-value">{money(valuation.internalSales.medianSoldPrice)}</div></div><div className="metric"><div className="metric-label">Internal mean</div><div className="metric-value">{money(valuation.internalSales.meanSoldPrice)}</div></div><div className="metric"><div className="metric-label">Most recent</div><div className="metric-value" style={{fontSize:18}}>{valuation.internalSales.newestSaleDate?new Date(valuation.internalSales.newestSaleDate).toLocaleDateString():"No linked sale"}</div></div></div>{valuation.internalSales.sales.length>0&&<details style={{marginTop:12}}><summary>View Legends sales</summary><ul>{valuation.internalSales.sales.map((sale,index)=><li key={`${sale.soldAt}-${index}`}>{new Date(sale.soldAt).toLocaleDateString()} · {sale.quantity} × {money(sale.unitPrice)} · {sale.status}</li>)}</ul></details>}</section>}

              <details className="panel" style={{ marginBottom: 12 }} open>
                <summary style={{ cursor: "pointer", fontWeight: 700 }}>How Comp Confidence is calculated</summary>
                <div className="metric-grid" style={{ marginTop: 12 }}>
                  {Object.entries(valuation.confidenceComponents).map(([name, points]) => (
                    <div className="metric" key={name}><div className="metric-label">{name.replace(/([A-Z])/g, " $1")}</div><div className="metric-value">{points.toFixed(1)}</div></div>
                  ))}
                </div>
                <p>{valuation.acceptedCompCount} qualifying confirmed sold comps from {valuation.evidenceSources.join(", ") || "no external source"}. Excluded evidence remains visible below with its reason. Confidence measures evidence quality, not expected price performance.</p>
              </details>

              <div style={{ marginBottom: 12 }}>
                <strong>Parsed Identity</strong>
                <pre style={{ background: "#f8f8f8", padding: 10, borderRadius: 8, overflowX: "auto" }}>
                  {JSON.stringify(valuation.parsedIdentity, null, 2)}
                </pre>
              </div>

              <h3>Accepted Comps</h3>
              <CompTable
                rows={valuation.comps.filter((row) => row.inclusionStatus === "accepted")}
                onExclude={(compKey) => updateComp(compKey, "exclude")}
                onRestore={(compKey) => updateComp(compKey, "restore")}
              />

              <h3 style={{ marginTop: 16 }}>Excluded Comps</h3>
              <CompTable
                rows={valuation.comps.filter((row) => row.inclusionStatus === "excluded")}
                onExclude={(compKey) => updateComp(compKey, "exclude")}
                onRestore={(compKey) => updateComp(compKey, "restore")}
              />

              {valuation.notes.length > 0 && (
                <div style={{ marginTop: 12, background: "#fff8e8", padding: 10, borderRadius: 8 }}>
                  <strong>Notes</strong>
                  {valuation.notes.map((note) => (
                    <div key={note}>{note}</div>
                  ))}
                </div>
              )}
                </>
              )}
            </>
          )}
          {selectedListing && loadingValuation && <div>Loading valuation...</div>}
        </section>
      </div>
    </main>
  );
}

function CompDistribution({ valuation }: { valuation: ValuationResult }) {
  const prices = valuation.comps.filter((row) => row.inclusionStatus === "accepted").map((row) => row.totalBuyerCost ?? row.soldPrice);
  const markers = [...prices, valuation.medianSoldPrice, valuation.weightedRecentMarketValue, valuation.currentPrice].filter((value): value is number => value != null);
  if (!prices.length || !markers.length) return null;
  const min = Math.min(...markers); const max = Math.max(...markers); const span = Math.max(0.01, max - min);
  const left = (value: number) => `${((value - min) / span) * 100}%`;
  return <section className="panel" style={{ marginBottom: 12 }} aria-label="Qualifying sold price distribution">
    <strong>Comp distribution</strong><div style={{ position: "relative", height: 54, margin: "14px 8px 4px", borderTop: "2px solid var(--border)" }}>
      {prices.map((price, index) => <span key={`${price}-${index}`} title={`Qualifying sale ${money(price)}`} style={{ position: "absolute", left: left(price), top: -6, width: 10, height: 10, borderRadius: 10, background: "var(--text)", transform: "translateX(-50%)" }} />)}
      <Marker value={valuation.medianSoldPrice} label="Median" color="var(--gold-hover)" left={left} />
      <Marker value={valuation.weightedRecentMarketValue} label="Legends estimate" color="var(--gold)" left={left} />
      <Marker value={valuation.currentPrice} label="Current" color="var(--danger)" left={left} />
    </div><div style={{ display: "flex", justifyContent: "space-between", color: "var(--muted)", fontSize: 12 }}><span>{money(min)}</span><span>{money(max)}</span></div>
  </section>;
}

function Marker({ value, label, color, left }: { value: number | null; label: string; color: string; left: (value: number) => string }) {
  if (value == null) return null;
  return <span title={`${label}: ${money(value)}`} style={{ position: "absolute", left: left(value), top: 4, height: 31, borderLeft: `3px solid ${color}`, color, fontSize: 10, paddingLeft: 4, whiteSpace: "nowrap" }}>{label}</span>;
}

function CompTable(props: {
  rows: CompRow[];
  onExclude: (compKey: string) => void;
  onRestore: (compKey: string) => void;
}) {
  const { rows, onExclude, onRestore } = props;

  if (rows.length === 0) {
    return <div style={{ color: "#666", marginBottom: 10 }}>None</div>;
  }

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ borderBottom: "2px solid #ccc" }}>
            <th style={th}>Sold Title</th>
            <th style={th}>Sold Date</th>
            <th style={th}>Sold Price</th>
            <th style={th}>Shipping</th>
            <th style={th}>Total Buyer Cost</th>
            <th style={th}>Evidence Tier</th>
            <th style={th}>Match Score</th>
            <th style={th}>Evidence</th>
            <th style={th}>Action</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.compKey} style={{ borderBottom: "1px solid #eee" }}>
              <td style={td}>{row.soldTitle}</td>
              <td style={td}>{new Date(row.soldDate).toLocaleDateString()}</td>
              <td style={td}>{money(row.soldPrice)}</td>
              <td style={td}>{money(row.shipping)}</td>
              <td style={td}>{money(row.totalBuyerCost)}</td>
              <td style={td}>Tier {row.researchTier}<div style={{color:"#666"}}>{row.researchTierLabel}</div></td>
              <td style={td}>{row.matchScore}</td>
              <td className="compact-prose-cell" style={td}><TableDetail summary={`${row.inclusionStatus === "accepted" ? "Included" : "Excluded"} · ${row.researchTierLabel}`} label="View evidence"><p>{row.exclusionReason ?? row.inclusionReason}</p><p><strong>Provider provenance:</strong> {row.providerName} · source item {row.sourceItemId}</p><p><strong>Evidence classification:</strong> Tier {row.researchTier} · match score {row.matchScore}.</p></TableDetail></td>
              <td style={td}>
                {row.inclusionStatus === "accepted" ? (
                  <button type="button" onClick={() => onExclude(row.compKey)} style={btn}>Exclude</button>
                ) : (
                  <button type="button" onClick={() => onRestore(row.compKey)} style={btn}>Restore</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const th: React.CSSProperties = { textAlign: "left", padding: "6px 8px" };
const td: React.CSSProperties = { textAlign: "left", padding: "6px 8px", verticalAlign: "top" };
const btn: React.CSSProperties = { padding: "6px 8px", border: "1px solid #aaa", borderRadius: 6, background: "#fff", cursor: "pointer" };
