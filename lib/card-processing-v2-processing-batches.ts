import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ResolvedV2Selection } from "./card-processing-v2-selection.ts";
import type { V2State } from "./card-processing-v2.ts";
const hash=z.string().regex(/^[a-f0-9]{64}$/),job=z.string().uuid();
export const processingBatchSchema=z.object({jobId:job,readyBatchId:z.string().uuid().optional(),readyBatchIds:z.array(z.string().uuid()).min(1).max(100).refine(ids=>new Set(ids).size===ids.length).transform(ids=>ids.slice().sort()).optional(),processVersion:z.string().optional(),intake:z.object({startedAt:z.string().datetime(),callIds:z.array(z.string()),actualMicros:z.number().int().nonnegative()}).strict().optional(),clickedAt:z.string().datetime(),acceptedAt:z.string().datetime(),status:z.enum(["accepted","running","failed","stopped"]),pid:z.number().int().positive().optional(),captures:z.array(z.object({candidateId:hash,cardId:z.string().optional(),photos:z.array(z.object({hash,side:z.enum(["front","back"])}).strict()).length(2)}).strict()).max(500),baselineCallIds:z.array(z.string()),failure:z.literal("Worker could not start; no processing completion is claimed.").optional()}).strict().superRefine((b,ctx)=>{if(b.readyBatchId&&b.readyBatchIds)ctx.addIssue({code:"custom",message:"Choose one ready source scope"});});
export type V2ProcessingBatch=z.infer<typeof processingBatchSchema>;
const directory=(root:string)=>path.join(root,"artifacts","card-processing-v2","processing-batches");
export function validateV2ClickedAt(value:unknown,now=new Date().toISOString()){const clicked=z.string().datetime().parse(value??now),age=Date.parse(now)-Date.parse(clicked);if(age<0||age>86400000)throw Error("Choose a current processing start time");return clicked;}
export async function writeV2ProcessingBatch(root:string,batch:V2ProcessingBatch,exclusive=false){
  const parsed=processingBatchSchema.parse(batch),dir=directory(root);await fs.mkdir(dir,{recursive:true});if((await fs.lstat(dir)).isSymbolicLink())throw Error("Invalid processing batch directory");
  const file=path.join(dir,`${parsed.jobId}.json`);if(exclusive){const handle=await fs.open(file,"wx");try{await handle.writeFile(JSON.stringify(parsed));await handle.sync();}finally{await handle.close();}return;}
  const temporary=path.join(dir,`${parsed.jobId}.${randomUUID()}.tmp`),handle=await fs.open(temporary,"wx");try{await handle.writeFile(JSON.stringify(parsed));await handle.sync();}finally{await handle.close();}await fs.rename(temporary,file);
}
export function newV2ProcessingBatch(jobId:string,selection:ResolvedV2Selection,state:V2State,clickedAt?:string):V2ProcessingBatch{
  const acceptedAt=new Date().toISOString();return processingBatchSchema.parse({jobId,...(selection.readyBatchId?{readyBatchId:selection.readyBatchId}:{}),...(selection.readyBatchIds?{readyBatchIds:selection.readyBatchIds}:{}),clickedAt:validateV2ClickedAt(clickedAt,acceptedAt),acceptedAt,status:"accepted",captures:selection.captures.map(c=>({candidateId:c.candidateId,...(c.cardId?{cardId:c.cardId}:{}),photos:c.photos.map(p=>({hash:p.hash,side:p.side}))})),baselineCallIds:state.calls.map(c=>c.id)});
}
/** Once spawn succeeded, a metadata I/O failure must not invite a second worker. The accepted checkpoint remains durable. */
export async function acknowledgeV2ProcessingBatchSpawn(root:string,batch:V2ProcessingBatch,pid:number,persist=writeV2ProcessingBatch){
  if(!Number.isInteger(pid)||pid<=0)throw Error("Actual worker PID required");
  try{await persist(root,{...batch,status:"running",pid});}catch{/* Preserve accepted metadata and acknowledge the actual launched process. */}
  return {pid,jobId:batch.jobId};
}
export function reconcileV2ProcessingBatch(batch:V2ProcessingBatch,state:V2State):V2ProcessingBatch{
  if(!["accepted","running"].includes(batch.status)||state.lastRun?.id!==batch.jobId)return batch;
  const run=state.lastRun;if(run.status!=="running")return {...batch,status:"stopped",pid:run.pid};
  try{process.kill(run.pid,0);return {...batch,status:"running",pid:run.pid};}catch(e){return {...batch,status:(e as NodeJS.ErrnoException).code==="EPERM"?"running":"stopped",pid:run.pid};}
}
export async function listV2ProcessingBatches(root:string):Promise<V2ProcessingBatch[]>{
  const dir=directory(root);let names:string[];try{if((await fs.lstat(dir)).isSymbolicLink())throw Error("Invalid processing batch directory");names=await fs.readdir(dir);}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return [];throw e;}
  const records:V2ProcessingBatch[]=[];
  const candidates=await Promise.all(names.filter(n=>/^[a-f0-9-]{36}\.json$/.test(n)).map(async name=>({name,stat:await fs.lstat(path.join(dir,name))})));
  for(const {name,stat} of candidates.sort((a,b)=>b.stat.mtimeMs-a.stat.mtimeMs).slice(0,100)){try{const file=path.join(dir,name);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>262144)continue;const parsed=processingBatchSchema.safeParse(JSON.parse(await fs.readFile(file,"utf8")));if(!parsed.success||`${parsed.data.jobId}.json`!==name)continue;const batch=parsed.data;if(batch.status==="running"&&batch.pid){try{process.kill(batch.pid,0);}catch(e){if((e as NodeJS.ErrnoException).code!=="EPERM")batch.status="stopped";}}records.push(batch);}catch{continue;}}
  return records.sort((a,b)=>b.acceptedAt.localeCompare(a.acceptedAt)).slice(0,20);
}
