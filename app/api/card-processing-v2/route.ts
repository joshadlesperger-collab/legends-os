import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { OPERATOR_SESSION_COOKIE, readOperatorSession } from "@/lib/operator-auth";
import { publicV2Snapshot, startV2Worker } from "@/lib/card-processing-v2-store";
import { listV2Candidates, v2SelectionSchema, v2ReadyBatchIdsSchema } from "@/lib/card-processing-v2-selection";
import {V2ReadinessError} from '@/lib/card-processing-v2-readiness';
import {V2UploaderAdmissionError} from '@/lib/card-processing-v2-uploader-admission';
import {startV2IdentifySort,resumeV2IdentifySort,recoverV2IdentifySort,getV2IdentifySortStatus,peekV2IdentifySort} from '@/lib/card-processing-v2-identify-sort';
import {connectV2BackgroundBrowser,resumeV2BackgroundRun} from '@/lib/card-processing-v2-background-supervisor';

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
const commandSchema = z.discriminatedUnion('action',[z.object({ action: z.literal("process"), selection: v2SelectionSchema, clickedAt:z.string().datetime().optional(),executionMode:z.enum(['end-to-end','prepare-only']).optional() }).strict(),z.object({action:z.literal('identify-sort'),selection:v2SelectionSchema,clickedAt:z.string().datetime().optional()}).strict(),z.object({action:z.literal('resume-identify-sort'),jobId:z.string().uuid()}).strict(),z.object({action:z.literal('connect-background')}).strict(),z.object({action:z.literal('resume-background'),batchId:z.string().uuid()}).strict()]);

export async function GET(req: NextRequest) {
  if (!await readOperatorSession(req.cookies.get(OPERATOR_SESSION_COOKIE)?.value)) {
    return NextResponse.json({ error: "Sign in to view Card Processing V2." }, { status: 401, headers });
  }
  try {
    const readyBatchId=req.nextUrl.searchParams.get('readyBatchId');
    const params=req.nextUrl.searchParams,hasSingle=params.has('readyBatchId'),hasSet=params.has('readyBatchIds'),rawSet=params.get('readyBatchIds');
    const parsedSet=hasSet?v2ReadyBatchIdsSchema.safeParse(rawSet?.split(',')):undefined;
    if(Array.from(params.keys()).some(key=>!['candidates','readyBatchId','readyBatchIds'].includes(key))||['candidates','readyBatchId','readyBatchIds'].some(key=>params.getAll(key).length>1)||params.has('candidates')&&params.get('candidates')!=='1'||hasSingle&&!z.string().uuid().safeParse(readyBatchId).success||hasSet&&!parsedSet?.success||hasSingle&&hasSet||(hasSingle||hasSet)&&params.get('candidates')!=='1')return NextResponse.json({error:'Use the scan intake or select up to 100 distinct named ready batches.'},{status:400,headers});
    if(params.get('candidates')==='1')return NextResponse.json(await listV2Candidates(process.cwd(),undefined,readyBatchId??undefined,parsedSet?.success?parsedSet.data:undefined),{headers});
    if((await peekV2IdentifySort(process.cwd()))?.interrupted)await recoverV2IdentifySort(process.cwd());
    return NextResponse.json(await publicV2Snapshot(), { headers });
  } catch {
    return NextResponse.json({ error: "The processing checkpoint could not be read. Existing cards have been preserved." }, { status: 409, headers });
  }
}

export async function POST(req: NextRequest) {
  if (!await readOperatorSession(req.cookies.get(OPERATOR_SESSION_COOKIE)?.value)) {
    return NextResponse.json({ error: "Sign in to process new cards." }, { status: 401, headers });
  }
  if (req.headers.get("origin") !== req.nextUrl.origin) {
    return NextResponse.json({ error: "Start processing from Legends OS." }, { status: 403, headers });
  }
  const body = await req.text();
  if (body.length > 262144) return NextResponse.json({ error: "Request too large." }, { status: 413, headers });
  try {
    const parsed = commandSchema.safeParse(JSON.parse(body));
    if (!parsed.success) return NextResponse.json({ error: "Open Process New Cards and choose all eligible photos or specific card pairs." }, { status: 400, headers });
    if(parsed.data.action==='identify-sort')return NextResponse.json(await startV2IdentifySort(process.cwd(),parsed.data.selection,parsed.data.clickedAt),{status:202,headers});
    if(parsed.data.action==='resume-identify-sort')return NextResponse.json(await resumeV2IdentifySort(process.cwd(),parsed.data.jobId),{status:202,headers});
    if(parsed.data.action==='connect-background')return NextResponse.json(await connectV2BackgroundBrowser(process.cwd()),{status:202,headers});
    if(parsed.data.action==='resume-background')return NextResponse.json(await resumeV2BackgroundRun(process.cwd(),parsed.data.batchId),{status:202,headers});
    const intakeStatus=await peekV2IdentifySort(process.cwd());
    if(intakeStatus&&intakeStatus.phase!=='complete')return NextResponse.json({error:'Identification and sorting are still running. Choose the ready batch after they finish.'},{status:409,headers});
    return NextResponse.json(await startV2Worker(process.cwd(), parsed.data.selection,parsed.data.clickedAt,parsed.data.executionMode), { status: 202, headers });
  } catch (error) {
    if(error instanceof V2UploaderAdmissionError)return NextResponse.json({error:error.message,code:error.code,processingStarted:false,providerCalls:0},{status:409,headers});
    if(error instanceof V2ReadinessError)return NextResponse.json({error:error.report.blockers.join(' '),readiness:error.report},{status:409,headers});
    const knownSelectionErrors = new Map([
      ["Resume the existing identification job before starting another", "Identify & Sort is already running. Refresh to see its progress. No second run was started."],
      ["Select every card in the existing quantity group together.", "Choose every card in an existing quantity group together. Select all eligible pairs, or include the other copies in that group."],
      ["No eligible photo pairs are selected. Review the retained holds.", "No eligible pairs are selected. Review the displayed holds or choose a new front/back pair."],
      ["Unknown or held photo pair; refresh and select eligible cards.", "A selected pair is held or no longer available. Refresh the photos and choose eligible pairs."],
    ]);
    const detail = error instanceof Error ? knownSelectionErrors.get(error.message) : undefined;
    return NextResponse.json({ error: detail || "These photos may have changed or another run started. Refresh the selection and choose again; existing work and holds are preserved." }, { status: 409, headers });
  }
}
