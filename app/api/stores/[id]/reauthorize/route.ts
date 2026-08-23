import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getEbayOAuthUrl } from "@/lib/ebay";
import { issueEbayOAuthState } from "@/lib/ebay-oauth-state";

export async function POST(_request: Request, { params }: { params: { id: string } }) {
  const store = await prisma.store.findUnique({
    where: { id: params.id },
    select: { id: true, connectionStatus: true },
  });

  if (!store) return NextResponse.json({ error: "Store not found" }, { status: 404 });
  if (store.connectionStatus !== "connected") {
    return NextResponse.json({ error: "Only a connected store can be reauthorized" }, { status: 409 });
  }

  const issued = issueEbayOAuthState(store.id, "reauthorize_orders");
  await prisma.store.update({ where: { id: store.id }, data: { oauthState: issued.storedState } });

  return NextResponse.json({ oauthUrl: getEbayOAuthUrl(issued.state) });
}
