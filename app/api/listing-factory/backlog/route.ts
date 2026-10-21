import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { OPERATOR_SESSION_COOKIE, readOperatorSession } from "@/lib/operator-auth";
import { loadCardBacklog } from "@/lib/card-backlog-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Coalesce concurrent refreshes. Each subsequent refresh re-reads evidence; image hashing alone is cached by stat.
let pending: ReturnType<typeof loadCardBacklog> | undefined;
export async function GET() {
  if (!await readOperatorSession((await cookies()).get(OPERATOR_SESSION_COOKIE)?.value)) return NextResponse.json({ error: "Operator sign-in required" }, { status: 401 });
  try {
    pending ??= loadCardBacklog().finally(() => { pending = undefined; });
    const snapshot = await pending;
    if (!snapshot.sources.some(s => s.path === "artifacts/identity-queue/cards.json" && s.status === "loaded")) return NextResponse.json({ error: "Local card evidence is unavailable. Open the canonical Legends OS workspace on this computer; a hosted server cannot read your Windows files." }, { status: 503 });
    return NextResponse.json(snapshot, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "Card evidence could not be read consistently. Previous records are preserved; retry after the source writer finishes." }, { status: 503 });
  }
}
