import { Prisma, type SyncJob } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { EbayApiError } from "@/lib/ebay";
import { acquireSyncRun, runStoreSync, type SyncMode } from "@/lib/ebay-sync-service";
import { runOrderSyncChunk, SyncJobLeaseLostError } from "@/lib/ebay-order-ingestion";
import { processHistoricalListingRecoveryChunk } from "@/lib/historical-listing-recovery";
import { recoverActiveListingEvidenceChunk } from "@/lib/active-listing-evidence-recovery";

export type SyncJobType = "listing_full" | "listing_incremental" | "orders_incremental" | "historical_recovery" | "active_evidence_recovery";
const ACTIVE_STATUSES = ["pending", "running", "retryable", "paused"];
const LEASE_MS = 55_000;

export async function enqueueSyncJob(storeId: string, type: SyncJobType) {
  try {
    return await prisma.$transaction(async (tx) => {
      const existing = await tx.syncJob.findFirst({ where: { storeId, status: { in: ACTIVE_STATUSES } }, orderBy: { createdAt: "asc" } });
      if (existing) return { job: existing, created: false };
      const job = await tx.syncJob.create({ data: { storeId, type, status: "pending" } });
      return { job, created: true };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2034") throw error;
    const existing = await prisma.syncJob.findFirst({ where: { storeId, status: { in: ACTIVE_STATUSES } }, orderBy: { createdAt: "asc" } });
    if (!existing) throw error;
    return { job: existing, created: false };
  }
}

export async function recoverAbandonedJobs() {
  const now = new Date();
  const stale = await prisma.syncJob.findMany({ where: { status: "running", leaseExpiresAt: { lt: now } }, select: { id: true, failureCount: true, maxAttempts: true } });
  for (const job of stale) {
    await prisma.syncJob.update({ where: { id: job.id }, data: {
      status: job.failureCount < job.maxAttempts ? "retryable" : "failed",
      scheduledAt: now, completedAt: job.failureCount < job.maxAttempts ? null : now,
      errorMessage: "Worker lease expired before the chunk completed",
      leaseToken: null, leaseExpiresAt: null,
    }});
  }
  return stale.length;
}

export async function claimNextJob(): Promise<SyncJob | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const candidate = await tx.syncJob.findFirst({
          where: { status: { in: ["pending", "retryable"] }, scheduledAt: { lte: new Date() } },
          orderBy: [{ scheduledAt: "asc" }, { createdAt: "asc" }],
        });
        if (!candidate) return null;
        const leaseToken = randomUUID();
        const now = new Date();
        const claimed = await tx.syncJob.updateMany({
          where: { id: candidate.id, status: candidate.status, leaseToken: null },
          data: { status: "running", startedAt: now, completedAt: null, errorMessage: null, attemptCount: { increment: 1 },
            leaseToken, leaseExpiresAt: new Date(now.getTime() + LEASE_MS), heartbeatAt: now },
        });
        return claimed.count === 1 ? tx.syncJob.findUnique({ where: { id: candidate.id } }) : null;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2034" || attempt === 2) throw error;
    }
  }
  return null;
}

export async function ensureHistoricalRecoveryJobs() {
  const pending = await prisma.historicalListingRecovery.groupBy({ by: ["storeId"], where: { status: { in: ["pending", "retryable"] }, attemptCount: { lt: 3 } } });
  let created = 0;
  for (const row of pending) {
    const existing = await prisma.syncJob.findFirst({ where: { storeId: row.storeId, type: "historical_recovery", status: { in: ACTIVE_STATUSES } }, select: { id: true } });
    if (!existing) { await prisma.syncJob.create({ data: { storeId: row.storeId, type: "historical_recovery", status: "pending" } }); created += 1; }
  }
  return created;
}

export async function ensureActiveEvidenceRecoveryJobs() {
  const stores = await prisma.store.findMany({ where: { connectionStatus: "connected", listings: { some: { listingStatus: "active", authoritativeObservedAt: null } } }, select: { id: true } });
  let created = 0;
  for (const store of stores) {
    const existing = await prisma.syncJob.findFirst({ where: { storeId: store.id, type: "active_evidence_recovery", status: { in: ACTIVE_STATUSES } }, select: { id: true } });
    if (!existing) { await prisma.syncJob.create({ data: { storeId: store.id, type: "active_evidence_recovery", status: "pending" } }); created += 1; }
  }
  return created;
}

function retryable(error: unknown) {
  if (!(error instanceof EbayApiError)) return false;
  const status = Number(error.code);
  return error.code == null || status === 408 || status === 429 || status >= 500;
}

export async function processSyncJob(job: SyncJob) {
  const store = await prisma.store.findUnique({ where: { id: job.storeId } });
  if (!store) throw new Error("Job store no longer exists");
  try {
    if (job.type === "orders_incremental") {
      if (!job.leaseToken) throw new SyncJobLeaseLostError();
      await runOrderSyncChunk(job, store, job.leaseToken);
      return prisma.syncJob.findUniqueOrThrow({ where: { id: job.id } });
    } else if (job.type === "historical_recovery") {
      const result = await processHistoricalListingRecoveryChunk(store.id);
      if (result.remaining > 0) return prisma.syncJob.update({ where: { id: job.id }, data: { status: "pending", progress: { increment: result.linked }, scheduledAt: new Date(Date.now() + 30_000), errorMessage: null, leaseToken: null, leaseExpiresAt: null, heartbeatAt: new Date() } });
      return prisma.syncJob.update({ where: { id: job.id }, data: { status: "completed", progress: { increment: result.linked }, completedAt: new Date(), errorMessage: null, leaseToken: null, leaseExpiresAt: null, heartbeatAt: new Date() } });
    } else if (job.type === "active_evidence_recovery") {
      const result = await recoverActiveListingEvidenceChunk(store);
      if (result.remaining > 0) return prisma.syncJob.update({ where: { id: job.id }, data: { status: "pending", progress: { increment: result.recovered }, scheduledAt: new Date(Date.now() + 30_000), errorMessage: null, leaseToken: null, leaseExpiresAt: null, heartbeatAt: new Date() } });
      return prisma.syncJob.update({ where: { id: job.id }, data: { status: "completed", progress: { increment: result.recovered }, completedAt: new Date(), errorMessage: null, leaseToken: null, leaseExpiresAt: null, heartbeatAt: new Date() } });
    } else {
      const mode: SyncMode = job.type === "listing_incremental" ? "incremental" : "full";
      const syncRun = await acquireSyncRun(store.id, mode);
      await prisma.syncJob.update({ where: { id: job.id }, data: { syncRunId: syncRun.id } });
      const result = await runStoreSync(store, mode, syncRun.id);
      await prisma.syncJob.update({ where: { id: job.id }, data: { progress: result.imported } });
    }
    return prisma.syncJob.update({ where: { id: job.id }, data: {
      status: "completed", completedAt: new Date(), errorMessage: null, leaseToken: null, leaseExpiresAt: null, heartbeatAt: new Date(),
    } });
  } catch (error) {
    if (error instanceof SyncJobLeaseLostError) throw error;
    const nextFailureCount = job.failureCount + 1;
    const canRetry = retryable(error) && nextFailureCount < job.maxAttempts;
    const delayMs = Math.min(15 * 60 * 1000, 30_000 * 2 ** Math.max(0, nextFailureCount - 1));
    await prisma.syncJob.updateMany({ where: { id: job.id, leaseToken: job.leaseToken }, data: {
      status: canRetry ? "retryable" : "failed", scheduledAt: canRetry ? new Date(Date.now() + delayMs) : job.scheduledAt,
      completedAt: canRetry ? null : new Date(), failureCount: nextFailureCount,
      errorMessage: (error instanceof Error ? error.message : "Job failed").slice(0, 1000), leaseToken: null, leaseExpiresAt: null,
    }});
    throw error;
  }
}

export async function processAvailableJobs(limit = 1) {
  await recoverAbandonedJobs();
  await ensureHistoricalRecoveryJobs();
  await ensureActiveEvidenceRecoveryJobs();
  const results: Array<{ id: string; status: string }> = [];
  for (let index = 0; index < Math.max(1, Math.min(limit, 5)); index += 1) {
    const job = await claimNextJob(); if (!job) break;
    try { const completed = await processSyncJob(job); results.push({ id: completed.id, status: completed.status }); }
    catch { const current = await prisma.syncJob.findUnique({ where: { id: job.id }, select: { status: true } }); results.push({ id: job.id, status: current?.status ?? "failed" }); }
  }
  return results;
}
