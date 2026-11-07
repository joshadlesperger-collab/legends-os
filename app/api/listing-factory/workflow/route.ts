import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { OPERATOR_SESSION_COOKIE, readOperatorSession } from "@/lib/operator-auth";
import { localBacklog } from "@/lib/card-backlog-service";
import { saveReview, WorkflowConflict } from "@/lib/card-workflow-store";
import { money } from "@/lib/card-orchestrator-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const commandSchema = z.object({ cardId:z.string().min(1).max(250),token:z.string().regex(/^[a-f0-9]{64}$/),requestId:z.string().uuid(),action:z.enum(["approve-price","set-price","hold","resume","note"]),note:z.string().max(2000),price:z.object({item:z.number().refine(n=>money(n,true)),shipping:z.number().refine(n=>money(n))}).strict().optional() }).strict().refine(c=>c.action==="set-price"?!!c.price:!c.price);
export async function POST(request: NextRequest) {
  if (!await readOperatorSession(request.cookies.get(OPERATOR_SESSION_COOKIE)?.value)) return NextResponse.json({error:"Operator sign-in required"},{status:401});
  if (request.headers.get("origin") !== request.nextUrl.origin) return NextResponse.json({error:"Same-origin request required"},{status:403});
  const body = await request.text();
  if (body.length > 8192) return NextResponse.json({error:"Review is too large"},{status:413});
  let command;
  try { command=commandSchema.parse(JSON.parse(body)); } catch { return NextResponse.json({error:"Invalid review decision"},{status:400}); }
  try { return NextResponse.json(await saveReview(command,() => localBacklog()),{headers:{"Cache-Control":"private, no-store"}}); }
  catch (e) { return NextResponse.json({error:e instanceof WorkflowConflict ? e.message : "Review could not be saved. Your current card remains open; retry safely."},{status:e instanceof WorkflowConflict ? 409 : 503}); }
}
