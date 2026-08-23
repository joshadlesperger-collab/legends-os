import { NextRequest, NextResponse } from "next/server";
import { reconcileUnlinkedOrderLines } from "@/lib/reconciliation";

export async function POST(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => ({})) as { storeId?: string };
  return NextResponse.json(await reconcileUnlinkedOrderLines(body.storeId));
}
