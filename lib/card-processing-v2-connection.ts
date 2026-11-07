/** One seller-verified OAuth connection per bounded V2 run. Never exposes tokens
 * in public capability reports, logs or operation packets. */
type SellerStore = {id:string;oauthAccessToken:string|null;oauthRefreshToken:string|null;tokenExpiresAt:Date|null};
type TokenBundle = {accessToken:string;refreshToken:string;expiresAt:Date};
export type V2SellerConnectionDependencies = {
  findStores:()=>Promise<SellerStore[]>;
  getValidAccessToken:(store:SellerStore,options?:{forceRefresh?:boolean})=>Promise<TokenBundle>;
  getEbayUser:(accessToken:string)=>Promise<{userId:string}>;
  isHardEbayAuthenticationError:(error:unknown)=>boolean;
  setStoredToken:(token:string)=>string;
  updateStore:(id:string,data:{oauthAccessToken:string;oauthRefreshToken:string|null;tokenExpiresAt:Date})=>Promise<unknown>;
};
export function v2SellerAccess(loadDependencies?:()=>Promise<V2SellerConnectionDependencies>) {
  let pending: Promise<string> | undefined;
  return () => pending ??= (async () => {
    let deps:V2SellerConnectionDependencies;
    if(loadDependencies) deps=await loadDependencies();
    else {
      if (!process.env.DATABASE_URL) throw Error("The local seller database connection is not configured.");
      const [{ prisma }, ebay] = await Promise.all([import("./prisma.ts"), import("./ebay.ts")]);
      deps={findStores:()=>prisma.store.findMany({where:{ebaySellerUsername:"imaydit58",isActive:true,connectionStatus:"connected"},take:2}),
        getValidAccessToken:ebay.getValidAccessToken,getEbayUser:ebay.getEbayUser,isHardEbayAuthenticationError:ebay.isHardEbayAuthenticationError,setStoredToken:ebay.setStoredToken,
        updateStore:(id,data)=>prisma.store.update({where:{id},data})};
    }
    const stores = await deps.findStores();
    if (stores.length !== 1) throw Error("Use the supported connection flow for a single imaydit58 seller account.");
    const store = stores[0];
    let bundle:TokenBundle,identity:{userId:string},forcedRefresh=false;
    try {
      bundle = await deps.getValidAccessToken(store);
      try { identity = await deps.getEbayUser(bundle.accessToken); }
      catch(error) {
        if(!deps.isHardEbayAuthenticationError(error)) throw error;
        forcedRefresh=true;
        bundle=await deps.getValidAccessToken(store,{forceRefresh:true});
        identity=await deps.getEbayUser(bundle.accessToken);
      }
    } catch { throw Error("Seller OAuth verification failed. Reconnect through the supported seller connection flow."); }
    if (identity.userId.toLowerCase() !== "imaydit58") throw Error("The authenticated seller does not match the V2 seller binding.");
    if (forcedRefresh || bundle.expiresAt.getTime() !== store.tokenExpiresAt?.getTime()) await deps.updateStore(store.id, {
      oauthAccessToken: deps.setStoredToken(bundle.accessToken), oauthRefreshToken: bundle.refreshToken ? deps.setStoredToken(bundle.refreshToken) : store.oauthRefreshToken, tokenExpiresAt: bundle.expiresAt,
    });
    return bundle.accessToken;
  })();
}

export function v2ConnectionPrerequisites() {
  const keys = ["DATABASE_URL", "TOKEN_ENCRYPTION_KEY", "EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "EBAY_REDIRECT_URI_NAME"] as const;
  const missing = keys.filter(key => !process.env[key]?.trim());
  return { configured: missing.length === 0, missing, seller: "imaydit58", verified: false as const,
    detail: missing.length ? "Configure the existing seller settings privately in the ignored local environment file; never paste values into chat." : "Settings are present; a successful seller-bound OAuth read is still required." };
}
