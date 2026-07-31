import { prisma } from "@/lib/prisma";
import SyncButton from "@/components/SyncButton";
import ConnectButton from "@/components/ConnectButton";

export const dynamic = "force-dynamic";

export default async function StoresPage() {
  const stores = await prisma.store.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      _count: {
        select: { listings: true },
      },
    },
  });

  return (
    <main style={{ maxWidth: 1000, margin: "0 auto", padding: 24 }}>
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
            <th>Listings</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {stores.map((store) => (
            <tr key={store.id} style={{ borderBottom: "1px solid #eee" }}>
              <td>{store.ebaySellerUsername ?? "Pending"}</td>
              <td>{store.ebaySellerUsername ?? "—"}</td>
              <td>{store.marketplace ?? "—"}</td>
              <td>{store.lastSyncAt ? new Date(store.lastSyncAt).toLocaleString() : "Never"}</td>
              <td>{store.connectionStatus}</td>
              <td>{store._count.listings}</td>
              <td>
                <SyncButton storeId={store.id} />
              </td>
            </tr>
          ))}
          {stores.length === 0 && (
            <tr>
              <td colSpan={7}>No stores connected.</td>
            </tr>
          )}
        </tbody>
      </table>
    </main>
  );
}
