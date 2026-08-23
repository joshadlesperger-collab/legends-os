import { NextRequest, NextResponse } from "next/server";
import { executeGovernedAction } from "@/lib/governed-ebay-actions";
import { executeGovernedSellerOffer } from "@/lib/governed-seller-offers";
import {prisma} from "@/lib/prisma";
import { OPERATOR_SESSION_COOKIE, readOperatorSession } from "@/lib/operator-auth";

export async function POST(request:NextRequest,{params}:{params:{id:string}}){
  const session=await readOperatorSession(request.cookies.get(OPERATOR_SESSION_COOKIE)?.value);if(!session)return NextResponse.json({error:"Operator sign-in required"},{status:401});
  try{const execution=await prisma.ebayActionExecution.findUnique({where:{id:params.id},select:{action:true}});if(!execution)return NextResponse.json({error:"Execution not found"},{status:404});if(execution.action==="SEND_OFFER")await executeGovernedSellerOffer(params.id,session.operatorId);else await executeGovernedAction(params.id,session.operatorId);return NextResponse.redirect(new URL(`/inventory-actions?execution=${params.id}`,request.url),303);}catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Execution failed"},{status:409});}
}
