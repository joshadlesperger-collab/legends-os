import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { loadInventoryHealth } from "@/lib/inventory-health-data";
import { OPERATOR_SESSION_COOKIE, readOperatorSession } from "@/lib/operator-auth";
import { isOperatorDecision, observationWindowDays } from "@/lib/operator-decisions";

export async function POST(request:NextRequest,{params}:{params:{listingId:string}}){
  const session=await readOperatorSession(request.cookies.get(OPERATOR_SESSION_COOKIE)?.value);if(!session)return NextResponse.json({error:"Operator sign-in required"},{status:401});
  const form=await request.formData();const decision=String(form.get("decision")||"");if(!isOperatorDecision(decision))return NextResponse.json({error:"Unsupported decision"},{status:400});
  const data=await loadInventoryHealth(new Date(),params.listingId);const row=data.rows[0];if(!row)return NextResponse.json({error:"Active listing not found"},{status:404});
  const adjustedRaw=String(form.get("adjustedValue")||"").trim();const adjustedValue=adjustedRaw?Number(adjustedRaw):null;if(adjustedValue!=null&&(!Number.isFinite(adjustedValue)||adjustedValue<=0))return NextResponse.json({error:"Adjusted value must be positive"},{status:400});
  const immutableEvidence=JSON.parse(JSON.stringify({...row,capturedAt:data.generatedAt.toISOString()}));
  await prisma.operatorDecision.create({data:{listingId:row.id,operatorId:session.operatorId,recommendedAction:row.doctrine.interventionSelected,doctrineVersion:row.doctrine.doctrineVersion,decision,operatorAdjustedValue:adjustedValue,beforeState:{currentPrice:row.currentPrice,quantity:row.quantity,healthScore:row.healthScore,healthState:row.state,saleLikelihood:row.saleLikelihood},evidenceSnapshot:immutableEvidence,observationWindowDays:row.doctrine.observationWindowDays}});
  const next=String(form.get("next")||"/inventory-health");return NextResponse.redirect(new URL(next.startsWith("/")&&!next.startsWith("//")?next:"/inventory-health",request.url),303);
}
