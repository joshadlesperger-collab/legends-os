import { parseCardIdentity } from "./comp-validation/identity.ts";
import type { ActiveMarketContext } from "./seller-active-market.ts";

export type ResearchPriority = { score:number; query:string; reasons:string[] };
export function scoreManualResearch(input:{title:string;currentBid:number;endTime:Date;estimatedMarketValue:number|null;confidence:"High"|"Medium"|"Low";active:ActiveMarketContext;now?:Date}):ResearchPriority{
  const now=input.now??new Date(),identity=parseCardIdentity(input.title);let score=0;const reasons:string[]=[];
  if(input.confidence==="Low"){score+=25;reasons.push("sold evidence remains Low confidence");}
  if(input.estimatedMarketValue==null){score+=15;reasons.push("no automatic market value");}
  const hours=Math.max(0,(input.endTime.getTime()-now.getTime())/3_600_000);if(hours<=6){score+=15;reasons.push("auction ends within 6 hours");}else if(hours<=12){score+=8;reasons.push("auction ends within 12 hours");}
  if(identity.printRun!=null){score+=identity.printRun<=25?20:identity.printRun<=99?14:8;reasons.push(`serial numbered /${identity.printRun}`);}
  if(identity.autograph||identity.patch){score+=12;reasons.push(identity.autograph?"autograph":"memorabilia card");}
  if(identity.rookie){score+=8;reasons.push("rookie card");} if(identity.parallel||identity.variation){score+=8;reasons.push("identified parallel or insert");}
  if(input.active.exactActiveCount>0){score+=10;reasons.push(`${input.active.exactActiveCount} exact active listings`);}
  if(input.active.fixedPriceAskLow!=null&&input.active.fixedPriceAskLow>=2*((input.currentBid*1.08)+1.05)){score+=15;reasons.push("lowest exact ask is above the 2× landed-cost threshold");}
  return{score:Math.min(100,score),query:input.active.query,reasons};
}
