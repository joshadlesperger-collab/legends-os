import { NextRequest, NextResponse } from "next/server";
import { OPERATOR_SESSION_COOKIE, readOperatorSession } from "@/lib/operator-auth";
import { prisma } from "@/lib/prisma";
import { collectSellerSales } from "@/lib/card-parallel-sales-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  if (!await readOperatorSession(request.cookies.get(OPERATOR_SESSION_COOKIE)?.value)) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  try {
    if (!process.env.DATABASE_URL) throw Error("Unavailable");
    return NextResponse.json(await collectSellerSales(prisma), { headers: { "Cache-Control": "private, no-store", "Content-Disposition": 'attachment; filename="seller-sales.json"' } });
  } catch { return NextResponse.json({ error: "Sales unavailable. Check the existing order connection; no paid source is needed." }, { status: 503, headers: { "Cache-Control": "private, no-store" } }); }
}
