import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getEbayOAuthUrl } from "@/lib/ebay";
import { issueEbayOAuthState } from "@/lib/ebay-oauth-state";

export async function GET() {
  const stores = await prisma.store.findMany({
    orderBy: { createdAt: "desc" },
    include: { account: { select: { name: true } } },
  });
  return NextResponse.json({ stores });
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as { accountId?: string };

  let accountId = body.accountId;
  if (!accountId) {
    const existing = await prisma.account.findFirst({ orderBy: { createdAt: "asc" } });
    if (existing) {
      accountId = existing.id;
    } else {
      const created = await prisma.account.create({
        data: { name: "Default Account", plan: "free" },
      });
      accountId = created.id;
    }
  }

  const store = await prisma.store.create({
    data: {
      accountId,
      connectionStatus: "pending",
      isActive: true,
    },
  });

  const issued = issueEbayOAuthState(store.id, "connect");
  await prisma.store.update({ where: { id: store.id }, data: { oauthState: issued.storedState } });
  const url = getEbayOAuthUrl(issued.state);
  return NextResponse.json({ storeId: store.id, oauthUrl: url });
}
