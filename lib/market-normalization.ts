import { createHash } from "node:crypto";
import type { CardCatalog } from "./card-knowledge.ts";
import type { MarketIndexEntry } from "./market-collection.ts";
import { productHint } from "./card-market-review.ts";

export const normalizationVersion = "market-research-v1";
export const key = (kind:string, value:unknown) => `${kind}:${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0,24)}`;
const words = (s:string) => ` ${s.normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim()} `;
export type Evidence = { sourceRef:string; provider:string; itemCents:number|null; shippingCents:number|null; currency:string|null; soldDate:string|null; datePrecision:string; priceStatus:string; units:number|null; constructedTitle:boolean; reportedOfferCents?:number|null };
export function cents(value:unknown):number|null {
  if(typeof value!=="number" || !Number.isFinite(value) || value<0)return null;
  const result=Math.round(value*100);return Number.isSafeInteger(result)?result:null;
}
export function displayedCents(value:unknown):number|null {
  if(typeof value!=="string" || !/^\$[\d,]+(?:\.\d{2})?$/.test(value.trim()))return null;
  return cents(Number(value.replace(/[$,]/g,"")));
}
export function normalizeIdentity(row:MarketIndexEntry,catalog:CardCatalog) {
  const title=row.title, normalized=words(title);
  const names=Array.from(new Set(catalog.cards.map(c=>c.player))).filter(name=>normalized.includes(words(name)));
  const players=names.map(name=>({id:key("athlete",words(name).trim()),name,status:"name-match-provisional"}));
  const seasons=Array.from(new Set(Array.from(title.matchAll(/\b((?:19|20)\d{2})(?:[-/]((?:19|20)\d{2}|\d{2}))?\b/g)).map(m=>m[2]?`${m[1]}-${m[2].slice(-2)}`:m[1])));
  const season=seasons.length===1?seasons[0]:null;
  // Family routing is independent of season; an unresolved title remains unresolved.
  const family=productHint(title.replace(/\b(?:19|20)\d{2}(?:[-/](?:(?:19|20)\d{2}|\d{2}))?\b/g,"2025"));
  const release=season&&!/unresolved|Other sport|Conflicting/.test(family)?{id:key("release",[family,season]),family,season,status:"title-proposal"}:null;
  const printRuns=Array.from(new Set(Array.from(title.matchAll(/\/\s*(\d{1,5})\b/g)).filter(m=>m.index===0||!/(?:19|20)\d{2}$/.test(title.slice(Math.max(0,m.index!-4),m.index))).map(m=>Number(m[1]))));
  const printRun=printRuns.length===1?printRuns[0]:null;
  const finishes=Array.from(new Set(Array.from(title.matchAll(/\b(x[- ]?fractor|raywave|ray wave|wave|refractor|prism|shimmer|sparkle|speckle|geometric|geo|mojo|lava|pulsar|superfractor|negative)\b/gi)).map(m=>m[1].toLowerCase().replace(/[- ]/g,"").replace(/^raywave$/,"raywave").replace(/^geometric$/,"geo"))));
  const colors=Array.from(new Set(Array.from(title.matchAll(/\b(gold|silver|red|blue|green|purple|orange|pink|magenta|aqua|yellow|black|white)\b/gi)).filter(m=>!(m[1].toLowerCase()==="black"&&/chrome\s+$/i.test(title.slice(0,m.index)))).map(m=>m[1].toLowerCase())));
  const rwb=/\bRWB\b|\bred\s*[,/&-]?\s*white\s*(?:and|&|\/|-)?\s*blue\b/i.test(title);
  if (/\bhyper\b/i.test(title)) finishes.push('hyper');
  if (/\bbasketball\s+(?:border\s+)?refractor\b/i.test(title)) finishes.push('basketball');
  const explicitBase=/\bbase\b/i.test(title)&&!finishes.length&&!colors.length&&!printRuns.length&&!rwb;
  const parallelLabel=[...(rwb?['red white blue']:colors),...finishes,printRun?`/${printRun}`:""].filter(Boolean).join(" ") || (explicitBase?"base":"unknown");
  const ambiguous=(colors.length>1&&!rwb)||printRuns.length>1;
  const parallel=release&&parallelLabel!=="unknown"&&!ambiguous?{id:key("parallel",[release.id,parallelLabel]),label:parallelLabel,printRun,status:"title-proposal"}:null;
  const grade=title.match(/\b(PSA|BGS|SGC|CGC)\s*(\d+(?:\.\d+)?)\b/i);
  const condition=grade?`${grade[1].toUpperCase()} ${grade[2]}`:/\b(?:PSA|BGS|SGC|CGC|graded)\b/i.test(title)||row.flags.some(f=>f==="graded"||f==="graded_card")?"graded-unspecified":/\braw\b/i.test(title)?"raw-described":"ungraded-unspecified";
  const autograph=/\b(?:auto|autograph|autographs|signed)\b/i.test(title)?"autograph-described":"autograph-unresolved";
  const variation=/\b(?:variation|variations|image|photo|SSP|SP)\b/i.test(title)?"variation-described":"variation-unresolved";
  const language=/\b(?:Japanese|Chinese|Spanish|French|German|English)\b/i.exec(title)?.[0].toLowerCase()??"language-unresolved";
  const excluded=/\blot\b|you pick|pick your|\b(?:box|pack|case|sealed|break|repack)\b/i.test(title)||row.flags.some(f=>["provider_lot","provider_accessory","provider_mystery","sealed_product","provider_sealed"].includes(f));
  const entry=catalog.cards.find(c=>c.id===row.proposedChecklistEntryId);
  return {players,release,parallel,condition,autograph,variation,language,entryId:row.proposedChecklistEntryId,section:entry?.section??null,variantId:entry&&parallel?key("variant",[entry.id,parallel.id,autograph,variation,language]):null,excluded,ambiguity:ambiguous||players.length!==1||row.flags.includes("source_title_conflict"),seasonCandidates:seasons};
}
export function normalizeListing(row:MarketIndexEntry,evidence:Evidence[],catalog:CardCatalog) {
  const identity=normalizeIdentity(row,catalog);
  const known=evidence.filter(e=>e.itemCents!==null);
  const conflict=new Set(known.map(e=>`${e.currency}:${e.itemCents}`)).size>1;
  const hidden=evidence.some(e=>e.priceStatus==="accepted-price-unknown");
  const aggregate=evidence.some(e=>e.units!==null&&e.units>1);
  const preferred=[...known].sort((a,b)=>Number(b.priceStatus==="auction-displayed")-Number(a.priceStatus==="auction-displayed")||a.sourceRef.localeCompare(b.sourceRef))[0];
  const blockers=[...(conflict?["conflicting-source-prices"]:[]),...(hidden?["accepted-price-unknown"]:[]),...(aggregate?["multi-unit-average"]:[]),...(identity.excluded?["not-single-card"]:[]),...(identity.ambiguity?["identity-ambiguous"]:[]),...(!preferred?["price-missing"]:[])];
  const tier=blockers.length?"held":preferred?.priceStatus==="auction-displayed"?"displayed-auction":"reported-uncertain";
  return {itemId:row.itemId,title:row.title,...identity,evidence,price:{itemCents:preferred?.itemCents??null,shippingCents:preferred?.shippingCents??null,currency:preferred?.currency??null,date:preferred?.soldDate??null,datePrecision:preferred?.datePrecision??"unknown",status:preferred?.priceStatus??"missing",sourceRef:preferred?.sourceRef??null,tier,blockers},flags:row.flags,pricingEligible:false,verifiedTransactionPrice:null};
}
export type NormalizedListing=ReturnType<typeof normalizeListing>;
export function comparisons(rows:NormalizedListing[],includeUncertain=false) {
  const groups=new Map<string,{dimension:string;label:string;cohort:string;rows:NormalizedListing[]}>();
  for(const r of rows){
    if(r.price.tier==="held"||(!includeUncertain&&r.price.tier!=="displayed-auction")||!r.release||r.players.length!==1||!r.parallel||!r.price.date||r.price.datePrecision==="approximate"||r.price.currency!=="USD"||!r.price.itemCents)continue;
    const month=r.price.date.slice(0,7),copyScope=[r.autograph,r.variation,r.language].join(" / ");
    const dimensions=[{dimension:"player",label:r.players[0].name,cohort:[r.release.family,r.release.season,r.section??"section unresolved",r.parallel.label,r.condition,month]},
      {dimension:"product",label:r.release.family,cohort:[r.players[0].name,r.release.season,r.section??"section unresolved",r.parallel.label,r.condition,month]},
      {dimension:"season",label:r.release.season,cohort:[r.players[0].name,r.release.family,r.section??"section unresolved",r.parallel.label,r.condition,month]},
      {dimension:"parallel",label:r.parallel.label,cohort:[r.players[0].name,r.release.family,r.release.season,r.entryId??"entry unresolved",r.condition,month]}];
    for(const d of dimensions){if((d.dimension==="parallel"&&!r.entryId)||(!r.section&&d.dimension!=="parallel"))continue;const cohort=[...d.cohort,copyScope].join(" · "),id=JSON.stringify([d.dimension,cohort,d.label]);const group=groups.get(id)??{dimension:d.dimension,label:d.label,cohort,rows:[]};group.rows.push(r);groups.set(id,group);}
  }
  const median=(a:number[])=>{const v=[...a].sort((a,b)=>a-b);return v.length%2?v[Math.floor(v.length/2)]:(v[v.length/2-1]+v[v.length/2])/2;};
  const result=Array.from(groups.values()).filter(g=>g.rows.length>=3).map(g=>({dimension:g.dimension,label:g.label,cohort:g.cohort,count:g.rows.length,medianItemCents:median(g.rows.map(r=>r.price.itemCents!)),minItemCents:Math.min(...g.rows.map(r=>r.price.itemCents!)),maxItemCents:Math.max(...g.rows.map(r=>r.price.itemCents!)),uncertainCount:g.rows.filter(r=>r.price.tier!=="displayed-auction").length,itemIds:g.rows.map(r=>r.itemId)}));
  const peers=new Map<string,number>();for(const g of result){const k=g.dimension+g.cohort;peers.set(k,(peers.get(k)??0)+1);}
  return result.map(g=>({...g,comparableGroups:g.dimension==="season" && new Set(result.filter(p=>p.dimension===g.dimension&&p.cohort===g.cohort).map(p=>p.label.slice(0,4))).size<2?1:peers.get(g.dimension+g.cohort)!})).sort((a,b)=>b.comparableGroups-a.comparableGroups||b.count-a.count);
}
