import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { exchangeCodeForTokens, getEbayOAuthScopes, getEbayUser, setStoredToken } from "@/lib/ebay";
import { getOAuthReplayOutcome, pendingOAuthState, processingOAuthState, verifyEbayOAuthState } from "@/lib/ebay-oauth-state";

export async function GET(req: NextRequest) {
  const searchParams = req.nextUrl.searchParams;
  const code = searchParams.get("code");
  const state = searchParams.get("state");

  if (!code || !state) {
    return NextResponse.json({ error: "Missing code or state" }, { status: 400 });
  }

  const verified = verifyEbayOAuthState(state);
  if (!verified) {
    return NextResponse.json({ error: "Invalid state" }, { status: 400 });
  }

  const store = await prisma.store.findUnique({ where: { id: verified.storeId } });
  if (!store) return NextResponse.json({ error: "Invalid state" }, { status: 400 });

  const claimed = await prisma.store.updateMany({
    where: { id: store.id, oauthState: pendingOAuthState(verified.verifier) },
    data: { oauthState: processingOAuthState(verified.verifier) },
  });
  if (claimed.count !== 1) {
    const current = await prisma.store.findUnique({ where: { id: store.id }, select: { oauthState: true, connectionStatus: true, orderAccessStatus: true } });
    const outcome = getOAuthReplayOutcome(current?.oauthState ?? null, verified.verifier, verified.intent, current?.connectionStatus ?? "pending", current?.orderAccessStatus ?? "requires_reauth");
    if (outcome === "completed") return NextResponse.redirect(new URL("/stores?oauth=success", req.url));
    if (outcome === "processing") return NextResponse.redirect(new URL("/stores?oauth=processing", req.url));
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
        orderAccessStatus: "ready",
      },
    });
    console.info("[ebay-oauth] new grant persisted",{storeId:store.id,intent:verified.intent,sellerIdentityVerified:Boolean(userId),accessTokenExpiresAt:tokens.expiresAt.toISOString(),refreshTokenReplaced:Boolean(tokens.refreshToken),requestedScopes:getEbayOAuthScopes()});

    return NextResponse.redirect(new URL("/stores?oauth=success", req.url));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.apiErrorLog.create({
      data: {
        storeId: store.id,
        apiName: "OAuthCallback",
        message,
      },
    });

    await prisma.store.updateMany({
      where: { id: store.id, oauthState: processingOAuthState(verified.verifier) },
      data: {
        oauthState: null,
        ...(verified.intent === "connect" ? { connectionStatus: "needs_auth" } : {}),
      },
    });

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
