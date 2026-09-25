import {NextRequest,NextResponse} from "next/server";
import {OPERATOR_SESSION_COOKIE,readOperatorSession} from "@/lib/operator-auth";
import {buildVelocityAutopilotPlan} from "@/lib/sales-velocity-autopilot";
export const dynamic="force-dynamic";export const maxDuration=120;
export async function POST(request:NextRequest){
  const session=await readOperatorSession(request.cookies.get(OPERATOR_SESSION_COOKIE)?.value);
  if(!session)return NextResponse.json({error:"Operator sign-in required"},{status:401});
  try{return NextResponse.json(await buildVelocityAutopilotPlan(),{headers:{"Cache-Control":"no-store"}});}
  catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Velocity planning failed"},{status:500});}
}