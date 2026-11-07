import {NextRequest,NextResponse} from 'next/server';
import {OPERATOR_SESSION_COOKIE,readOperatorSession} from '@/lib/operator-auth';
import {readV2PriceCheckReport} from '@/lib/card-processing-v2-price-check-report';
import {projectV2UnpublishedPriceReport} from '@/lib/card-processing-v2-selected-publication';

export const runtime='nodejs';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store'};

export async function GET(req:NextRequest){
 const operator=await readOperatorSession(req.cookies.get(OPERATOR_SESSION_COOKIE)?.value);
 if(!operator)
  return NextResponse.json({error:'Sign in to review saved draft prices.'},{status:401,headers});
 try{return NextResponse.json(await projectV2UnpublishedPriceReport(await readV2PriceCheckReport(),operator.operatorId),{headers});}
 catch{return NextResponse.json({error:'The saved report is unavailable. No prices were changed and no market check was started.'},{status:503,headers});}
}
