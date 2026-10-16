/** Card Listing Factory v1 — pure, review-first domain logic. No eBay writes. */
import type { PricingReview } from "./card-pricing-review.ts";
export type Sport = "Baseball" | "Football" | "Basketball" | "Hockey" | "Soccer" | "Other";
export type CardIdentity = {
  sport: Sport; player: string; year: number; manufacturer: string; set: string;
  cardNumber: string; team?: string; parallel?: string; serialNumber?: string;
  numberedTo?: number; rookie?: boolean; autograph?: boolean; graded?: boolean;
  grade?: string; condition?: string;
};
export type DraftCard = {
  identity: CardIdentity; quantity: number; frontImageId?: string; backImageId?: string;
  manualTitle?: string; lockedFields?: string[]; verified: boolean;
  pricing?: PricingReview;
  automation?: { message: string; warnings: string[] };
};
export type ListingProjection = {
  title: string; specifics: Record<string, string>; description: string;
  storageLocation: string; quantity: number; requiresReview: boolean; reviewReasons: string[];
};
const words = (s: string) => s.trim().replace(/\s+/g, " ");
const validQuantity = (n: number) => Number.isSafeInteger(n) && n >= 1;
const identityError = (c: CardIdentity) => {
  if (!c.player.trim() || !c.set.trim() || !c.manufacturer.trim() || !c.cardNumber.trim()) return "Missing card identity";
  if (!Number.isInteger(c.year) || c.year < 1880 || c.year > 2100) return "Invalid card year";
  if ((c.serialNumber && !c.numberedTo) || (c.numberedTo && !c.serialNumber)) return "Incomplete serial numbering";
  if (c.numberedTo !== undefined && (!Number.isSafeInteger(c.numberedTo) || c.numberedTo < 1)) return "Invalid print run";
  if (c.graded && !c.grade?.trim()) return "Grade required for a graded card";
  if (!c.graded && c.grade?.trim()) return "Grade requires a graded card";
  if (c.serialNumber && c.numberedTo) {
    const match = /^(\d+)(?:\/(\d+))?$/.exec(c.serialNumber.trim());
    if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) < 1 || Number(match[1]) > c.numberedTo || (match[2] && Number(match[2]) !== c.numberedTo)) return "Invalid serial number";
  }
  return null;
};
export function storageLocation(c: CardIdentity): string {
  const last = words(c.player).split(" ").at(-1) ?? "";
  const initial = last.normalize("NFKD").replace(/[^A-Za-z]/g, "").charAt(0).toUpperCase();
  return `${c.sport} / ${initial || "?"}`;
}
export function canonicalCardKey(c: CardIdentity): string {
  const parts = [c.sport,c.player,c.year,c.manufacturer,c.set,c.cardNumber,c.parallel??"",
    c.numberedTo??"",c.serialNumber??"",c.graded?"graded":"raw",c.grade??"",c.condition??"",c.rookie??false,c.autograph??false,c.team??""];
  return parts.map(x=>words(String(x)).toLowerCase()).join("|");
}
export function canMergeQuantities(a: CardIdentity,b: CardIdentity): boolean {
  // Individually numbered cards must remain distinct even if photos look similar.
  if (identityError(a) || identityError(b) || a.numberedTo || b.numberedTo || a.serialNumber || b.serialNumber) return false;
  return canonicalCardKey(a) === canonicalCardKey(b);
}
export function generateTitle(c: CardIdentity): string {
  const prefix = [String(c.year),c.manufacturer,c.set,c.player,`#${c.cardNumber}`];
  const suffix = [c.parallel??"",c.numberedTo?`/${c.numberedTo}`:"",c.rookie?"RC":"",c.autograph?"Auto":"",c.team??"",c.graded?c.grade??"":""];
  const trim = (parts:string[]) => words(parts.filter(Boolean).join(" "));
  const combined=[...prefix,...suffix];
  const result = trim(combined);
  if (result.length <= 80) return result;
  // Remove optional team then redundant manufacturer cumulatively. Keep RC/Auto and parallel.
  for (const index of [9,1]) {
    combined[index]="";
    const candidate=trim(combined);
    if(candidate.length<=80) return candidate;
  }
  // Never silently cut essential identity information: flag via projection review instead.
  return result;
}
export function projectListing(draft: DraftCard): ListingProjection {
  const c=draft.identity;
  const issues:string[]=[];
  const problem=identityError(c);
  if(problem) issues.push(problem);
  if(!validQuantity(draft.quantity)) issues.push("Quantity must be a positive integer");
  if(draft.quantity !== 1) issues.push("Photo review supports one physical card per pair; quantity must be 1");
  if(!draft.frontImageId || !draft.backImageId) issues.push("Front and back images required");
  if(draft.frontImageId && draft.frontImageId === draft.backImageId) issues.push("Front and back must be different photos");
  if(!draft.verified) issues.push("Card identification requires approval");
  const generatedTitle=generateTitle(c);
  const title=draft.manualTitle ? words(draft.manualTitle) : generatedTitle;
  if(title.length>80) issues.push("Title exceeds eBay's 80-character limit");
  if(draft.manualTitle && title!==generatedTitle) issues.push("Manually edited title: reconcile card identity before publishing");
  const specifics:Record<string,string>={
    Sport:c.sport, Player:c.player, Year:String(c.year), Manufacturer:c.manufacturer,
    Set:c.set, "Card Number":c.cardNumber, "Graded":c.graded?"Yes":"No",
    "Autographed":c.autograph?"Yes":"No",
  };
  if(c.team) specifics.Team=c.team;
  if(c.parallel) specifics["Parallel/Variety"]=c.parallel;
  if(c.numberedTo) { specifics.Features="Serial Numbered"; specifics["Print Run"]=String(c.numberedTo); specifics["Serial Number"]=`${c.serialNumber?.split("/")[0]}/${c.numberedTo}`; }
  if(c.rookie) specifics["Rookie"]= "Yes";
  if(c.grade) specifics.Grade=c.grade;
  if(c.condition) specifics.Condition=c.condition;
  const details=[`${c.year} ${c.manufacturer} ${c.set} ${c.player} #${c.cardNumber}`,
    c.parallel, c.numberedTo?`Serial numbered ${c.serialNumber?.split("/")[0]}/${c.numberedTo}`:undefined,
    c.team, c.rookie?"Rookie":undefined, c.autograph?"Autographed":undefined,
    c.graded?`Grade: ${c.grade ?? "unspecified"}`:undefined, c.condition?`Condition: ${c.condition}`:undefined].filter(Boolean).join(" · ");
  const description=`${details}\n\nYou will receive the exact card pictured. Please inspect both photos for corners, edges, centering, and surface condition. Card is ${c.graded?"graded":"ungraded"}; no additional grade is guaranteed. Packaged securely for shipping.`;
  return {title,specifics,description,storageLocation:storageLocation(c),quantity:draft.quantity,
    requiresReview:issues.length>0,reviewReasons:issues};
}
export function applyIdentityCorrection(draft:DraftCard,correction:Partial<CardIdentity>):DraftCard {
  // Recompute every dependent field from identity, not from a stale title.
  return {...draft,identity:{...draft.identity,...correction},verified:false,manualTitle:undefined};
}
/** Listing price premium over a verified sold comp; percent is 8–10, default 9. */
export function priceFromSoldComp(comp:number,premiumPercent=9):number {
  if(!Number.isFinite(comp)||comp<=0)throw new Error("A verified positive sold comp is required");
  if(!Number.isFinite(premiumPercent)||premiumPercent<8||premiumPercent>10)throw new Error("Comp premium must be between 8% and 10%");
  const price=Math.round(comp*(1+premiumPercent/100)*100)/100;
  if(!Number.isFinite(price))throw new Error("Listing price exceeds supported range");
  return price;
}
export function suggestedShipping(price:number,needsTracked:boolean):number {
  if(!Number.isFinite(price)||price<=0)throw new Error("Invalid listing price");
  return needsTracked||price>=20?6.29:price>=10?1.95:1.49;
}
