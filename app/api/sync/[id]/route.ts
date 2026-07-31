import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const syncRun = await prisma.syncRun.findUnique({
    where: { id: params.id },
    include: { store: { select: { ebaySellerUsername: true } } },
  });

  if (!syncRun) {
    return NextResponse.json({ error: "Sync run not found" }, { status: 404 });
  }

  return NextResponse.json({ syncRun });
}
