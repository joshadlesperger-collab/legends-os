import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { enqueueSyncJob } from "@/lib/sync-jobs";

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const mode = request.nextUrl.searchParams.get("mode") ?? "full";
  if (mode !== "full" && mode !== "incremental") return NextResponse.json({ error: "mode must be full or incremental" }, { status: 400 });
  const store = await prisma.store.findUnique({ where: { id: params.id }, select: { id: true } });
  if (!store) return NextResponse.json({ error: "Store not found" }, { status: 404 });
  const { job, created } = await enqueueSyncJob(store.id, mode === "full" ? "listing_full" : "listing_incremental");
  return NextResponse.json({ queued: created, jobId: job.id, status: job.status }, { status: created ? 202 : 200 });
}
