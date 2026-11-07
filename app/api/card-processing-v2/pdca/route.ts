import {NextRequest,NextResponse} from 'next/server';
import {OPERATOR_SESSION_COOKIE,readOperatorSession} from '@/lib/operator-auth';
import {readV2PdcaRegister} from '@/lib/card-processing-v2-pdca-store';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function GET(req:NextRequest){const headers={'Cache-Control':'private, no-store'};if(!await readOperatorSession(req.cookies.get(OPERATOR_SESSION_COOKIE)?.value))return NextResponse.json({error:'Sign in to view batch performance.'},{status:401,headers});try{return NextResponse.json({register:await readV2PdcaRegister()},{headers});}catch{return NextResponse.json({error:'The performance evidence could not be read. Existing card work is unchanged.'},{status:503,headers});}}
