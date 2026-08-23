import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildGovernedProposal, createGovernedExecution } from "@/lib/governed-ebay-actions";
import { loadInventoryHealth } from "@/lib/inventory-health-data";
import { OPERATOR_SESSION_COOKIE, readOperatorSession } from "@/lib/operator-auth";

export async function POST(request:NextRequest,{params}:{params:{listingId:string}}){
  const session=await readOperatorSession(request.cookies.get(OPERATOR_SESSION_COOKIE)?.value);if(!session)return NextResponse.json({error:"Operator sign-in required"},{status:401});
  const [proposal,data]=await Promise.all([buildGovernedProposal(params.listingId),loadInventoryHealth(new Date(),params.listingId)]);const row=data.rows[0];
  if(!proposal||!proposal.ready)return NextResponse.json({error:"Action is not execution-ready"},{status:409});
  const immutableEvidence=JSON.parse(JSON.stringify({...(row??{}),governedProposal:proposal,capturedAt:data.generatedAt.toISOString()}));
  const decision=await prisma.operatorDecision.create({data:{listingId:proposal.listingId,operatorId:session.operatorId,recommendedAction:proposal.action,doctrineVersion:proposal.doctrineVersion,decision:"follow_recommendation",beforeState:JSON.parse(JSON.stringify(proposal.before)),evidenceSnapshot:immutableEvidence,observationWindowDays:row?.doctrine.observationWindowDays??0}});
  const execution=await createGovernedExecution(decision.id,session.operatorId);
  return NextResponse.redirect(new URL(`/inventory-actions?execution=${execution.id}`,request.url),303);
}
