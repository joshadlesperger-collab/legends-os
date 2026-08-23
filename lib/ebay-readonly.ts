export type EbayReadProbe={provider:string;status:"succeeded"|"failed"|"not-configured";observedAt:string;message:string;httpStatus?:number};
export class EbayReadError extends Error{provider:string;status:number;payload:string;constructor(provider:string,status:number,payload:string){super(`${provider} failed with HTTP ${status}`);this.provider=provider;this.status=status;this.payload=payload}}
export type EbayReadFailureKind="missing-scope"|"seller-program-ineligible"|"marketplace-prerequisite"|"token-persistence"|"rate-limit"|"provider-failure";
export function classifyEbayReadFailure(error:unknown):{kind:EbayReadFailureKind;message:string}{if(!(error instanceof EbayReadError))return{kind:"provider-failure",message:error instanceof Error?error.message:"Unknown provider failure"};const body=error.payload.toLowerCase();if(error.status===401)return{kind:"token-persistence",message:"The persisted access/refresh grant is invalid or expired"};if(error.status===403&&/insufficient permissions|scope/.test(body))return{kind:"missing-scope",message:"The persisted OAuth grant lacks the required API permission"};if(/not eligible|ineligible|program/.test(body))return{kind:"seller-program-ineligible",message:"The seller is not eligible or enrolled for this eBay program"};if(/marketplace|site|prerequisite|terms/.test(body))return{kind:"marketplace-prerequisite",message:"An eBay marketplace, terms, or API prerequisite is unmet"};if(error.status===429)return{kind:"rate-limit",message:"The eBay API rate limit was reached"};return{kind:"provider-failure",message:`eBay returned HTTP ${error.status}`}}
export async function ebayGetJson<T>(provider:string,path:string,accessToken:string,fetcher:typeof fetch=fetch):Promise<T>{
  if(!path.startsWith("/"))throw new Error("eBay read path must be relative");
  const response=await fetcher(`https://api.ebay.com${path}`,{method:"GET",headers:{Authorization:`Bearer ${accessToken}`,Accept:"application/json","X-EBAY-C-MARKETPLACE-ID":"EBAY_US"}});
  if(!response.ok)throw new EbayReadError(provider,response.status,(await response.text()).slice(0,500));
  if(response.status===204)return {} as T;
  const body=await response.text();if(!body.trim())throw new EbayReadError(provider,response.status,"Successful response unexpectedly contained no JSON body");
  return JSON.parse(body) as T;
}
