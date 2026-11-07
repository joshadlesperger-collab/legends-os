import test from "node:test";
import assert from "node:assert/strict";
import {captureEngineeringInstruction,instructionCoverage,type EngineeringQueue} from "../lib/engineering-work-queue.ts";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {execFileSync} from "node:child_process";
import { nextEngineeringTask, checkpointEngineeringTask, type EngineeringTask } from "../lib/engineering-work-queue.ts";
import {resumeEngineeringTask,suspendSellerAccess} from "../lib/engineering-work-queue.ts";
import {engineeringWorkerDispatch,claimEngineeringTaskForWorker} from "../lib/engineering-work-queue.ts";
const task = (id: string, priority: number): EngineeringTask => ({id,priority,status:"ready",completionCriteria:"measured outcome",dependencies:[],requiredPermissions:["local"],checkpoint:"",measurableOutcome:null,failureReason:null,retryPolicy:"new evidence only",links:{cards:[],code:[],evidence:[]}});
test('worker claims bypass foreign active work without stealing it or completing the wrong task',()=>{
 const legacy=task('legacy',100),a=task('a',20),b=task('b',10);legacy.status='in-progress';
 const tasks=[legacy,a,b],before=JSON.stringify(legacy);
 claimEngineeringTaskForWorker(tasks,['local'],'worker-a','token-a','2026-10-25T14:00:00Z','a');
 assert.equal(engineeringWorkerDispatch(tasks,['local'],'worker-b').next?.id,'b');
 assert.throws(()=>claimEngineeringTaskForWorker(tasks,['local'],'worker-b','token-b','2026-10-25T14:00:00Z','a'),/not actionable/);
 assert.throws(()=>checkpointEngineeringTask(a,'done','evidence.json',{}),/Matching worker/);
 assert.throws(()=>checkpointEngineeringTask(a,'done','evidence.json',{},undefined,{owner:'worker-b',token:'token-a'}),/Matching worker/);
 assert.throws(()=>claimEngineeringTaskForWorker(tasks,['local'],'worker-a','other','2026-10-25T14:00:00Z','b'),/Checkpoint/);
 checkpointEngineeringTask(a,'done','evidence.json',{passed:true},undefined,{owner:'worker-a',token:'token-a'});
 claimEngineeringTaskForWorker(tasks,['local'],'worker-a','token-b','2026-10-25T14:01:00Z','b');
 assert.equal(JSON.stringify(legacy),before);
});
test('worker dispatch separates actionable backlog from exact dependency and permission gates',()=>{
 const a=task('a',1),b=task('b',20),c=task('c',10);b.dependencies=['missing'];c.requiredPermissions=['paid'];
 const result=engineeringWorkerDispatch([a,b,c],['local'],'worker');
 assert.deepEqual(result.actionable.map(t=>t.id),['a']);
 assert.deepEqual(result.exceptions.map(t=>t.reasons),[['Dependency unfinished: missing'],['Permission unavailable: paid']]);
 assert.throws(()=>claimEngineeringTaskForWorker([a,b,c],['local'],'worker','token','2026-10-25','b'),/not actionable/);
});
test('owned CLI receipt selects the requested task and fences checkpoints across processes',()=>{
 const dir=mkdtempSync(join(tmpdir(),'owned-engineering-')),folder=join(dir,'artifacts/engineering-mission');mkdirSync(folder,{recursive:true});
 const script=fileURLToPath(new URL('../scripts/engineering-work-queue.ts',import.meta.url));
 const run=(...args:string[])=>execFileSync(process.execPath,['--experimental-strip-types',script,...args],{cwd:dir,stdio:['ignore','pipe','pipe']}).toString();
 try{
  const legacy=task('legacy',100),a=task('a',1);legacy.status='in-progress';legacy.requiredPermissions=a.requiredPermissions=['local-read'];
  const file=join(folder,'work-queue.json'),outcome=join(dir,'outcome.json');writeFileSync(file,JSON.stringify({version:1,tasks:[legacy,a]}));
  const receipt=JSON.parse(run('claim-owned','a','worker'));
  assert.equal(receipt.claimed.id,'a');assert.equal(receipt.dispatch.next.id,'a');
  writeFileSync(outcome,JSON.stringify({claim:receipt.claimed.claim,passed:1}));
  const saved=readFileSync(file,'utf8');
  assert.throws(()=>run('done','a',outcome,outcome));assert.equal(readFileSync(file,'utf8'),saved);
  assert.throws(()=>run('done-owned','a','absent.json',outcome));assert.equal(readFileSync(file,'utf8'),saved);
  run('done-owned','a',outcome,outcome);
  const after=JSON.parse(readFileSync(file,'utf8'));assert.equal(after.tasks[1].status,'done');assert.deepEqual(after.tasks[0],legacy);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('blocked work resumes only with new evidence and retains old failure history',()=>{
 const a=task('resume',1);checkpointEngineeringTask(a,'blocked','old.json',{failed:true},'login required');
 assert.throws(()=>resumeEngineeringTask(a,'initial','new.json'),/New input/);
 assert.throws(()=>resumeEngineeringTask(a,'new','old.json'),/New input/);
 resumeEngineeringTask(a,'new','signed-in.json');
 assert.equal(nextEngineeringTask([a],['local'])?.id,'resume');
 assert.equal(a.history?.[0].failureReason,'login required');
 assert.deepEqual(a.history?.[0].measurableOutcome,{failed:true});
 assert.throws(()=>resumeEngineeringTask(a,'newer','other.json'),/Only blocked/);
});
test('lost seller access isolates active review and allows independent local work',()=>{
 const gate=task('seller-read-access',90),pricing=task('pricing',65),local=task('photos',50);
 checkpointEngineeringTask(gate,'done','login.json',{signedIn:true});
 pricing.dependencies=[gate.id];pricing.status='in-progress';
 const tasks=[gate,pricing,local];suspendSellerAccess(tasks,'expired-session.json','Session expired');
 assert.equal(gate.status,'blocked');assert.equal(pricing.status,'blocked');
 assert.equal(nextEngineeringTask(tasks,['local'])?.id,'photos');
 assert.equal(gate.history?.[0].status,'done');
 assert.throws(()=>suspendSellerAccess(tasks,'same.json','Session expired'),/already blocked/);
 resumeEngineeringTask(gate,'new-login','relogin.json');checkpointEngineeringTask(gate,'done','verified-relogin.json',{signedIn:true});
 assert.equal(pricing.status,'blocked'); // Resume the interrupted card with its own fresh evidence.
});
test('instruction capture is atomic, preserves provenance and reports unfinished coverage',()=>{
 const state:EngineeringQueue={version:1,tasks:[]};const t=task('fix',10);t.links.evidence=['request.json'];
 const instruction={id:'request',text:'fix whatever is needed here',source:'chat 2026-10-25',capturedAt:'2026-10-25T18:00:00Z',taskIds:['fix'],policyRefs:['AGENTS.md']};
 assert.throws(()=>captureEngineeringInstruction(state,{...instruction,taskIds:['missing']},[t]),/Unknown/);
 assert.equal(state.tasks.length,0);assert.equal(state.instructions,undefined);
 captureEngineeringInstruction(state,instruction,[t]);t.status='done';assert.equal(state.tasks[0].status,'ready');
 assert.equal(instructionCoverage(state)[0].tasks[0].status,'ready');
 assert.throws(()=>captureEngineeringInstruction(state,instruction),/Duplicate/);
 captureEngineeringInstruction(state,{...instruction,id:'revision',supersedes:['request']});
 assert.deepEqual(instructionCoverage(state)[0].supersededBy,['revision']);
 assert.equal(instructionCoverage(state)[0].text,instruction.text);
 checkpointEngineeringTask(state.tasks[0],'blocked','receipt.json',{},'missing source');
 assert.equal(instructionCoverage(state)[1].tasks[0].blocker,'missing source');
});
test("blocked task does not stop independent work; completed tasks are not repeated", () => {
  const a=task("a",10), b=task("b",5), c=task("c",20);c.dependencies=["a"];
  assert.equal(nextEngineeringTask([a,b,c],["local"])?.id,"a");
  checkpointEngineeringTask(a,"blocked","receipt.json",{count:0},"missing source");
  assert.equal(nextEngineeringTask([a,b,c],["local"])?.id,"b");
  a.status="ready";assert.equal(nextEngineeringTask([a,b,c],["local"])?.id,"b");
  a.inputVersion="new evidence";assert.equal(nextEngineeringTask([a,b,c],["local"])?.id,"a");
  checkpointEngineeringTask(a,"done","verified.json",{count:1});
  assert.equal(nextEngineeringTask([a,b,c],["local"])?.id,"c");
  assert.throws(()=>checkpointEngineeringTask(a,"done","other.json",{}),/overwritten/);
});
test("permission and dependency gates cannot be skipped; duplicate IDs fail closed", () => {
  const a=task("a",10);assert.equal(nextEngineeringTask([a],[]),null);
  a.dependencies=["missing"];assert.equal(nextEngineeringTask([a],["local"]),null);
  assert.throws(()=>nextEngineeringTask([a,a],["local"]),/Duplicate/);
});

test("CLI checkpoints survive process restart, refuse replay and preserve an existing lock",()=>{
  const dir=mkdtempSync(join(tmpdir(),"engineering-queue-")),folder=join(dir,"artifacts/engineering-mission");mkdirSync(folder,{recursive:true});
  const file=join(folder,"work-queue.json"),outcome=join(dir,"outcome.json");
  const script=fileURLToPath(new URL("../scripts/engineering-work-queue.ts",import.meta.url));
  const run=(...args:string[])=>execFileSync(process.execPath,["--experimental-strip-types",script,...args],{cwd:dir,stdio:["ignore","pipe","pipe"]}).toString();
  try {
    const a=task("a",10),b=task("b",5);a.requiredPermissions=b.requiredPermissions=["local-read"];
    writeFileSync(file,JSON.stringify({version:1,tasks:[a,b]}));writeFileSync(outcome,JSON.stringify({passed:1}));
    run("done","a","receipt.json",outcome);
    const saved=readFileSync(file,"utf8");assert.equal(JSON.parse(saved).tasks[0].status,"done");
    assert.equal(JSON.parse(run("next")).id,"b");
    const packet=join(dir,'instruction.json');
    writeFileSync(packet,JSON.stringify({instruction:{id:'request',text:'finish b',source:'test chat',capturedAt:'2026-10-25T18:00:00Z',taskIds:['b'],policyRefs:[]}}));
    run('capture',packet);assert.equal(JSON.parse(run('instructions'))[0].tasks[0].status,'ready');
    assert.throws(()=>run('capture',packet));
    const captured=readFileSync(file,'utf8');
    assert.throws(()=>run("done","a","receipt.json",outcome));assert.equal(readFileSync(file,"utf8"),captured);
    assert.equal(existsSync(file+".lock"),false);
    writeFileSync(file+".lock","another owner");assert.throws(()=>run("done","b","receipt.json",outcome));
    assert.equal(readFileSync(file+".lock","utf8"),"another owner");assert.equal(readFileSync(file,"utf8"),captured);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test("empty dispatch requests discovery; evidence-backed admission resumes independent work", async()=>{
  const {engineeringDispatch,admitEngineeringTask}=await import('../lib/engineering-work-queue.ts');
  const a=task('blocked',100);checkpointEngineeringTask(a,'blocked','blocked.json',{},'external input');
  const tasks=[a];assert.equal(engineeringDispatch(tasks,['local']).action,'discover');
  assert.equal(engineeringDispatch(tasks,['local']).missionComplete,false);
  const b=task('audit',5);assert.throws(()=>admitEngineeringTask(tasks,b),/evidence/);
  b.links.evidence=['discovery.json'];admitEngineeringTask(tasks,b);
  assert.equal(engineeringDispatch(tasks,['local']).next?.id,'audit');
  assert.equal(tasks[0].status,'blocked');assert.throws(()=>admitEngineeringTask(tasks,b),/Duplicate/);
});

test('claim persists active work and blocked completion immediately frees independent work',async()=>{
 const {claimEngineeringTask}=await import('../lib/engineering-work-queue.ts');
 const a=task('a',10),b=task('b',5),tasks=[a,b];
 assert.equal(claimEngineeringTask(tasks,['local']).next?.id,'a');assert.equal(a.status,'in-progress');
 b.priority=100;assert.equal(claimEngineeringTask(tasks,['local']).next?.id,'a');
 checkpointEngineeringTask(a,'blocked','new-blocker.json',{},'missing external evidence');
 assert.equal(claimEngineeringTask(tasks,['local']).next?.id,'b');
 assert.throws(()=>claimEngineeringTask(tasks,[]),/permission/);
});
