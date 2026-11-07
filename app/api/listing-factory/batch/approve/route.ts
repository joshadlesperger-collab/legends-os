import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { OPERATOR_SESSION_COOKIE,readOperatorSession } from "@/lib/operator-auth";
import { readBatch } from "@/lib/card-batch-store";
import { localEvidence } from "@/lib/card-backlog-service";
import { saveReviews,WorkflowConflict } from "@/lib/card-workflow-store";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const schema=z.object({batchId:z.string().uuid(),decisions:z.array(z.object({cardId:z.string().min(1).max(250),token:z.string().regex(/^[a-f0-9]{64}$/),requestId:z.string().uuid()}).strict()).min(1).max(500)}).strict();
export async function POST(req:NextRequest){
  if(!await readOperatorSession(req.cookies.get(OPERATOR_SESSION_COOKIE)?.value))return NextResponse.json({error:"Sign in required"},{status:401});
  if(req.headers.get("origin")!==req.nextUrl.origin)return NextResponse.json({error:"Same-origin request required"},{status:403});
  const raw=await req.text();if(raw.length>200000)return NextResponse.json({error:"Request too large"},{status:413});
  try{
    const input=schema.parse(JSON.parse(raw)),batch=await readBatch();
    if(!batch||batch.id!==input.batchId||input.decisions.some(d=>!batch.cardIds.includes(d.cardId))||new Set(input.decisions.map(d=>d.cardId)).size!==input.decisions.length)throw new WorkflowConflict("Batch changed; review the selected prices again.");
    return NextResponse.json(await saveReviews(input.decisions.map(d=>({...d,action:"approve-price" as const,note:"Seller approved displayed batch item prices and buyer shipping."})),()=>localEvidence()),{headers:{"Cache-Control":"private, no-store"}});
  }catch(e){return NextResponse.json({error:e instanceof WorkflowConflict?e.message:"Batch approval not saved. Refresh and review current prices."},{status:409});}
}
