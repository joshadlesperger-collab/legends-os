import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {replaceQueueFile,withQueue,readQueue} from '../lib/card-orchestrator-store.ts';

for(const code of ['EPERM','EACCES','EBUSY'])test(`queue replacement recovers ${code} without replaying transaction`,async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'queue-replace-'));
  const original=fs.rename;let calls=0,callbacks=0;
  try {
    await withQueue(dir,s=>{s.externalWriterPossible=false;});
    fs.rename=async(source,target)=>{if(++calls<3)throw Object.assign(new Error('sharing'),{code});await original(source,target);};
    await withQueue(dir,s=>{callbacks++;s.externalWriterPossible=true;});
    assert.equal(callbacks,1);assert.equal(calls,3);assert.equal((await readQueue(dir)).revision,2);
    assert.equal((await readQueue(dir)).externalWriterPossible,true);
  }finally{fs.rename=original;await fs.rm(dir,{recursive:true,force:true});}
});

test('persistent sharing failure preserves old state and staged recovery; releases own lock',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'queue-replace-'));
  const original=fs.rename;let calls=0,callbacks=0;
  try {
    await withQueue(dir,s=>{s.externalWriterPossible=false;});
    const before=await fs.readFile(path.join(dir,'state.json'),'utf8');
    fs.rename=async()=>{calls++;throw Object.assign(new Error('persistent'),{code:'EPERM'});};
    await assert.rejects(withQueue(dir,s=>{callbacks++;s.externalWriterPossible=true;}),/persistent/);
    assert.equal(callbacks,1);assert.equal(calls,3);
    assert.equal(await fs.readFile(path.join(dir,'state.json'),'utf8'),before);
    const files=await fs.readdir(dir);assert.equal(files.filter(f=>f.endsWith('.tmp')).length,1);assert.ok(!files.includes('queue.lock'));
  }finally{fs.rename=original;await fs.rm(dir,{recursive:true,force:true});}
});

test('uncertain commit and non-sharing failures never retry',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'queue-replace-'));
  try {
    const temp=path.join(dir,'staged'),target=path.join(dir,'state');let calls=0;
    await fs.writeFile(temp,'new');
    await assert.rejects(replaceQueueFile(temp,target,async(s,t)=>{calls++;await fs.rename(s,t);throw Object.assign(new Error('uncertain'),{code:'EPERM'});},async()=>{}),{code:'ENOENT'});
    assert.equal(calls,1);assert.equal(await fs.readFile(target,'utf8'),'new');
    calls=0;
    await assert.rejects(replaceQueueFile(temp,target,async()=>{calls++;throw Object.assign(new Error('disk full'),{code:'ENOSPC'});},async()=>{}),/disk full/);
    assert.equal(calls,1);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
