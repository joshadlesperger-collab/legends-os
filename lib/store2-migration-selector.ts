export type Store2MigrationSourceRow = Record<string, string>;

import type { EbayBrowseItem } from "./ebay-browse";

export const STORE2_MIGRATION_SUPPORTED_CATEGORIES = new Set([
  "261328",
  "183050",
]);

export const STORE2_MIGRATION_EXCLUDED_SOURCE_IDS = new Set([
  "358541944109",
  "358847656958",
  "358847631794",
  "358847669697",
  "358847683279",
  "358541944254",
  "358541944288",
  "358541944300",
  "358847645700",
  "358847656916",
]);

export const STORE2_MIGRATION_LOSSLESS_MULTI_VALUE_ASPECTS = new Set([
  "features",
  "league",
]);

const GRADER_IDS: Record<string, string> = {
  "Professional Sports Authenticator (PSA)": "275010",
  "Beckett Collectors Club Grading (BCCG)": "275011",
  "Beckett Vintage Grading (BVG)": "275012",
  "Beckett Grading Services (BGS)": "275013",
  "Certified Sports Guaranty (CSG)": "275014",
  "Certified Guaranty Company (CGC)": "275015",
  "Sportscard Guaranty Corporation (SGC)": "275016",
  "Gem Mint Authentication (GMA)": "275018",
  Other: "2750123",
};

const GRADE_IDS: Record<string, string> = {
  "10": "275020",
  "9.5": "275021",
  "9": "275022",
  "8.5": "275023",
  "8": "275024",
  "7.5": "275025",
  "7": "275026",
  "6.5": "275027",
  "6": "275028",
};

export type Store2MigrationEligibilityContext = {
  sourceSeller: string;
  migratedSourceIds: ReadonlySet<string>;
  destinationSkus: ReadonlySet<string>;
  destinationNormalizedTitles: ReadonlySet<string>;
};

export type Store2MigrationEligibilityResult =
  | {
      eligible: true;
      sourceId: string;
      sku: string;
      title: string;
      price: number;
      quantity: number;
      categoryId: string;
      conditionId: string;
      condition: string;
      conditionDescriptors: Array<{
        name: string;
        value: string;
        additionalInfo?: string;
      }>;
      images: string[];
      specifics: Array<{ name: string; value: string }>;
      sport: string;
    }
  | {
      eligible: false;
      sourceId: string;
      sku: string;
      rule: string;
      evidence: Record<string, unknown>;
    };

export function normalizeStore2MigrationTitle(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Convert a provider aspect into the exact logical values that should be sent
 * to eBay. Values at or below the provider limit are unchanged. Only the two
 * non-identity fields proven through VerifyAddFixedPriceItem are eligible for
 * lossless comma-delimited splitting.
 */
export function getStore2MigrationAspectValues(
  name: string,
  value: string,
  maximumLength = 65,
): string[] | null {
  const normalizedName = name.trim().toLowerCase();
  const trimmedValue = value.trim();
  if (!trimmedValue) return null;
  if (trimmedValue.length <= maximumLength) return [trimmedValue];
  if (!STORE2_MIGRATION_LOSSLESS_MULTI_VALUE_ASPECTS.has(normalizedName)) {
    return null;
  }

  const values = trimmedValue
    .split(/\s*,\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (values.length < 2 || values.some((part) => part.length > maximumLength)) {
    return null;
  }
  return values;
}

function rejected(
  sourceId: string,
  sku: string,
  rule: string,
  evidence: Record<string, unknown> = {},
): Store2MigrationEligibilityResult {
  return { eligible: false, sourceId, sku, rule, evidence };
}

/**
 * Canonical, non-mutating Store #2 migration eligibility policy.
 *
 * This is deliberately the proven execution selector policy. Reporting must
 * call this function rather than maintaining a looser READY NOW definition.
 */
export function evaluateStore2MigrationEligibility(
  row: Store2MigrationSourceRow,
  browse: EbayBrowseItem,
  context: Store2MigrationEligibilityContext,
): Store2MigrationEligibilityResult {
  const sourceId = row["Item number"];
  const sku = `MIG-${sourceId}`;
  if (STORE2_MIGRATION_EXCLUDED_SOURCE_IDS.has(sourceId)) {
    return rejected(sourceId, sku, "GOVERNED_SOURCE_EXCLUSION");
  }
  if (context.migratedSourceIds.has(sourceId)) {
    return rejected(sourceId, sku, "VERIFIED_MIGRATION_EXISTS");
  }
  if (context.destinationSkus.has(sku)) {
    return rejected(sourceId, sku, "DESTINATION_MIGRATION_SKU_EXISTS", { sku });
  }
  if (browse.seller?.username?.toLowerCase() !== context.sourceSeller.toLowerCase()) {
    return rejected(sourceId, sku, "SOURCE_SELLER_MISMATCH", {
      seller: browse.seller?.username ?? null,
    });
  }
  if (!browse.buyingOptions?.includes("FIXED_PRICE")) {
    return rejected(sourceId, sku, "SOURCE_NOT_ACTIVE_FIXED_PRICE", {
      buyingOptions: browse.buyingOptions ?? [],
    });
  }
  if (browse.title.trim() !== row.Title.trim()) {
    return rejected(sourceId, sku, "CSV_BROWSE_TITLE_MISMATCH", {
      csvTitle: row.Title,
      browseTitle: browse.title,
    });
  }

  const price = Number(row["Current price"]);
  const providerPrice = Number(browse.price?.value);
  if (!Number.isFinite(price) || price <= 0 || Math.abs(providerPrice - price) > 0.005) {
    return rejected(sourceId, sku, "CSV_BROWSE_PRICE_MISMATCH", {
      csvPrice: price,
      browsePrice: providerPrice,
    });
  }

  const quantity = Number(row["Available quantity"]);
  const providerQuantity = Number(
    browse.estimatedAvailabilities?.[0]?.estimatedAvailableQuantity,
  );
  if (!Number.isInteger(quantity) || quantity < 1 || providerQuantity !== quantity) {
    return rejected(sourceId, sku, "CSV_BROWSE_QUANTITY_MISMATCH", {
      csvQuantity: quantity,
      browseQuantity: providerQuantity,
    });
  }

  const normalizedTitle = normalizeStore2MigrationTitle(row.Title);
  if (context.destinationNormalizedTitles.has(normalizedTitle)) {
    return rejected(sourceId, sku, "DESTINATION_NORMALIZED_TITLE_DUPLICATE", {
      normalizedTitle,
    });
  }

  const categoryId = row["eBay category 1 number"];
  if (
    !STORE2_MIGRATION_SUPPORTED_CATEGORIES.has(categoryId) ||
    (browse.categoryId && browse.categoryId !== categoryId)
  ) {
    return rejected(sourceId, sku, "UNSUPPORTED_OR_CONFLICTING_CATEGORY", {
      csvCategory: categoryId,
      browseCategory: browse.categoryId ?? null,
    });
  }

  const images = [
    browse.image?.imageUrl,
    ...(browse.additionalImages ?? []).map((image) => image.imageUrl),
  ].filter((url): url is string => Boolean(url));
  if (images.length < 2 || new Set(images).size !== images.length) {
    return rejected(sourceId, sku, "COMPLETE_DISTINCT_IMAGE_SET_UNAVAILABLE", {
      imageCount: images.length,
      uniqueImageCount: new Set(images).size,
    });
  }

  const specifics = (browse.localizedAspects ?? []).flatMap((aspect) =>
    aspect.name?.trim() && aspect.value?.trim()
      ? [{ name: aspect.name.trim(), value: aspect.value.trim() }]
      : [],
  );
  const blockingOverlength = findOverlengthMigrationAspects(specifics).filter(
    (aspect) => getStore2MigrationAspectValues(aspect.name, aspect.value) === null,
  );
  if (blockingOverlength.length) {
    return rejected(sourceId, sku, "OVERLENGTH_ASPECT", {
      aspects: blockingOverlength,
    });
  }

  const aspectMap = new Map(
    specifics.map((specific) => [specific.name.toLowerCase(), specific.value]),
  );
  if (!aspectMap.get("type") || !aspectMap.get("sport")) {
    return rejected(sourceId, sku, "REQUIRED_IDENTITY_ASPECTS_MISSING", {
      type: aspectMap.get("type") ?? null,
      sport: aspectMap.get("sport") ?? null,
    });
  }

  const autographed = aspectMap.get("autographed");
  const safeSpecifics = specifics.filter((specific) => {
    const key = specific.name.toLowerCase();
    if (
      autographed === "No" &&
      ["signed by", "autograph format", "autograph authentication"].includes(key)
    ) {
      return false;
    }
    if (
      ["player/athlete", "team"].includes(key) &&
      (/\d{1,2}\.\d{1,2}\.\d{2}/.test(specific.value) ||
        specific.value.split(",").length > 2)
    ) {
      return false;
    }
    return true;
  });

  let conditionId: string;
  let condition: string;
  let conditionDescriptors: Array<{
    name: string;
    value: string;
    additionalInfo?: string;
  }>;
  if (row.Condition === "Ungraded" && browse.conditionId === "4000") {
    conditionId = "4000";
    condition = "Ungraded - Near mint or better";
    conditionDescriptors = [{ name: "40001", value: "400010" }];
  } else if (row.Condition === "Graded" && browse.conditionId === "2750") {
    const grader = row["CD:Professional Grader - (ID: 27501)"];
    const grade = row["CD:Grade - (ID: 27502)"];
    const graderId = GRADER_IDS[grader];
    const gradeId = GRADE_IDS[grade];
    if (!graderId || !gradeId) {
      return rejected(sourceId, sku, "UNSUPPORTED_GRADED_CONDITION_MAPPING", {
        grader,
        grade,
      });
    }
    const certification = browse.conditionDescriptors
      ?.find((descriptor) => descriptor.name === "Certification Number")
      ?.values?.[0]?.content;
    conditionId = "2750";
    condition = `Graded - ${grader} ${grade}`;
    conditionDescriptors = [
      { name: "27501", value: graderId },
      { name: "27502", value: gradeId },
      ...(certification
        ? [{ name: "27503", value: "", additionalInfo: certification }]
        : []),
    ];
  } else {
    return rejected(sourceId, sku, "CSV_BROWSE_CONDITION_MISMATCH", {
      csvCondition: row.Condition,
      browseCondition: browse.condition ?? null,
      browseConditionId: browse.conditionId ?? null,
    });
  }

  return {
    eligible: true,
    sourceId,
    sku,
    title: row.Title.trim(),
    price,
    quantity,
    categoryId,
    conditionId,
    condition,
    conditionDescriptors,
    images,
    specifics: safeSpecifics,
    sport: aspectMap.get("sport")!,
  };
}

export function findOverlengthMigrationAspects(
  aspects: Array<{ name?: string; value?: string }>,
  maximumLength = 65,
): Array<{ name: string; value: string }> {
  return aspects.flatMap((aspect) => {
    const name = aspect.name?.trim();
    const value = aspect.value?.trim();
    return name && value && value.length > maximumLength
      ? [{ name, value }]
      : [];
  });
}

/**
 * Preserve the proven migration priority order while returning the complete
 * unique source population. Eligibility is intentionally evaluated later so
 * migrated or ineligible rows near the front cannot hide qualified rows.
 */
export function orderStore2MigrationSources(
  rows: Store2MigrationSourceRow[],
): Store2MigrationSourceRow[] {
  const graded = rows.filter((row) => row.Condition === "Graded");
  const multi = rows.filter((row) => Number(row["Available quantity"]) > 1);
  const otherCategory = rows.filter(
    (row) => row["eBay category 1 number"] !== "261328",
  );
  const raw = rows.filter(
    (row) =>
      row.Condition === "Ungraded" &&
      Number(row["Available quantity"]) === 1,
  );

  const seen = new Set<string>();
  return [...graded, ...multi, ...otherCategory, ...raw].filter((row) => {
    const itemId = row["Item number"];
    if (!itemId || seen.has(itemId)) return false;
    seen.add(itemId);
    return true;
  });
}
