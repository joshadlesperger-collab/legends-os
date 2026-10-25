// Local-only bounded supervisor for the existing preparation CLI.
// Run from repository root: node scripts/harness-preparation-supervisor.mjs
// This does NOT perform image research or eBay writes and is not a deployed service.
import { spawn } from "node:child_process";
import { mkdir, open, readFile, rename, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const dir = path.resolve("artifacts/card-orchestrator");
const lockPath = path.join(dir, "supervisor.lock");
const statusPath = path.join(dir, "supervisor-status.json");
const maxCycles = Number(process.env.HARNESS_MAX_CYCLES ?? 12);
const maxMinutes = Number(process.env.HARNESS_MAX_MINUTES ?? 120);
const cycleTimeoutMs = Number(process.env.HARNESS_CYCLE_TIMEOUT_MS ?? 300000);
if (![maxCycles,maxMinutes,cycleTimeoutMs].every(Number.isFinite) || maxCycles < 1 || maxCycles > 100 || maxMinutes < 1 || maxMinutes > 720 || cycleTimeoutMs < 1000 || cycleTimeoutMs > 3600000) {
  throw new Error("Invalid supervisor limits");
}
await mkdir(dir, {recursive:true});
let lock;
try { lock = await open(lockPath, "wx"); }
catch (e) { if (e.code === "EEXIST") throw new Error("Supervisor lock exists: verify no active supervisor before removing stale lock"); throw e; }
const started = Date.now();
const report = {startedAt:new Date(started).toISOString(),finishedAt:null,cycles:[],state:"running",note:"Local preparation only; eBay drafts not created"};
async function checkpoint() {
  const tmp = statusPath + ".tmp";
  await writeFile(tmp,JSON.stringify(report,null,2));
  await rename(tmp,statusPath);
}
async function run(args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ["--experimental-strip-types","scripts/card-orchestrator.ts",...args], {cwd:process.cwd(),stdio:["ignore","pipe","pipe"],windowsHide:true});
    let stdout="",stderr="",timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;child.kill();},cycleTimeoutMs);
    child.stdout.on("data",b=>{stdout=(stdout+b).slice(-16000);});
    child.stderr.on("data",b=>{stderr=(stderr+b).slice(-16000);});
    child.on("error",err=>{clearTimeout(timer);resolve({ok:false,error:String(err),timedOut});});
    child.on("close",(code)=>{clearTimeout(timer);resolve({ok:code===0,code,timedOut,stdout,stderr});});
  });
}
try {
  await lock.writeFile(JSON.stringify({pid:process.pid,startedAt:report.startedAt}));
  await checkpoint();
  for(let i=0;i<maxCycles && Date.now()-started < maxMinutes*60000;i++) {
    const sync=await run(["sync","--new","--limit","10"]);
    const execution=sync.ok ? await run(["run","--limit","10"]) : null;
    report.cycles.push({at:new Date().toISOString(),sync,execution});
    await checkpoint();
    if(!sync.ok || !execution?.ok){report.state="stopped-on-error";break;}
    // Deliberately bounded: this CLI cannot autonomously supply missing image/comp evidence.
  }
  if(report.state==="running") report.state="bounded-run-complete";
} catch(e) { report.state="failed";report.error=String(e); }
finally {
  report.finishedAt=new Date().toISOString();
  await checkpoint();
  await lock.close();
  await unlink(lockPath).catch(()=>{});
}
if(report.state==="failed" || report.state==="stopped-on-error") process.exitCode=1;
