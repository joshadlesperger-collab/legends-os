import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { newQueue, type QueueState } from "./card-orchestrator.ts";

/** Local single-host queue. Atomic rename plus an exclusive lock; never use as a distributed/cloud database. */
export async function readQueue(directory:string):Promise<QueueState> {
  try {
    const state=JSON.parse(await fs.readFile(path.join(directory,"state.json"),"utf8")) as QueueState;
    if(state.schemaVersion!==1||state.mode!=="local-preparation-only"||state.seller!=="imaydit58"||!state.cards||!Array.isArray(state.events))throw new Error("Queue schema/account mismatch; stop for recovery");
    return state;
  } catch(e) {if((e as NodeJS.ErrnoException).code==="ENOENT")return newQueue();throw e;}
}
export async function withQueue<T>(directory:string,fn:(state:QueueState)=>Promise<T>|T):Promise<T> {
  await fs.mkdir(directory,{recursive:true});
  const lock=path.join(directory,"queue.lock"),token=randomUUID();
  let handle;
  try {handle=await fs.open(lock,"wx");}
  catch(e) {if((e as NodeJS.ErrnoException).code==="EEXIST")throw new Error("Queue is locked by another process. Do not delete or steal its lock; inspect the recorded owner and recover only after confirming that process stopped.");throw e;}
  try {
    await handle.writeFile(JSON.stringify({token,pid:process.pid,host:os.hostname(),createdAt:new Date().toISOString()}));await handle.sync();
    const state=await readQueue(directory),before=JSON.stringify(state),result=await fn(state);
    if(JSON.stringify(state)!==before) {
      state.revision++;
      const temp=path.join(directory,`state.${token}.tmp`);
      const file=await fs.open(temp,"wx");
      try {await file.writeFile(JSON.stringify(state,null,2));await file.sync();}finally{await file.close();}
      // A failed replace preserves the prior state and the temp recovery file; never delete the old state first.
      await fs.rename(temp,path.join(directory,"state.json"));
    }
    return result;
  } finally {
    await handle.close();
    const owner=JSON.parse(await fs.readFile(lock,"utf8"));
    if(owner.token===token)await fs.unlink(lock);
  }
}
