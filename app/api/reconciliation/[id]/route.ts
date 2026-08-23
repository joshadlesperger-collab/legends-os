import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { linkOrderLine } from "@/lib/reconciliation";

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await request.json().catch(() => null) as { action?: string; listingId?: string } | null;
  const row = await prisma.orderLineReconciliation.findUnique({ where: { id }, select: { orderLineId: true, candidateListingId: true, confidence: true, matchTier: true, reasons: true } });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (body?.action === "reject") {
    await prisma.orderLineReconciliation.update({ where: { id }, data: { status: "rejected", reviewedAt: new Date() } });
    return NextResponse.json({ status: "rejected" });
  }
  if (body?.action !== "accept") return NextResponse.json({ error: "Action must be accept or reject" }, { status: 400 });
  const listingId = body.listingId ?? row.candidateListingId;
  if (!listingId) return NextResponse.json({ error: "A listing is required" }, { status: 400 });
  const manuallySelected = Boolean(body.listingId && body.listingId !== row.candidateListingId);
  const storedReasons = row.reasons && typeof row.reasons === "object" && "primary" in row.reasons ? (row.reasons as { primary?: unknown }).primary : [];
  const reasons = manuallySelected ? ["Operator selected a different listing"] : Array.isArray(storedReasons) ? storedReasons.map(String) : ["Operator accepted proposed listing"];
  await linkOrderLine(row.orderLineId, listingId, "accepted", manuallySelected ? "manual" : row.matchTier ?? "manual", manuallySelected ? null : row.confidence, reasons);
  return NextResponse.json({ status: "accepted" });
}
