import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { OPERATOR_SESSION_COOKIE, readOperatorSession } from "@/lib/operator-auth";
import { localEvidence } from "@/lib/card-backlog-service";
import { readReviews, withWorkflow } from "@/lib/card-workflow-store";
import { readQueue, withQueue } from "@/lib/card-orchestrator-store";
import { fingerprint, type QueueState } from "@/lib/card-orchestrator";
import { workflowDecisions } from "@/lib/card-orchestrator-flow";
import { reusablePricing, reusePricing } from "@/lib/card-pricing-library";
import type { WorkflowSnapshot } from "@/lib/card-workflow";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const directory="artifacts/card-orchestrator";
// Evidence lookup needs source bindings, not an inventory-wide filesystem/hash audit.
const evidenceSnapshot=()=>localEvidence().then(s=>withWorkflow(s));
function mapped(state:QueueState,snapshot:WorkflowSnapshot,id:string){
  const c=snapshot.cards.find(c=>c.id===id);
  if(!c||c.issues.length||c.backHashes.length!==1)throw Error("Original pair requires review");
  const matches=Object.values(state.cards).filter(q=>q.input.photos.some(p=>p.side==="front"&&p.sha256.toLowerCase()===c.frontHash)&&q.input.photos.some(p=>p.side==="back"&&p.sha256.toLowerCase()===c.backHashes[0]));
  if(matches.length!==1)throw Error("Unique queue mapping required");
  return matches[0].input.id;
}
export async function GET(req:NextRequest){
  if(!await readOperatorSession(req.cookies.get(OPERATOR_SESSION_COOKIE)?.value))return NextResponse.json({error:"Sign in required"},{status:401});
  const ids=req.nextUrl.searchParams.get("cards")?.split(",")??[];
  if(!ids.length||ids.length>50||new Set(ids).size!==ids.length)return NextResponse.json({error:"Select 1–50 captures"},{status:400});
  try{
    const [state,snapshot]=await Promise.all([readQueue(directory),evidenceSnapshot()]);
    const holds=Object.fromEntries(snapshot.cards.flatMap(c=>snapshot.workflow[c.id]?.holdReason?c.aliases.map(id=>[id,snapshot.workflow[c.id].holdReason!]):[]));
    return NextResponse.json(Object.fromEntries(ids.map(id=>{try{return [id,reusablePricing(state,mapped(state,snapshot,id),new Date().toISOString(),holds)];}catch{return [id,{options:[],reason:"Original pair or queue mapping requires review"}];}})),{headers:{"Cache-Control":"private, no-store"}});
  }catch{return NextResponse.json({error:"Evidence unavailable; refresh"},{status:409});}
}
const schema=z.object({cardId:z.string().min(1).max(250),sourceId:z.string().min(1).max(100),token:z.string().regex(/^[a-f0-9]{64}$/),confirmed:z.literal(true)}).strict();
export async function POST(req:NextRequest){
  if(!await readOperatorSession(req.cookies.get(OPERATOR_SESSION_COOKIE)?.value))return NextResponse.json({error:"Sign in required"},{status:401});
  if(req.headers.get("origin")!==req.nextUrl.origin)return NextResponse.json({error:"Same-origin request required"},{status:403});
  const body=await req.text();if(body.length>4096)return NextResponse.json({error:"Request too large"},{status:413});
  try{
    const command=schema.parse(JSON.parse(body)),before=fingerprint(await readReviews());
    const snapshot=await evidenceSnapshot();
    const result=await withQueue(directory,async state=>{
      if(fingerprint(await readReviews())!==before)throw Error("Reviews changed; refresh");
      const id=mapped(state,snapshot,command.cardId),review=snapshot.workflow[command.cardId];
      if(review?.manualPrice||review?.approvedAt)throw Error("Retain current approval or manual price");
      const decisions=workflowDecisions(state,snapshot,[id,command.sourceId]);
      const holds=Object.fromEntries(Object.entries(decisions).flatMap(([key,d])=>d.holdReason?[[key,d.holdReason]]:[]));
      return reusePricing(state,id,command.sourceId,command.token,true,new Date().toISOString(),holds);
    });
    return NextResponse.json(result,{headers:{"Cache-Control":"private, no-store"}});
  }catch{return NextResponse.json({error:"Evidence changed, held, already completed or claimed. Refresh before reusing; no approval or eBay change was made."},{status:409});}
}
