"use client";

import { useEffect, useMemo, useState } from "react";

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
  confidenceBand: "high" | "moderate" | "low" | "insufficient";
  recommendationType: "raise-price" | "lower-price" | "hold" | "insufficient-data";
  acceptedCompCount: number;
  excludedCompCount: number;
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
  telemetry: Record<string, number>;
};

function money(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) return "Unknown";
  return `$${value.toFixed(2)}`;
}

export default function CompValidationPage() {
  const [cohort, setCohort] = useState<CohortResponse | null>(null);
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
    loadCohort();
  }, []);

  useEffect(() => {
    if (selectedId) loadValuation(selectedId);
  }, [selectedId]);

  const selectedListing = useMemo(() => cohort?.cohort.find((row) => row.listingId === selectedId) ?? null, [cohort, selectedId]);

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
      <h1>Comp Validation MVP</h1>
      <p style={{ color: "#444" }}>
        Phase 1 uses a provider-independent engine with fixture sold data while live provider authorization is pending.
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
          {selectedListing && valuation && (
            <>
              <h2 style={{ marginTop: 0 }}>View Comps</h2>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(160px, 1fr))", gap: 10, marginBottom: 12 }}>
                <div><strong>Target Listing</strong><div>{valuation.listingTitle}</div></div>
                <div><strong>Current Price</strong><div>{money(valuation.currentPrice)}</div></div>
                <div><strong>Current Shipping</strong><div>{valuation.targetShippingKnown ? money(valuation.targetShipping) : "Unknown"}</div></div>
                <div><strong>Market Value</strong><div>{money(valuation.weightedRecentMarketValue)}</div></div>
                <div><strong>Market Range</strong><div>{money(valuation.lowMarketRange)} - {money(valuation.highMarketRange)}</div></div>
                <div><strong>Recommended Price</strong><div>{money(valuation.recommendedPrice)}</div></div>
                <div><strong>Confidence</strong><div>{valuation.confidenceScore} ({valuation.confidenceBand})</div></div>
                <div><strong>Trend</strong><div>{valuation.trendDirection} ({valuation.trendPct.toFixed(1)}%)</div></div>
                <div><strong>Recommendation</strong><div>{valuation.recommendationType}</div></div>
              </div>

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
          {selectedListing && loadingValuation && <div>Loading valuation...</div>}
        </section>
      </div>
    </main>
  );
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
            <th style={th}>Source</th>
            <th style={th}>Sold Date</th>
            <th style={th}>Sold Price</th>
            <th style={th}>Shipping</th>
            <th style={th}>Total Buyer Cost</th>
            <th style={th}>Match Tier</th>
            <th style={th}>Match Score</th>
            <th style={th}>Reason</th>
            <th style={th}>Action</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.compKey} style={{ borderBottom: "1px solid #eee" }}>
              <td style={td}>{row.soldTitle}</td>
              <td style={td}>{row.providerName}<div style={{ color: "#666" }}>{row.sourceItemId}</div></td>
              <td style={td}>{new Date(row.soldDate).toLocaleDateString()}</td>
              <td style={td}>{money(row.soldPrice)}</td>
              <td style={td}>{money(row.shipping)}</td>
              <td style={td}>{money(row.totalBuyerCost)}</td>
              <td style={td}>{row.matchTier}</td>
              <td style={td}>{row.matchScore}</td>
              <td style={td}>{row.exclusionReason ?? row.inclusionReason}</td>
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
