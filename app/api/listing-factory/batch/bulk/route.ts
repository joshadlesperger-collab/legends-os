import { NextRequest, NextResponse } from "next/server";
import { OPERATOR_SESSION_COOKIE, readOperatorSession } from "@/lib/operator-auth";
import { readBatch } from "@/lib/card-batch-store";
import { verifiedBulkDraftExport } from "@/lib/card-bulk-draft-service";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function GET(req:NextRequest){
  if(!await readOperatorSession(req.cookies.get(OPERATOR_SESSION_COOKIE)?.value))return NextResponse.json({error:"Sign in required"},{status:401});
  try{
    const batch=await readBatch();if(!batch)return NextResponse.json({error:"Select a batch first."},{status:409});
    const result=await verifiedBulkDraftExport(batch);
    if(req.nextUrl.searchParams.get("format")==="csv"){
      if(!result.csv)return NextResponse.json({error:"Bulk export blocked",blockers:result.blockers},{status:409});
      return new NextResponse(result.csv,{headers:{"Content-Type":"text/csv; charset=utf-8","Content-Disposition":`attachment; filename="ebay-drafts-${batch.id}.csv"`,"Cache-Control":"private, no-store"}});
    }
    return NextResponse.json(result,{headers:{"Cache-Control":"private, no-store"}});
  }catch{return NextResponse.json({error:"Bulk export requires current price approvals, resolved holds and verified original photos."},{status:409});}
}
