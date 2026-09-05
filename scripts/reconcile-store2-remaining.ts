import nextEnv from "@next/env";
const {loadEnvConfig}=nextEnv;loadEnvConfig(process.cwd(),true);
import {readFileSync,writeFileSync,mkdirSync} from "node:fs";
import {dirname} from "node:path";
import {prisma} from "../lib/prisma.ts";
import {getActiveListings,getValidAccessToken,type EbayListingItem} from "../lib/ebay.ts";
import {getBrowseItemByLegacyId,getEbayApplicationAccessToken,type EbayBrowseItem} from "../lib/ebay-browse.ts";
import {getCategoryAspects} from "../lib/ebay-taxonomy.ts";
import {parseCardIdentity} from "../lib/comp-validation/identity.ts";
import {evaluateStore2MigrationEligibility,normalizeStore2MigrationTitle,orderStore2MigrationSources} from "../lib/store2-migration-selector.ts";

const CSV_PATH="C:\\Users\\josha\\OneDrive\\Desktop\\eBay-all-active-listings-report-2026-08-23-12340890194 (1).csv";
const OUTPUT="artifacts/store2-remaining-reconciliation-2026-08-24.json";
const SOURCE_SELLER="imaydir582";
const SUPPORTED=new Set(["261328","183050"]);
type Csv=Record<string,string>;
type Disposition="READY NOW"|"LOW-RISK POLICY UNLOCK"|"QUANTITY MISMATCH — RECONCILABLE"|"DESTINATION DUPLICATE — CONSOLIDATION CANDIDATE"|"IDENTITY EVIDENCE GAP — POTENTIALLY RECOVERABLE"|"OVERLENGTH ASPECT — POTENTIALLY NORMALIZABLE"|"UNSUPPORTED CATEGORY — POTENTIALLY EXTENDABLE"|"TRUE MANUAL REVIEW"|"DO NOT MIGRATE";
type Result={sourceItemId:string;title:string;disposition:Disposition;reason:string;details:Record<string,unknown>};
type OriginalReadyAudit={sourceItemId:string;title:string;reconcilerDisposition:"READY NOW";canonicalDisposition:string;executionSelectorRule:string;evidence:Record<string,unknown>;assessment:"legitimate safety exclusion"|"implementation inconsistency"|"missing evidence"};
function csv(text:string){const all:string[][]=[];let row:string[]=[],cell="",quoted=false;for(let i=0;i<text.length;i++){const c=text[i];if(quoted){if(c==='"'&&text[i+1]==='"'){cell+='"';i++;}else if(c==='"')quoted=false;else cell+=c;}else if(c==='"')quoted=true;else if(c===","){row.push(cell);cell="";}else if(c==="\n"){row.push(cell.replace(/\r$/, ""));all.push(row);row=[];cell="";}else cell+=c;}if(cell||row.length){row.push(cell.replace(/\r$/, ""));all.push(row);}const head=(all.shift()??[]).map((x,i)=>i?x:x.replace(/^\uFEFF/,""));return all.filter(r=>r.some(Boolean)).map(r=>Object.fromEntries(head.map((h,i)=>[h,r[i]??""])) as Csv);}
const norm=normalizeStore2MigrationTitle;
const aspects=(item:EbayBrowseItem)=>new Map((item.localizedAspects??[]).flatMap(x=>x.name?.trim()&&x.value?.trim()?[[x.name.trim().toLowerCase(),x.value.trim()] as const]:[]));
const images=(item:EbayBrowseItem)=>[item.image?.imageUrl,...(item.additionalImages??[]).map(x=>x.imageUrl)].filter(Boolean);
const destSku=(item:EbayListingItem)=>String(item.SKU??"");
function identityKey(title:string){const x=parseCardIdentity(title);return x.identityCompleteness>=80?x.identityHash:null;}
function result(row:Csv,disposition:Disposition,reason:string,details:Record<string,unknown>={}):Result{return{sourceItemId:row["Item number"],title:row.Title,disposition,reason,details};}

async function main(){
 const rows=csv(readFileSync(CSV_PATH,"utf8")).filter(r=>r.Format==="FIXED_PRICE");
 const store=await prisma.store.findFirstOrThrow({where:{isActive:true,connectionStatus:"connected"}});
 const [{accessToken},browseToken,migrated]=await Promise.all([getValidAccessToken(store),getEbayApplicationAccessToken(),prisma.ebayActionExecution.findMany({where:{action:"MIGRATE_LISTING",status:"verified"},select:{oldEbayItemId:true}})]);
 const migratedIds=new Set(migrated.map(x=>x.oldEbayItemId));
 const remaining=rows.filter(r=>!migratedIds.has(r["Item number"]));
 const destination:EbayListingItem[]=[];for await(const page of getActiveListings(accessToken))destination.push(...page);
 const unique=new Set(destination.map(x=>String(x.ItemID)));if(unique.size!==destination.length)throw new Error("Incomplete destination snapshot: duplicate Item IDs");
 const byTitle=new Map<string,EbayListingItem[]>(),byIdentity=new Map<string,EbayListingItem[]>();
 for(const item of destination){const tk=norm(item.Title),ta=byTitle.get(tk)??[];ta.push(item);byTitle.set(tk,ta);const ik=identityKey(item.Title);if(ik){const ia=byIdentity.get(ik)??[];ia.push(item);byIdentity.set(ik,ia);}}
 const categoryIds=Array.from(new Set(remaining.map(r=>r["eBay category 1 number"]).filter(Boolean)));
 const taxonomy=Object.fromEntries(await Promise.all(categoryIds.map(async id=>{try{const a=await getCategoryAspects(browseToken,id);return[id,{available:true,aspectCount:a.length,names:a.map(x=>x.name),required:a.filter(x=>x.required).map(x=>x.name)}];}catch(error){return[id,{available:false,error:error instanceof Error?error.message:String(error)}];}})));
 const results:Result[]=[];let completed=0;
 const originalReadyAudit:OriginalReadyAudit[]=[];
 const simulatedTitles=new Set(destination.map(item=>norm(item.Title)));
 const simulatedSkus=new Set(destination.map(destSku).filter(Boolean));
 for(const row of orderStore2MigrationSources(remaining)){try{
   const item=await getBrowseItemByLegacyId(browseToken,row["Item number"]);
   const legacyExact=byTitle.get(norm(row.Title))??[],legacyIdentity=identityKey(row.Title),legacyStrong=legacyIdentity?(byIdentity.get(legacyIdentity)??[]):[];
   const legacyMap=aspects(item),legacyOver=Array.from(legacyMap.values()).some(value=>value.length>65),legacyParsed=parseCardIdentity(row.Title);
   const legacyCsvPrice=Number(row["Current price"]),legacyBrowsePrice=Number(item.price?.value),legacyCsvQuantity=Number(row["Available quantity"]),legacyBrowseQuantity=Number(item.estimatedAvailabilities?.[0]?.estimatedAvailableQuantity);
   const wasOriginalReady=item.seller?.username?.toLowerCase()===SOURCE_SELLER&&item.buyingOptions?.includes("FIXED_PRICE")===true&&legacyExact.length===0&&legacyStrong.length===0&&SUPPORTED.has(row["eBay category 1 number"])&&(!item.categoryId||item.categoryId===row["eBay category 1 number"])&&item.title.trim()===row.Title.trim()&&Number.isFinite(legacyCsvPrice)&&Number.isFinite(legacyBrowsePrice)&&Math.abs(legacyCsvPrice-legacyBrowsePrice)<=.005&&Number.isInteger(legacyBrowseQuantity)&&legacyBrowseQuantity>0&&legacyCsvQuantity===legacyBrowseQuantity&&!legacyOver&&Boolean(legacyMap.get("type"))&&Boolean(legacyMap.get("sport"))&&images(item).length>=2&&((row.Condition==="Ungraded"&&item.conditionId==="4000")||(row.Condition==="Graded"&&item.conditionId==="2750"));
   const eligibility=evaluateStore2MigrationEligibility(row,item,{sourceSeller:SOURCE_SELLER,migratedSourceIds:migratedIds,destinationSkus:simulatedSkus,destinationNormalizedTitles:simulatedTitles});
   if(wasOriginalReady){const canonicalDisposition=eligibility.eligible?"EXECUTION READY":eligibility.rule==="DESTINATION_NORMALIZED_TITLE_DUPLICATE"||eligibility.rule==="DESTINATION_MIGRATION_SKU_EXISTS"?"DUPLICATE / CONSOLIDATION":eligibility.rule==="OVERLENGTH_ASPECT"?"OVERLENGTH":eligibility.rule==="REQUIRED_IDENTITY_ASPECTS_MISSING"||eligibility.rule==="COMPLETE_DISTINCT_IMAGE_SET_UNAVAILABLE"?"IDENTITY GAP":eligibility.rule==="UNSUPPORTED_OR_CONFLICTING_CATEGORY"?"UNSUPPORTED":eligibility.rule==="SOURCE_NOT_ACTIVE_FIXED_PRICE"||eligibility.rule==="CSV_BROWSE_QUANTITY_MISMATCH"?"NO LIVE INVENTORY":"MANUAL REVIEW";originalReadyAudit.push({sourceItemId:row["Item number"],title:row.Title,reconcilerDisposition:"READY NOW",canonicalDisposition,executionSelectorRule:eligibility.eligible?"EXECUTION_ELIGIBLE":eligibility.rule,evidence:eligibility.eligible?{categoryId:eligibility.categoryId,quantity:eligibility.quantity,imageCount:eligibility.images.length}:{...eligibility.evidence},assessment:eligibility.eligible?"implementation inconsistency":eligibility.rule.includes("DUPLICATE")?"legitimate safety exclusion":eligibility.rule.includes("IMAGE")||eligibility.rule.includes("IDENTITY")?"missing evidence":"legitimate safety exclusion"});}
   if(eligibility.eligible){
     results.push(result(row,"READY NOW","Canonical governed execution eligibility passed",{rule:"EXECUTION_ELIGIBLE",categoryId:eligibility.categoryId,quantity:eligibility.quantity,imageCount:eligibility.images.length,sport:eligibility.sport}));
     simulatedTitles.add(norm(eligibility.title));simulatedSkus.add(eligibility.sku);
   }else{
     const rule=eligibility.rule,evidence=eligibility.evidence;
     let disposition:Disposition="TRUE MANUAL REVIEW";
     if(["DESTINATION_MIGRATION_SKU_EXISTS","DESTINATION_NORMALIZED_TITLE_DUPLICATE"].includes(rule))disposition="DESTINATION DUPLICATE — CONSOLIDATION CANDIDATE";
     else if(rule==="OVERLENGTH_ASPECT")disposition="OVERLENGTH ASPECT — POTENTIALLY NORMALIZABLE";
     else if(["REQUIRED_IDENTITY_ASPECTS_MISSING","COMPLETE_DISTINCT_IMAGE_SET_UNAVAILABLE"].includes(rule))disposition="IDENTITY EVIDENCE GAP — POTENTIALLY RECOVERABLE";
     else if(rule==="UNSUPPORTED_OR_CONFLICTING_CATEGORY")disposition=SUPPORTED.has(row["eBay category 1 number"])?"TRUE MANUAL REVIEW":"UNSUPPORTED CATEGORY — POTENTIALLY EXTENDABLE";
     else if(rule==="CSV_BROWSE_QUANTITY_MISMATCH")disposition=Number(evidence.browseQuantity)>0?"QUANTITY MISMATCH — RECONCILABLE":"DO NOT MIGRATE";
     else if(["SOURCE_NOT_ACTIVE_FIXED_PRICE","SOURCE_SELLER_MISMATCH"].includes(rule))disposition="DO NOT MIGRATE";
     else if(rule==="UNSUPPORTED_GRADED_CONDITION_MAPPING")disposition="LOW-RISK POLICY UNLOCK";
     results.push(result(row,disposition,rule,{...evidence,executionSelectorRule:rule}));
   }
  }catch(error){const message=error instanceof Error?error.message:String(error);results.push(result(row,/HTTP 404|MISSING_ITEM|not found/i.test(message)?"DO NOT MIGRATE":"TRUE MANUAL REVIEW",message,{executionSelectorRule:"PROVIDER_LOOKUP_FAILURE"}));}
  completed++;if(completed%100===0)process.stderr.write(`reconciled ${completed}/${remaining.length}\n`);
 }
 if(results.length!==remaining.length)throw new Error(`Canonical reconciliation invariant failed: evaluated ${results.length} of ${remaining.length}`);
 const counts=Object.entries(results.reduce((a,r)=>(a[r.disposition]=(a[r.disposition]??0)+1,a),{} as Record<string,number>)).map(([disposition,count])=>({disposition,count,percent:Number((count/results.length*100).toFixed(2))}));
 const duplicateSubtypes=results.filter(r=>r.disposition.startsWith("DESTINATION DUPLICATE")).reduce((a,r)=>{const k=String(r.details.subtype);a[k]=(a[k]??0)+1;return a;},{} as Record<string,number>);
 const categoryCounts=results.reduce((a,r)=>{const source=remaining.find(x=>x["Item number"]===r.sourceItemId)!;const k=source["eBay category 1 number"]||"missing";a[k]=(a[k]??0)+1;return a;},{} as Record<string,number>);
 const originalReadyReasonDistribution=Object.entries(originalReadyAudit.reduce((acc,row)=>{acc[row.executionSelectorRule]=(acc[row.executionSelectorRule]??0)+1;return acc;},{} as Record<string,number>)).map(([rule,count])=>({rule,count}));
 const report={generatedAt:new Date().toISOString(),sourceFixedPriceRows:rows.length,migratedLedgerCount:migratedIds.size,remaining:remaining.length,destinationSnapshot:{active:destination.length,uniqueItemIds:unique.size},counts,duplicateSubtypes,remainingCategoryCounts:categoryCounts,taxonomy,originalReadyAudit:{count:originalReadyAudit.length,reasonDistribution:originalReadyReasonDistribution,results:originalReadyAudit},results};
 mkdirSync(dirname(OUTPUT),{recursive:true});writeFileSync(OUTPUT,JSON.stringify(report,null,2));console.log(JSON.stringify({...report,results:undefined,output:OUTPUT},null,2));
 await prisma.$disconnect();
}
main().catch(async error=>{console.error(error);await prisma.$disconnect();process.exitCode=1;});
