// Deliberately read-only: this diagnostic cannot create, replace, or publish objects.
export async function probeInventoryOffers({token, skus, fetcher = fetch}) {
  if (!token || !Array.isArray(skus) || !skus.length || skus.length > 2 || skus.some(s => typeof s !== 'string' || !s.trim())) throw new Error('Token and one or two explicit SKUs required');
  const results = [];
  for (const sku of [...new Set(skus)]) {
    const start = performance.now();
    try {
      const url = new URL('https://api.ebay.com/sell/inventory/v1/offer');
      url.searchParams.set('sku', sku);
      const response = await fetcher(url, {method:'GET', headers:{Authorization:`Bearer ${token}`,Accept:'application/json'}, signal:AbortSignal.timeout(15000)});
      const body = await response.json();
      results.push({sku,httpStatus:response.status,elapsedMs:performance.now()-start,
        // No raw error messages or headers: they can contain sensitive context.
        errorIds:(body.errors ?? []).map(e=>e.errorId),
        offers:response.ok?(body.offers ?? []).map(o=>({offerId:o.offerId,status:o.status,marketplaceId:o.marketplaceId,listingPolicies:o.listingPolicies})):[],
        completeRead:response.ok && !body.next});
    } catch { results.push({sku,status:'transport-or-response-failure',elapsedMs:performance.now()-start}); }
  }
  return {kind:'live-read-only-inventory-probe',writesPerformed:0,results,
    creationAllowed:false,reason:'An empty offer response does not clear Seller Hub drafts, active listings, sold receipts or capture ownership.'};
}
