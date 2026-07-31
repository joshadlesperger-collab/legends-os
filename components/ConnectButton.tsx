"use client";

import { useState } from "react";

export default function ConnectButton() {
  const [loading, setLoading] = useState(false);

  async function connect() {
    setLoading(true);
    try {
      const res = await fetch("/api/stores", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (data.oauthUrl) {
        window.location.href = data.oauthUrl;
      } else {
        alert(data.error ?? "Failed to start eBay connection");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={connect}
      disabled={loading}
      style={{
        padding: "10px 20px",
        background: "#0064d2",
        color: "#fff",
        border: "none",
        borderRadius: 6,
        cursor: loading ? "not-allowed" : "pointer",
      }}
    >
      {loading ? "Connecting…" : "Connect eBay Store"}
    </button>
  );
}
