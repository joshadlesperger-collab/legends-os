import fs from "node:fs/promises";

const retryDelaysMs=[50,100,200,400,800,1000,1000];
/** Retry only transient replacement locks, retaining the same fsynced temporary and existing target on failure. */
export async function replaceV2Checkpoint(temporary:string,target:string,dependencies:{rename?:(from:string,to:string)=>Promise<void>;wait?:(milliseconds:number)=>Promise<void>}={}){
  const rename=dependencies.rename??fs.rename,wait=dependencies.wait??(milliseconds=>new Promise<void>(resolve=>setTimeout(resolve,milliseconds)));
  for(let attempt=0;;attempt++){
    try{await rename(temporary,target);return;}
    catch(error){const code=(error as NodeJS.ErrnoException).code;if(!["EPERM","EBUSY"].includes(code??"")||attempt>=retryDelaysMs.length)throw error;await wait(retryDelaysMs[attempt]);}
  }
}
