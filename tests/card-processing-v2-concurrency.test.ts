import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {mapV2Bounded, v2Limiter} from '../lib/card-processing-v2-concurrency.ts';
import {withV2State,readV2State,withV2PreparationCommits} from '../lib/card-processing-v2-store.ts';

test('parallel preparations commit every checkpoint once without lost updates',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'v2-concurrent-commits-'));
  try {
    await withV2PreparationCommits(()=>Promise.all(Array.from({length:30},(_,n)=>withV2State(async s=>{await Promise.resolve();s.notices.push(`commit-${n}`);},root))));
    const state=await readV2State(root);assert.equal(state.revision,30);assert.equal(new Set(state.notices).size,30);
    await assert.rejects(withV2State(()=>{throw Error('synthetic transaction failure');},root));
    await withV2State(s=>{s.notices.push('after-failure');},root);
    assert.equal((await readV2State(root)).revision,31);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});

test('fatal pool failure drains already started work before releasing ownership',async()=>{
  let finish!:()=>void;const held=new Promise<void>(r=>{finish=r;});const completed:number[]=[];
  const running=mapV2Bounded([0,1,2,3,4],3,async n=>{if(n===0){await Promise.resolve();throw Error('stop');}await held;completed.push(n);});
  await Promise.resolve();await Promise.resolve();let ended=false;void running.catch(()=>{ended=true;});
  await Promise.resolve();assert.equal(ended,false);finish();await assert.rejects(running,/stop/);
  assert.deepEqual(completed.sort(),[1,2]);
});

test('photo limiter caps independent groups and frees failed slots',async()=>{
  const limited=v2Limiter(3);let active=0,max=0;let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
  const tasks=Array.from({length:8},(_,n)=>limited(async()=>{active++;max=Math.max(max,active);try{if(n<3)await gate;if(n===2)throw Error('photo failed');return n;}finally{active--;}}));
  await Promise.resolve();assert.equal(max,3);release();const results=await Promise.allSettled(tasks);assert.equal(max,3);assert.equal(results.filter(r=>r.status==='fulfilled').length,7);assert.equal(active,0);
});
