import { NextRequest,NextResponse } from "next/server";
import { readOperatorSession,OPERATOR_SESSION_COOKIE } from "@/lib/operator-auth";
import { cancelScheduledBid } from "@/lib/scheduled-bids";
export async function POST(request:NextRequest,{params}:{params:{id:string}}){const session=await readOperatorSession(request.cookies.get(OPERATOR_SESSION_COOKIE)?.value);if(!session)return NextResponse.json({error:"Unauthorized"},{status:401});try{return NextResponse.json(await cancelScheduledBid(params.id,session.operatorId));}catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Cancellation failed"},{status:409});}}
