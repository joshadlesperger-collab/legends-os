import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { replaceV2Checkpoint } from "../lib/card-processing-v2-atomic-replace.ts";
async function fixture(run:(temporary:string,target:string)=>Promise<void>){const root=await fs.mkdtemp(path.join(os.tmpdir(),"v2-replace-"));try{const temporary=path.join(root,"state.retained.tmp"),target=path.join(root,"state.json");await fs.writeFile(temporary,'{"revision":2}');await fs.writeFile(target,'{"revision":1}');await run(temporary,target);}finally{await fs.rm(root,{recursive:true,force:true});}}
test("transient EPERM and EBUSY retry the exact same temporary while preserving target until atomic success",()=>fixture(async(temporary,target)=>{
  const attempts:[string,string][]=[],delays:number[]=[];
  await replaceV2Checkpoint(temporary,target,{rename:async(from,to)=>{attempts.push([from,to]);assert.equal(await fs.readFile(target,"utf8"),'{"revision":1}');assert.equal(await fs.readFile(temporary,"utf8"),'{"revision":2}');if(attempts.length<3)throw Object.assign(Error("temporary Windows lock"),{code:attempts.length===1?"EPERM":"EBUSY"});await fs.rename(from,to);},wait:async milliseconds=>{delays.push(milliseconds);}});
  assert.deepEqual(attempts,[[temporary,target],[temporary,target],[temporary,target]]);assert.deepEqual(delays,[50,100]);assert.equal(await fs.readFile(target,"utf8"),'{"revision":2}');await assert.rejects(fs.stat(temporary),{code:"ENOENT"});
}));
test("exhausted transient replacement preserves original and retained temporary without unbounded retries",()=>fixture(async(temporary,target)=>{
  let attempts=0,waits=0;const failure=Object.assign(Error("still locked"),{code:"EPERM"});await assert.rejects(replaceV2Checkpoint(temporary,target,{rename:async()=>{attempts++;throw failure;},wait:async()=>{waits++;}}),error=>error===failure);
  assert.equal(attempts,8);assert.equal(waits,7);assert.equal(await fs.readFile(target,"utf8"),'{"revision":1}');assert.equal(await fs.readFile(temporary,"utf8"),'{"revision":2}');
}));
test("nontransient replacement error fails immediately with both files retained",()=>fixture(async(temporary,target)=>{
  let attempts=0;await assert.rejects(replaceV2Checkpoint(temporary,target,{rename:async()=>{attempts++;throw Object.assign(Error("permanent permission failure"),{code:"EACCES"});},wait:async()=>{assert.fail("nontransient failure must not wait");}}),{code:"EACCES"});assert.equal(attempts,1);await fs.stat(target);await fs.stat(temporary);
}));
