import { getStore2MigrationAspectValues } from "./store2-migration-selector.ts";

export type Store2MigrationSpecific = { name: string; value: string };
export type Store2MigrationProviderSpecific = { name: string; values: string[] };

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function serializeStore2MigrationItemSpecificsXml(
  specifics: Store2MigrationSpecific[],
): string {
  return `<ItemSpecifics>${specifics
    .map((specific) => {
      const values = getStore2MigrationAspectValues(
        specific.name,
        specific.value,
      );
      if (!values) {
        throw new Error(`Unsafe migration aspect: ${specific.name}`);
      }
      return `<NameValueList><Name>${escapeXml(specific.name)}</Name>${values
        .map((value) => `<Value>${escapeXml(value)}</Value>`)
        .join("")}</NameValueList>`;
    })
    .join("")}</ItemSpecifics>`;
}

function canonicalValues(name: string, values: string[]): string[] {
  return values
    .flatMap((value) => getStore2MigrationAspectValues(name, value) ?? [value.trim()])
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Reconcile the provider response against the logical source values. This
 * accepts either eBay representation for verified multi-value fields: an
 * array of values or the original comma-delimited value, while still failing
 * closed on missing or changed logical values.
 */
export function findStore2MigrationSpecificDifferences(
  expected: Store2MigrationSpecific[],
  actual: Store2MigrationProviderSpecific[],
): string[] {
  const actualByName = new Map<string, string[]>();
  for (const specific of actual) {
    const key = specific.name.trim().toLowerCase();
    actualByName.set(key, [
      ...(actualByName.get(key) ?? []),
      ...specific.values.map((value) => value.trim()).filter(Boolean),
    ]);
  }

  const differences: string[] = [];
  for (const specific of expected) {
    const expectedValues = getStore2MigrationAspectValues(
      specific.name,
      specific.value,
    );
    if (!expectedValues) {
      differences.push(`specific:${specific.name}`);
      continue;
    }
    const actualValues = actualByName.get(specific.name.trim().toLowerCase());
    if (!actualValues) {
      differences.push(`specific:${specific.name}`);
      continue;
    }
    const left = canonicalValues(specific.name, expectedValues);
    const right = canonicalValues(specific.name, actualValues);
    if (
      left.length !== right.length ||
      left.some((value, index) => value !== right[index])
    ) {
      differences.push(`specific:${specific.name}`);
    }
  }
  return differences;
}
