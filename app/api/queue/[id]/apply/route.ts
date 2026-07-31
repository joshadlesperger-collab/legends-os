import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const updated = await prisma.recommendation.update({
    where: { id: params.id },
    data: { status: "applied", appliedAt: new Date() },
  });

  return NextResponse.json({
    success: true,
    note: "Applied status is local only; perform the action manually on eBay.",
    recommendation: updated,
  });
}
