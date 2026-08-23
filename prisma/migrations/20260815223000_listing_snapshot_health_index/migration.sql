-- Support bounded per-listing traffic-window baselines as snapshot history grows.
CREATE INDEX "ListingSnapshot_listingId_capturedAt_idx" ON "ListingSnapshot"("listingId", "capturedAt");
