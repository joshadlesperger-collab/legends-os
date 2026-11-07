import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { measureBatchOperation,readBatchOperations } from "../lib/card-batch-metrics.ts";
test("concurrent operation measurements preserve failures without changing batch revisions",async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"card-metrics-"));
  try{
    const batch={id:"test",revision:3,createdAt:new Date().toISOString(),cardIds:["one"],intervals:[]};
    await Promise.all([
      measureBatchOperation(batch,"photos",async()=>42,root),
      assert.rejects(measureBatchOperation(batch,"research",async()=>{throw Error("service unavailable");},root),/service unavailable/)
    ]);
    const {operations}=await readBatchOperations(batch,root);
    assert.equal(operations.length,2);assert.deepEqual(operations.map(o=>o.outcome).sort(),["error","ok"]);
    assert.ok(operations.every(o=>o.durationMs>=0));assert.equal(batch.revision,3);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
