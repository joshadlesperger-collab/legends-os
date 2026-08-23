import { Prisma, type Store } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { EbayApiError, getItem, getValidAccessToken, setStoredToken } from "@/lib/ebay";
import { normalizeItemSpecifics } from "@/lib/ebay-sync-domain";

const MAX_CHUNK = 12;

export async function recoverActiveListingEvidenceChunk(store: Store, limit = MAX_CHUNK) {
  const listings = await prisma.listing.findMany({
    where: {
      storeId: store.id,
      listingStatus: "active",
      authoritativeObservedAt: null,
      ebayItemId: { not: "" },
    },
    // Highest expected sales-velocity impact first while retaining stable tie-breakers.
    orderBy: [{ watchers: "desc" }, { currentPrice: "desc" }, { views: "desc" }, { startTime: "asc" }, { id: "asc" }],
    take: Math.max(1, Math.min(limit, MAX_CHUNK)),
    select: { id: true, ebayItemId: true },
  });
  if (!listings.length) return { attempted: 0, recovered: 0, unavailable: 0, remaining: 0 };

  let tokenBundle = await getValidAccessToken(store);
  let accessToken=tokenBundle.accessToken;
  let refreshInFlight:Promise<void>|null=null;
  const persistToken=async()=>{await prisma.store.update({where:{id:store.id},data:{oauthAccessToken:setStoredToken(tokenBundle.accessToken),oauthRefreshToken:tokenBundle.refreshToken?setStoredToken(tokenBundle.refreshToken):store.oauthRefreshToken,tokenExpiresAt:tokenBundle.expiresAt}});};
  await persistToken();
  const authenticatedGetItem=async(itemId:string)=>{try{return await getItem(accessToken,itemId);}catch(error){if(!(error instanceof EbayApiError)||error.code!=="21917053")throw error;if(!refreshInFlight)refreshInFlight=(async()=>{tokenBundle=await getValidAccessToken(store,{forceRefresh:true});accessToken=tokenBundle.accessToken;await persistToken();})();await refreshInFlight;return getItem(accessToken,itemId);}};
  let recovered = 0;
  let unavailable = 0;
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(3, listings.length) }, async () => {
    for (;;) {
      const listing = listings[nextIndex++];
      if (!listing) return;
      const observedAt = new Date();
      try {
        const item = await authenticatedGetItem(listing.ebayItemId);
        const specifics = normalizeItemSpecifics(item);
        await prisma.listing.update({
          where: { id: listing.id },
          data: {
            title: item.Title,
            categoryId: item.PrimaryCategory?.CategoryID == null ? undefined : String(item.PrimaryCategory.CategoryID),
            condition: item.ConditionDisplayName ?? undefined,
            listingFormat: item.ListingType ?? undefined,
            itemSpecifics: specifics ?? Prisma.JsonNull,
            authoritativeSource: "ebay-trading-get-item",
            authoritativeObservedAt: observedAt,
          },
        });
        recovered += 1;
      } catch (error) {
        const permanent = error instanceof EbayApiError && ["17", "INVALID_ITEM_ID", "MISSING_ITEM"].includes(error.code ?? "");
        if (!permanent) throw error;
        await prisma.listing.update({ where: { id: listing.id }, data: { authoritativeSource: "ebay-trading-get-item-unavailable", authoritativeObservedAt: observedAt } });
        unavailable += 1;
      }
    }
  });
  await Promise.all(workers);
  const remaining = await prisma.listing.count({ where: { storeId: store.id, listingStatus: "active", authoritativeObservedAt: null } });
  return { attempted: listings.length, recovered, unavailable, remaining };
}
