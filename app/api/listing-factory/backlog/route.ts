import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { OPERATOR_SESSION_COOKIE, readOperatorSession } from "@/lib/operator-auth";
import { localBacklog } from "@/lib/card-backlog-service";
import { withWorkflow } from "@/lib/card-workflow-store";
import { BacklogReadError, backlogErrorResponse } from "@/lib/card-backlog-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  if (!await readOperatorSession((await cookies()).get(OPERATOR_SESSION_COOKIE)?.value)) return NextResponse.json({ error: "Operator sign-in required" }, { status: 401 });
  try {
    const snapshot = await localBacklog();
    if (!snapshot.sources.some(s => s.path === "artifacts/identity-queue/cards.json" && s.status === "loaded")) throw new BacklogReadError("LOCAL_EVIDENCE_UNAVAILABLE");
    return NextResponse.json(await withWorkflow(snapshot), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json(backlogErrorResponse(error), { status: 503, headers: { "Cache-Control": "private, no-store" } });
  }
}
