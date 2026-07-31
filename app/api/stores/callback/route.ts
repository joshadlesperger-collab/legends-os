import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { exchangeCodeForTokens, getEbayUser, setStoredToken } from "@/lib/ebay";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");

  if (!code || !state) {
    return NextResponse.json({ error: "Missing code or state" }, { status: 400 });
  }

  const store = await prisma.store.findFirst({ where: { oauthState: state } });
  if (!store) {
    return NextResponse.json({ error: "Invalid state" }, { status: 400 });
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    const { userId } = await getEbayUser(tokens.accessToken);

    await prisma.store.update({
      where: { id: store.id },
      data: {
        ebaySellerUsername: userId,
        marketplace: "EBAY_US",
        connectionStatus: "connected",
        oauthAccessToken: setStoredToken(tokens.accessToken),
        oauthRefreshToken: setStoredToken(tokens.refreshToken),
        tokenExpiresAt: tokens.expiresAt,
        lastSyncAt: new Date(),
        oauthState: null,
      },
    });

    return NextResponse.json({ success: true, storeId: store.id, userId });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.apiErrorLog.create({
      data: {
        storeId: store.id,
        apiName: "OAuthCallback",
        message,
      },
    });

    await prisma.store.update({
      where: { id: store.id },
      data: { connectionStatus: "needs_auth" },
    });

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
