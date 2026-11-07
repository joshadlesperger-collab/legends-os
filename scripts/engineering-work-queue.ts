import { readFileSync, writeFileSync, openSync, closeSync, renameSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {createHash} from "node:crypto";
import {existsSync} from 'node:fs';
import {assessBulkImportTrial} from '../lib/bulk-import-acceptance.mjs';
import {capaSummary,recordCapa,checkCapa,syncDraftCapas,syncBulkAiCapas,draftFailureContext,type CapaQueue} from "../lib/engineering-capa.ts";
import {execFileSync} from "node:child_process";
import {pipelineEngineeringTask} from "../lib/engineering-pipeline.ts";
import {resumeEngineeringTask,suspendSellerAccess} from "../lib/engineering-work-queue.ts";
import {engineeringWorkerDispatch,claimEngineeringTaskForWorker} from "../lib/engineering-work-queue.ts";
import { captureEngineeringInstruction, instructionCoverage, type EngineeringQueue } from "../lib/engineering-work-queue.ts";
import { nextEngineeringTask, checkpointEngineeringTask, engineeringDispatch, admitEngineeringTask, claimEngineeringTask, type EngineeringTask } from "../lib/engineering-work-queue.ts";
const file = "artifacts/engineering-mission/work-queue.json";
const [command = "dispatch", id, evidence, outcomeFile] = process.argv.slice(2);
const read = () => JSON.parse(readFileSync(file, "utf8")) as CapaQueue;
const dispatch = (state: CapaQueue) => ({...engineeringDispatch(state.tasks,["local-read","local-write"]),instructions:instructionCoverage(state),capas:capaSummary(state)});
const proofFiles=(paths:string[])=>Object.fromEntries(paths.map(path=>{const bytes=readFileSync(path);if(!bytes.length)throw Error(`Empty CAPA evidence: ${path}`);return[path,createHash('sha256').update(bytes).digest('hex')];}));
// Generate without holding the engineering lock; admission rechecks task IDs under lock.
const pipeline=command==="discover-pipeline"?JSON.parse(execFileSync(process.execPath,["--experimental-strip-types","scripts/card-orchestrator.ts","work-plan","--limit","10"],{encoding:"utf8",maxBuffer:8*1024*1024})):null;
if (command === "next") console.log(JSON.stringify(nextEngineeringTask(read().tasks, ["local-read","local-write"]), null, 2));
else if(command === "dispatch") console.log(JSON.stringify(dispatch(read()),null,2));
else if(command === "instructions") console.log(JSON.stringify(instructionCoverage(read()),null,2));
else if(command === "dispatch-owned") {const state=read();console.log(JSON.stringify({...engineeringWorkerDispatch(state.tasks,["local-read","local-write"],id),capas:capaSummary(state)},null,2));}
else if(command === "capa-status") console.log(JSON.stringify(capaSummary(read()),null,2));
else if(command === "capa-draft-context") console.log(JSON.stringify(draftFailureContext(JSON.parse(readFileSync('artifacts/card-orchestrator/state.json','utf8'))),null,2));
else {
  if (!["capa-record","capa-check","capa-sync-drafts","done","blocked","done-owned","blocked-owned","claim-owned","admit","claim","capture","resume","discover-pipeline","suspend-access"].includes(command)) throw Error("Use capa-status, capa-record PACKET, capa-check ID RESULT, capa-sync-drafts, dispatch-owned WORKER, claim-owned TASK_ID WORKER, done-owned/blocked-owned ID EVIDENCE OUTCOME, dispatch, instructions, capture, claim, next, admit, resume, discover-pipeline or suspend-access");
  const lock = `${file}.lock`, handle = openSync(lock, "wx");
  try {
    const state = read();
    let claimed;
    if(command === "capa-record") {
      const packet=JSON.parse(readFileSync(id,"utf8"));
      const hashes=proofFiles([...packet.incidents.map((i:{evidence:string})=>i.evidence),...packet.rootCause.evidence,...packet.implementationEvidence]);
      const row=recordCapa(state,packet);row.history.push({at:new Date().toISOString(),event:'evidence-hashes',snapshot:hashes});
    }
    else if(command === "capa-check") {
      const result=JSON.parse(readFileSync(evidence,"utf8"));
      const hashes=proofFiles(result.observations.map((o:{evidence:string})=>o.evidence));
      const row=checkCapa(state,id,result);row.history.push({at:new Date().toISOString(),event:'effectiveness-evidence-hashes',snapshot:hashes});
    }
    else if(command === "capa-sync-drafts") {
      const cardState=JSON.parse(readFileSync('artifacts/card-orchestrator/state.json','utf8'));
      const learning=cardState.draftLearning??{};
      if(Object.entries(learning).some(([field,r])=>(r as {failures:number}).failures>(state.capas?.find(c=>c.id===`draft-check-${field}`)?.sourceCount??0))){
        const proof=`artifacts/engineering-mission/capa-draft-observations-${randomUUID()}.json`;
        writeFileSync(proof,JSON.stringify({observedAt:new Date().toISOString(),source:'artifacts/card-orchestrator/state.json',learning},null,2),{flag:'wx',flush:true});
        syncDraftCapas(state,learning,proof);
      }
      const submissions=cardState.bulkAiSubmissions??{};
      const known=new Set(state.capas?.find(c=>c.id==='bulk-ai-stall-recovery')?.incidents.map(i=>i.id)??[]);
      const changed=Object.values(submissions).some((b:any)=>{const failure=[...(b.checkpoints??[])].reverse().find((c:any)=>c.phase==='recovery-failed'||c.phase==='stalled');return failure&&!known.has(`${b.id}:${failure.observationId}`);});
      if(changed){
        const proof=`artifacts/engineering-mission/capa-bulk-observations-${randomUUID()}.json`;
        writeFileSync(proof,JSON.stringify({observedAt:new Date().toISOString(),submissions},null,2),{flag:'wx',flush:true});
        syncBulkAiCapas(state,submissions,proof);
      }
    }
    else if(command === "discover-pipeline") {
      const proof=`artifacts/engineering-mission/pipeline-dispatch-${randomUUID()}.json`;
      writeFileSync(proof,JSON.stringify(pipeline,null,2),{flag:"wx",flush:true});
      if(pipeline.candidates.some((candidate:{needsSellerAccess:boolean})=>candidate.needsSellerAccess) && !state.tasks.some(t=>t.id==="seller-read-access")) {
        admitEngineeringTask(state.tasks,{id:"seller-read-access",priority:90,status:"ready",completionCriteria:"Verify current supported read-only Seller Hub/Product Research access with actual signed-in read evidence; no eBay edits, publication or paid API calls",dependencies:[],requiredPermissions:["local-read","local-write"],checkpoint:"",measurableOutcome:null,failureReason:null,retryPolicy:"Retry only after a changed authenticated session or user-selected supported source",links:{cards:[],code:[],evidence:[proof]}});
      }
      for(const candidate of pipeline.candidates)if(!state.tasks.some(t=>t.id===candidate.id))admitEngineeringTask(state.tasks,pipelineEngineeringTask(candidate,proof));
    }
    else if(command === "suspend-access") {
      if(id!=="seller-read-access" || !readFileSync(evidence,"utf8").trim())throw Error("Existing seller access failure evidence required");
      suspendSellerAccess(state.tasks,evidence,JSON.parse(readFileSync(outcomeFile,"utf8")).blocker);
    }
    else if(command === "resume") {
      const task=state.tasks.find(t=>t.id===id);if(!task)throw Error("Unknown task");
      if(!readFileSync(evidence,"utf8").trim())throw Error("Resume evidence file is empty");
      resumeEngineeringTask(task,outcomeFile,evidence);
    }
    else if(command === "capture") { const packet=JSON.parse(readFileSync(id,"utf8")); captureEngineeringInstruction(state,packet.instruction,packet.tasks ?? []); }
    else if(command === "claim") claimEngineeringTask(state.tasks,["local-read","local-write"]);
    else if(command === "claim-owned") claimed=claimEngineeringTaskForWorker(state.tasks,["local-read","local-write"],evidence,randomUUID(),new Date().toISOString(),id);
    else if(command === "admit") admitEngineeringTask(state.tasks,JSON.parse(readFileSync(id,"utf8")));
    else {
    const task = state.tasks.find(t=>t.id === id);
    if (!task) throw Error("Unknown task");
    const outcome = JSON.parse(readFileSync(outcomeFile, "utf8"));
    if(command.startsWith('done') && task.acceptanceKind==='bulk-import') {
      const result=assessBulkImportTrial(JSON.parse(readFileSync(outcome.acceptanceEvidence,'utf8')),existsSync);
      if(!result.passed)throw Error(`Import acceptance failed: ${result.failures.join('; ')}`);
    }
    if(command.endsWith("-owned") && (!task.claim || !readFileSync(evidence,"utf8").trim()))throw Error("Owned claim and nonempty evidence file required");
    checkpointEngineeringTask(task, command.startsWith("done")?"done":"blocked", evidence, outcome, outcome.blocker,command.endsWith("-owned")?outcome.claim:undefined);
    }
    const temp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(state, null, 2), { flag: "wx", flush: true });
    renameSync(temp, file);
    console.log(JSON.stringify({ task: id, status: command, claimed, dispatch: claimed?engineeringWorkerDispatch(state.tasks,["local-read","local-write"],claimed.claim!.owner):dispatch(state) }));
  } finally { closeSync(handle); unlinkSync(lock); }
}
