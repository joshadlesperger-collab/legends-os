import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const fields = ["unitAcquisitionCost", "unitGradingCost", "unitSuppliesCost", "unitOutboundPostageCost", "unitOtherCost"] as const;

function optionalMoney(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000) throw new Error("Costs must be between 0 and 1,000,000");
  return amount.toFixed(2);
}

export async function PUT(request: Request, { params }: { params: { id: string } }) {
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; }
  catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  let costs: Record<string, string | null>;
  let notes: string | null;
  try {
    costs = Object.fromEntries(fields.map((field) => [field, optionalMoney(body[field])]));
    notes = body.notes == null ? null : String(body.notes).trim().slice(0, 500) || null;
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid cost basis" }, { status: 400 });
  }
  const listing = await prisma.listing.findUnique({ where: { id: params.id }, select: { id: true } });
  if (!listing) return NextResponse.json({ error: "Listing not found" }, { status: 404 });
  const costBasis = await prisma.listingCostBasis.upsert({
    where: { listingId: listing.id },
    create: { listingId: listing.id, currency: "USD", ...costs, notes, source: "manual", enteredAt: new Date(), importBatchId: null },
    update: { ...costs, notes, source: "manual", sourceReference: null, enteredAt: new Date(), importBatchId: null },
    select: { listingId: true, currency: true, unitAcquisitionCost: true, unitGradingCost: true, unitSuppliesCost: true, unitOutboundPostageCost: true, unitOtherCost: true, notes: true, source: true, sourceReference: true, enteredAt: true, updatedAt: true },
  });
  return NextResponse.json({ costBasis });
}
