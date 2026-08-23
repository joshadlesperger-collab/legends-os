import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

function getVerificationToken(): string {
  const token = process.env.EBAY_MADN_VERIFICATION_TOKEN;
  if (!token) {
    throw new Error("EBAY_MADN_VERIFICATION_TOKEN is not configured");
  }
  return token;
}

function getEndpointUrl(): string {
  return (
    process.env.EBAY_MADN_ENDPOINT_URL ??
    `${process.env.APP_URL ?? "https://localhost:3000"}/api/ebay/account-deletion`
  );
}

function buildChallengeResponse(challengeCode: string): string {
  const verificationToken = getVerificationToken();
  const endpointUrl = getEndpointUrl();
  const hash = crypto
    .createHash("sha256")
    .update(challengeCode, "utf8")
    .update(verificationToken, "utf8")
    .update(endpointUrl, "utf8")
    .digest("hex");
  return hash;
}

export async function GET(req: NextRequest) {
  const challengeCode = req.nextUrl.searchParams.get("challenge_code");

  if (!challengeCode) {
    return NextResponse.json({ error: "Missing challenge_code" }, { status: 400 });
  }

  try {
    const challengeResponse = buildChallengeResponse(challengeCode);
    return NextResponse.json({ challengeResponse }, { status: 200 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    // Acknowledge without logging headers or the notification payload. Both may
    // contain authentication material and personal account identifiers.
    await req.text();
    console.info("[eBay MADN] notification acknowledged");

    return NextResponse.json({ status: "acknowledged" }, { status: 200 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[eBay MADN] error:", message);
    return NextResponse.json({ status: "acknowledged" }, { status: 200 });
  }
}
