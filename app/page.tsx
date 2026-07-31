import { prisma } from "@/lib/prisma";
import ConnectButton from "@/components/ConnectButton";

function daysSince(date: Date | null) {
  if (!date) return "—";
  const diff = Date.now() - new Date(date).getTime();
  return Math.max(0, Math.floor(diff / (1000 * 60 * 60 * 24))).toString();
}
async function QueueSummary() {
  const groups = await prisma.recommendation.groupBy({
    by: ["type"],
    where: { status: "pending" },
    _count: { type: true },
  });

  const counts: Record<string, number> = {};
  for (const g of groups) {
    counts[g.type] = g._count.type;
  }

  return (
    <div style={{ display: "flex", gap: 16, marginBottom: 24 }}>
      <div style={{ padding: 16, border: "1px solid #ddd", borderRadius: 8 }}>
        <strong>Lower</strong>
        <div>{counts["lower-price"] ?? 0}</div>
      </div>
      <div style={{ padding: 16, border: "1px solid #ddd", borderRadius: 8 }}>
        <strong>Relist</strong>
        <div>{counts["end-relist"] ?? 0}</div>
      </div>
      <div style={{ padding: 16, border: "1px solid #ddd", borderRadius: 8 }}>
        <strong>Leave Alone</strong>
        <div>{counts["leave-alone"] ?? 0}</div>
      </div>
    </div>
  );
}

async function ActionQueue() {
  const recommendations = await prisma.recommendation.findMany({
    where: { status: "pending" },
    include: { listing: true },
    orderBy: [{ expectedProfitImpact: "desc" }, { confidence: "desc" }],
    take: 20,
  });

  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead>
        <tr style={{ textAlign: "left", borderBottom: "2px solid #ccc" }}>
          <th>#</th>
          <th>Card</th>
          <th>Action</th>
          <th>Est. Impact</th>
          <th>Confidence</th>
        </tr>
      </thead>
      <tbody>
        {recommendations.map((rec, i) => (
          <tr key={rec.id} style={{ borderBottom: "1px solid #eee" }}>
            <td>{i + 1}</td>
            <td>{rec.listing?.title ?? "Unknown"}</td>
            <td>
              {rec.type === "lower-price" && rec.suggestedPrice !== null
                ? `Lower to $${Number(rec.suggestedPrice).toFixed(2)}`
                : rec.type === "end-relist"
                ? "End & Relist"
                : "Leave alone"}
            </td>
            <td>
              {rec.expectedProfitImpact !== null
                ? `+$${Number(rec.expectedProfitImpact).toFixed(2)}`
                : "—"}
            </td>
            <td>{rec.confidence ? `${rec.confidence}%` : "—"}</td>
          </tr>
        ))}
        {recommendations.length === 0 && (
          <tr>
            <td colSpan={5}>No recommendations yet. Connect a store and run a sync.</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

export default async function Home() {
  const [listings, stores] = await Promise.all([
    prisma.listing.findMany({
      orderBy: { lastSyncedAt: "desc" },
      take: 50,
      include: { store: { select: { ebaySellerUsername: true } } },
    }),
    prisma.store.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        ebaySellerUsername: true,
        marketplace: true,
        lastSyncAt: true,
        connectionStatus: true,
      },
    }),
  ]);

  return (
    <main style={{ maxWidth: 1000, margin: "0 auto", padding: 24 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <h1>Legends OS</h1>
        <ConnectButton />
      </header>

      <section style={{ marginBottom: 24 }}>
        <h2>Connected Stores ({stores.length})</h2>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "2px solid #ccc" }}>
              <th>Store</th>
              <th>Marketplace</th>
              <th>Last Sync</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {stores.map((s) => (
              <tr key={s.id} style={{ borderBottom: "1px solid #eee" }}>
                <td>{s.ebaySellerUsername ?? "—"}</td>
                <td>{s.marketplace ?? "—"}</td>
                <td>{s.lastSyncAt ? new Date(s.lastSyncAt).toLocaleString() : "Never"}</td>
                <td>{s.connectionStatus}</td>
              </tr>
            ))}
            {stores.length === 0 && (
              <tr>
                <td colSpan={4}>No stores connected.</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section>
        <h2>Recent Listings ({listings.length})</h2>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "2px solid #ccc" }}>
              <th>Title</th>
              <th>Store</th>
              <th>Price</th>
              <th>Qty</th>
              <th>Views</th>
              <th>Watchers</th>
              <th>Days</th>
            </tr>
          </thead>
          <tbody>
            {listings.map((l) => (
              <tr key={l.id} style={{ borderBottom: "1px solid #eee" }}>
                <td>{l.title}</td>
                <td>{l.store?.ebaySellerUsername ?? "—"}</td>
                <td>${Number(l.currentPrice).toFixed(2)}</td>
                <td>{l.quantity}</td>
                <td>{l.views}</td>
                <td>{l.watchers}</td>
                <td>{daysSince(l.startTime)}</td>
              </tr>
            ))}
            {listings.length === 0 && (
              <tr>
                <td colSpan={7}>No listings. Connect a store and run a sync.</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </main>
  );
}
