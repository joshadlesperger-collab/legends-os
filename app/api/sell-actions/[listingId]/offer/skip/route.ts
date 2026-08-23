import {NextRequest,NextResponse} from "next/server";
import {recordSellerOfferSkip} from "@/lib/governed-seller-offers";
import {OPERATOR_SESSION_COOKIE,readOperatorSession} from "@/lib/operator-auth";
export async function POST(request:NextRequest,{params}:{params:{listingId:string}}){const session=await readOperatorSession(request.cookies.get(OPERATOR_SESSION_COOKIE)?.value);if(!session)return NextResponse.json({error:"Operator sign-in required"},{status:401});try{await recordSellerOfferSkip(params.listingId,session.operatorId);return NextResponse.redirect(new URL("/inventory-actions",request.url),303);}catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Seller offer could not be skipped"},{status:409});}}
