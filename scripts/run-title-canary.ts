import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd(), true);

import { prisma } from "../lib/prisma.ts";
import { getItem, getValidAccessToken } from "../lib/ebay.ts";
import { loadTitleInspection } from "../lib/title-inspection-data.ts";
import { inspectListingTitle } from "../lib/title-inspection-agent.ts";
import { createGovernedTitleExecution, ebayWriteProvider, executeGovernedAction, unrelatedProviderState } from "../lib/governed-ebay-actions.ts";

const APPROVAL_ARGUMENT = "--execute-approved-10-title-canary";
const SCALE_APPROVAL_ARGUMENT = "--execute-approved-remaining-99";

function liveActive(item: Awaited<ReturnType<typeof getItem>>) {
  const status = String(item.SellingStatus?.ListingStatus ?? "").toLocaleLowerCase();
  if (status !== "active") return false;
  const available = Number(item.QuantityAvailable);
  if (Number.isFinite(available)) return available > 0;
  const quantity = Number(item.Quantity), sold = Number(item.SellingStatus?.QuantitySold ?? 0);
  return !Number.isFinite(quantity) || quantity - sold > 0;
}

function qualityGate(row: Awaited<ReturnType<typeof loadTitleInspection>>["recommendations"][number]) {
  if (row.confidence !== 99 || !row.proposedTitle || row.proposedTitle.length > 80) return false;
  if (row.additions.length !== 1 || row.additions[0]?.aspect !== "Card Number") return false;
  return row.proposedTitle === `${row.currentTitle.trimEnd()} ${row.additions[0].value}`;
}

async function main() {
  const canaryExecution = process.argv.includes(APPROVAL_ARGUMENT), scaleExecution = process.argv.includes(SCALE_APPROVAL_ARGUMENT), scaleMode = scaleExecution || process.argv.includes("--remaining-99"), execute = canaryExecution || scaleExecution;
  if (!execute && !process.argv.includes("--preflight-only")) throw new Error(`Use --preflight-only, ${APPROVAL_ARGUMENT}, or ${SCALE_APPROVAL_ARGUMENT}`);
  const operatorId = scaleMode ? "operator-approved-title-scale-99-2026-08-22" : "operator-approved-title-canary-2026-08-22";
  const benchmark = await loadTitleInspection();
  const candidates = benchmark.recommendations.filter(qualityGate);
  const approved: Array<{ listingId: string; ebayItemId: string; before: string; proposed: string; liveBefore: unknown }> = [];
  const rejected: Array<{ ebayItemId: string; reason: string; providerStatus?: string; quantityAvailable?: number; liveTitleMatches?: boolean }> = [];

  for (const row of candidates) {
    if (!scaleMode && approved.length === 10) break;
    const listing = await prisma.listing.findUnique({ where: { id: row.listingId }, include: { store: true } });
    if (!listing || listing.listingStatus !== "active" || listing.title !== row.currentTitle) { rejected.push({ ebayItemId: row.ebayItemId, reason: "persisted listing state changed" }); continue; }
    const { accessToken } = await getValidAccessToken(listing.store);
    const live = await getItem(accessToken, listing.ebayItemId);
    if (!liveActive(live) || live.Title !== row.currentTitle) { rejected.push({ ebayItemId: row.ebayItemId, reason: !liveActive(live) ? "provider did not return an active available listing" : "live title changed", providerStatus: String(live.SellingStatus?.ListingStatus ?? "missing"), quantityAvailable: Number(live.QuantityAvailable), liveTitleMatches: live.Title === row.currentTitle }); continue; }
    const liveInspection = inspectListingTitle({ listingId: listing.id, ebayItemId: listing.ebayItemId, title: live.Title, itemSpecifics: listing.itemSpecifics, evidenceObservedAt: listing.authoritativeObservedAt ?? listing.lastSyncedAt });
    if (liveInspection.status !== "RECOMMEND" || liveInspection.proposedTitle !== row.proposedTitle || liveInspection.confidence !== 99 || !qualityGate(liveInspection)) { rejected.push({ ebayItemId: row.ebayItemId, reason: "live evidence did not reproduce the approved proposal" }); continue; }
    approved.push({ listingId: listing.id, ebayItemId: listing.ebayItemId, before: row.currentTitle, proposed: row.proposedTitle!, liveBefore: unrelatedProviderState(live) });
  }
  const expected = scaleMode ? candidates.length : Math.min(10, candidates.length);
  if (!scaleMode && approved.length !== expected) { console.log(JSON.stringify({ approved: approved.length, rejected }, null, 2)); throw new Error(`Fail closed: only ${approved.length} live listings passed the ${expected}-item canary preflight`); }
  if (!execute) { console.log(JSON.stringify({ benchmarkGeneratedAt: benchmark.generatedAt, selected: approved.length, approved: approved.map(({ liveBefore: _liveBefore, ...row }) => row) }, null, 2)); return; }

  const results: unknown[] = [];
  for (const candidate of approved) {
    let executionId: string | null = null;
    try {
      const execution = await createGovernedTitleExecution(candidate.listingId, operatorId); executionId = execution.id;
      const completed = await executeGovernedAction(execution.id, operatorId, ebayWriteProvider, { writesEnabled: true });
      const events = await prisma.ebayActionExecutionEvent.findMany({ where: { executionId: execution.id }, orderBy: { sequence: "asc" } });
      results.push({ ebayItemId: candidate.ebayItemId, executionId: execution.id, decisionId: execution.decisionId, before: candidate.before, proposed: candidate.proposed, status: completed.status, providerVerifiedAt: completed.providerVerifiedAt, events: events.map(event => ({ id: event.id, type: event.type, createdAt: event.createdAt, snapshot: event.snapshot })) });
    } catch (error) {
      results.push({ ebayItemId: candidate.ebayItemId, executionId, before: candidate.before, proposed: candidate.proposed, status: "failed", error: error instanceof Error ? error.message : "Unknown failure" });
      const systemic = executionId ? await prisma.ebayActionExecutionEvent.count({ where: { executionId, type: { in: ["provider_accepted", "unintended_change_detected"] } } }) : 0;
      if (systemic) break;
    }
  }
  console.log(JSON.stringify({ benchmarkGeneratedAt: benchmark.generatedAt, eligible: candidates.length, selected: approved.length, skippedPreflight: rejected, results }, null, 2));
}

main().finally(() => prisma.$disconnect()).catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
