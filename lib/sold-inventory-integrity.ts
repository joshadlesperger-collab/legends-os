import { parseCardIdentity } from "./comp-validation/identity.ts";

export type SoldInventoryClassification = "HIGH CONFIDENCE — LIKELY SOLD INVENTORY" | "REVIEW — POSSIBLE SOLD INVENTORY" | "SAFE / EXPLAINED";

export type SoldInventoryActive = {
  id:string; ebayItemId:string; title:string; price:number; quantity:number; startTime:Date|null; sku:string|null;
  itemSpecifics:unknown; quantitySold:number; maxObservedQuantity:number; authoritativeObservedAt:Date|null;
};
export type SoldInventorySale = {id:string; ebayItemId:string|null; title:string; quantity:number; soldAt:Date; price:number; cancelled:boolean};
export type SoldInventoryResult = {
  listing:SoldInventoryActive; classification:SoldInventoryClassification; priorSale:SoldInventorySale|null;
  matchType:"SAME_ITEM_ID"|"NEW_ITEM_ID_IDENTITY"|null; confidence:number; evidence:string[]; reason:string;
};

const text=(value:string)=>value.toLowerCase().replace(/[’']/g,"").replace(/[^a-z0-9]+/g," ").trim();
export function legacyTitleFamily(title:string){return text(title.replace(/\.{1,3}\s*$/, ""));}
const aspects=(value:unknown)=>{
  if(!value||typeof value!=="object"||Array.isArray(value))return {} as Record<string,string[]>;
  return Object.fromEntries(Object.entries(value as Record<string,unknown>).map(([key,row])=>[key.toLowerCase(),Array.isArray(row)?row.map(String):[String(row)]]));
};
function enrichedTitle(row:SoldInventoryActive){
  const source=aspects(row.itemSpecifics);const values=(...names:string[])=>names.flatMap(name=>source[name.toLowerCase()]??[]).filter(Boolean);
  return [row.title,...values("Player/Athlete","Year","Season","Year Manufactured","Manufacturer","Brand","Set","Card Number","Parallel/Variety","Professional Grader","Grade")].join(" ");
}
type ParsedIdentity=ReturnType<typeof parseCardIdentity>;
function identityEvidence(active:SoldInventoryActive,sale:SoldInventorySale,parsed?:{active:ParsedIdentity;sale:ParsedIdentity}){
  const a=parsed?.active??parseCardIdentity(enrichedTitle(active)),s=parsed?.sale??parseCardIdentity(sale.title);const evidence:string[]=[];
  const eq=(label:string,left:unknown,right:unknown)=>{if(left!=null&&right!=null&&text(String(left))===text(String(right))){evidence.push(`${label}: ${left}`);return true;}return false;};
  const player=eq("Player",a.player,s.player),year=eq("Year",a.year,s.year),card=eq("Card number",a.cardNumber,s.cardNumber);
  const product=eq("Product/set",a.setName,s.setName)||eq("Manufacturer",a.manufacturer,s.manufacturer);
  const conflicts=[a.parallel&&s.parallel&&text(a.parallel)!==text(s.parallel),a.gradeCompany&&s.gradeCompany&&a.gradeCompany!==s.gradeCompany,a.gradeValue!=null&&s.gradeValue!=null&&a.gradeValue!==s.gradeValue,a.serialNumber!=null&&s.serialNumber!=null&&a.serialNumber!==s.serialNumber,a.printRun!=null&&s.printRun!=null&&a.printRun!==s.printRun,a.rawOrGraded!==s.rawOrGraded].some(Boolean);
  const sensitive=["Parallel",a.parallel,s.parallel,"Grade company",a.gradeCompany,s.gradeCompany,"Grade",a.gradeValue,s.gradeValue,"Serial",a.serialNumber,s.serialNumber,"Print run",a.printRun,s.printRun] as const;
  for(let i=0;i<sensitive.length;i+=3)if(sensitive[i+1]!=null&&sensitive[i+2]!=null&&String(sensitive[i+1])===String(sensitive[i+2]))evidence.push(`${sensitive[i]}: ${sensitive[i+1]}`);
  return {strong:player&&year&&card&&product&&!conflicts,near:player&&year&&product&&!conflicts,conflicts,evidence};
}

export function assessSoldInventory(input:{active:SoldInventoryActive[];sales:SoldInventorySale[];historicalTitles:string[]}){
  const salesByItem=new Map<string,SoldInventorySale[]>(),salesByFamily=new Map<string,SoldInventorySale[]>(),salesByIdentity=new Map<string,Array<{sale:SoldInventorySale;identity:ParsedIdentity}>>();
  const identityKeys=(identity:ParsedIdentity)=>{if(!identity.player||identity.year==null)return[];const base=`${text(identity.player)}|${identity.year}`;return [identity.setName?`${base}|set:${text(identity.setName)}`:null,identity.manufacturer?`${base}|maker:${text(identity.manufacturer)}`:null].filter((row):row is string=>Boolean(row));};
  for(const sale of input.sales.filter(row=>!row.cancelled&&row.quantity>0)){if(sale.ebayItemId){const rows=salesByItem.get(sale.ebayItemId)??[];rows.push(sale);salesByItem.set(sale.ebayItemId,rows);}const family=legacyTitleFamily(sale.title),rows=salesByFamily.get(family)??[];rows.push(sale);salesByFamily.set(family,rows);const identity=parseCardIdentity(sale.title);for(const key of identityKeys(identity)){const matches=salesByIdentity.get(key)??[];matches.push({sale,identity});salesByIdentity.set(key,matches);}}
  const familyCounts=new Map<string,number>();for(const title of input.historicalTitles){const key=legacyTitleFamily(title);familyCounts.set(key,(familyCounts.get(key)??0)+1);}
  let migratedExclusions=0,legacyDuplicateFamilyExclusions=0,sameItemIdReappearances=0,newItemIdIdentityMatches=0;
  const results=input.active.filter(listing=>listing.quantity===1).map(listing=>{
    const safe=(reason:string,evidence:string[]=[]):SoldInventoryResult=>({listing,classification:"SAFE / EXPLAINED",priorSale:null,matchType:null,confidence:100,evidence,reason});
    if(/^\s*(?:\(\s*[2-9]\d*\s*\)|[2-9]\d*\s*(?:card|cards|ct)\b)|\b(?:lot of|card lot|cards lot)\b/i.test(listing.title))return safe("Title identifies multiple physical cards despite a single listing quantity");
    if(/^MIG-\d+$/i.test(listing.sku??"")){migratedExclusions++;return safe("Store #2 migration provenance explains the Store #1 listing");}
    if(listing.quantitySold>1||listing.maxObservedQuantity>1)return safe("Authoritative listing history supports multiple physical copies");
    const same=(salesByItem.get(listing.ebayItemId)??[]).sort((a,b)=>b.soldAt.getTime()-a.soldAt.getTime());
    const eligibleSame=same.find(sale=>listing.startTime!=null&&listing.startTime>sale.soldAt);
    if(eligibleSame){
      if(same.reduce((sum,row)=>sum+row.quantity,0)>1)return safe("Multiple sold units are recorded for this Item ID",[`Recorded sold units: ${same.reduce((sum,row)=>sum+row.quantity,0)}`]);
      sameItemIdReappearances++;return {listing,classification:"HIGH CONFIDENCE — LIKELY SOLD INVENTORY",priorSale:eligibleSame,matchType:"SAME_ITEM_ID",confidence:100,evidence:["Exact eBay Item ID","Single-unit sale","Active listing start is after sale"],reason:"The same single-quantity eBay Item ID sold and later appears active again"};
    }
    const family=legacyTitleFamily(listing.title),activeIdentity=parseCardIdentity(enrichedTitle(listing));const pool=new Map<string,{sale:SoldInventorySale;identity:ParsedIdentity}>();for(const sale of salesByFamily.get(family)??[])pool.set(sale.id,{sale,identity:parseCardIdentity(sale.title)});for(const key of identityKeys(activeIdentity))for(const row of salesByIdentity.get(key)??[])pool.set(row.sale.id,row);
    const candidates=Array.from(pool.values()).filter(({sale})=>sale.quantity===1&&sale.ebayItemId!==listing.ebayItemId&&listing.startTime!=null&&listing.startTime>sale.soldAt).map(({sale,identity})=>({sale,match:identityEvidence(listing,sale,{active:activeIdentity,sale:identity}),exactFamily:legacyTitleFamily(sale.title)===family})).filter(row=>row.match.strong||(row.exactFamily&&row.match.near)).sort((a,b)=>Number(b.match.strong)-Number(a.match.strong)||b.sale.soldAt.getTime()-a.sale.soldAt.getTime());
    const candidate=candidates[0];if(!candidate)return safe(listing.startTime?"No qualifying authoritative prior sale match":"Listing start date is unavailable; chronology cannot be proven");
    const duplicateFamily=(familyCounts.get(family)??0)>1;
    if(duplicateFamily&&candidate.exactFamily){legacyDuplicateFamilyExclusions++;return safe("Legacy trailing-period duplicate family may represent separate physical inventory",candidate.match.evidence);}
    const relatedSales=candidates.filter(row=>row.match.strong);if(relatedSales.length>1)return safe("Multiple authoritative prior sales support multiple physical copies",[`Matching prior sales: ${relatedSales.length}`]);
    newItemIdIdentityMatches++;
    const punctuationAmbiguous=/\.{1,3}\s*$/.test(listing.title)||/\.{1,3}\s*$/.test(candidate.sale.title);
    if(candidate.match.strong&&candidate.exactFamily&&!punctuationAmbiguous)return {listing,classification:"HIGH CONFIDENCE — LIKELY SOLD INVENTORY",priorSale:candidate.sale,matchType:"NEW_ITEM_ID_IDENTITY",confidence:98,evidence:["Different eBay Item ID",...candidate.match.evidence,"Exact normalized title family","Active listing start is after sale"],reason:"A strongly identified single card sold under a prior Item ID and later reappeared under a new Item ID"};
    if(candidate.match.strong&&candidate.exactFamily&&punctuationAmbiguous)return {listing,classification:"REVIEW — POSSIBLE SOLD INVENTORY",priorSale:candidate.sale,matchType:"NEW_ITEM_ID_IDENTITY",confidence:94,evidence:["Different eBay Item ID",...candidate.match.evidence,"Exact punctuation-normalized title family","Trailing punctuation may be a legacy physical-copy discriminator","Active listing start is after sale"],reason:"The identity strongly matches a prior sale, but legacy trailing punctuation prevents proof that it is the same physical copy"};
    return {listing,classification:"REVIEW — POSSIBLE SOLD INVENTORY",priorSale:candidate.sale,matchType:"NEW_ITEM_ID_IDENTITY",confidence:candidate.match.strong?92:80,evidence:["Different eBay Item ID",...candidate.match.evidence,"Active listing start is after sale"],reason:"Deterministic identity evidence suggests reappearance, but exact proof is incomplete"};
  });
  return {results,metrics:{activeSingleQuantity:input.active.filter(row=>row.quantity===1).length,highConfidence:results.filter(row=>row.classification.startsWith("HIGH")).length,review:results.filter(row=>row.classification.startsWith("REVIEW")).length,safe:results.filter(row=>row.classification.startsWith("SAFE")).length,sameItemIdReappearances,newItemIdIdentityMatches,migratedExclusions,legacyDuplicateFamilyExclusions}};
}
