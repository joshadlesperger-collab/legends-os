import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { newQueue, type QueueState } from "./card-orchestrator.ts";

/** Retry a rejected rename, never a transaction callback. Caller retains the queue lock.
 * Missing staged input means an uncertain commit: stop rather than replay it. */
export async function replaceQueueFile(temp:string,target:string,rename=fs.rename,wait:(ms:number)=>Promise<unknown>=delay):Promise<void> {
  for(let attempt=0;;attempt++) {
    try {await rename(temp,target);return;}
    catch(error) {
      if(attempt>=2||!["EPERM","EACCES","EBUSY"].includes((error as NodeJS.ErrnoException).code??""))throw error;
      await fs.stat(temp); // A completed/uncertain rename must never be repeated.
      await wait(50*(attempt+1));
    }
  }
}

/** Local single-host queue. Atomic rename plus an exclusive lock; never use as a distributed/cloud database. */
export async function readQueue(directory:string):Promise<QueueState> {
  try {
    const state=JSON.parse(await fs.readFile(path.join(directory,"state.json"),"utf8")) as QueueState;
    if(state.schemaVersion!==1||state.mode!=="local-preparation-only"||state.seller!=="imaydit58"||!state.cards||!Array.isArray(state.events))throw new Error("Queue schema/account mismatch; stop for recovery");
    return state;
  } catch(e) {if((e as NodeJS.ErrnoException).code==="ENOENT")return newQueue();throw e;}
}
export class QueueBusyError extends Error {}
export async function withQueue<T>(directory:string,fn:(state:QueueState)=>Promise<T>|T,options:{lockWaitMs?:number}={}):Promise<T> {
  return withLockedQueue(directory,fn,options,true);
}
/** Read an isolated snapshot under the same writer lock. Callback mutations are
 * deliberately never committed; use withQueue for durable queue changes. */
export async function withQueueSnapshot<T>(directory:string,fn:(state:QueueState)=>Promise<T>|T,options:{lockWaitMs?:number}={}):Promise<T> {
  return withLockedQueue(directory,fn,options,false);
}
async function withLockedQueue<T>(directory:string,fn:(state:QueueState)=>Promise<T>|T,options:{lockWaitMs?:number},persist:boolean):Promise<T> {
  const lockWaitMs=options.lockWaitMs??3000;
  if(!Number.isFinite(lockWaitMs)||lockWaitMs<0||lockWaitMs>30000)throw new Error("Queue lock wait must be between 0 and 30000 milliseconds");
  await fs.mkdir(directory,{recursive:true});
  const lock=path.join(directory,"queue.lock"),token=randomUUID();
  let handle,attempt=0;
  const deadline=performance.now()+lockWaitMs;
  // Acquisition retries never enter or replay the transaction callback.
  for(;;) {
    try {handle=await fs.open(lock,"wx");break;}
    catch(e) {
      if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;
      const remaining=deadline-performance.now();
      if(remaining<=0)throw new QueueBusyError(`Queue is locked by another process after waiting up to ${lockWaitMs} ms. Retry later; do not delete or steal its lock. Inspect the recorded owner before any stale-lock recovery.`);
      await delay(Math.min(remaining,25*2**Math.min(attempt++,3)));
    }
  }
  try {
    await handle.writeFile(JSON.stringify({token,pid:process.pid,host:os.hostname(),createdAt:new Date().toISOString()}));await handle.sync();
    const state=await readQueue(directory),before=persist?JSON.stringify(state):undefined,result=await fn(state);
    if(persist&&JSON.stringify(state)!==before) {
      state.revision++;
      const temp=path.join(directory,`state.${token}.tmp`);
      const file=await fs.open(temp,"wx");
      try {await file.writeFile(JSON.stringify(state,null,2));await file.sync();}finally{await file.close();}
      // A failed replace preserves the prior state and the temp recovery file; never delete the old state first.
      await replaceQueueFile(temp,path.join(directory,"state.json"));
    }
    return result;
  } finally {
    await handle.close();
    const owner=JSON.parse(await fs.readFile(lock,"utf8"));
    if(owner.token===token)await fs.unlink(lock);
  }
}
