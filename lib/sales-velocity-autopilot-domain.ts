export const VELOCITY_AUTOPILOT_VERSION="sales-velocity-autopilot-v1.0.0";
export const VELOCITY_OFFER_DISCOUNT_PCT=8;
export const VELOCITY_OFFER_MAX_PER_RUN=25;
export const VELOCITY_UNKNOWN_COST_OFFER_MAX_PER_DAY=10;
export const VELOCITY_REFRESH_MAX_PER_RUN=10;
export const VELOCITY_REFRESH_CANARY=3;
export const VELOCITY_APPROVAL_TEXT="I APPROVE SALES VELOCITY AUTOPILOT V1";
export const calculateVelocityOfferPrice=(price:number)=>Math.ceil(price*(1-VELOCITY_OFFER_DISCOUNT_PCT/100)*100-1e-9)/100;
