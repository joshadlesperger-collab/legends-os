export type EngineeringTask = {
  acceptanceKind?: 'bulk-import';
  id: string; priority: number; status: "ready" | "in-progress" | "done" | "blocked";
  completionCriteria: string; dependencies: string[]; requiredPermissions: string[];
  checkpoint: string; measurableOutcome: unknown; failureReason: string | null;
  retryPolicy: string; links: { cards: string[]; code: string[]; evidence: string[] };
  attempts?: number; inputVersion?: string; failedInputVersion?: string;
  claim?: { owner: string; token: string; claimedAt: string };
  history?: {status:string; checkpoint:string; measurableOutcome:unknown; failureReason:string|null; inputVersion?:string}[];
};
export type EngineeringInstruction = {
  id: string; text: string; source: string; capturedAt: string;
  taskIds: string[]; policyRefs: string[]; supersedes?: string[];
};
export type EngineeringQueue = { version: number; tasks: EngineeringTask[]; instructions?: EngineeringInstruction[] };

/** Capture provenance and its executable/policy coverage in the same durable queue. */
export function captureEngineeringInstruction(state: EngineeringQueue, instruction: EngineeringInstruction, tasks: EngineeringTask[] = []) {
  if (!instruction?.id?.trim() || !instruction.text?.trim() || !instruction.source?.trim()
    || !Number.isFinite(Date.parse(instruction.capturedAt))
    || !Array.isArray(instruction.taskIds) || !Array.isArray(instruction.policyRefs)
    || [...instruction.taskIds,...instruction.policyRefs].some(value=>typeof value!=="string" || !value.trim())
    || (!instruction.taskIds.length && !instruction.policyRefs.length)) throw Error("Instruction requires source, exact text, timestamp and task or policy coverage");
  const existing = state.instructions ?? [];
  if(existing.some(item=>item.id===instruction.id)) throw Error("Duplicate instruction ID; preserve original capture");
  if((instruction.supersedes ?? []).some(id=>!existing.some(item=>item.id===id))) throw Error("Unknown superseded instruction");
  const staged = structuredClone(state.tasks);
  for(const task of tasks) admitEngineeringTask(staged,task);
  if(instruction.taskIds.some(id=>!staged.some(task=>task.id===id))) throw Error("Unknown instruction task");
  if(tasks.some(task=>!instruction.taskIds.includes(task.id))) throw Error("New task must be linked to instruction");
  state.tasks=staged;
  state.instructions=[...existing,structuredClone(instruction)];
}

export function instructionCoverage(state: EngineeringQueue) {
  return (state.instructions ?? []).map(instruction=>({ ...instruction,
    supersededBy:(state.instructions ?? []).filter(other=>other.supersedes?.includes(instruction.id)).map(other=>other.id),
    tasks:instruction.taskIds.map(id=>{const task=state.tasks.find(item=>item.id===id);return {
      id,status:task?.status ?? "missing",checkpoint:task?.checkpoint ?? "",blocker:task?.failureReason ?? null,
    };}),
  }));
}
export function nextEngineeringTask(tasks: EngineeringTask[], permissions: readonly string[]) {
  const ids = new Set(tasks.map(task => task.id));
  if (ids.size !== tasks.length) throw Error("Duplicate engineering task ID");
  const completed = new Set(tasks.filter(task => task.status === "done").map(task => task.id));
  return tasks.filter(task => (task.status === "ready" || task.status === "in-progress")
    && task.dependencies.every(id => completed.has(id))
    && task.requiredPermissions.every(permission => permissions.includes(permission))
    && !(task.failedInputVersion && task.failedInputVersion === (task.inputVersion ?? "initial")))
    .sort((a,b) => Number(b.status==="in-progress")-Number(a.status==="in-progress") || b.priority-a.priority || a.id.localeCompare(b.id))[0] ?? null;
}
export function checkpointEngineeringTask(task: EngineeringTask, status: "done" | "blocked", evidence: string, outcome: unknown, failureReason?: string, claim?: {owner:string;token:string}) {
  if(task.claim && (task.claim.owner!==claim?.owner || task.claim.token!==claim?.token)) throw Error("Matching worker claim required; foreign work cannot be checkpointed");
  if (!evidence.trim() || outcome === undefined || (status === "blocked" && !failureReason?.trim())) throw Error("Evidence, outcome and explicit blocker required");
  if (task.status === "done") throw Error("Completed work cannot be overwritten");
  task.status = status; task.checkpoint = evidence; task.measurableOutcome = outcome;
  task.failureReason = status === "blocked" ? failureReason! : null;
  task.attempts = (task.attempts ?? 0) + 1;
  if (status === "blocked") task.failedInputVersion = task.inputVersion ?? "initial";
  if (!task.links.evidence.includes(evidence)) task.links.evidence.push(evidence);
}

/** Explicit changed evidence reopens only this task; never clears its earlier failure. */
export function resumeEngineeringTask(task: EngineeringTask, inputVersion: string, evidence: string) {
  if(task.status!=="blocked")throw Error("Only blocked tasks may resume");
  if(!inputVersion?.trim() || inputVersion===(task.inputVersion ?? "initial") || inputVersion===task.failedInputVersion
    || !evidence?.trim() || task.links.evidence.includes(evidence))throw Error("New input version and new evidence required");
  task.history ??= [];
  task.history.push({status:task.status,checkpoint:task.checkpoint,measurableOutcome:structuredClone(task.measurableOutcome),failureReason:task.failureReason,inputVersion:task.inputVersion});
  task.status="ready"; task.inputVersion=inputVersion;task.checkpoint=evidence;task.failureReason=null;
  task.links.evidence.push(evidence);
}

/** A lost session invalidates this access prerequisite, not completed card work. */
export function suspendSellerAccess(tasks:EngineeringTask[], evidence:string, reason:string) {
  const gate=tasks.find(task=>task.id==="seller-read-access");
  if(!gate || !evidence.trim() || !reason.trim())throw Error("Seller access gate and actual failure evidence required");
  if(gate.status==="blocked")throw Error("Access is already blocked; do not repeat unchanged failures");
  const affected=[gate,...tasks.filter(task=>task.status==="in-progress"&&task.dependencies.includes(gate.id))];
  for(const task of affected){
    task.history ??=[];
    task.history.push({status:task.status,checkpoint:task.checkpoint,measurableOutcome:structuredClone(task.measurableOutcome),failureReason:task.failureReason,inputVersion:task.inputVersion});
    task.status="ready";
    checkpointEngineeringTask(task,"blocked",evidence,{accessAvailable:false},reason,task.claim);
  }
}

/** An empty eligible queue is a discovery request, never proof the mission is complete. */
export function engineeringDispatch(tasks: EngineeringTask[], permissions: readonly string[]) {
  const next = nextEngineeringTask(tasks, permissions);
  return { action: next ? "execute" : "discover", next,
    missionComplete: false,
    exceptions: tasks.filter(t=>t.status!=="done"&&t.id!==next?.id).map(t=>({id:t.id,
      reason:t.failureReason ?? "Dependency, permission or unchanged-input gate",
      checkpoint:t.checkpoint,retryPolicy:t.retryPolicy})),
    discovery: next ? [] : [
      "Inspect changed inputs and newly completed dependencies before retrying blocked work",
      "Audit remaining mission requirements for independent unpaid work; admit a concrete task with evidence and completion criteria",
      "If no work is eligible, checkpoint exact external inputs needed; do not repeat unchanged builds, tests or holds",
    ] };
}

/** Persist selection before execution so subsequent invocations resume unfinished work. */
export function claimEngineeringTask(tasks: EngineeringTask[], permissions: readonly string[]) {
  const legacy = tasks.filter(t=>!t.claim);
  const active = legacy.filter(t=>t.status==="in-progress");
  if(active.length>1)throw Error("Multiple active engineering tasks require reconciliation");
  const selected = nextEngineeringTask(tasks, permissions);
  const task = active[0] ?? (selected?.claim ? null : selected);
  if(!task)return engineeringDispatch(tasks,permissions);
  if(!task.requiredPermissions.every(p=>permissions.includes(p)))throw Error("Active task requires unavailable permission");
  if(!task.dependencies.every(id=>tasks.some(t=>t.id===id&&t.status==="done")))throw Error("Active task dependency unavailable");
  task.status="in-progress";
  return {...engineeringDispatch(tasks,permissions),action:"execute",next:task};
}

/** Ownership is explicit. Legacy active work stays untouched and never monopolizes another worker. */
export function engineeringWorkerDispatch(tasks:EngineeringTask[], permissions:readonly string[], owner:string) {
  if(!owner?.trim())throw Error("Worker owner required");
  if(new Set(tasks.map(t=>t.id)).size!==tasks.length)throw Error("Duplicate engineering task ID");
  const completed=new Set(tasks.filter(t=>t.status==="done").map(t=>t.id));
  const rows=tasks.filter(t=>t.status!=="done").map(task=>{
    const reasons:string[]=[];
    if(task.status==="blocked")reasons.push(task.failureReason ?? "Explicit hold");
    for(const id of task.dependencies)if(!completed.has(id))reasons.push(`Dependency unfinished: ${id}`);
    for(const permission of task.requiredPermissions)if(!permissions.includes(permission))reasons.push(`Permission unavailable: ${permission}`);
    if(task.failedInputVersion && task.failedInputVersion===(task.inputVersion??"initial"))reasons.push("Unchanged failed input");
    if(task.status==="in-progress" && task.claim?.owner!==owner)reasons.push(task.claim?`Owned by ${task.claim.owner}`:"Legacy active task: owner unrecorded; preserved");
    return {task,reasons};
  });
  const actionable=rows.filter(r=>!r.reasons.length).map(r=>r.task).sort((a,b)=>Number(b.status==="in-progress")-Number(a.status==="in-progress")||b.priority-a.priority||a.id.localeCompare(b.id));
  return {owner,action:actionable.length?"execute":"discover",next:actionable[0]??null,
    actionable:actionable.map(t=>({id:t.id,status:t.status,priority:t.priority})),
    exceptions:rows.filter(r=>r.reasons.length).map(r=>({id:r.task.id,reasons:r.reasons,checkpoint:r.task.checkpoint})),missionComplete:false};
}

export function claimEngineeringTaskForWorker(tasks:EngineeringTask[],permissions:readonly string[],owner:string,token:string,now:string,id?:string) {
  if(!token?.trim()||!Number.isFinite(Date.parse(now)))throw Error("Claim token and time required");
  const dispatch=engineeringWorkerDispatch(tasks,permissions,owner);
  const ownActive=tasks.find(t=>t.status==="in-progress"&&t.claim?.owner===owner);
  if(ownActive && id && ownActive.id!==id)throw Error("Checkpoint owned active task before claiming another");
  const selected=id?tasks.find(t=>t.id===id):dispatch.next;
  if(!selected || !dispatch.actionable.some(t=>t.id===selected.id))throw Error("Requested task is not actionable for this worker");
  if(selected.status!=="in-progress")selected.claim={owner,token,claimedAt:now};
  selected.status="in-progress";
  return selected;
}

export function admitEngineeringTask(tasks: EngineeringTask[], candidate: EngineeringTask) {
  if (!candidate || typeof candidate.id!=="string" || !candidate.id.trim()
    || !Number.isFinite(candidate.priority) || candidate.status!=="ready"
    || !candidate.completionCriteria?.trim() || !candidate.retryPolicy?.trim()
    || !Array.isArray(candidate.dependencies) || !Array.isArray(candidate.requiredPermissions)
    || !candidate.links || !Array.isArray(candidate.links.evidence) || !candidate.links.evidence.length
    || !Array.isArray(candidate.links.cards) || !Array.isArray(candidate.links.code)) throw Error("New task requires criteria, permissions and discovery evidence");
  if(tasks.some(t=>t.id===candidate.id))throw Error("Duplicate engineering task ID");
  if(candidate.dependencies.some(id=>!tasks.some(t=>t.id===id)))throw Error("Unknown dependency");
  tasks.push(structuredClone(candidate));
}
