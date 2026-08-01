"use client";

import { useEffect, useMemo, useState } from "react";

type RecommendationType = "raise-price" | "lower-price" | "hold" | "insufficient-data";

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
  raise: Recommendation[];
  lower: Recommendation[];
  hold: Recommendation[];
  insufficient: Recommendation[];
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

export default function RecommendationDashboard() {
  const [queue, setQueue] = useState<QueueResponse | null>(null);
  const [filter, setFilter] = useState<"all" | RecommendationType>("all");
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [activeAction, setActiveAction] = useState<string | null>(null);

  const recommendations = useMemo(() => {
    if (!queue) return [] as Recommendation[];
    const all = [...queue.raise, ...queue.lower, ...queue.hold, ...queue.insufficient];
    if (filter === "all") return all;
    return all.filter((rec) => rec.type === filter);
  }, [filter, queue]);

  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [hoveredSortKey, setHoveredSortKey] = useState<SortKey | null>(null);

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

  function requestSort(key: SortKey) {
    if (sortKey === key) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }

    setSortKey(key);
    setSortDirection("asc");
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

  useEffect(() => {
    loadQueue();
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

  const totalCount = queue ? queue.raise.length + queue.lower.length + queue.hold.length + queue.insufficient.length : 0;

  return (
    <section style={{ width: "100%", maxWidth: "100%", margin: "0 auto", padding: "24px 0" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24, gap: 24, flexWrap: "wrap" }}>
        <div>
          <h1>Recommendations</h1>
          <p style={{ margin: 0, color: "#555" }}>
            Generate recommendations from your active listings and manage the daily action queue.
          </p>
        </div>
        <button
          type="button"
          onClick={handleGenerate}
          disabled={submitting}
          style={{ padding: "10px 18px", fontSize: 16, cursor: submitting ? "not-allowed" : "pointer" }}
        >
          {submitting ? "Generating…" : "Generate Recommendations"}
        </button>
      </header>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16, marginBottom: 24, justifyItems: "center", textAlign: "center" }}>
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
          <strong>Hold</strong>
          <div style={{ fontSize: 24, marginTop: 8 }}>{queue ? queue.hold.length : "..."}</div>
        </div>
        <div style={{ padding: 16, border: "1px solid #ddd", borderRadius: 10, minWidth: 160, width: "100%" }}>
          <strong>Insufficient</strong>
          <div style={{ fontSize: 24, marginTop: 8 }}>{queue ? queue.insufficient.length : "..."}</div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap", justifyContent: "center" }}>
        {(["all", "raise-price", "lower-price", "hold", "insufficient-data"] as const).map((value) => (
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

      {message && (
        <div style={{ marginBottom: 20, color: "#1a5", background: "#f4ffef", padding: 12, borderRadius: 8 }}>
          {message}
        </div>
      )}

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1320, tableLayout: "fixed" }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "2px solid #ccc" }}>
              <th style={{ padding: "10px 8px", width: 48, textAlign: "center" }}>#</th>
              {renderSortHeader("title", "Listing", 360, "left", true)}
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
              <th style={{ padding: "10px 8px", width: 460, textAlign: "left" }}>Reason</th>
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
                  No pending recommendations. Run generation to create a new action queue.
                </td>
              </tr>
            ) : (
              sortedRecommendations.map((rec, index) => (
                <tr key={rec.id} style={{ borderBottom: "1px solid #eee" }}>
                  <td style={{ padding: "8px 6px", width: 48, textAlign: "center" }}>{index + 1}</td>
                  <td style={{ padding: "8px 10px", width: 360, overflowWrap: "anywhere", textAlign: "left" }}>{rec.listing.title}</td>
                  <td style={{ padding: "8px 6px", width: 110, textAlign: "center" }}>{labels[rec.type]}</td>
                  <td style={{ padding: "8px 6px", width: 100, textAlign: "center" }}>{formatMoney(rec.listing.currentPrice)}</td>
                  <td style={{ padding: "8px 6px", width: 100, textAlign: "center" }}>{formatMoney(rec.suggestedPrice)}</td>
                  <td style={{ padding: "8px 6px", width: 90, textAlign: "center" }}>{formatMoney(rec.expectedProfitImpact)}</td>
                  <td style={{ padding: "8px 6px", width: 80, textAlign: "center" }}>{rec.confidence ? `${rec.confidence}%` : "—"}</td>
                  <td style={{ padding: "8px 6px", width: 70, textAlign: "center" }}>{ageDays(rec.listing.startTime)}</td>
                  <td style={{ padding: "8px 6px", width: 70, textAlign: "center" }}>{rec.listing.views ?? "—"}</td>
                  <td style={{ padding: "8px 6px", width: 70, textAlign: "center" }}>{rec.listing.watchers ?? "—"}</td>
                  <td style={{ padding: "8px 6px", width: 75, textAlign: "center" }}>{rec.listing.quantity ?? "—"}</td>
                  <td style={{ padding: "8px 6px", width: 75, textAlign: "center" }}>{rec.listing.quantitySold ?? "—"}</td>
                  <td style={{ padding: "8px 10px", width: 460, overflowWrap: "anywhere", textAlign: "left" }}>{rec.reason}</td>
                  <td style={{ padding: "8px 10px", width: 150, display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
                    <button
                      type="button"
                      onClick={() => handleAction(rec.id, "dismiss")}
                      disabled={activeAction === rec.id}
                      style={{ padding: "8px 12px", cursor: "pointer" }}
                    >
                      Dismiss
                    </button>
                    <button
                      type="button"
                      onClick={() => handleAction(rec.id, "apply")}
                      disabled={activeAction === rec.id}
                      style={{ padding: "8px 12px", cursor: "pointer" }}
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
