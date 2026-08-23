import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { evaluateCompAgainstIdentity } from "@/lib/comp-validation/engine";
import { parseCardIdentity } from "@/lib/comp-validation/identity";
import { manualEvidenceToComp, type ManualSoldEvidence } from "@/lib/comp-validation/valuation-service";
import { valueLatestSellerSingles } from "@/lib/seller-single-valuations";

const object=(value:Prisma.JsonValue|null)=>value&&typeof value==="object"&&!Array.isArray(value)?value as Prisma.JsonObject:{};
export async function POST(request:NextRequest,{params}:{params:{seller:string}}){
  const auction=await prisma.sellerOpportunityAuction.findUnique({where:{id:params.seller}});if(!auction||auction.kind!=="single")return NextResponse.json({error:"Single opportunity not found"},{status:404});
  const form=await request.formData();const soldTitle=String(form.get("soldTitle")??"").trim();const soldPrice=Number(form.get("soldPrice"));const shippingRaw=String(form.get("shipping")??"").trim();const shipping=shippingRaw===""?null:Number(shippingRaw);const soldDate=String(form.get("soldDate")??"");const sourceUrl=String(form.get("sourceUrl")??"").trim()||null;const sourceItemId=String(form.get("sourceItemId")??"").trim();const designation=String(form.get("designation")??"") as ManualSoldEvidence["designation"];
  if(!soldTitle||!Number.isFinite(soldPrice)||soldPrice<=0||(shipping!=null&&(!Number.isFinite(shipping)||shipping<0))||!sourceItemId||!["exact","near","proxy"].includes(designation))return NextResponse.json({error:"Complete sold title, positive price, item ID, and evidence designation are required."},{status:400});
  const timestamp=Date.parse(soldDate);if(!Number.isFinite(timestamp)||timestamp>Date.now())return NextResponse.json({error:"Sale date must be valid and not in the future."},{status:400});
  if(sourceUrl){try{const url=new URL(sourceUrl);if(url.protocol!=="https:")throw new Error();}catch{return NextResponse.json({error:"Evidence URL must be a valid HTTPS URL."},{status:400});}}
  const evidence:ManualSoldEvidence={id:randomUUID(),soldTitle,soldPrice,shipping,soldDate:new Date(timestamp).toISOString(),sourceUrl,sourceItemId,designation};const evaluation=evaluateCompAgainstIdentity(manualEvidenceToComp(evidence),parseCardIdentity(auction.title));
  if(!evaluation.tier)return NextResponse.json({error:`Canonical matcher rejected this evidence: ${evaluation.failureReason??"insufficient identity"}.`},{status:409});
  if(designation==="exact"&&evaluation.tier!=="exact")return NextResponse.json({error:"Evidence was designated exact but the canonical matcher classified it as near. Resubmit with a conservative designation."},{status:409});
  const root=object(auction.itemSpecifics),existing=Array.isArray(root.manualSoldEvidence)?root.manualSoldEvidence:[];await prisma.sellerOpportunityAuction.update({where:{id:auction.id},data:{itemSpecifics:{...root,manualSoldEvidence:[...existing,evidence]} as Prisma.InputJsonValue}});await valueLatestSellerSingles({ebayItemIds:[auction.ebayItemId],force:true});
  return NextResponse.redirect(new URL("/seller-opportunities?view=singles&research=saved",request.url),303);
}
