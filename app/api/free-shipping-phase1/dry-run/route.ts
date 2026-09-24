import { NextRequest, NextResponse } from "next/server";
import { OPERATOR_SESSION_COOKIE, readOperatorSession } from "@/lib/operator-auth";
import { runFreeShippingPhase1DryRun } from "@/lib/free-shipping-phase1-runner";

export const dynamic="force-dynamic";
export const maxDuration=60;

export async function POST(request:NextRequest){
  const session=await readOperatorSession(request.cookies.get(OPERATOR_SESSION_COOKIE)?.value);
  if(!session)return NextResponse.json({error:"Operator sign-in required"},{status:401});
  try{
    const result=await runFreeShippingPhase1DryRun();
    return NextResponse.json(result,{headers:{"Cache-Control":"no-store"}});
  }catch(error){
    return NextResponse.json({error:error instanceof Error?error.message:"Dry run failed"},{status:500});
  }
}
