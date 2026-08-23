import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd(), true);

import { prisma } from "../lib/prisma.ts";
import { getItem, getValidAccessToken } from "../lib/ebay.ts";
import { hasLegacyDuplicateDiscriminator, inspectListingTitle, legacyDuplicateTitleKey } from "../lib/title-inspection-agent.ts";
import { createGovernedTitleExecution, ebayWriteProvider, executeGovernedAction, unrelatedProviderState } from "../lib/governed-ebay-actions.ts";

const APPROVAL_ARGUMENT="--execute-approved-title-v2-pilot";
const OPERATOR_ID="operator-approved-title-v2-pilot-2026-08-23";
const APPROVED=[
  ["127890810107","2016 Immaculate Coll. #IQP-RR - Immaculate Quad /99 K. Marte/T.Story","2016 Panini Immaculate Coll. #IQP-RR - Immaculate Quad /99 K. Marte/T.Story"],
  ["127868345069","2024 Stadium Club Paul Skenes Rookie RC Pittsburgh Pirates","2024 Topps Stadium Club Paul Skenes Rookie RC Pittsburgh Pirates #237"],
  ["127857814038","2025 Select FOTL #AM-JC Jackson Chourio Blue Prizm Patch Auto  /35 Bookend","2025 Panini Select FOTL #AM-JC Jackson Chourio Blue Prizm Patch Auto /35 Bookend"],
  ["127857813930","2024 Mosaic Keenan Allen Montage #M-16 Purple /49 Bears","2024 Panini Mosaic Keenan Allen Montage #M-16 Purple /49 Bears"],
  ["127857827720","2024-25 Prizm Black Shawn Kemp Legends Snakeskin Prizm #299 Supersonics","2024-25 Panini Prizm Black Shawn Kemp Legends Snakeskin Prizm #299 Supersonics"],
  ["127868100954","2025 Prizm Premium Set Walter Nolan Pandora /400","2025 Panini Prizm Premium Set Walter Nolan Pandora /400"],
  ["127857813960","2023 Prizm #40 Chuba Hubbard  Red Yellow Choice /44 Panthers","2023 Panini Prizm #40 Chuba Hubbard Red Yellow Choice /44 Panthers"],
  ["127857827627","2024 Prizm D.J. James RC Red Sparkle Rookie #322 Seahawks","2024 Panini Prizm D.J. James RC Red Sparkle Rookie #322 Seahawks"],
  ["127857813941","2024 Gold Standard #118 Chop Robinson RC /99 Miami Dolphins","2024 Panini Gold Standard #118 Chop Robinson RC /99 Miami Dolphins"],
  ["127857813869","2024 Prizm Max Melton RC Red Sparkle Rookie #376 Cardinals","2024 Panini Prizm Max Melton RC Red Sparkle Rookie #376 Cardinals"],
] as const;

function liveActive(item:Awaited<ReturnType<typeof getItem>>){return String(item.SellingStatus?.ListingStatus??"").toLowerCase()==="active"&&Number(item.QuantityAvailable??1)>0;}

async function main(){
  if(!process.argv.includes(APPROVAL_ARGUMENT))throw new Error(`Explicit ${APPROVAL_ARGUMENT} is required`);
  const allTitles=await prisma.listing.findMany({select:{title:true}}),results:Array<Record<string,unknown>>=[];
  for(const[itemId,approvedBefore,approvedAfter]of APPROVED){let executionId:string|null=null;
    try{
      const listing=await prisma.listing.findFirst({where:{ebayItemId:itemId},include:{store:true}});if(!listing||listing.listingStatus!=="active"||listing.title!==approvedBefore)throw new Error("Persisted active title no longer matches approved before-state");
      const siblings=allTitles.map(row=>row.title).filter(title=>legacyDuplicateTitleKey(title)===legacyDuplicateTitleKey(listing.title));if(siblings.length!==1||hasLegacyDuplicateDiscriminator(listing.title,siblings))throw new Error("Unresolved active or historical normalized-title duplicate ambiguity");
      const {accessToken}=await getValidAccessToken(listing.store);const live=await getItem(accessToken,itemId);if(!liveActive(live)||live.Title!==approvedBefore)throw new Error("Live provider state no longer matches approved active before-state");
      const inspection=inspectListingTitle({listingId:listing.id,ebayItemId:itemId,title:live.Title,itemSpecifics:listing.itemSpecifics,evidenceObservedAt:listing.authoritativeObservedAt??listing.lastSyncedAt,legacyDuplicateDiscriminator:false});
      if(inspection.status!=="RECOMMEND"||inspection.confidence!==97||inspection.proposedTitle!==approvedAfter||inspection.proposedTitle.length>80||inspection.conflicts.length||inspection.missingEvidence.length)throw new Error("Live deterministic evidence did not reproduce the approved proposal");
      const unrelatedBefore=unrelatedProviderState(live),execution=await createGovernedTitleExecution(listing.id,OPERATOR_ID);executionId=execution.id;
      if(String((execution.proposedState as Record<string,unknown>).title)!==approvedAfter)throw new Error("Governed proposal differs from the approved title");
      const completed=await executeGovernedAction(execution.id,OPERATOR_ID,ebayWriteProvider,{writesEnabled:true});const verified=await getItem(accessToken,itemId),events=await prisma.ebayActionExecutionEvent.findMany({where:{executionId},orderBy:{sequence:"asc"}});
      results.push({itemId,executionId,decisionId:execution.decisionId,before:approvedBefore,after:verified.Title,status:completed.status,providerVerifiedAt:completed.providerVerifiedAt,unrelatedStateUnchanged:JSON.stringify(unrelatedBefore)===JSON.stringify(unrelatedProviderState(verified)),providerWarnings:events.filter(event=>event.type==="provider_accepted").map(event=>event.snapshot),eventIds:events.map(event=>event.id)});
    }catch(error){results.push({itemId,executionId,status:"failed",error:error instanceof Error?error.message:"Unknown failure"});const systemic=executionId?await prisma.ebayActionExecutionEvent.count({where:{executionId,type:{in:["provider_accepted","unintended_change_detected"]}}}):0;if(systemic)break;}
  }
  console.log(JSON.stringify({approved:APPROVED.length,attempted:results.length,results},null,2));
}
main().finally(()=>prisma.$disconnect()).catch(error=>{console.error(error instanceof Error?error.message:error);process.exitCode=1;});
