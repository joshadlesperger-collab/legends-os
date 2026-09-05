import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateStore2MigrationEligibility,
  findOverlengthMigrationAspects,
  getStore2MigrationAspectValues,
  normalizeStore2MigrationTitle,
  orderStore2MigrationSources,
} from "../lib/store2-migration-selector.ts";
import type { EbayBrowseItem } from "../lib/ebay-browse.ts";

const row = (index: number) => ({
  "Item number": String(350_000_000_000 + index),
  Condition: "Ungraded",
  "Available quantity": "1",
  "eBay category 1 number": "261328",
});

test("qualified listings beyond the first 400 remain discoverable", () => {
  const ordered = orderStore2MigrationSources(
    Array.from({ length: 650 }, (_, index) => row(index)),
  );
  const migratedOrExcluded = new Set(
    ordered.slice(0, 500).map((source) => source["Item number"]),
  );

  const selected = ordered
    .filter((source) => !migratedOrExcluded.has(source["Item number"]))
    .slice(0, 100);

  assert.equal(ordered.length, 650);
  assert.equal(selected.length, 100);
  assert.equal(selected[0]["Item number"], row(500)["Item number"]);
  assert.equal(selected[99]["Item number"], row(599)["Item number"]);
});

test("priority ordering remains unique without a fixed source window", () => {
  const raw = Array.from({ length: 450 }, (_, index) => row(index));
  const graded = {
    ...row(700),
    Condition: "Graded",
  };
  const duplicate = { ...graded };

  const ordered = orderStore2MigrationSources([...raw, graded, duplicate]);

  assert.equal(ordered[0]["Item number"], graded["Item number"]);
  assert.equal(ordered.length, 451);
  assert.equal(
    ordered.filter(
      (source) => source["Item number"] === graded["Item number"],
    ).length,
    1,
  );
  assert.equal(ordered.at(-1)?.["Item number"], row(449)["Item number"]);
});

test("multi-quantity listings beyond the former first-80 window remain discoverable", () => {
  const multi = Array.from({ length: 205 }, (_, index) => ({
    ...row(800 + index),
    "Available quantity": "2",
  }));

  const ordered = orderStore2MigrationSources(multi);

  assert.equal(ordered.length, 205);
  assert.equal(ordered.at(-1)?.["Item number"], multi.at(-1)?.["Item number"]);
});

test("lossless multi-value fields can cross the 65-character provider limit", () => {
  const league =
    "National Collegiate Athletic Association (NCAA), National Football League (NFL)";
  const features =
    "Base Set, Chase, Exclusive, Insert, Parallel/Variety, Serial Numbered, Short Print, SP";

  assert.deepEqual(getStore2MigrationAspectValues("League", league), [
    "National Collegiate Athletic Association (NCAA)",
    "National Football League (NFL)",
  ]);
  assert.deepEqual(getStore2MigrationAspectValues("Features", features), [
    "Base Set",
    "Chase",
    "Exclusive",
    "Insert",
    "Parallel/Variety",
    "Serial Numbered",
    "Short Print",
    "SP",
  ]);
});

test("identity-sensitive or unsplittable overlength values remain blocked", () => {
  assert.equal(
    getStore2MigrationAspectValues("Player/Athlete", "x".repeat(66)),
    null,
  );
  assert.equal(
    getStore2MigrationAspectValues("Team", "x".repeat(66)),
    null,
  );
  assert.equal(
    getStore2MigrationAspectValues("League", "x".repeat(66)),
    null,
  );
  assert.deepEqual(
    findOverlengthMigrationAspects([{ name: "League", value: "x".repeat(66) }]),
    [{ name: "League", value: "x".repeat(66) }],
  );
});

function eligibleRow(itemId: string, title = "2025 Topps Test Player #1") {
  return {
    "Item number": itemId,
    Title: title,
    Format: "FIXED_PRICE",
    Condition: "Ungraded",
    "Current price": "4.95",
    "Available quantity": "1",
    "eBay category 1 number": "261328",
  };
}

function eligibleBrowse(itemId: string, title = "2025 Topps Test Player #1") {
  return {
    itemId: `v1|${itemId}|0`,
    title,
    categoryId: "261328",
    conditionId: "4000",
    seller: { username: "imaydir582" },
    buyingOptions: ["FIXED_PRICE"],
    price: { value: "4.95", currency: "USD" },
    estimatedAvailabilities: [{ estimatedAvailableQuantity: 1 }],
    image: { imageUrl: "https://example.test/front.jpg" },
    additionalImages: [{ imageUrl: "https://example.test/back.jpg" }],
    localizedAspects: [
      { name: "Sport", value: "Baseball" },
      { name: "Type", value: "Sports Trading Card" },
    ],
  } as unknown as EbayBrowseItem;
}

const emptyContext = () => ({
  sourceSeller: "imaydir582",
  migratedSourceIds: new Set<string>(),
  destinationSkus: new Set<string>(),
  destinationNormalizedTitles: new Set<string>(),
});

test("canonical eligibility preserves the proven execution safeguards", () => {
  const source = eligibleRow("358000000001");
  const browse = eligibleBrowse(source["Item number"]);
  assert.equal(
    evaluateStore2MigrationEligibility(source, browse, emptyContext()).eligible,
    true,
  );

  const duplicateContext = emptyContext();
  duplicateContext.destinationNormalizedTitles.add(
    normalizeStore2MigrationTitle(source.Title),
  );
  assert.deepEqual(
    evaluateStore2MigrationEligibility(source, browse, duplicateContext),
    {
      eligible: false,
      sourceId: source["Item number"],
      sku: `MIG-${source["Item number"]}`,
      rule: "DESTINATION_NORMALIZED_TITLE_DUPLICATE",
      evidence: { normalizedTitle: normalizeStore2MigrationTitle(source.Title) },
    },
  );
});

test("canonical eligibility accepts only proven lossless overlength fields", () => {
  const source = eligibleRow("358000000021");
  const browse = eligibleBrowse(source["Item number"]);
  browse.localizedAspects!.push({
    name: "League",
    value:
      "National Collegiate Athletic Association (NCAA), National Football League (NFL)",
  });
  assert.equal(
    evaluateStore2MigrationEligibility(source, browse, emptyContext()).eligible,
    true,
  );

  browse.localizedAspects!.push({ name: "Player/Athlete", value: "x".repeat(66) });
  const blocked = evaluateStore2MigrationEligibility(source, browse, emptyContext());
  assert.equal(blocked.eligible, false);
  if (!blocked.eligible) assert.equal(blocked.rule, "OVERLENGTH_ASPECT");
});

test("reported READY NOW and canonical execution-eligible populations are identical", () => {
  const rows = [
    eligibleRow("358000000011", "2025 Topps Alpha #1"),
    eligibleRow("358000000012", "2025 Topps Beta #2"),
    eligibleRow("358000000013", "2025 Topps Alpha #1"),
  ];
  const context = emptyContext();
  const executionEligible: string[] = [];
  const reportedReady: string[] = [];

  for (const source of orderStore2MigrationSources(rows)) {
    const outcome = evaluateStore2MigrationEligibility(
      source,
      eligibleBrowse(source["Item number"], source.Title),
      context,
    );
    if (!outcome.eligible) continue;
    executionEligible.push(source["Item number"]);
    reportedReady.push(source["Item number"]);
    context.destinationNormalizedTitles.add(
      normalizeStore2MigrationTitle(outcome.title),
    );
    context.destinationSkus.add(outcome.sku);
  }

  assert.deepEqual(reportedReady, executionEligible);
  assert.deepEqual(executionEligible, ["358000000011", "358000000012"]);
});
