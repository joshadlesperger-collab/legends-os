import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { transitionBatch, type BatchStage, type TimedBatch } from "./card-batch.ts";

const directory=(root:string)=>path.join(root,"artifacts/card-batches");
export async function readBatch(root=process.cwd()):Promise<TimedBatch|null>{
  try{return JSON.parse(await fs.readFile(path.join(directory(root),"current.json"),"utf8"));}
  catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return null;throw e;}
}
export async function saveBatch(command:{revision:number;batchId?:string;cardIds?:string[];stage?:BatchStage|null;finish?:boolean},root=process.cwd()){
  const dir=directory(root);await fs.mkdir(dir,{recursive:true});const lock=await fs.open(path.join(dir,"lock"),"wx");
  try{
    const old=await readBatch(root);if((old?.revision??0)!==command.revision)throw new Error("Batch changed. Refresh before continuing.");
    if(old&&old.id!==command.batchId)throw new Error("Batch changed. Refresh before continuing.");
    if(command.finish){if(!old||old.intervals.some(i=>!i.end))throw new Error("Pause timing before archiving the measurement.");await fs.writeFile(path.join(dir,`${old.id}.json`),JSON.stringify({...old,finishedAt:new Date().toISOString()},null,2),{flag:"wx"});await fs.unlink(path.join(dir,"current.json"));return null;}
    const now=new Date().toISOString();let next:TimedBatch;
    if(command.cardIds){
      if(old)throw new Error("A timed batch already exists; pause and archive its measurement before starting another.");
      if(command.cardIds.length<1||command.cardIds.length>500||new Set(command.cardIds).size!==command.cardIds.length)throw new Error("Select 1 to 500 distinct captures.");
      next={id:randomUUID(),cardIds:command.cardIds,createdAt:now,revision:1,intervals:[]};
    }else{if(!old)throw new Error("Select a batch first.");next=transitionBatch(old,command.stage??null,now);}
    const temp=path.join(dir,`${randomUUID()}.tmp`);await fs.writeFile(temp,JSON.stringify(next,null,2));await fs.rename(temp,path.join(dir,"current.json"));return next;
  }finally{await lock.close();await fs.unlink(path.join(dir,"lock"));}
}
