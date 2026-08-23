import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { parseOptionalMoney, validateCostRow, type CostImportRow } from "@/lib/cost-basis-import";

type Resolved = CostImportRow & { listingId?: string; listingTitle?: string; status: "matched" | "conflict" | "unmatched" | "ambiguous" | "invalid" | "duplicate"; errors: string[] };
async function resolveRows(rows: CostImportRow[]): Promise<Resolved[]> {
  const ids = rows.map((row) => row.listing_id).filter(Boolean) as string[]; const items = rows.map((row) => row.ebay_item_id).filter(Boolean) as string[]; const skus = rows.map((row) => row.sku).filter(Boolean) as string[];
  const listings = await prisma.listing.findMany({ where: { OR: [{ id: { in: ids } }, { ebayItemId: { in: items } }, { sku: { in: skus } }] }, select: { id: true, ebayItemId: true, sku: true, title: true, costBasis: { select: { unitAcquisitionCost: true, unitGradingCost: true, unitSuppliesCost: true, unitOutboundPostageCost: true, unitOtherCost: true } } } });
  const seen = new Set<string>();
  return rows.map((row) => { const errors = validateCostRow(row); const matches = listings.filter((listing) => (row.listing_id && listing.id === row.listing_id) || (row.ebay_item_id && listing.ebayItemId === row.ebay_item_id) || (row.sku && listing.sku === row.sku)); if (errors.length) return { ...row, status: "invalid", errors }; if (!matches.length) return { ...row, status: "unmatched", errors: ["No listing matched the supplied identity"] }; if (matches.length > 1) return { ...row, status: "ambiguous", errors: ["Identity matched multiple listings"] }; const listing = matches[0]; if (seen.has(listing.id)) return { ...row, listingId: listing.id, listingTitle: listing.title, status: "duplicate", errors: ["Multiple CSV rows target the same listing"] }; seen.add(listing.id); const hasExisting=listing.costBasis&&Object.values(listing.costBasis).some(value=>value!=null); return { ...row, listingId: listing.id, listingTitle: listing.title, status: hasExisting?"conflict":"matched", errors: hasExisting?["Existing cost basis requires explicit replace policy"]:[] }; });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as { mode?: string; rows?: CostImportRow[]; sourceFileName?: string; overwritePolicy?: "preserve" | "replace" } | null;
  if (!body?.rows || body.rows.length > 10000) return NextResponse.json({ error: "Provide at most 10,000 rows" }, { status: 400 });
  const resolved = await resolveRows(body.rows);
  if (body.mode !== "apply") return NextResponse.json({ rows: resolved, summary: summarize(resolved) });
  const applicable = resolved.filter((row) => (row.status === "matched" || (row.status === "conflict" && body.overwritePolicy === "replace")) && row.listingId);
  const summary=summarize(resolved);
  const batch=await prisma.$transaction(async tx=>{const created=await tx.costBasisImportBatch.create({data:{sourceFileName:body.sourceFileName?.trim().slice(0,255)||null,suppliedRows:body.rows!.length,appliedRows:applicable.length,summary:summary as Prisma.InputJsonValue}});for(const row of applicable){const data={unitAcquisitionCost:parseOptionalMoney(row.acquisition_cost),unitGradingCost:parseOptionalMoney(row.grading_cost),unitSuppliesCost:parseOptionalMoney(row.supplies),unitOutboundPostageCost:parseOptionalMoney(row.postage),unitOtherCost:parseOptionalMoney(row.other_cost),notes:row.notes?.trim()||null,source:"csv-import",sourceReference:body.sourceFileName?.trim().slice(0,255)||null,enteredAt:new Date(),importBatchId:created.id};await tx.listingCostBasis.upsert({where:{listingId:row.listingId!},create:{listingId:row.listingId!,...data},update:data});}return created;});
  return NextResponse.json({ applied: applicable.length, importBatchId:batch.id, rows: resolved, summary });
}
function summarize(rows: Resolved[]) { return Object.fromEntries(["matched", "conflict", "unmatched", "ambiguous", "invalid", "duplicate"].map((status) => [status, rows.filter((row) => row.status === status).length])); }
