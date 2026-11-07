import {NextRequest,NextResponse} from 'next/server';
import {OPERATOR_SESSION_COOKIE,readOperatorSession} from '@/lib/operator-auth';
import {enqueueV2SelectedPublication,getV2SelectedPublicationStatus,V2PublicationError} from '@/lib/card-processing-v2-selected-publication';
export const runtime='nodejs';export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store'};
export async function GET(req:NextRequest){const operator=await readOperatorSession(req.cookies.get(OPERATOR_SESSION_COOKIE)?.value);if(!operator)return NextResponse.json({error:'Sign in to review publication status.'},{status:401,headers});
 try{return NextResponse.json(await getV2SelectedPublicationStatus(operator.operatorId,req.nextUrl.searchParams.get('requestId')??req.nextUrl.searchParams.get('jobId')??undefined),{headers});}catch(e){return NextResponse.json({error:e instanceof V2PublicationError?e.message:'Publication status is unavailable.'},{status:e instanceof V2PublicationError?e.status:503,headers});}}
export async function POST(req:NextRequest){const operator=await readOperatorSession(req.cookies.get(OPERATOR_SESSION_COOKIE)?.value);if(!operator)return NextResponse.json({error:'Sign in to publish selected drafts.'},{status:401,headers});
 if(req.headers.get('origin')!==req.nextUrl.origin)return NextResponse.json({error:'Submit selected drafts from Legends OS.'},{status:403,headers});
 const raw=await req.text();if(raw.length>100_000)return NextResponse.json({error:'Select at most500 drafts.'},{status:413,headers});
 try{return NextResponse.json(await enqueueV2SelectedPublication(operator.operatorId,JSON.parse(raw)),{status:202,headers});}catch(e){return NextResponse.json({error:e instanceof V2PublicationError?e.message:'The selected publication request could not be accepted. No eBay action was started.',code:e instanceof V2PublicationError?e.code:'PUBLICATION_UNAVAILABLE'},{status:e instanceof V2PublicationError?e.status:409,headers});}}
