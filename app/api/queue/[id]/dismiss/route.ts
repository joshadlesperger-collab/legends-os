import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const updated = await prisma.recommendation.update({
    where: { id: params.id },
    data: { status: "dismissed", dismissedAt: new Date() },
  });

  return NextResponse.json({ success: true, recommendation: updated });
}
