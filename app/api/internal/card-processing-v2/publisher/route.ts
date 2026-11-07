import {NextRequest,NextResponse} from 'next/server';
import {OPERATOR_SESSION_COOKIE,readOperatorSession} from '@/lib/operator-auth';
import {handleV2PublicationWorker,V2PublicationError} from '@/lib/card-processing-v2-selected-publication';
export const runtime='nodejs';export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store'};
/** Polling worker uses the existing operator session; no public token or cloud filesystem queue. */
export async function POST(req:NextRequest){const operator=await readOperatorSession(req.cookies.get(OPERATOR_SESSION_COOKIE)?.value);if(!operator)return NextResponse.json({error:'Publisher sign-in is required.'},{status:401,headers});
 if(req.headers.get('origin')!==req.nextUrl.origin)return NextResponse.json({error:'Publisher origin differs.'},{status:403,headers});
 const raw=await req.text();if(raw.length>1_000_000)return NextResponse.json({error:'Publisher checkpoint is too large.'},{status:413,headers});
 try{return NextResponse.json(await handleV2PublicationWorker(operator.operatorId,JSON.parse(raw)),{headers});}catch(e){return NextResponse.json({error:e instanceof V2PublicationError?e.message:'Publisher checkpoint could not be retained; stop before any new remote action.',code:e instanceof V2PublicationError?e.code:'PUBLISHER_UNAVAILABLE'},{status:e instanceof V2PublicationError?e.status:409,headers});}}
