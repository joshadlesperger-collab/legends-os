import { prisma } from "@/lib/prisma";
import Link from "next/link";

export default async function InventoryPage() {
  const listings = await prisma.listing.findMany({
    orderBy: { lastSyncedAt: "desc" },
    take: 100,
    include: { store: { select: { ebaySellerUsername: true } } },
  });

  return (
    <main style={{ maxWidth: 1200, margin: "0 auto", padding: 24 }}>
      <h1>Inventory</h1>
      <p>{listings.length} imported listings</p>

      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "2px solid #ccc" }}>
            <th>Image</th>
            <th>Title</th>
            <th>Store</th>
            <th>Price</th>
            <th>Qty</th>
            <th>Views</th>
            <th>Watchers</th>
            <th>Condition</th>
            <th>Last Synced</th>
          </tr>
        </thead>
        <tbody>
          {listings.map((l) => (
            <tr key={l.id} style={{ borderBottom: "1px solid #eee" }}>
              <td>
                {l.imageUrls[0] ? (
                  <img
                    src={l.imageUrls[0]}
                    alt={l.title}
                    style={{ width: 60, height: 60, objectFit: "cover" }}
                  />
                ) : (
                  "—"
                )}
              </td>
              <td>{l.title}</td>
              <td>{l.store?.ebaySellerUsername ?? "—"}</td>
              <td>${Number(l.currentPrice).toFixed(2)}</td>
              <td>{l.quantity}</td>
              <td>{l.views}</td>
              <td>{l.watchers}</td>
              <td>{l.condition ?? "—"}</td>
              <td>{new Date(l.lastSyncedAt).toLocaleString()}</td>
            </tr>
          ))}
          {listings.length === 0 && (
            <tr>
              <td colSpan={9}>
                No listings. Connect a store and run a sync from the{" "}
                <Link href="/stores">Stores</Link> page.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </main>
  );
}
