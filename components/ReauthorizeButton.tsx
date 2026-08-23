"use client";

import { useState } from "react";

export default function ReauthorizeButton({ storeId }: { storeId: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reauthorize() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/stores/${storeId}/reauthorize`, { method: "POST" });
      const data = await response.json();
      if (!response.ok || !data.oauthUrl) {
        setError(data.error ?? "Failed to start eBay reauthorization");
        return;
      }
      window.location.href = data.oauthUrl;
    } catch {
      setError("Failed to start eBay reauthorization");
    } finally {
      setLoading(false);
    }
  }

  return (
    <span>
      <button
        onClick={reauthorize}
        disabled={loading}
        style={{ padding: "6px 12px", background: "#0064d2", color: "#fff", border: "none", borderRadius: 4, cursor: loading ? "not-allowed" : "pointer" }}
      >
        {loading ? "Opening eBay..." : "Reauthorize eBay access"}
      </button>
      {error && <span style={{ marginLeft: 6, color: "#b00020", fontSize: 12 }}>{error}</span>}
    </span>
  );
}
