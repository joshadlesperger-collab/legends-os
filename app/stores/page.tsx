import { prisma } from "@/lib/prisma";
import SyncButton from "@/components/SyncButton";
import ConnectButton from "@/components/ConnectButton";
import ReauthorizeButton from "@/components/ReauthorizeButton";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function StoresPage() {
  const [stores, activeListingCounts] = await Promise.all([
    prisma.store.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        _count: {
          select: { listings: true, ebayOrders: true },
        },
        syncJobs: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    }),
    prisma.listing.groupBy({
      by: ["storeId"],
      where: { listingStatus: "active" },
      _count: { _all: true },
    }),
  ]);
  const activeByStore = new Map(activeListingCounts.map((row) => [row.storeId, row._count._all]));

  return (
    <main className="page" style={{ maxWidth: 1100 }}>
      <nav style={{ display: "flex", gap: 14, marginBottom: 12 }}><Link href="/sales">Sales &amp; Performance</Link><Link href="/inventory">Inventory</Link><Link href="/">Recommendations</Link></nav>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <h1>Connected eBay Stores</h1>
        <ConnectButton />
      </header>

      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "2px solid #ccc" }}>
            <th>Store Name</th>
            <th>eBay User ID</th>
            <th>Marketplace</th>
            <th>Last Sync</th>
            <th>Status</th>
            <th>Active Listings</th>
            <th>Orders</th>
            <th>Latest Job</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {stores.map((store) => {
            const activeListings = activeByStore.get(store.id) ?? 0;
            const historicalListings = Math.max(0, store._count.listings - activeListings);
            return <tr key={store.id} style={{ borderBottom: "1px solid #eee" }}>
              <td>{store.ebaySellerUsername ?? "Pending"}</td>
              <td>{store.ebaySellerUsername ?? "—"}</td>
              <td>{store.marketplace ?? "—"}</td>
              <td>{store.lastSyncAt ? new Date(store.lastSyncAt).toLocaleString() : "Never"}</td>
              <td>{store.connectionStatus}</td>
              <td>
                <strong>{activeListings.toLocaleString()}</strong>
                <small style={{ display: "block", color: "var(--muted)", marginTop: 4 }}>
                  {store._count.listings.toLocaleString()} total records · {historicalListings.toLocaleString()} historical
                </small>
              </td>
              <td>{store._count.ebayOrders}</td>
              <td>{store.syncJobs[0]?.status ?? "None"}</td>
              <td>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <SyncButton storeId={store.id} />
                  <SyncButton storeId={store.id} kind="orders" disabled={store.orderAccessStatus !== "ready"} />
                  {store.connectionStatus === "connected" && (
                    <ReauthorizeButton storeId={store.id} />
                  )}
                </div>
              </td>
            </tr>;
          })}
          {stores.length === 0 && (
            <tr>
              <td colSpan={10}>No stores connected.</td>
            </tr>
          )}
        </tbody>
      </table>
    </main>
  );
}
