import { CURRENT_CARD_PRICE_POLICY, MINIMUM_CARD_ITEM } from "./card-price-policy.ts";
import { createHash } from "node:crypto";
import type { batchPacket } from "./card-batch.ts";

export type DraftPacket = ReturnType<typeof batchPacket>;
export type HostedCardPhoto = { originalHash:string; url:string; expiresAt:string; uprightReviewed:boolean };
export const DRAFT_HEADERS = ["Action(SiteID=US|Country=US|Currency=USD|Version=1193|CC=UTF-8)","Custom label (SKU)","Category ID","Title","UPC","Price","Quantity","Item photo URL","Condition ID","Description","Format"];
const categoryIds:Record<string,string>={"CCG Individual Cards":"183454","Sports Trading Card Singles":"261328"};
const cell=(v:string|number)=>`"${String(v).replace(/"/g,'""')}"`;
const html=(v:string)=>v.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");

/** Exact names from the seller's policy UI; not IDs inferred from similar names.
 * These are category-template inputs, not proof that the Draft importer persists them.
 * Existing draft IDs must use the editor, never another Draft upload.
 */
export function categoryDraftCompletionFields(input:{conditionLabel:string;shippingPolicyName:string;paymentPolicyName:string;returnPolicyName:string;location:string;existingDraftId?:string}) {
  if(input.existingDraftId)throw Error("Existing draft: repair the saved ID; do not create another Draft row");
  // Only the NM value has been checked against this retained category template.
  if(input.conditionLabel!=="Near mint or better")throw Error("Condition requires exact category-template verification");
  for(const key of ["shippingPolicyName","paymentPolicyName","returnPolicyName","location"] as const)
    if(!input[key]?.trim()||/[\r\n]/.test(input[key]))throw Error(`Missing or invalid ${key}`);
  return {"Condition ID":"4000","CD:Card Condition - (ID: 40001)":`${input.conditionLabel} - (ID: 400010)`,
    "Shipping profile name":input.shippingPolicyName,"Payment profile name":input.paymentPolicyName,
    "Return profile name":input.returnPolicyName,"Location":input.location};
}

/** Input must come from verifiedBatchPacket, never a client-supplied price packet.
 * The minimal official template omits shipping/specifics: retain them in the
 * companion verification manifest, and finish these fields in bulk on eBay.
 */
export function bulkDraftExport(packet:DraftPacket,photos:HostedCardPhoto[],now=Date.now()) {
  const blockers:string[]=[],rows:(string|number)[][]=[],seen=new Set<string>();
  const existing=packet.listings.filter(c=>c.receipts.length||c.quantityPlan.route==="review-existing-quantity");
  const fresh=packet.listings.filter(c=>!existing.includes(c));
  for(const c of fresh){
    const category=categoryIds[c.category??""];
    if(c.pricingPolicy!=="seller-manual-price-v1" && (c.pricingPolicy!==CURRENT_CARD_PRICE_POLICY || !/^[a-f0-9]{64}$/.test(c.pricingEvidenceKey??"") || !(Date.parse(c.pricingEvidenceExpiresAt??"")>now)))blockers.push(`${c.sku}: current pricing policy and unexpired evidence required`);
    if(!category)blockers.push(`${c.sku}: unsupported category`);
    if(!c.title||c.title.length>80||!Number.isInteger(c.quantity)||!c.quantity||c.quantity<1)blockers.push(`${c.sku}: title/quantity requires review`);
    if(!Number.isFinite(c.item)||c.item<MINIMUM_CARD_ITEM||!Number.isFinite(c.shipping)||c.shipping<0)blockers.push(`${c.sku}: valid draft price/shipping required`);
    if(!c.sku||seen.has(c.sku)||/^\s*[=+@-]/.test(c.sku)||/^\s*[=+@-]/.test(c.title))blockers.push(`${c.id}: unsafe or repeated SKU/title`);
    seen.add(c.sku);
    const urls=[c.originals.frontHash,...c.originals.backHashes].map(hash=>{
      const p=photos.find(p=>p.originalHash===hash&&p.uprightReviewed&&Number.isFinite(Date.parse(p.expiresAt))&&Date.parse(p.expiresAt)>now+86400000);
      if(!p){blockers.push(`${c.sku}: upright hosted photo missing or expires within 24 hours (${hash.slice(0,12)})`);return "";}
      try{const u=new URL(p.url);if(u.protocol!=="https:"||u.username||u.password||/[|\r\n]/.test(p.url)||!/(^|\.)ebayimg\.com$/i.test(u.hostname))throw Error();}
      catch{blockers.push(`${c.sku}: photo requires an eBay-hosted HTTPS URL`);return "";}
      return p.url;
    });
    // 4000 is eBay's ungraded card condition. Detailed condition stays in
    // the description/manifest for the bulk editor's condition descriptors.
    if(!/^ungraded$/i.test(String(c.identity.conditionType??"")))blockers.push(`${c.sku}: explicitly reviewed Ungraded condition type required`);
    rows.push(["Draft",c.sku,category??"",c.title,"",c.item.toFixed(2),c.quantity??0,urls.join("|"),"4000",`<p>${html(c.description)}</p>`,"FixedPrice"]);
  }
  if(!fresh.length)blockers.push("No new drafts to create; resume existing receipts instead.");
  const csv=blockers.length?null:["#INFO,Version=0.0.2,Template= eBay-draft-listings-template_US,,,,,,,,",DRAFT_HEADERS.map(cell).join(","),...rows.map(r=>r.map(cell).join(","))].join("\r\n")+"\r\n";
  // Finish unsupported template fields by shared bulk selections, not one card
  // at a time. These are instructions, never executable publication actions.
  const bulkEdits=new Map<string,{skus:string[];shipping:number;shippingService:string;specifics:typeof fresh[number]["specifics"];condition:string}>();
  for(const card of fresh){
    const values={shipping:card.shipping,shippingService:card.shippingService,specifics:card.specifics,condition:card.condition};
    const key=JSON.stringify({shipping:values.shipping,shippingService:values.shippingService,condition:values.condition});
    const group=bulkEdits.get(key);if(group){group.skus.push(card.sku);for(const field of Object.keys(group.specifics))if(group.specifics[field]!==card.specifics[field])delete group.specifics[field];}else bulkEdits.set(key,{...values,specifics:{...values.specifics},skus:[card.sku]});
  }
  return {batchId:packet.batchId,generatedAt:new Date(now).toISOString(),canPublish:false as const,ready:!!csv,blockers,csv,
    readinessScope:"csv-import-only" as const,
    submissionReady:false as const,
    requiresPostImportVerification:true as const,
    postImportFields:["condition descriptor","item specifics","shipping policy","payment policy","return policy","item location","offer settings"],
    bulkEditGroups:Array.from(bulkEdits.values()),
    csvSha256:csv?createHash("sha256").update(csv).digest("hex"):null,
    draftCount:fresh.length,physicalCopies:fresh.reduce((n,c)=>n+(c.quantity??0),0),
    existing:existing.map(c=>({sku:c.sku,captureIds:c.captureIds,receipts:c.receipts,quantityPlan:c.quantityPlan})),
    verification:fresh.map(c=>({sku:c.sku,captureIds:c.captureIds,title:c.title,quantity:c.quantity,item:c.item,shipping:c.shipping,specifics:c.specifics,condition:c.condition,offersEnabled:c.offersEnabled,minimumOffer:c.minimumOffer,autoAccept:c.autoAccept,shippingService:c.shippingService,pricingPolicy:c.pricingPolicy,pricingEvidenceKey:c.pricingEvidenceKey,originals:c.originals})),
    nextSteps:["Run fresh orchestrator preflight and inventory/shipping checks before uploading.","Upload this file once through Seller Hub Reports; retain the upload result report.","Finish shared shipping, item specifics, condition and offers in the bulk editor; save drafts only.","Match saved draft IDs by SKU and verify photos, quantity, draft price and shipping.","Unknown upload outcome: reconcile the result report and saved IDs before retrying any row.","Archive originals through verified record-receipt only; CSV generation is not verification."]};
}
