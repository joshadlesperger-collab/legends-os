import { NextRequest, NextResponse } from "next/server";
import { OPERATOR_SESSION_COOKIE, readOperatorSession } from "@/lib/operator-auth";
import { runFreeShippingPhase1Execution } from "@/lib/free-shipping-phase1-executor";

export const dynamic="force-dynamic";
export const maxDuration=300;

export async function POST(request:NextRequest){
  const session=await readOperatorSession(request.cookies.get(OPERATOR_SESSION_COOKIE)?.value);
  if(!session)return NextResponse.json({error:"Operator sign-in required"},{status:401});
  try{
    const body=await request.json() as {phase?:"canary"|"remaining";approvalText?:string};
    if(body.phase!=="canary"&&body.phase!=="remaining")return NextResponse.json({error:"Invalid execution phase"},{status:400});
    const result=await runFreeShippingPhase1Execution({phase:body.phase,operatorId:session.operatorId,approvalText:body.approvalText??""});
    return NextResponse.json(result,{headers:{"Cache-Control":"no-store"}});
  }catch(error){
    return NextResponse.json({error:error instanceof Error?error.message:"Execution failed"},{status:409});
  }
}
