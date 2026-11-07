import { NextRequest, NextResponse } from "next/server";
import { OPERATOR_SESSION_COOKIE, readOperatorSession } from "@/lib/operator-auth";
import { cardCatalog, recoverySummary } from "@/lib/card-knowledge-store";
import { searchCatalog, catalogGraph } from "@/lib/card-knowledge";
import { reviewedKnowledge } from "@/lib/card-reviewed-knowledge";
import { readQueue } from "@/lib/card-orchestrator-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  if (!await readOperatorSession(request.cookies.get(OPERATOR_SESSION_COOKIE)?.value)) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  const params = request.nextUrl.searchParams;
  const query = params.get("q") ?? "", section = params.get("section") ?? "";
  if (query.length > 120 || section.length > 160) return NextResponse.json({ error: "Search is too long" }, { status: 400 });
  const data = params.get("view") === "reviewed" ? reviewedKnowledge(await readQueue("artifacts/card-orchestrator"),query,Number(params.get("offset")??0)) : params.get("view") === "graph" ? catalogGraph(cardCatalog, query, section) : {
    product: cardCatalog.product, sources: cardCatalog.sources,
    ...searchCatalog(cardCatalog, query, section, Number(params.get("offset") ?? 0), 50),
    recovery: await recoverySummary(), limitations: cardCatalog.limitations,
  };
  return NextResponse.json(data, { headers: { "Cache-Control": "private, no-store" } });
}
