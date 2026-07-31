"use client";

import { useState } from "react";

export default function SyncButton({ storeId }: { storeId: string }) {
  const [status, setStatus] = useState<string | null>(null);

  async function sync() {
    setStatus("Syncing…");
    try {
      const res = await fetch(`/api/stores/${storeId}/sync`, { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setStatus(`Imported ${data.imported} listings`);
      } else {
        setStatus(`Error: ${data.error ?? "Unknown error"}`);
      }
    } catch (err: unknown) {
      setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return (
    <span>
      <button
        onClick={sync}
        style={{
          padding: "6px 12px",
          background: "#28a745",
          color: "#fff",
          border: "none",
          borderRadius: 4,
          cursor: "pointer",
        }}
      >
        Sync Now
      </button>
      {status && <span style={{ marginLeft: 8, fontSize: 14 }}>{status}</span>}
    </span>
  );
}
