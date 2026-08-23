import { NextRequest, NextResponse } from "next/server";
import { collectSellerOpportunities, IncompleteSellerRunError } from "@/lib/seller-opportunities";

export async function POST(request: NextRequest, { params }: { params: { seller: string } }) {
  try {
    await collectSellerOpportunities(params.seller);
    return NextResponse.redirect(new URL(`/seller-opportunities?refresh=success`, request.url), 303);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Collection failed";
    const target = new URL("/seller-opportunities", request.url);
    target.searchParams.set("refresh", "error");
    target.searchParams.set("message", message.slice(0, 180));
    if(error instanceof IncompleteSellerRunError){target.searchParams.set("audit","incomplete");target.searchParams.set("reported",String(error.audit.reportedTotal));target.searchParams.set("retrieved",String(error.audit.retrievedTotal));target.searchParams.set("unique",String(error.audit.uniqueItemIds));target.searchParams.set("duplicates",String(error.audit.duplicateCount));target.searchParams.set("outside",String(error.audit.outsideBoundaryCount));target.searchParams.set("singles",String(error.audit.singleCount));target.searchParams.set("lots",String(error.audit.lotCount));target.searchParams.set("earliest",error.audit.earliestEndTime??"");target.searchParams.set("latest",error.audit.latestEndTime??"");}
    return NextResponse.redirect(target, 303);
  }
}
