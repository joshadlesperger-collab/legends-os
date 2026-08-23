export const SELLER_BID_STATUSES=["DRAFT","SCHEDULED","ARMED","SUBMITTING","SUBMITTED","WON","LOST","CANCELLED","SKIPPED","FAILED"] as const;
export type SellerBidStatus=(typeof SELLER_BID_STATUSES)[number];
export const CANCELLABLE_BID_STATUSES:readonly SellerBidStatus[]=["DRAFT","SCHEDULED","ARMED"];
export function canCancelScheduledBid(status:SellerBidStatus){return CANCELLABLE_BID_STATUSES.includes(status);}
export function recoveryStatus(status:SellerBidStatus,leaseExpired:boolean,alreadySubmitted:boolean):SellerBidStatus{return leaseExpired&&!alreadySubmitted&&(status==="ARMED"||status==="SUBMITTING")?"SCHEDULED":status;}
export type SellerBidMode="BID_NOW"|"SNIPE";

export type SellerBidExecutionRecord={id:string;idempotencyKey:string;opportunityId:string;ebayItemId:string;mode:SellerBidMode;status:SellerBidStatus;maxBid:number;snipeOffsetSeconds:number|null;requestedAt:string;scheduledSubmissionAt:string|null;auctionEndAt:string;actualSubmissionAt:string|null;providerResult:unknown|null};

export function normalizeSnipeOffset(value:number,defaultSeconds=7){const candidate=Number.isFinite(value)?Math.trunc(value):defaultSeconds;return Math.max(5,Math.min(300,candidate));}
export function scheduledSubmissionAt(auctionEndAt:string,offsetSeconds:number){const end=new Date(auctionEndAt).getTime();return Number.isFinite(end)?new Date(end-normalizeSnipeOffset(offsetSeconds)*1_000).toISOString():null;}
export function validateBidDraft(input:{maxBid:number|null;auctionEndAt:string;now?:Date}){if(input.maxBid==null||!Number.isFinite(input.maxBid)||input.maxBid<=0)return{ok:false as const,reason:"Enter Your Max Bid"};if(new Date(input.auctionEndAt).getTime()<=(input.now??new Date()).getTime())return{ok:false as const,reason:"Auction has ended"};return{ok:true as const};}
export function validateBidSubmission(input:{status:SellerBidStatus;maxBid:number;currentRequiredBid:number;auctionEndAt:string;now?:Date}){if(["SUBMITTED","WON","LOST","CANCELLED"].includes(input.status))return{ok:false as const,reason:"Bid record is not submit-ready"};const draft=validateBidDraft({maxBid:input.maxBid,auctionEndAt:input.auctionEndAt,now:input.now});if(!draft.ok)return draft;if(!Number.isFinite(input.currentRequiredBid)||input.currentRequiredBid<=0)return{ok:false as const,reason:"Live required bid is unavailable"};if(input.currentRequiredBid>input.maxBid)return{ok:false as const,reason:"Live required bid exceeds Your Max Bid"};return{ok:true as const};}
export type LiveAuction={browseItemId:string;legacyItemId:string|null;title:string;active:boolean;auctionEndAt:string;currentRequiredBid:number|null;buyerUserId:string};
export type OfferResult={offerId?:string;raw:Record<string,unknown>};
export interface BidExecutionProvider{getAuction(itemId:string):Promise<LiveAuction>;placeProxyBid(itemId:string,maxBid:number,currency:string):Promise<OfferResult>}
export type ExecutionInput={browseItemId:string;legacyItemId:string|null;title:string;buyerUserId:string;auctionEndAt:string;operatorMaxBid:number;currency:string;status:SellerBidStatus;alreadySubmitted:boolean;now:Date};
export async function executeBidAttempt(input:ExecutionInput,provider:BidExecutionProvider){
  if(input.alreadySubmitted||["SUBMITTED","WON","LOST","CANCELLED"].includes(input.status))return{status:"SKIPPED" as const,reason:"A successful or terminal execution already exists"};
  const live=await provider.getAuction(input.browseItemId);
  if(live.browseItemId!==input.browseItemId||(input.legacyItemId&&live.legacyItemId!==input.legacyItemId))return{status:"SKIPPED" as const,reason:"Item identity changed"};
  if(live.buyerUserId!==input.buyerUserId)return{status:"SKIPPED" as const,reason:"Authenticated Sandbox buyer does not match"};
  if(!live.active||new Date(live.auctionEndAt).getTime()<=input.now.getTime())return{status:"SKIPPED" as const,reason:"Auction is no longer active"};
  if(Math.abs(new Date(live.auctionEndAt).getTime()-new Date(input.auctionEndAt).getTime())>2_000)return{status:"SKIPPED" as const,reason:"Auction end time materially changed"};
  if(live.currentRequiredBid==null||live.currentRequiredBid>input.operatorMaxBid)return{status:"SKIPPED" as const,reason:"Current required bid exceeds Operator Max Bid or is unavailable"};
  try{return{status:"SUBMITTED" as const,result:await provider.placeProxyBid(input.browseItemId,input.operatorMaxBid,input.currency)};}catch(error){return{status:"FAILED" as const,reason:error instanceof Error?error.message:"Offer API failure"};}
}
