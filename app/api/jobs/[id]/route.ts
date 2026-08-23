import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const job = await prisma.syncJob.findUnique({ where: { id: params.id }, select: {
    id: true, storeId: true, type: true, status: true, attemptCount: true, maxAttempts: true,
    progress: true, scheduledAt: true, startedAt: true, completedAt: true, errorMessage: true,
  }});
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  return NextResponse.json({ job });
}
