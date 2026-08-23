"use client";

import { useState } from "react";

export default function SyncButton({ storeId, kind = "listings", disabled = false }: { storeId: string; kind?: "listings" | "orders"; disabled?: boolean }) {
  const [status, setStatus] = useState<string | null>(null);

  async function pollJob(jobId: string) {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const response = await fetch(`/api/jobs/${jobId}`, { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json();
      const job = data.job as { status: string; progress: number };
      setStatus(`${job.status}${job.progress ? ` (${job.progress})` : ""}`);
      if (job.status === "completed" || job.status === "failed") return;
    }
  }

  async function sync() {
    setStatus("Queueing...");
    try {
      const endpoint = kind === "orders" ? `/api/stores/${storeId}/orders/sync` : `/api/stores/${storeId}/sync`;
      const response = await fetch(endpoint, { method: "POST" });
      const data = await response.json();
      if (!response.ok) { setStatus(`Error: ${data.error ?? "Unknown error"}`); return; }
      setStatus(data.queued ? "Queued" : `Already ${data.status}`);
      if (data.jobId) void pollJob(data.jobId);
    } catch (error) {
      setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return (
    <span>
      <button onClick={sync} disabled={disabled} style={{ padding: "6px 12px", background: "#28a745", color: "#fff", border: "none", borderRadius: 4, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.55 : 1 }}>
        {kind === "orders" ? "Sync Orders" : "Sync Listings"}
      </button>
      {status && <span style={{ marginLeft: 6, fontSize: 12 }}>{status}</span>}
    </span>
  );
}
