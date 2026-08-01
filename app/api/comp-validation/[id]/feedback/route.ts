import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { buildValuation, createTelemetry, mergeCompState } from "@/lib/comp-validation/engine";
import type { CompFeedbackEntry } from "@/lib/comp-validation/types";

export const dynamic = "force-dynamic";

type FeedbackBody = {
  compKey: string;
  action: "exclude" | "restore";
  reason?: string;
};

function toInputJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  const telemetry = createTelemetry();

  const body = (await request.json()) as FeedbackBody;
  if (!body.compKey || !body.action) {
    return NextResponse.json({ error: "compKey and action are required" }, { status: 400 });
  }

  telemetry.dbReads += 1;
  const row = await prisma.listing.findUnique({
    where: { id: params.id },
    select: {
      id: true,
      storeId: true,
      title: true,
      currentPrice: true,
      quantity: true,
      quantitySold: true,
      views: true,
      watchers: true,
      listingFormat: true,
      condition: true,
      listingQuality: true,
    },
  });

  if (!row) {
    return NextResponse.json({ error: "Listing not found" }, { status: 404 });
  }

  const listingQuality = row.listingQuality && typeof row.listingQuality === "object"
    ? { ...(row.listingQuality as Record<string, unknown>) }
    : {};
  const currentState: Parameters<typeof mergeCompState>[1] =
    listingQuality.compValidation && typeof listingQuality.compValidation === "object"
    ? { ...(listingQuality.compValidation as Parameters<typeof mergeCompState>[1]) }
    : {};
  const feedbackRaw = currentState.feedback && typeof currentState.feedback === "object"
    ? { ...(currentState.feedback as Record<string, CompFeedbackEntry>) }
    : {};

  if (body.action === "exclude") {
    feedbackRaw[body.compKey] = {
      excluded: true,
      reason: body.reason?.trim() || "seller rejected comp",
      updatedAt: new Date().toISOString(),
    };
  } else {
    delete feedbackRaw[body.compKey];
  }

  const nextCompState: Parameters<typeof mergeCompState>[1] = {
    ...currentState,
    feedback: feedbackRaw,
  };

  const mergedListingQuality = mergeCompState(row.listingQuality, nextCompState);

  telemetry.dbWrites += 1;
  await prisma.listing.update({
    where: { id: row.id },
    data: {
      listingQuality: toInputJsonValue(mergedListingQuality),
    },
  });

  const listing = {
    id: row.id,
    storeId: row.storeId,
    title: row.title,
    currentPrice: Number(row.currentPrice),
    quantity: row.quantity,
    quantitySold: row.quantitySold,
    views: row.views,
    watchers: row.watchers,
    listingFormat: row.listingFormat,
    condition: row.condition,
    listingQuality: mergedListingQuality,
  };

  const identityResultCache = new Map();
  const { result } = await buildValuation({ listing, telemetry, identityResultCache });

  return NextResponse.json({ result, telemetry });
}
