import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BatchStage, TimedBatch } from "./card-batch.ts";

export type BatchOperation = { id:string; batchId:string; stage:BatchStage; startedAt:string; finishedAt:string; durationMs:number; outcome:"ok"|"error"; captureCount:number };
/** Separate append-only records: concurrent operations never overwrite timers or
 * change approval revisions. Durations are monotonic, not wall-clock guesses. */
export async function measureBatchOperation<T>(batch:TimedBatch,stage:BatchStage,operation:()=>Promise<T>,root=process.cwd()):Promise<T>{
  const startedAt=new Date().toISOString(),start=performance.now();let outcome:BatchOperation["outcome"]="error";
  try{const result=await operation();outcome="ok";return result;}
  finally{
    const record:BatchOperation={id:randomUUID(),batchId:batch.id,stage,startedAt,finishedAt:new Date().toISOString(),durationMs:performance.now()-start,outcome,captureCount:batch.cardIds.length};
    const dir=path.join(root,"artifacts/card-batches/operations",batch.id);await fs.mkdir(dir,{recursive:true});
    await fs.writeFile(path.join(dir,`${record.id}.json`),JSON.stringify(record),{flag:"wx"});
  }
}
export async function readBatchOperations(batch:TimedBatch,root=process.cwd()){
  const dir=path.join(root,"artifacts/card-batches/operations",batch.id);
  let names:string[];try{names=await fs.readdir(dir);}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;names=[];}
  const operations:BatchOperation[]=await Promise.all(names.filter(n=>n.endsWith(".json")).map(async n=>JSON.parse(await fs.readFile(path.join(dir,n),"utf8"))));
  return {operations:operations.sort((a,b)=>a.startedAt.localeCompare(b.startedAt)),note:"Measured server operation time. Overlapping operations are not elapsed batch time; external browser work uses the stage timers."};
}
