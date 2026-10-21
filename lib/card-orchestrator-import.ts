import type { CardInput, Identity, PricingHandoff } from "./card-orchestrator.ts";
import { money } from "./card-orchestrator-policy.ts";

type Row = Record<string, unknown>;
const str = (value: unknown) => typeof value === "string" ? value.trim() : "";
const row = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
function pricingHandoff(i: Row, p: Row): PricingHandoff | undefined {
  if(!Object.keys(p).length)return undefined;
  const textKey=(value:unknown)=>str(value).toLowerCase().replace(/\s+/g," ");
  const serialKey=(value:unknown)=>str(value).split("/")[0].replace(/^0+(?=\d)/,"");
  const matchesOriginals=str(i.card_id)===str(p.card_id)
    && ["front_sha256","back_sha256"].every(k=>/^[a-f0-9]{64}$/i.test(str(i[k]))&&textKey(i[k])===textKey(p[k]))
    && ["player","season","set","manufacturer","card_number","parallel"].every(k=>textKey(i[k])===textKey(p[k]))
    && serialKey(i.serial_text)===serialKey(p.serial_text||p.serial_number)
    && (Number(i.print_run)||null)===(Number(p.print_run)||null);
  const amount=(value:unknown,positive=false)=>value!==""&&value!=null&&money(Number(value),positive)?Number(value):null;
  return {status:str(p.status)||"unknown",item:matchesOriginals?amount(p.proposed_item_price,true):null,
    shipping:matchesOriginals?amount(p.buyer_shipping):null,updatedAt:str(p.updated_at),
    policyVersion:str(p.pricing_policy_version),source:"artifacts/pricing-queue/queue-state.json",
    matchesOriginals,needsReview:true,reason:[!matchesOriginals?"Pricing source identity/original hashes do not match; amounts withheld.":"",str(p.review_reason),str(p.no_evidence_reason)].filter(Boolean).join(" ")};
}
export type SavedReceiptRow={source:string;data:unknown};
function matchingReceipts(id:string,sku:string,pair:string[],entries:SavedReceiptRow[]) {
  return entries.map(entry=>{
    const r=row(entry.data),archive=row(r.photoArchive);
    const files=[...(Array.isArray(r.files)?r.files:[]),...(Array.isArray(archive.files)?archive.files:[])];
    const hashes=Array.from(new Set([...files.map(f=>str(row(f).sha256)),str(r.frontHash),str(r.backHash)].filter(Boolean).map(h=>h.toLowerCase()))).sort();
    const keys=[str(r.key),str(r.source_key)].filter(Boolean).sort(),cardIds=[str(r.cardId),str(r.card_id)].filter(Boolean).sort();
    return {source:entry.source,keys,cardIds,hashes,liveId:str(r.liveItemId)||str(r.itemId),draftId:str(r.draftId),
      pairMatches:pair.length===2&&pair.every(h=>!!h&&hashes.includes(h.toLowerCase()))};
  }).filter(r=>(r.liveId||r.draftId)&&(r.pairMatches||(!!sku&&r.keys.includes(sku))||(!!id&&r.cardIds.includes(id))));
}
export function savedReceiptDependencies(identityRaw:unknown,entries:SavedReceiptRow[]) {
  const i=row(identityRaw);
  // Use the same receipt matching as import; unrelated cards and editorial metadata cannot wake a hold.
  return matchingReceipts(str(i.card_id),str(i.source_key),[str(i.front_sha256),str(i.back_sha256)],entries)
    .sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
export function applySavedReceipts(input:CardInput,entries:SavedReceiptRow[]):CardInput {
  const receipts:NonNullable<CardInput["savedReceipts"]> = [];
  for(const entry of matchingReceipts(input.id,input.sku,input.photos.map(p=>p.sha256),entries)) {
    const {liveId,draftId}=entry;
    if(!entry.pairMatches)throw new Error(`Saved receipt in ${entry.source} matches card ID/SKU but its original photo pair is missing or different; reconcile before new work`);
    for(const [disposition,itemId] of [["live",liveId],["draft",draftId]] as const) {
      if(!itemId)continue;
      if(!/^\d+$/.test(itemId))throw new Error(`Invalid saved receipt ID in ${entry.source}`);
      if(!receipts.some(r=>r.disposition===disposition&&r.itemId===itemId&&r.source===entry.source))receipts.push({disposition,itemId,source:entry.source});
    }
  }
  if(!receipts.length)return input;
  const live=receipts.find(r=>r.disposition==="live"),draft=receipts.find(r=>r.disposition==="draft");
  return {...input,savedReceipts:receipts,
    knownLive:input.knownLive??(live?{itemId:live.itemId,url:`https://www.ebay.com/itm/${live.itemId}`,observedAt:"",source:`Saved manifest receipt matched both original hashes: ${live.source}; not fresh inventory clearance`}:undefined),
    knownDraft:input.knownDraft??draft?.itemId};
}
export function importLegacyCard(identityRaw: unknown, pricingRaw: unknown, comps: unknown[], observationRaw?: unknown): CardInput {
  const i=row(identityRaw),p=row(pricingRaw),o=row(observationRaw),live=row(o.liveMatch),exception=row(o.identityException);
  const id=str(i.card_id),sku=str(i.source_key);
  if(!id||!sku||Number(i.quantity)!==1)throw new Error("Only individually identified quantity-one cards can enter this pilot");
  const required=["player","season","set","manufacturer","card_number","sport_game","parallel"];
  if(required.some(k=>!str(i[k])))throw new Error("Identity source is missing required fields; retain in identity inbox");
  const condition=str(i.condition_plan);
  if(!["Near mint or better","Excellent","Very good","Poor"].includes(condition))throw new Error("Unrecognized condition; preserve the source override for review");
  const printRun=Number(i.print_run)||null,serial=str(i.serial_text);
  if(printRun && !serial)throw new Error("Numbered source has no physical serial");
  const identity:Identity={player:str(i.player),season:str(i.season),set:str(i.set),manufacturer:str(i.manufacturer),cardNumber:str(i.card_number),
    sport:str(i.sport_game),team:str(i.team),parallel:str(i.parallel),serial,printRun,condition:condition as Identity["condition"],
    autograph:/^(yes|true)$/i.test(str(i.autograph))?true:/^(no|false)$/i.test(str(i.autograph))?false:null,
    patch:/patch|jersey|relic|memorabilia/i.test([str(i.memorabilia),str(i.subset_insert)].join(" "))};
  let override:CardInput["override"];
  if(p.user_price_override!==null && p.user_price_override!==undefined && p.user_price_override!=="") {
    const value=typeof p.user_price_override==="number"?p.user_price_override:row(p.user_price_override).item;
    const shipping=row(p.user_price_override).shipping??p.buyer_shipping;
    if(typeof value!=="number"||typeof shipping!=="number")throw new Error("Saved price override needs an explicit item and shipping amount; do not replace it with a formula");
    override={item:value,shipping,evidence:`Preserved explicit user_price_override from pricing queue for ${id}`};
  }
  const itemId=str(live.itemId)||str(i.recorded_live_item_id)||str(p.live_item_id);
  return {id,sku,identity,photos:(["front","back"] as const).map(side=>({side,path:str(i[`${side}_original_path`]),sha256:str(i[`${side}_sha256`]).toLowerCase()})),
    candidates:comps,override,pricingHandoff:pricingHandoff(i,p),source:"artifacts/identity-queue/cards.json + artifacts/pricing-queue/queue-state.json (read only)",
    sourceHold:str(i.hold_reason)||undefined,identityIssue:Object.keys(exception).length?JSON.stringify(exception):str(i.unresolved_fields)||undefined,
    knownLive:itemId?{itemId,url:`https://www.ebay.com/itm/${itemId}`,observedAt:str(p.live_verified_at)||str(i.verified_at),source:Object.keys(live).length?"Saved read-only bulk pilot observation":"Legacy positive listing receipt; not fresh clearance"}:undefined,
    knownDraft:str(i.recorded_draft_id)||str(p.draft_id)||undefined};
}
