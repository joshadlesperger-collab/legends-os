import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { OPERATOR_SESSION_COOKIE, readOperatorSession } from "@/lib/operator-auth";
import { localBacklog } from "@/lib/card-backlog-service";
import { withWorkflow } from "@/lib/card-workflow-store";
import { readBatch, saveBatch } from "@/lib/card-batch-store";
import { readBatchOperations } from "@/lib/card-batch-metrics";
import { BATCH_STAGES, batchPacket } from "@/lib/card-batch";
import { verifiedBatchPacket } from "@/lib/card-batch-service";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const schema=z.object({revision:z.number().int().nonnegative(),batchId:z.string().uuid().optional(),cardIds:z.array(z.string().min(1).max(250)).min(1).max(500).optional(),stage:z.enum(BATCH_STAGES).nullable().optional(),finish:z.boolean().optional()}).strict().refine(c=>c.cardIds?c.stage===undefined&&!c.finish&&!c.batchId:!!c.batchId);
export async function GET(req:NextRequest){
  if(!await readOperatorSession(req.cookies.get(OPERATOR_SESSION_COOKIE)?.value))return NextResponse.json({error:"Sign in required"},{status:401});
  try{const batch=await readBatch();if(batch&&req.nextUrl.searchParams.get("metrics")==="1")return NextResponse.json(await readBatchOperations(batch),{headers:{"Cache-Control":"private, no-store"}});return NextResponse.json(req.nextUrl.searchParams.get("packet")==="1"&&batch?await verifiedBatchPacket(batch):batch,{headers:{"Cache-Control":"private, no-store"}});}
  catch{return NextResponse.json({error:"Packet unavailable. Review all selected price approvals, photo and stage holds, category fields, title length and matching-copy details."},{status:409});}
}
export async function POST(req:NextRequest){
  if(!await readOperatorSession(req.cookies.get(OPERATOR_SESSION_COOKIE)?.value))return NextResponse.json({error:"Sign in required"},{status:401});
  if(req.headers.get("origin")!==req.nextUrl.origin)return NextResponse.json({error:"Same-origin request required"},{status:403});
  const text=await req.text();if(text.length>65536)return NextResponse.json({error:"Request too large"},{status:413});
  try{const command=schema.parse(JSON.parse(text));
    if(command.cardIds){const s=await withWorkflow(await localBacklog());for(const id of command.cardIds){const c=s.cards.find(c=>c.id===id);if(!c||!c.physicalUnits||!c.frontHash||c.backHashes.length!==1||c.receipts.length||c.excludedFromNewListing||c.issues.length||s.workflow[id]?.holdReason)throw new Error("Select new captures without receipts or conflicts.");}}
    return NextResponse.json(await saveBatch(command),{headers:{"Cache-Control":"private, no-store"}});
  }catch{return NextResponse.json({error:"Batch was not saved. Refresh; select 1 to 500 new captures without receipts, conflicts or seller holds."},{status:409});}
}
