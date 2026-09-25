import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";

test("Legends Scheduler cron cadence is explicit and bounded",()=>{
  const config=JSON.parse(readFileSync(new URL("../vercel.json",import.meta.url),"utf8")) as {crons:Array<{path:string;schedule:string}>};
  const byPath=new Map(config.crons.map(row=>[row.path,row.schedule]));
  assert.equal(byPath.get("/api/internal/jobs/process"),"*/5 * * * *");
  assert.equal(byPath.get("/api/internal/scheduler/sense"),"0 */2 * * *");
  assert.equal(byPath.get("/api/internal/scheduler/velocity-plan"),"15 */4 * * *");
  assert.equal(byPath.get("/api/internal/scheduler/offers"),"0 14,23 * * *");
  assert.equal(byPath.get("/api/internal/scheduler/refresh"),"30 12 * * *");
  assert.equal(byPath.get("/api/internal/scheduler/diagnostics"),"0 11 * * *");
  assert.equal(byPath.get("/api/internal/scheduler/titles"),"45 12 * * *");
  assert.equal(byPath.get("/api/internal/scheduler/learning"),"30 10 * * *");
  assert.equal(new Set(config.crons.map(row=>row.path)).size,config.crons.length);
});

test("write crons remain separate from sensing crons",()=>{
  const config=JSON.parse(readFileSync(new URL("../vercel.json",import.meta.url),"utf8")) as {crons:Array<{path:string}>};
  const paths=config.crons.map(row=>row.path);
  assert.ok(paths.includes("/api/internal/scheduler/offers"));
  assert.ok(paths.includes("/api/internal/scheduler/refresh"));
  assert.ok(paths.includes("/api/internal/scheduler/sense"));
});
