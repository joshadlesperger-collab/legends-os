/** Successful empty results mean ineligible; absent/failed store reads remain unknown. */
export class StoreOfferEvidence {
  private readonly stores = new Map<string, { ids: Set<string>; observedAt: string }>();

  recordSuccess(storeId: string, ids: Iterable<string>, observedAt: string) {
    this.stores.set(storeId, { ids: new Set(ids), observedAt });
  }

  get(storeId: string, itemId: string): { eligible: boolean | null; observedAt: string | null } {
    const result = this.stores.get(storeId);
    return result
      ? { eligible: result.ids.has(itemId), observedAt: result.observedAt }
      : { eligible: null, observedAt: null };
  }
}
