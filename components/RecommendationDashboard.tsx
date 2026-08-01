"use client";

import { useEffect, useMemo, useState } from "react";

type RecommendationType = "lower-price" | "end-relist" | "leave-alone";

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
  lower: Recommendation[];
  relist: Recommendation[];
  leave: Recommendation[];
};

const labels: Record<RecommendationType | "all", string> = {
  all: "All",
  "lower-price": "Lower Price",
  "end-relist": "End & Relist",
  "leave-alone": "Leave Alone",
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
    const all = [...queue.lower, ...queue.relist, ...queue.leave];
    if (filter === "all") return all;
    return all.filter((rec) => rec.type === filter);
  }, [filter, queue]);

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

  const totalCount = queue ? queue.lower.length + queue.relist.length + queue.leave.length : 0;

  return (
    <section style={{ maxWidth: 1200, margin: "0 auto", padding: 24 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
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

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 24 }}>
        <div style={{ padding: 16, border: "1px solid #ddd", borderRadius: 10, minWidth: 160 }}>
          <strong>Total Pending</strong>
          <div style={{ fontSize: 24, marginTop: 8 }}>{loading ? "..." : totalCount}</div>
        </div>
        <div style={{ padding: 16, border: "1px solid #ddd", borderRadius: 10, minWidth: 160 }}>
          <strong>Lower Price</strong>
          <div style={{ fontSize: 24, marginTop: 8 }}>{queue ? queue.lower.length : "..."}</div>
        </div>
        <div style={{ padding: 16, border: "1px solid #ddd", borderRadius: 10, minWidth: 160 }}>
          <strong>End & Relist</strong>
          <div style={{ fontSize: 24, marginTop: 8 }}>{queue ? queue.relist.length : "..."}</div>
        </div>
        <div style={{ padding: 16, border: "1px solid #ddd", borderRadius: 10, minWidth: 160 }}>
          <strong>Leave Alone</strong>
          <div style={{ fontSize: 24, marginTop: 8 }}>{queue ? queue.leave.length : "..."}</div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
        {(["all", "lower-price", "end-relist", "leave-alone"] as const).map((value) => (
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
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 900 }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "2px solid #ccc" }}>
              <th style={{ padding: 12 }}>#</th>
              <th style={{ padding: 12 }}>Listing</th>
              <th style={{ padding: 12 }}>Action</th>
              <th style={{ padding: 12 }}>Reason</th>
              <th style={{ padding: 12 }}>Suggested Price</th>
              <th style={{ padding: 12 }}>Impact</th>
              <th style={{ padding: 12 }}>Confidence</th>
              <th style={{ padding: 12 }}>Age</th>
              <th style={{ padding: 12 }}>Views</th>
              <th style={{ padding: 12 }}>Watchers</th>
              <th style={{ padding: 12 }}>Qty Sold</th>
              <th style={{ padding: 12 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={12} style={{ padding: 16 }}>
                  Loading recommendations…
                </td>
              </tr>
            ) : recommendations.length === 0 ? (
              <tr>
                <td colSpan={12} style={{ padding: 16 }}>
                  No pending recommendations. Run generation to create a new action queue.
                </td>
              </tr>
            ) : (
              recommendations.map((rec, index) => (
                <tr key={rec.id} style={{ borderBottom: "1px solid #eee" }}>
                  <td style={{ padding: 12 }}>{index + 1}</td>
                  <td style={{ padding: 12, maxWidth: 260 }}>{rec.listing.title}</td>
                  <td style={{ padding: 12 }}>{labels[rec.type]}</td>
                  <td style={{ padding: 12, maxWidth: 280 }}>{rec.reason}</td>
                  <td style={{ padding: 12 }}>{formatMoney(rec.suggestedPrice)}</td>
                  <td style={{ padding: 12 }}>{formatMoney(rec.expectedProfitImpact)}</td>
                  <td style={{ padding: 12 }}>{rec.confidence ? `${rec.confidence}%` : "—"}</td>
                  <td style={{ padding: 12 }}>{ageDays(rec.listing.startTime)}</td>
                  <td style={{ padding: 12 }}>{rec.listing.views}</td>
                  <td style={{ padding: 12 }}>{rec.listing.watchers}</td>
                  <td style={{ padding: 12 }}>{rec.listing.quantitySold}</td>
                  <td style={{ padding: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
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
