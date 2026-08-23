import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { enqueueSyncJob } from "@/lib/sync-jobs";

export async function POST(_request: Request, { params }: { params: { id: string } }) {
  const store = await prisma.store.findUnique({ where: { id: params.id }, select: { id: true, orderAccessStatus: true } });
  if (!store) return NextResponse.json({ error: "Store not found" }, { status: 404 });
  if (store.orderAccessStatus !== "ready") return NextResponse.json({ error: "Reconnect this store to authorize read-only order access", requiresReauthorization: true }, { status: 409 });
  const { job, created } = await enqueueSyncJob(store.id, "orders_incremental");
  return NextResponse.json({ queued: created, jobId: job.id, status: job.status }, { status: created ? 202 : 200 });
}
