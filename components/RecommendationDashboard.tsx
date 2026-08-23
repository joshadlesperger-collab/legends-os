"use client";

import { useEffect, useMemo, useState } from "react";
import { formatRecommendationMoney } from "@/lib/recommendation-display";
import TableDetail from "@/components/TableDetail";

type RecommendationType = "raise-price" | "lower-price" | "hold" | "insufficient-data";
type TrafficState =
  | "new-learning"
  | "no-traffic"
  | "low-traffic"
  | "traffic-no-interest"
  | "interested-not-converting"
  | "converting"
  | "strong-demand-potentially-underpriced";

type PriorityLevel = "critical" | "high" | "medium" | "low";

type Listing = {
  id: string;
  title: string;
  currentPrice: string;
  quantity: number;
  quantitySold: number;
  watchers: number;
  views: number;
  startTime?: string | null;
  storeId: string;
};

type Recommendation = {
  id: string;
  type: RecommendationType;
  suggestedPrice: string | null;
  reason: string;
  expectedProfitImpact: string | null;
  confidence: number | null;
  listing: Listing;
};

type QueueResponse = {
  date: string;
  actionableTotal: number;
  raise: Recommendation[];
  lower: Recommendation[];
  pricingEvidenceUnavailable: { total: number; items: Recommendation[] };
  legacyPendingExcluded: number;
  pricingCoverage: { activeListings: number; analyzedListings: number; supportedListings: number; insufficientListings: number; notAnalyzedListings: number; supportedPct: number };
};

type TrafficHealthRow = {
  listingId: string;
  title: string;
  currentPrice: number;
  listingAgeDays: number;
  activeDays: number;
  views: number;
  viewsPerDay: number;
  viewsPer30: number;
  watchers: number;
  watcherRate: number;
  quantitySold: number;
  lifetimeConversionProxy: number;
  recentVelocityPerDay: number | null;
  recentConversionProxy: number | null;
  trafficState: TrafficState;
  priority: PriorityLevel;
  compSummary: {
    recommendedPrice: number | null;
    confidenceScore: number;
    confidenceBand: string;
    recommendationType: string;
    acceptedCompCount: number;
    excludedCompCount: number;
  } | null;
  reason: string;
};

type TrafficHealthResponse = {
  generatedAt: string;
  minExposureDays: number;
  telemetry: {
    dbReads: number;
    dbWrites: number;
    listingsEvaluated: number;
    snapshotRowsUsed: number;
    cacheStatus: "hit" | "miss";
  };
  summary: {
    trafficHealthPct: number;
    matureListingsCount: number;
    healthyMatureCount: number;
    counts: Record<TrafficState, number>;
  };
  rows: TrafficHealthRow[];
};

type SortKey =
  | "title"
  | "type"
  | "currentPrice"
  | "suggestedPrice"
  | "expectedProfitImpact"
  | "confidence"
  | "age"
  | "views"
  | "watchers"
  | "quantity"
  | "quantitySold";

type TrafficSortKey =
  | "title"
  | "price"
  | "age"
  | "views"
  | "viewsPer30"
  | "watchers"
  | "watcherRate"
  | "quantitySold"
  | "conversion"
  | "state"
  | "priority"
  | "compConfidence";

const labels: Record<RecommendationType | "all", string> = {
  all: "All",
  "raise-price": "Raise Price",
  "lower-price": "Lower Price",
  hold: "Hold",
  "insufficient-data": "Insufficient Data",
};

function formatMoney(value: string | number | null | undefined) {
  if (value == null || value === "") return "—";
  const amount = Number(value);
  if (Number.isNaN(amount)) return "—";
  return `$${amount.toFixed(2)}`;
}

function ageDays(startTime?: string | null) {
  if (!startTime) return "—";
  const timestamp = Date.parse(startTime);
  if (Number.isNaN(timestamp)) return "—";
  const diff = Date.now() - timestamp;
  return Math.max(0, Math.floor(diff / (1000 * 60 * 60 * 24))).toString();
}

function reasonSummary(reason: string) {
  return reason.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() || reason;
}

export default function RecommendationDashboard() {
  const [queue, setQueue] = useState<QueueResponse | null>(null);
  const [trafficHealth, setTrafficHealth] = useState<TrafficHealthResponse | null>(null);
  const [filter, setFilter] = useState<"all" | RecommendationType>("all");
  const [trafficFilter, setTrafficFilter] = useState<"all" | TrafficState>("all");
  const [showTrafficDetails, setShowTrafficDetails] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingTraffic, setLoadingTraffic] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [activeAction, setActiveAction] = useState<string | null>(null);

  const recommendations = useMemo(() => {
    if (!queue) return [] as Recommendation[];
    const all = [...queue.raise, ...queue.lower];
    if (filter === "all") return all;
    return all.filter((rec) => rec.type === filter);
  }, [filter, queue]);

  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [hoveredSortKey, setHoveredSortKey] = useState<SortKey | null>(null);
  const [trafficSortKey, setTrafficSortKey] = useState<TrafficSortKey>("priority");
  const [trafficSortDirection, setTrafficSortDirection] = useState<"asc" | "desc">("asc");
  const [trafficHoveredSortKey, setTrafficHoveredSortKey] = useState<TrafficSortKey | null>(null);

  const sortButtonBaseStyle = {
    background: "transparent",
    border: "none",
    padding: 0,
    font: "inherit",
    cursor: "pointer",
    color: "inherit",
    width: "100%",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    whiteSpace: "nowrap",
    transition: "background-color 0.15s ease, color 0.15s ease",
  } as const;

  const stateLabels: Record<TrafficState, string> = {
    "new-learning": "New / Learning",
    "no-traffic": "No Traffic",
    "low-traffic": "Low Traffic",
    "traffic-no-interest": "Traffic / No Interest",
    "interested-not-converting": "Interested / Not Converting",
    converting: "Converting",
    "strong-demand-potentially-underpriced": "Strong Demand / Potentially Underpriced",
  };

  const priorityLabels: Record<PriorityLevel, string> = {
    critical: "Critical",
    high: "High",
    medium: "Medium",
    low: "Low",
  };

  const renderSortHeader = (
    key: SortKey,
    label: string,
    width: number,
    align: "left" | "center" = "center",
    spaceBetween = false
  ) => (
    <th style={{ padding: "10px 8px", width, textAlign: align }}>
      <button
        type="button"
        onClick={() => requestSort(key)}
        onMouseEnter={() => setHoveredSortKey(key)}
        onMouseLeave={() => setHoveredSortKey(null)}
        style={{
          ...sortButtonBaseStyle,
          justifyContent: spaceBetween ? "space-between" : "center",
          backgroundColor: hoveredSortKey === key ? "#f7f7f7" : "transparent",
        }}
      >
        <span>{label}</span>
        <span>{sortKey === key ? (sortDirection === "asc" ? "▲" : "▼") : "↕"}</span>
      </button>
    </th>
  );

  const normalizeSortValue = (value: unknown, numeric = false) => {
    if (value === null || value === undefined || value === "") {
      return { isNull: true, value: null as number | string | null };
    }

    if (numeric) {
      const num = Number(value);
      return Number.isFinite(num)
        ? { isNull: false, value: num }
        : { isNull: true, value: null };
    }

    return { isNull: false, value: String(value).trim().toLowerCase() };
  };

  const getAgeSortValue = (startTime?: string | null) => {
    if (!startTime) return { isNull: true, value: null as number | null };
    const timestamp = Date.parse(startTime);
    if (Number.isNaN(timestamp)) return { isNull: true, value: null };
    const diff = Date.now() - timestamp;
    return { isNull: false, value: Math.max(0, Math.floor(diff / (1000 * 60 * 60 * 24))) };
  };

  const getSortValue = (rec: Recommendation, key: SortKey) => {
    switch (key) {
      case "title":
        return normalizeSortValue(rec.listing.title, false);
      case "type":
        return normalizeSortValue(labels[rec.type], false);
      case "currentPrice":
        return normalizeSortValue(rec.listing.currentPrice, true);
      case "suggestedPrice":
        return normalizeSortValue(rec.suggestedPrice, true);
      case "expectedProfitImpact":
        return normalizeSortValue(rec.expectedProfitImpact, true);
      case "confidence":
        return normalizeSortValue(rec.confidence, true);
      case "age":
        return getAgeSortValue(rec.listing.startTime);
      case "views":
        return normalizeSortValue(rec.listing.views, true);
      case "watchers":
        return normalizeSortValue(rec.listing.watchers, true);
      case "quantity":
        return normalizeSortValue(rec.listing.quantity, true);
      case "quantitySold":
        return normalizeSortValue(rec.listing.quantitySold, true);
    }
  };

  const sortedRecommendations = useMemo(() => {
    if (!sortKey) return recommendations;
    return [...recommendations].sort((a, b) => {
      const aValue = getSortValue(a, sortKey);
      const bValue = getSortValue(b, sortKey);

      if (aValue.isNull && bValue.isNull) return 0;
      if (aValue.isNull) return 1;
      if (bValue.isNull) return -1;

      if (aValue.value! < bValue.value!) {
        return sortDirection === "asc" ? -1 : 1;
      }
      if (aValue.value! > bValue.value!) {
        return sortDirection === "asc" ? 1 : -1;
      }
      return 0;
    });
  }, [recommendations, sortDirection, sortKey]);

  const filteredTrafficRows = useMemo(() => {
    const rows = trafficHealth?.rows ?? [];
    if (trafficFilter === "all") return rows;
    return rows.filter((row) => row.trafficState === trafficFilter);
  }, [trafficFilter, trafficHealth]);

  const sortedTrafficRows = useMemo(() => {
    const rows = [...filteredTrafficRows];
    rows.sort((a, b) => {
      const byPriority = (value: PriorityLevel) => {
        if (value === "critical") return 0;
        if (value === "high") return 1;
        if (value === "medium") return 2;
        return 3;
      };

      const byState = (value: TrafficState) => {
        if (value === "interested-not-converting") return 0;
        if (value === "no-traffic") return 1;
        if (value === "strong-demand-potentially-underpriced") return 2;
        if (value === "low-traffic") return 3;
        if (value === "traffic-no-interest") return 4;
        if (value === "converting") return 5;
        return 6;
      };

      const getValue = (row: TrafficHealthRow) => {
        switch (trafficSortKey) {
          case "title":
            return row.title.toLowerCase();
          case "price":
            return row.currentPrice;
          case "age":
            return row.listingAgeDays;
          case "views":
            return row.views;
          case "viewsPer30":
            return row.viewsPer30;
          case "watchers":
            return row.watchers;
          case "watcherRate":
            return row.watcherRate;
          case "quantitySold":
            return row.quantitySold;
          case "conversion":
            return row.lifetimeConversionProxy;
          case "state":
            return byState(row.trafficState);
          case "priority":
            return byPriority(row.priority);
          case "compConfidence":
            return row.compSummary?.confidenceScore ?? -1;
        }
      };

      const aValue = getValue(a);
      const bValue = getValue(b);

      if (aValue < bValue) return trafficSortDirection === "asc" ? -1 : 1;
      if (aValue > bValue) return trafficSortDirection === "asc" ? 1 : -1;
      return 0;
    });
    return rows;
  }, [filteredTrafficRows, trafficSortDirection, trafficSortKey]);

  function requestSort(key: SortKey) {
    if (sortKey === key) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }

    setSortKey(key);
    setSortDirection("asc");
  }

  function requestTrafficSort(key: TrafficSortKey) {
    if (trafficSortKey === key) {
      setTrafficSortDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }

    setTrafficSortKey(key);
    setTrafficSortDirection("asc");
  }

  const sortIndicator = (key: SortKey) => {
    if (sortKey !== key) return "";
    return sortDirection === "asc" ? " ↑" : " ↓";
  };

  async function loadQueue() {
    setLoading(true);
    setMessage(null);
    try {
      const response = await fetch("/api/queue");
      if (!response.ok) {
        throw new Error(`Queue fetch failed (${response.status})`);
      }
      const data = (await response.json()) as QueueResponse;
      setQueue(data);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  async function loadTrafficHealth() {
    setLoadingTraffic(true);
    try {
      const response = await fetch("/api/traffic-health?maxRows=1200");
      if (!response.ok) {
        throw new Error(`Traffic health fetch failed (${response.status})`);
      }
      const data = (await response.json()) as TrafficHealthResponse;
      setTrafficHealth(data);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingTraffic(false);
    }
  }

  useEffect(() => {
    loadQueue();
    loadTrafficHealth();
  }, []);

  async function handleGenerate() {
    setSubmitting(true);
    setMessage(null);
    try {
      const response = await fetch("/api/recommendations/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!response.ok) {
        throw new Error(`Generate failed (${response.status})`);
      }
      const result = await response.json();
      setMessage(`Generated ${result.generated} recommendation(s).`);
      await loadQueue();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAction(id: string, action: "dismiss" | "apply") {
    setActiveAction(id);
    setMessage(null);
    try {
      const response = await fetch(`/api/queue/${id}/${action}`, {
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(`${action} failed (${response.status})`);
      }
      await loadQueue();
      setMessage(action === "dismiss" ? "Recommendation dismissed." : "Recommendation marked complete.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setActiveAction(null);
    }
  }

  const totalCount = queue?.actionableTotal ?? 0;

  const renderCurrentRecommended = (rec: Recommendation) => {
    const currentPrice = formatMoney(rec.listing.currentPrice);
    const recommendedPrice = formatRecommendationMoney(rec.suggestedPrice);

    if (rec.type === "raise-price" || rec.type === "lower-price") {
      return (
        <div style={{ display: "grid", gap: 2, marginBottom: 6, fontSize: 13, color: "#444" }}>
          <div>
            <strong>Current:</strong> {currentPrice}
          </div>
          <div>
            <strong>Recommended:</strong> {recommendedPrice}
          </div>
        </div>
      );
    }

    if (rec.type === "hold") {
      return (
        <div style={{ display: "grid", gap: 2, marginBottom: 6, fontSize: 13, color: "#444" }}>
          <div>
            <strong>Current:</strong> {currentPrice}
          </div>
          <div>
            <strong>Recommended:</strong> Keep price
          </div>
        </div>
      );
    }

    if (rec.type === "insufficient-data") {
      return (
        <div style={{ display: "grid", gap: 2, marginBottom: 6, fontSize: 13, color: "#444" }}>
          <div>
            <strong>Current:</strong> {currentPrice}
          </div>
          <div>
            <strong>Recommended:</strong> Wait for more data
          </div>
        </div>
      );
    }

    return null;
  };

  return (
    <section className="recommendations-layout" style={{ width: "100%", maxWidth: "100%", margin: "0 auto", padding: "24px 0" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24, gap: 24, flexWrap: "wrap" }}>
        <div>
          <h1>Recommendations</h1>
          <p style={{ margin: 0, color: "#555" }}>
            Generate recommendations from your active listings and manage the daily action queue.
          </p>
        </div>
        <button className="btn-primary"
          type="button"
          onClick={handleGenerate}
          disabled={submitting}
          style={{ padding: "10px 18px", fontSize: 16, cursor: submitting ? "not-allowed" : "pointer" }}
        >
          {submitting ? "Generating…" : "Generate Recommendations"}
        </button>
      </header>

      <section className="panel traffic-health-section" style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 22 }}>Traffic Health</h2>
            <div style={{ color: "#555", marginTop: 4 }}>
              Mature listing health excludes New / Learning inventory from denominator.
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              type="button"
              onClick={() => setShowTrafficDetails((current) => !current)}
              style={{ padding: "8px 12px", border: "1px solid #ccc", borderRadius: 8, background: "#fff", cursor: "pointer" }}
            >
              {showTrafficDetails ? "Hide Details" : "View Traffic Health Details"}
            </button>
            <button
              type="button"
              onClick={loadTrafficHealth}
              disabled={loadingTraffic}
              style={{ padding: "8px 12px", border: "1px solid #ccc", borderRadius: 8, background: "#fff", cursor: loadingTraffic ? "not-allowed" : "pointer" }}
            >
              {loadingTraffic ? "Refreshing..." : "Refresh Traffic Health"}
            </button>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10, marginTop: 14 }}>
          <TrafficStatCard
            label="Traffic Health %"
            value={trafficHealth ? `${trafficHealth.summary.trafficHealthPct.toFixed(2)}%` : "..."}
            sub={trafficHealth ? `${trafficHealth.summary.healthyMatureCount} / ${trafficHealth.summary.matureListingsCount} mature listings` : ""}
          />
          <TrafficStatCard label="No Traffic" value={String(trafficHealth?.summary.counts["no-traffic"] ?? "...")} />
          <TrafficStatCard label="Low Traffic" value={String(trafficHealth?.summary.counts["low-traffic"] ?? "...")} />
          <TrafficStatCard label="Traffic / No Interest" value={String(trafficHealth?.summary.counts["traffic-no-interest"] ?? "...")} />
          <TrafficStatCard label="Interested / Not Converting" value={String(trafficHealth?.summary.counts["interested-not-converting"] ?? "...")} />
          <TrafficStatCard label="Converting" value={String(trafficHealth?.summary.counts["converting"] ?? "...")} />
          <TrafficStatCard label="Strong Demand / Potentially Underpriced" value={String(trafficHealth?.summary.counts["strong-demand-potentially-underpriced"] ?? "...")} />
          <TrafficStatCard label="New / Learning" value={String(trafficHealth?.summary.counts["new-learning"] ?? "...")} />
        </div>

        {trafficHealth && (
          <div style={{ marginTop: 10, color: "#666", fontSize: 12 }}>
            Telemetry: dbReads {trafficHealth.telemetry.dbReads} | dbWrites {trafficHealth.telemetry.dbWrites} | listings {trafficHealth.telemetry.listingsEvaluated} | snapshotRows {trafficHealth.telemetry.snapshotRowsUsed} | cache {trafficHealth.telemetry.cacheStatus}
          </div>
        )}

        {showTrafficDetails && (
          <div style={{ marginTop: 14 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
              {(["all", "interested-not-converting", "no-traffic", "low-traffic", "traffic-no-interest", "strong-demand-potentially-underpriced", "converting", "new-learning"] as const).map((state) => (
                <button
                  key={state}
                  type="button"
                  onClick={() => setTrafficFilter(state)}
                  style={{
                    padding: "7px 10px",
                    borderRadius: 8,
                    border: trafficFilter === state ? "2px solid #111" : "1px solid #ccc",
                    background: trafficFilter === state ? "#111" : "#fff",
                    color: trafficFilter === state ? "#fff" : "#111",
                    cursor: "pointer",
                  }}
                >
                  {state === "all" ? "All" : stateLabels[state]}
                </button>
              ))}
            </div>

            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1700 }}>
                <thead>
                  <tr style={{ textAlign: "left", borderBottom: "2px solid #ccc" }}>
                    <TrafficSortHeader
                      label="Listing"
                      width={360}
                      sortKey="title"
                      current={trafficSortKey}
                      direction={trafficSortDirection}
                      hovered={trafficHoveredSortKey}
                      onHover={setTrafficHoveredSortKey}
                      onSort={requestTrafficSort}
                    />
                    <TrafficSortHeader label="Price" width={90} sortKey="price" current={trafficSortKey} direction={trafficSortDirection} hovered={trafficHoveredSortKey} onHover={setTrafficHoveredSortKey} onSort={requestTrafficSort} />
                    <TrafficSortHeader label="Age" width={70} sortKey="age" current={trafficSortKey} direction={trafficSortDirection} hovered={trafficHoveredSortKey} onHover={setTrafficHoveredSortKey} onSort={requestTrafficSort} />
                    <TrafficSortHeader label="Views" width={70} sortKey="views" current={trafficSortKey} direction={trafficSortDirection} hovered={trafficHoveredSortKey} onHover={setTrafficHoveredSortKey} onSort={requestTrafficSort} />
                    <TrafficSortHeader label="Views / 30d" width={90} sortKey="viewsPer30" current={trafficSortKey} direction={trafficSortDirection} hovered={trafficHoveredSortKey} onHover={setTrafficHoveredSortKey} onSort={requestTrafficSort} />
                    <TrafficSortHeader label="Watchers" width={80} sortKey="watchers" current={trafficSortKey} direction={trafficSortDirection} hovered={trafficHoveredSortKey} onHover={setTrafficHoveredSortKey} onSort={requestTrafficSort} />
                    <TrafficSortHeader label="Watcher Rate" width={95} sortKey="watcherRate" current={trafficSortKey} direction={trafficSortDirection} hovered={trafficHoveredSortKey} onHover={setTrafficHoveredSortKey} onSort={requestTrafficSort} />
                    <TrafficSortHeader label="Qty Sold" width={80} sortKey="quantitySold" current={trafficSortKey} direction={trafficSortDirection} hovered={trafficHoveredSortKey} onHover={setTrafficHoveredSortKey} onSort={requestTrafficSort} />
                    <TrafficSortHeader label="Conversion Proxy" width={120} sortKey="conversion" current={trafficSortKey} direction={trafficSortDirection} hovered={trafficHoveredSortKey} onHover={setTrafficHoveredSortKey} onSort={requestTrafficSort} />
                    <TrafficSortHeader label="State" width={200} sortKey="state" current={trafficSortKey} direction={trafficSortDirection} hovered={trafficHoveredSortKey} onHover={setTrafficHoveredSortKey} onSort={requestTrafficSort} />
                    <TrafficSortHeader label="Priority" width={85} sortKey="priority" current={trafficSortKey} direction={trafficSortDirection} hovered={trafficHoveredSortKey} onHover={setTrafficHoveredSortKey} onSort={requestTrafficSort} />
                    <TrafficSortHeader label="Comp Confidence" width={120} sortKey="compConfidence" current={trafficSortKey} direction={trafficSortDirection} hovered={trafficHoveredSortKey} onHover={setTrafficHoveredSortKey} onSort={requestTrafficSort} />
                    <th style={{ padding: "10px 8px", width: 270, textAlign: "left" }}>Comp Recommendation</th>
                    <th style={{ padding: "10px 8px", width: 320, textAlign: "left" }}>Diagnostic</th>
                    <th style={{ padding: "10px 8px", width: 160, textAlign: "center" }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedTrafficRows.length === 0 ? (
                    <tr>
                      <td colSpan={15} style={{ padding: 14 }}>
                        No traffic health rows in this filter.
                      </td>
                    </tr>
                  ) : (
                    sortedTrafficRows.map((row) => (
                      <tr key={row.listingId} style={{ borderBottom: "1px solid #eee" }}>
                        <td style={{ padding: "8px 8px", maxWidth: 360, whiteSpace: "normal", overflowWrap: "break-word" }}>{row.title}</td>
                        <td style={{ padding: "8px 8px", textAlign: "center" }}>{formatMoney(row.currentPrice)}</td>
                        <td style={{ padding: "8px 8px", textAlign: "center" }}>{row.listingAgeDays}</td>
                        <td style={{ padding: "8px 8px", textAlign: "center" }}>{row.views}</td>
                        <td style={{ padding: "8px 8px", textAlign: "center" }}>{row.viewsPer30.toFixed(2)}</td>
                        <td style={{ padding: "8px 8px", textAlign: "center" }}>{row.watchers}</td>
                        <td style={{ padding: "8px 8px", textAlign: "center" }}>{(row.watcherRate * 100).toFixed(2)}%</td>
                        <td style={{ padding: "8px 8px", textAlign: "center" }}>{row.quantitySold}</td>
                        <td style={{ padding: "8px 8px", textAlign: "center" }}>{(row.lifetimeConversionProxy * 100).toFixed(2)}%</td>
                        <td style={{ padding: "8px 8px" }}>{stateLabels[row.trafficState]}</td>
                        <td style={{ padding: "8px 8px", textAlign: "center" }}>{priorityLabels[row.priority]}</td>
                        <td style={{ padding: "8px 8px", textAlign: "center" }}>{row.compSummary ? `${row.compSummary.confidenceScore} (${row.compSummary.confidenceBand})` : "—"}</td>
                        <td style={{ padding: "8px 8px" }}>{row.compSummary ? row.compSummary.recommendationType : "No cached comp summary"}</td>
                        <td className="compact-prose-cell" style={{ padding: "8px 8px" }}><TableDetail summary={reasonSummary(row.reason)}><p>{row.reason}</p>{row.compSummary&&<p><strong>Comp evidence:</strong> {row.compSummary.acceptedCompCount} accepted, {row.compSummary.excludedCompCount} excluded · {row.compSummary.confidenceScore} ({row.compSummary.confidenceBand}).</p>}<a href={`/comp-validation?listingId=${row.listingId}`}>View evidence</a></TableDetail></td>
                        <td style={{ padding: "8px 8px", textAlign: "center" }}>
                          {(row.trafficState === "interested-not-converting" || row.trafficState === "strong-demand-potentially-underpriced") ? (
                            <a
                              href={`/comp-validation?listingId=${row.listingId}`}
                              style={{
                                display: "inline-block",
                                padding: "6px 10px",
                                border: "1px solid #aaa",
                                borderRadius: 6,
                                color: "#111",
                                textDecoration: "none",
                              }}
                            >
                              Review Comps
                            </a>
                          ) : (
                            <span style={{ color: "#666" }}>—</span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      {queue&&<section className="panel" style={{marginBottom:20}}><div className="eyebrow">Pricing coverage</div><h2 style={{margin:"5px 0"}}>{queue.pricingCoverage.supportedListings} / {queue.pricingCoverage.activeListings.toLocaleString()} supported <span className="badge badge-info">{queue.pricingCoverage.supportedPct.toFixed(2)}%</span></h2><p>Live sold evidence is intentionally strict. Unanalyzed inventory is different from inventory that was analyzed and lacked enough trustworthy comps.</p><div className="metric-grid"><div className="metric"><div className="metric-label">Supported</div><div className="metric-value" style={{color:"var(--success)"}}>{queue.pricingCoverage.supportedListings}</div><div className="metric-detail">Actionable at Moderate confidence or better</div></div><div className="metric"><div className="metric-label">Insufficient evidence</div><div className="metric-value" style={{color:"var(--warning)"}}>{queue.pricingCoverage.insufficientListings}</div><div className="metric-detail">Analyzed; trustworthy sold comps were insufficient</div></div><div className="metric"><div className="metric-label">Not yet analyzed</div><div className="metric-value">{queue.pricingCoverage.notAnalyzedListings.toLocaleString()}</div><div className="metric-detail">No current pricing conclusion</div></div></div></section>}

      <div className="metric-grid" style={{ marginBottom: 24, textAlign: "center" }}>
        <div style={{ padding: 16, border: "1px solid #ddd", borderRadius: 10, minWidth: 160, width: "100%" }}>
          <strong>Total Pending</strong>
          <div style={{ fontSize: 24, marginTop: 8 }}>{loading ? "..." : totalCount}</div>
        </div>
        <div style={{ padding: 16, border: "1px solid #ddd", borderRadius: 10, minWidth: 160, width: "100%" }}>
          <strong>Raise Price</strong>
          <div style={{ fontSize: 24, marginTop: 8 }}>{queue ? queue.raise.length : "..."}</div>
        </div>
        <div style={{ padding: 16, border: "1px solid #ddd", borderRadius: 10, minWidth: 160, width: "100%" }}>
          <strong>Lower Price</strong>
          <div style={{ fontSize: 24, marginTop: 8 }}>{queue ? queue.lower.length : "..."}</div>
        </div>
        <div style={{ padding: 16, border: "1px solid #ddd", borderRadius: 10, minWidth: 160, width: "100%" }}>
          <strong>Pricing Evidence Unavailable</strong>
          <div style={{ fontSize: 24, marginTop: 8 }}>{queue ? queue.pricingEvidenceUnavailable.total : "..."}</div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap", justifyContent: "center" }}>
        {(["all", "raise-price", "lower-price"] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setFilter(value)}
            style={{
              padding: "10px 16px",
              borderRadius: 8,
              border: filter === value ? "2px solid #111" : "1px solid #ccc",
              background: filter === value ? "#111" : "#fff",
              color: filter === value ? "#fff" : "#111",
              cursor: "pointer",
            }}
          >
            {labels[value]}
          </button>
        ))}
      </div>

      {queue && queue.pricingEvidenceUnavailable.total > 0 && (
        <section className="card-warning" style={{ marginBottom: 24 }}>
          <span className="badge badge-warning">Review</span><h2 style={{ margin: "8px 0 0" }}>{queue.pricingEvidenceUnavailable.total} listings · Pricing evidence unavailable</h2>
          <p>
            Pricing analysis was attempted for {queue.pricingEvidenceUnavailable.total} listing{queue.pricingEvidenceUnavailable.total === 1 ? "" : "s"}, but no actionable price is shown because trustworthy comp evidence is insufficient.
          </p>
          <details>
            <summary>View representative listings</summary>
            <ul>
              {queue.pricingEvidenceUnavailable.items.map((rec) => (
                <li key={rec.id} style={{ marginTop: 8 }}>
                  <strong>{rec.listing.title}</strong> — {rec.reason}
                </li>
              ))}
            </ul>
          </details>
        </section>
      )}

      {message && (
        <div style={{ marginBottom: 20, color: "#1a5", background: "#f4ffef", padding: 12, borderRadius: 8 }}>
          {message}
        </div>
      )}

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1400, tableLayout: "auto" }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "2px solid #ccc" }}>
              <th style={{ padding: "10px 8px", width: 48, textAlign: "center" }}>#</th>
              {renderSortHeader("title", "Listing", 440, "left", true)}
              {renderSortHeader("type", "Action", 110, "center")}
              {renderSortHeader("currentPrice", "Current Price", 100, "center")}
              {renderSortHeader("suggestedPrice", "Suggested Price", 100, "center")}
              {renderSortHeader("expectedProfitImpact", "Impact", 90, "center")}
              {renderSortHeader("confidence", "Confidence", 80, "center")}
              {renderSortHeader("age", "Age", 70, "center")}
              {renderSortHeader("views", "Views", 70, "center")}
              {renderSortHeader("watchers", "Watchers", 70, "center")}
              {renderSortHeader("quantity", "Qty Available", 80, "center")}
              {renderSortHeader("quantitySold", "Qty Sold", 80, "center")}
              <th style={{ padding: "10px 8px", width: 320, textAlign: "left" }}>Reason</th>
              <th style={{ padding: "10px 8px", width: 150, textAlign: "center" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={14} style={{ padding: 16 }}>
                  Loading recommendations…
                </td>
              </tr>
            ) : sortedRecommendations.length === 0 ? (
              <tr>
                <td colSpan={14} style={{ padding: 16 }}>
                  No supported pricing actions are pending. Listings without trustworthy evidence are reported separately above.
                </td>
              </tr>
            ) : (
              sortedRecommendations.map((rec, index) => (
                <tr key={rec.id} style={{ borderBottom: "1px solid #eee" }}>
                  <td style={{ padding: "8px 6px", width: 48, textAlign: "center" }}>{index + 1}</td>
                  <td style={{ padding: "8px 10px", minWidth: 440, maxWidth: 560, overflowWrap: "break-word", whiteSpace: "normal", textAlign: "left" }}>
                    {rec.listing.title}
                    {renderCurrentRecommended(rec)}
                  </td>
                  <td style={{ padding: "8px 6px", width: 110, textAlign: "center" }}><span className={`badge ${rec.type==="raise-price"?"badge-success":"badge-danger"}`}>{labels[rec.type]}</span></td>
                  <td style={{ padding: "8px 6px", width: 100, textAlign: "center" }}>{formatMoney(rec.listing.currentPrice)}</td>
                  <td style={{ padding: "8px 6px", width: 100, textAlign: "center" }}>{formatRecommendationMoney(rec.suggestedPrice)}</td>
                  <td style={{ padding: "8px 6px", width: 90, textAlign: "center" }}>{formatMoney(rec.expectedProfitImpact)}</td>
                  <td style={{ padding: "8px 6px", width: 80, textAlign: "center" }}>{rec.confidence ? <><div className="confidence-value">{rec.confidence}</div><span className={`badge ${rec.confidence>=75?"badge-success":rec.confidence>=60?"badge-warning":"badge-neutral"}`}>{rec.confidence>=90?"Very High":rec.confidence>=75?"High":rec.confidence>=60?"Moderate":"Insufficient"}</span></> : "—"}</td>
                  <td style={{ padding: "8px 6px", width: 70, textAlign: "center" }}>{ageDays(rec.listing.startTime)}</td>
                  <td style={{ padding: "8px 6px", width: 70, textAlign: "center" }}>{rec.listing.views ?? "—"}</td>
                  <td style={{ padding: "8px 6px", width: 70, textAlign: "center" }}>{rec.listing.watchers ?? "—"}</td>
                  <td style={{ padding: "8px 6px", width: 75, textAlign: "center" }}>{rec.listing.quantity ?? "—"}</td>
                  <td style={{ padding: "8px 6px", width: 75, textAlign: "center" }}>{rec.listing.quantitySold ?? "—"}</td>
                  <td className="compact-prose-cell" style={{ padding: "8px 10px", textAlign: "left" }}><TableDetail summary={reasonSummary(rec.reason)}><p>{rec.reason}</p><a href={`/comp-validation?listingId=${rec.listing.id}`}>View evidence</a></TableDetail></td>
                  <td style={{ padding: "8px 10px", width: 150, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, justifyContent: "center" }}>
                    <a href={`/comp-validation?listingId=${rec.listing.id}`} style={{ gridColumn: "1 / -1", textAlign: "center", fontSize: 12 }}>Explain My Comp</a>
                    <button
                      type="button"
                      onClick={() => handleAction(rec.id, "dismiss")}
                      disabled={activeAction === rec.id}
                      style={{ padding: "6px 10px", cursor: "pointer", width: "100%" }}
                    >
                      Dismiss
                    </button>
                    <button
                      type="button"
                      onClick={() => handleAction(rec.id, "apply")}
                      disabled={activeAction === rec.id}
                      style={{ padding: "6px 10px", cursor: "pointer", width: "100%" }}
                    >
                      Mark Completed
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TrafficStatCard(props: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ padding: 12, border: "1px solid #ddd", borderRadius: 10, background: "#fff" }}>
      <div style={{ fontSize: 12, color: "#555" }}>{props.label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>{props.value}</div>
      {props.sub && <div style={{ marginTop: 3, fontSize: 11, color: "#666" }}>{props.sub}</div>}
    </div>
  );
}

function TrafficSortHeader(props: {
  label: string;
  width: number;
  sortKey: TrafficSortKey;
  current: TrafficSortKey;
  direction: "asc" | "desc";
  hovered: TrafficSortKey | null;
  onHover: (value: TrafficSortKey | null) => void;
  onSort: (value: TrafficSortKey) => void;
}) {
  return (
    <th style={{ padding: "10px 8px", width: props.width, textAlign: "center" }}>
      <button
        type="button"
        onClick={() => props.onSort(props.sortKey)}
        onMouseEnter={() => props.onHover(props.sortKey)}
        onMouseLeave={() => props.onHover(null)}
        style={{
          background: props.hovered === props.sortKey ? "#f7f7f7" : "transparent",
          border: "none",
          padding: 0,
          font: "inherit",
          cursor: "pointer",
          color: "inherit",
          width: "100%",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          transition: "background-color 0.15s ease, color 0.15s ease",
          gap: 4,
          whiteSpace: "nowrap",
        }}
      >
        <span>{props.label}</span>
        <span>{props.current === props.sortKey ? (props.direction === "asc" ? "▲" : "▼") : "↕"}</span>
      </button>
    </th>
  );
}
