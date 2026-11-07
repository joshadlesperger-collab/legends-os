import { NextRequest, NextResponse } from "next/server";
import { OPERATOR_SESSION_COOKIE, readOperatorSession } from "@/lib/operator-auth";
import { readV2CandidatePhoto } from "@/lib/card-processing-v2-selection";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  const headers = { "Cache-Control": "private, no-store" };
  if (!await readOperatorSession(req.cookies.get(OPERATOR_SESSION_COOKIE)?.value)) return NextResponse.json({ error: "Sign in required" }, { status: 401, headers });
  const { searchParams } = req.nextUrl, side = searchParams.get("side");
  if (side !== "front" && side !== "back" || Array.from(searchParams.keys()).some(k => !["token", "id", "side"].includes(k))) return NextResponse.json({ error: "Choose a selected original" }, { status: 400, headers });
  try { return new NextResponse(new Uint8Array(await readV2CandidatePhoto(process.cwd(), searchParams.get("token") ?? "", searchParams.get("id") ?? "", side)), { headers: { ...headers, "Content-Type": "image/jpeg", "X-Content-Type-Options": "nosniff" } }); }
  catch { return NextResponse.json({ error: "Original preview changed or is unavailable. Refresh the selection." }, { status: 409, headers }); }
}
