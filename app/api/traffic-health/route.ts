import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { parseCardIdentity } from "@/lib/comp-validation/identity";

type TrafficState =
  | "new-learning"
  | "no-traffic"
  | "low-traffic"
  | "traffic-no-interest"
  | "interested-not-converting"
  | "converting"
  | "strong-demand-potentially-underpriced";

type PriorityLevel = "critical" | "high" | "medium" | "low";

type CompSummary = {
  recommendedPrice: number | null;
  confidenceScore: number;
  confidenceBand: string;
  recommendationType: string;
  acceptedCompCount: number;
  excludedCompCount: number;
};

type ListingRow = {
  id: string;
  title: string;
  categoryId: string | null;
  listingFormat: string | null;
  currentPrice: number;
  quantity: number;
  quantitySold: number;
  views: number;
  watchers: number;
  startTime: string | null;
  createdAt: string;
  listingQuality: unknown;
};

type SnapshotRow = {
  listingId: string;
  capturedAt: string;
  quantitySold: number;
  views: number;
  watchers: number;
};

type ListingHealthRow = {
  listingId: string;
  title: string;
  currentPrice: number;
  listingAgeDays: number;
  activeDays: number;
  views: number;
  viewsPerDay: number;
  viewsPer30: number;
  watchers: number;
  watcherRate: number;
  quantitySold: number;
  lifetimeConversionProxy: number;
  recentVelocityPerDay: number | null;
  recentConversionProxy: number | null;
  trafficState: TrafficState;
  priority: PriorityLevel;
  compSummary: CompSummary | null;
  reason: string;
};

type TrafficHealthResponse = {
  generatedAt: string;
  minExposureDays: number;
  telemetry: {
    dbReads: number;
    dbWrites: number;
    listingsEvaluated: number;
    snapshotRowsUsed: number;
    cacheStatus: "hit" | "miss";
  };
  summary: {
    trafficHealthPct: number;
    counts: Record<TrafficState, number>;
    matureListingsCount: number;
    healthyMatureCount: number;
  };
  rows: ListingHealthRow[];
};

const CACHE_TTL_MS = 2 * 60 * 1000;
const SNAPSHOT_LOOKBACK_DAYS = 30;
const MIN_EXPOSURE_DAYS = 7;
const MAX_ROWS_DEFAULT = 500;
const MAX_ROWS_LIMIT = 2000;

type CacheEntry = { expiresAt: number; payload: TrafficHealthResponse };

let cachedResponse: CacheEntry | null = null;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function round(value: number, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function bucketPrice(price: number) {
  if (price < 20) return "lt20";
  if (price < 50) return "20-49";
  if (price < 100) return "50-99";
  return "100plus";
}

function percentile(sortedValues: number[], p: number) {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0];

  const index = (p / 100) * (sortedValues.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower];

  const fraction = index - lower;
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * fraction;
}

function safeRate(numerator: number, denominator: number) {
  if (denominator <= 0) return 0;
  return numerator / denominator;
}

function parseCompSummary(listingQuality: unknown, title: string): CompSummary | null {
  if (!listingQuality || typeof listingQuality !== "object") return null;

  const root = listingQuality as Record<string, unknown>;
  const compValidation = root.compValidation;
  if (!compValidation || typeof compValidation !== "object") return null;

  const state = compValidation as Record<string, unknown>;
  const cache = state.cache;
  if (!cache || typeof cache !== "object") return null;

  const identity = parseCardIdentity(title);
  const cacheRecord = cache as Record<string, unknown>;
  const byIdentity = cacheRecord[identity.identityHash];
  if (!byIdentity || typeof byIdentity !== "object") return null;

  const entry = byIdentity as Record<string, unknown>;
  const result = entry.result;
  if (!result || typeof result !== "object") return null;

  const summary = result as Record<string, unknown>;
  return {
    recommendedPrice: typeof summary.recommendedPrice === "number" ? summary.recommendedPrice : null,
    confidenceScore: typeof summary.confidenceScore === "number" ? summary.confidenceScore : 0,
    confidenceBand: typeof summary.confidenceBand === "string" ? summary.confidenceBand : "insufficient",
    recommendationType: typeof summary.recommendationType === "string" ? summary.recommendationType : "insufficient-data",
    acceptedCompCount: typeof summary.acceptedCompCount === "number" ? summary.acceptedCompCount : 0,
    excludedCompCount: typeof summary.excludedCompCount === "number" ? summary.excludedCompCount : 0,
  };
}

function toDate(value: string | null) {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed);
}

function daysSince(date: Date | null) {
  if (!date) return 0;
  const diffMs = Date.now() - date.getTime();
  return Math.max(0, Math.floor(diffMs / (24 * 60 * 60 * 1000)));
}

function stateRank(state: TrafficState) {
  switch (state) {
    case "interested-not-converting":
      return 0;
    case "no-traffic":
      return 1;
    case "strong-demand-potentially-underpriced":
      return 2;
    case "low-traffic":
      return 3;
    case "traffic-no-interest":
      return 4;
    case "converting":
      return 5;
    case "new-learning":
      return 6;
  }
}

function priorityRank(priority: PriorityLevel) {
  switch (priority) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    case "low":
      return 3;
  }
}

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const maxRowsParam = Number(request.nextUrl.searchParams.get("maxRows") ?? String(MAX_ROWS_DEFAULT));
  const maxRows = clamp(Number.isFinite(maxRowsParam) ? Math.floor(maxRowsParam) : MAX_ROWS_DEFAULT, 1, MAX_ROWS_LIMIT);

  if (cachedResponse && cachedResponse.expiresAt > Date.now()) {
    return NextResponse.json({
      ...cachedResponse.payload,
      rows: cachedResponse.payload.rows.slice(0, maxRows),
      telemetry: {
        ...cachedResponse.payload.telemetry,
        cacheStatus: "hit",
      },
    } satisfies TrafficHealthResponse);
  }

  let dbReads = 0;

  dbReads += 1;
  const listingRowsRaw = await prisma.listing.findMany({
    where: { listingStatus: "active" },
    select: {
      id: true,
      title: true,
      categoryId: true,
      listingFormat: true,
      currentPrice: true,
      quantity: true,
      quantitySold: true,
      views: true,
      watchers: true,
      startTime: true,
      createdAt: true,
      listingQuality: true,
    },
  });

  const listingRows: ListingRow[] = listingRowsRaw.map((row) => ({
    id: row.id,
    title: row.title,
    categoryId: row.categoryId,
    listingFormat: row.listingFormat,
    currentPrice: Number(row.currentPrice),
    quantity: row.quantity,
    quantitySold: row.quantitySold,
    views: row.views,
    watchers: row.watchers,
    startTime: row.startTime ? row.startTime.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    listingQuality: row.listingQuality,
  }));

  const listingIds = listingRows.map((row) => row.id);
  const snapshotWindowStart = new Date(Date.now() - SNAPSHOT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  dbReads += 1;
  const snapshotsRaw = listingIds.length
    ? await prisma.listingSnapshot.findMany({
        where: {
          listingId: { in: listingIds },
          capturedAt: { gte: snapshotWindowStart },
        },
        select: {
          listingId: true,
          capturedAt: true,
          quantitySold: true,
          views: true,
          watchers: true,
        },
        orderBy: [{ listingId: "asc" }, { capturedAt: "asc" }],
      })
    : [];

  const snapshots: SnapshotRow[] = snapshotsRaw.map((row) => ({
    listingId: row.listingId,
    capturedAt: row.capturedAt.toISOString(),
    quantitySold: row.quantitySold,
    views: row.views,
    watchers: row.watchers,
  }));

  const snapshotsByListing = new Map<string, SnapshotRow[]>();
  for (const row of snapshots) {
    const list = snapshotsByListing.get(row.listingId) ?? [];
    list.push(row);
    snapshotsByListing.set(row.listingId, list);
  }

  type Derived = {
    listing: ListingRow;
    activeDays: number;
    viewsPerDay: number;
    viewsPer30: number;
    watcherRate: number;
    conversionLifetime: number;
    recentVelocityPerDay: number | null;
    recentConversionProxy: number | null;
    compSummary: CompSummary | null;
  };

  const derivedRows: Derived[] = listingRows.map((listing) => {
    const start = toDate(listing.startTime) ?? toDate(listing.createdAt);
    const ageDays = daysSince(start);
    const activeDays = Math.max(1, ageDays);

    const viewsPerDay = safeRate(listing.views, activeDays);
    const viewsPer30 = viewsPerDay * 30;
    const watcherRate = listing.views > 0 ? safeRate(listing.watchers, listing.views) : 0;
    const conversionLifetime = listing.views > 0 ? safeRate(listing.quantitySold, listing.views) : 0;

    const snaps = snapshotsByListing.get(listing.id) ?? [];
    let recentVelocityPerDay: number | null = null;
    let recentConversionProxy: number | null = null;

    if (snaps.length >= 2) {
      const oldest = snaps[0];
      const latest = snaps[snaps.length - 1];
      const oldestTs = Date.parse(oldest.capturedAt);
      const latestTs = Date.parse(latest.capturedAt);

      if (!Number.isNaN(oldestTs) && !Number.isNaN(latestTs) && latestTs > oldestTs) {
        const days = Math.max(1, Math.floor((latestTs - oldestTs) / (24 * 60 * 60 * 1000)));
        const quantitySoldDelta = Math.max(0, latest.quantitySold - oldest.quantitySold);
        const viewsDelta = Math.max(0, latest.views - oldest.views);

        recentVelocityPerDay = quantitySoldDelta / days;
        recentConversionProxy = quantitySoldDelta / Math.max(viewsDelta, 1);
      }
    }

    return {
      listing,
      activeDays,
      viewsPerDay,
      viewsPer30,
      watcherRate,
      conversionLifetime,
      recentVelocityPerDay,
      recentConversionProxy,
      compSummary: parseCompSummary(listing.listingQuality, listing.title),
    };
  });

  type PeerKey = string;
  const peerGroups = new Map<PeerKey, number[]>();

  for (const row of derivedRows) {
    const category = row.listing.categoryId ?? "uncategorized";
    const format = row.listing.listingFormat ?? "unknown";
    const band = bucketPrice(row.listing.currentPrice);
    const key = `${category}|${format}|${band}`;
    const pool = peerGroups.get(key) ?? [];
    pool.push(row.viewsPer30);
    peerGroups.set(key, pool);
  }

  const peerStats = new Map<PeerKey, { p20: number; p50: number; p75: number }>();
  peerGroups.forEach((values, key) => {
    const sorted = [...values].sort((a, b) => a - b);
    peerStats.set(key, {
      p20: percentile(sorted, 20),
      p50: percentile(sorted, 50),
      p75: percentile(sorted, 75),
    });
  });

  const counts: Record<TrafficState, number> = {
    "new-learning": 0,
    "no-traffic": 0,
    "low-traffic": 0,
    "traffic-no-interest": 0,
    "interested-not-converting": 0,
    converting: 0,
    "strong-demand-potentially-underpriced": 0,
  };

  const rows: ListingHealthRow[] = [];
  let matureListingsCount = 0;
  let healthyMatureCount = 0;

  for (const row of derivedRows) {
    const category = row.listing.categoryId ?? "uncategorized";
    const format = row.listing.listingFormat ?? "unknown";
    const band = bucketPrice(row.listing.currentPrice);
    const key = `${category}|${format}|${band}`;
    const peer = peerStats.get(key) ?? { p20: 0.5, p50: 1, p75: 2 };

    const hasMatureExposure = row.activeDays >= MIN_EXPOSURE_DAYS;
    const viewsMeaningful = row.viewsPer30 >= Math.max(5, peer.p50 * 0.75);
    const lowTrafficCutoff = Math.max(2, peer.p20 > 0 ? peer.p20 : peer.p50 * 0.35);
    const strongTrafficCutoff = Math.max(12, peer.p75 > 0 ? peer.p75 : peer.p50 * 1.4);

    const watchersMeaningful = row.listing.watchers >= 2;
    const watcherRateLow = row.watcherRate < 0.02;
    const watcherRateStrong = row.watcherRate >= 0.08;

    const conversionPositive = row.listing.quantitySold > 0;
    const conversionWeak = row.conversionLifetime < 0.01;
    const recentVelocityStrong = (row.recentVelocityPerDay ?? 0) >= 0.08;

    let trafficState: TrafficState;
    let reason = "";

    if (!hasMatureExposure) {
      trafficState = "new-learning";
      reason = `Only ${row.activeDays} active days (< ${MIN_EXPOSURE_DAYS} day minimum exposure).`;
    } else if (conversionPositive && (row.conversionLifetime >= 0.01 || recentVelocityStrong || row.listing.quantitySold > 0)) {
      if (
        row.viewsPer30 >= strongTrafficCutoff &&
        (row.conversionLifetime >= 0.03 || watcherRateStrong) &&
        row.compSummary?.confidenceScore &&
        row.compSummary.confidenceScore >= 65 &&
        row.compSummary.recommendationType === "raise-price"
      ) {
        trafficState = "strong-demand-potentially-underpriced";
        reason = "Strong normalized traffic and conversion, plus cached comp signal indicating potential pricing headroom.";
      } else {
        trafficState = "converting";
        reason = "Sales have occurred; conversion signal is present from quantity sold and/or recent velocity.";
      }
    } else if (row.listing.views <= 0 || row.viewsPer30 < 1) {
      trafficState = "no-traffic";
      reason = "Sufficient exposure but effectively no normalized traffic.";
    } else if (row.viewsPer30 < lowTrafficCutoff) {
      trafficState = "low-traffic";
      reason = `Normalized traffic (${round(row.viewsPer30, 2)}/30d) is below peer-relative low cutoff (${round(lowTrafficCutoff, 2)}).`;
    } else if (viewsMeaningful && (watchersMeaningful || row.watcherRate >= 0.03) && !conversionPositive) {
      trafficState = "interested-not-converting";
      reason = "Buyers are showing interest (views/watchers) but no sales have converted yet.";
    } else if (viewsMeaningful && !watchersMeaningful && watcherRateLow && conversionWeak) {
      trafficState = "traffic-no-interest";
      reason = "Traffic exists but engagement is weak (low watcher rate and no meaningful conversion).";
    } else if (!conversionPositive && viewsMeaningful) {
      trafficState = "interested-not-converting";
      reason = "Traffic is meaningful but conversion has not occurred after exposure.";
    } else {
      trafficState = "traffic-no-interest";
      reason = "Traffic and engagement signals are mixed; investigate listing quality and demand fit.";
    }

    counts[trafficState] += 1;

    if (hasMatureExposure) {
      matureListingsCount += 1;
      if (trafficState !== "no-traffic" && trafficState !== "low-traffic") {
        healthyMatureCount += 1;
      }
    }

    const highValue = row.listing.currentPrice >= 75 || row.listing.quantity >= 2;

    let priority: PriorityLevel = "low";
    if (trafficState === "interested-not-converting") {
      if (row.activeDays >= 21 && row.listing.watchers >= 3 && row.viewsPer30 >= Math.max(10, peer.p50) && highValue) {
        priority = "critical";
      } else {
        priority = "high";
      }
    } else if (trafficState === "no-traffic") {
      priority = row.activeDays >= 21 && highValue ? "high" : "medium";
    } else if (trafficState === "strong-demand-potentially-underpriced") {
      priority = "high";
    } else if (trafficState === "low-traffic" || trafficState === "traffic-no-interest") {
      priority = "medium";
    }

    rows.push({
      listingId: row.listing.id,
      title: row.listing.title,
      currentPrice: row.listing.currentPrice,
      listingAgeDays: row.activeDays,
      activeDays: row.activeDays,
      views: row.listing.views,
      viewsPerDay: round(row.viewsPerDay, 4),
      viewsPer30: round(row.viewsPer30, 3),
      watchers: row.listing.watchers,
      watcherRate: round(row.watcherRate, 4),
      quantitySold: row.listing.quantitySold,
      lifetimeConversionProxy: round(row.conversionLifetime, 4),
      recentVelocityPerDay: row.recentVelocityPerDay == null ? null : round(row.recentVelocityPerDay, 4),
      recentConversionProxy: row.recentConversionProxy == null ? null : round(row.recentConversionProxy, 4),
      trafficState,
      priority,
      compSummary: row.compSummary,
      reason,
    });
  }

  rows.sort((a, b) => {
    const priorityDelta = priorityRank(a.priority) - priorityRank(b.priority);
    if (priorityDelta !== 0) return priorityDelta;

    const stateDelta = stateRank(a.trafficState) - stateRank(b.trafficState);
    if (stateDelta !== 0) return stateDelta;

    if (a.currentPrice !== b.currentPrice) return b.currentPrice - a.currentPrice;
    return b.viewsPer30 - a.viewsPer30;
  });

  const trafficHealthPct = matureListingsCount > 0
    ? round((healthyMatureCount / matureListingsCount) * 100, 2)
    : 0;

  const payload: TrafficHealthResponse = {
    generatedAt: new Date().toISOString(),
    minExposureDays: MIN_EXPOSURE_DAYS,
    telemetry: {
      dbReads,
      dbWrites: 0,
      listingsEvaluated: listingRows.length,
      snapshotRowsUsed: snapshots.length,
      cacheStatus: "miss",
    },
    summary: {
      trafficHealthPct,
      counts,
      matureListingsCount,
      healthyMatureCount,
    },
    rows,
  };

  cachedResponse = {
    expiresAt: Date.now() + CACHE_TTL_MS,
    payload,
  };

  return NextResponse.json({
    ...payload,
    rows: payload.rows.slice(0, maxRows),
  } satisfies TrafficHealthResponse);
}
