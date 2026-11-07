import {assertV2JournalRowsUnchanged} from './card-processing-v2-checkpoint-guard.ts';
import runtimeRoot from './card-processing-v2-runtime-root.cjs';
import fs from "node:fs/promises";
import { openSync, closeSync, writeSync } from "node:fs";
import path from "node:path";
import { randomUUID,createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { categorySchema, emptyV2State, stateSchema, v2Summary, type V2State } from "./card-processing-v2.ts";
import { historicalMethodReview } from "./card-processing-v2-transport.ts";
import { v2ConnectionPrerequisites } from "./card-processing-v2-connection.ts";
import { replaceV2Checkpoint } from "./card-processing-v2-atomic-replace.ts";
import { listV2ProcessingBatches, newV2ProcessingBatch, writeV2ProcessingBatch, validateV2ClickedAt, acknowledgeV2ProcessingBatchSpawn, reconcileV2ProcessingBatch } from "./card-processing-v2-processing-batches.ts";
import {readV2ActivitySnapshot,recordV2ActivityCheckpoint,recordV2ObservedActivity} from './card-processing-v2-activity.ts';
import {v2BatchProgress} from './card-processing-v2-batch-progress.ts';
import {readV2TimingJournal,mergeV2JournalTimings} from './card-processing-v2-timing-journal.ts';

const categoryReportSchema = z.object({ observedAt: z.string().datetime(), categories: z.array(categorySchema), capabilities: z.array(z.object({
  categoryId: z.enum(["183454", "261328", "183050"]), status: z.enum(["ready", "blocked"]), detail: z.string(), conditionHelpText: z.string().optional(), descriptorId: z.string().optional(), descriptorValueId: z.string().optional(),
  diagnostic: z.object({ phase: z.literal("category-aspects"), code: z.enum(["READ_FAILED", "SCHEMA_INVALID", "UNSUPPORTED_CONTRACT"]), httpStatus: z.number().int().optional(), paths: z.array(z.string().max(300)).max(20).optional() }).strict().optional(),
}).strict()) }).passthrough();
async function categoryReport(root: string) {
  try { return categoryReportSchema.parse(JSON.parse(await fs.readFile(path.join(v2Dir(root), "category-metadata.json"), "utf8"))); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw Error("V2 category evidence is invalid; no requirements were inferred."); }
}
const configBoundaries = new WeakMap<V2Config,number[]>();
async function effectiveConfig(config: V2Config, root: string) {
  const report = await categoryReport(root);
  if(report)configBoundaries.set(config,[Date.parse(report.observedAt),Date.parse(report.observedAt)+7*86400000]);
  if (!report || Date.parse(report.observedAt) > Date.now() || Date.now() - Date.parse(report.observedAt) > 7 * 86400000) return config;
  const categories = new Map(config.categories.map(c => [c.categoryId, c]));
  for (const category of report.categories) if (!categories.has(category.categoryId) || Date.parse(category.observedAt) > Date.parse(categories.get(category.categoryId)!.observedAt)) categories.set(category.categoryId, category);
  const result={ ...config, categories: Array.from(categories.values()) };configBoundaries.set(result,configBoundaries.get(config)??[]);return result;
}

export const configSchema = z.object({
  folder: z.string().min(1), pairing: z.enum(["named", "alternating"]).default("named"),
  batchLimit: z.number().int().min(1).max(20).default(10), categories: z.array(categorySchema).default([]),
  inputVersion: z.string().min(1).default("initial"),
  identification: z.object({ model: z.string().min(1), authority: z.string().min(1), expiresAt: z.string().datetime(),
    pricingSource: z.string().url(), inputUsdPerMillion: z.number().positive(), outputUsdPerMillion: z.number().positive(),
    maxInputTokens: z.number().int().positive(), maxOutputTokens: z.number().int().min(1000).max(6000),
    maxRequestBytes: z.number().int().positive().max(10_000_000), capMicros: z.number().int().positive(),
  }).strict().optional(),
}).strict();
export type V2Config = z.infer<typeof configSchema>;
export const v2Dir = (root = process.cwd()) => path.join(root, "artifacts", "card-processing-v2");
async function readV2ConfigUncached(root = process.cwd()): Promise<V2Config> {
  try { return await effectiveConfig(configSchema.parse(JSON.parse(await fs.readFile(path.join(v2Dir(root), "config.json"), "utf8"))), root); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw Error("Card Processing V2 configuration is invalid; existing records were preserved."); }
  return effectiveConfig(configSchema.parse({ folder: process.env.CARD_SCANNER_PATH || process.env.CARD_INBOX_PATH || (process.platform === "win32" ? "C:\\CardScans" : path.join(root, "CardScans")) }), root);
}
type ConfigReadEntry = {fingerprint:string; value:Promise<V2Config>; checkedAt:number};
const configReads = new AsyncLocalStorage<Map<string,ConfigReadEntry>>();
/** Explicit request/run lifetime only. Each read still detects file replacement and freshness boundaries. */
export function withV2ConfigReads<T>(action:()=>T):T {
  return configReads.getStore() ? action() : configReads.run(new Map(),action);
}
export async function readV2Config(root=process.cwd()):Promise<V2Config> {
  const cache=configReads.getStore();if(!cache)return readV2ConfigUncached(root);
  const key=path.resolve(root), now=Date.now();
  const fingerprint=(await Promise.all(['config.json','category-metadata.json'].map(async name=>{
    try{const s=await fs.stat(path.join(v2Dir(root),name),{bigint:true});return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;}
    catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return 'missing';throw e;}
  }))).join('|');
  const previous=cache.get(key);
  if(previous&&previous.fingerprint===fingerprint){
    const value=await previous.value;
    // Re-evaluate at any observed category timestamp / seven-day expiry boundary, including clock rollback.
    const crossed=now<previous.checkedAt || (configBoundaries.get(value)??[]).some(boundary=>previous.checkedAt<=boundary&&now>boundary);
    if(!crossed)return value;
  }
  const value=readV2ConfigUncached(root),entry={fingerprint,value,checkedAt:now};cache.set(key,entry);
  try{return await value;}catch(e){if(cache.get(key)===entry)cache.delete(key);throw e;}
}
async function readV2StateDocument(root = process.cwd()): Promise<V2State> {
  try { return stateSchema.parse(JSON.parse(await fs.readFile(path.join(v2Dir(root), "state.json"), "utf8"))); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return emptyV2State(); throw Error("V2 checkpoint is unreadable; stopped without replacing it."); }
}
/** Read compatibility includes the separate timing journal without folding it
 * into the inventory checkpoint on the next domain write. */
export async function readV2State(root = process.cwd()): Promise<V2State> {
  const [state,journal]=await Promise.all([readV2StateDocument(root),readV2TimingJournal(root)]);
  state.timings=mergeV2JournalTimings(state.timings,journal.spans);return state;
}
export function processAlive(pid: number) { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } }

/** Single-host PID lock. A dead owner's lock is recoverable; a live owner's lock is never stolen. */
export async function acquireV2Lock(name: "state" | "worker", root = process.cwd()) {
  runtimeRoot.assertV2RuntimeRoot(root);
  const directory = v2Dir(root); await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, `${name}.lock`), token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx");
      try { writeSync(fd, JSON.stringify({ pid: process.pid, token })); } finally { closeSync(fd); }
      return async () => {
        const current = JSON.parse(await fs.readFile(file, "utf8"));
        if (current.token !== token) throw Error("V2 lock ownership changed; refusing to unlock another worker.");
        await fs.unlink(file);
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // Empty/malformed locks are not guessed stale (the owner may be writing its PID).
      let old: { pid: number; token: string };
      try { old = JSON.parse(await fs.readFile(file, "utf8")); } catch { throw Error("V2 lock needs reconciliation; no work was repeated."); }
      if (!Number.isInteger(old.pid) || old.pid < 1 || typeof old.token !== "string" || !old.token || processAlive(old.pid)) throw Error("Card Processing V2 already has an active worker or an invalid lock.");
      // Serialize recovery itself: otherwise two stale-lock observers could move a new owner's lock.
      const recoveryFile = `${file}.recovery`;
      let recovery;
      try { recovery = await fs.open(recoveryFile, "wx"); } catch { throw Error("Another V2 lock recovery needs to finish before retrying."); }
      try {
        const again = JSON.parse(await fs.readFile(file, "utf8"));
        if (again.token !== old.token || again.pid !== old.pid || processAlive(again.pid)) throw Error("V2 lock changed; refresh before trying again.");
        await fs.rename(file, `${file}.recovered-${randomUUID()}`);
      } finally { await recovery.close(); await fs.unlink(recoveryFile); }
    }
  }
  throw Error("Unable to acquire V2 ownership.");
}
async function mutateV2State<T>(fn: (state: V2State) => T | Promise<T>, root: string): Promise<T> {
  // Other local lanes may finish a short checkpoint at the same time. Wait only
  // before invoking the mutation; never replay a callback or steal live ownership.
  const deadline=Date.now()+10000;
  let release:()=>Promise<void>;
  for(;;){try{release=await acquireV2Lock("state",root);break;}catch(error){
    if(!(error instanceof Error)||error.message!=="Card Processing V2 already has an active worker or an invalid lock."||Date.now()>=deadline)throw error;
    const bytes=await fs.readFile(path.join(v2Dir(root),'state.lock'),'utf8').catch(e=>{if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;});if(bytes===null)continue;
    const lock=JSON.parse(bytes);
    if(!Number.isInteger(lock.pid)||lock.pid<1||typeof lock.token!=='string'||!lock.token||!processAlive(lock.pid))throw error;
    await new Promise(resolve=>setTimeout(resolve,100));
  }}
  try {
    const [state,journal]=await Promise.all([readV2StateDocument(root),readV2TimingJournal(root)]),legacyTimings=state.timings;
    state.timings=mergeV2JournalTimings(legacyTimings,journal.spans);
    const journalRows=new Map(journal.spans.map(t=>[t.id,JSON.stringify(t)]));
    const result = await fn(state);
    assertV2JournalRowsUnchanged(state.timings,journalRows);
    state.timings=state.timings.filter(t=>!journalRows.has(t.id));
    for(const legacy of legacyTimings)if(journalRows.has(legacy.id))state.timings.push(legacy);
    state.revision++;
    const data = JSON.stringify(stateSchema.parse(state), null, 2);
    const temporary = path.join(v2Dir(root), `state.${randomUUID()}.tmp`);
    const out = await fs.open(temporary, "wx"); try { await out.writeFile(data); await out.sync(); } finally { await out.close(); }
    await replaceV2Checkpoint(temporary, path.join(v2Dir(root), "state.json")); return result;
  } finally { await release(); }
}

// Parallel preparations share one process-local commit lane. The durable PID lock
// still rejects foreign workers; no callback is retried after a partial mutation.
const stateCommits = new Map<string, Promise<void>>();
const preparationCommits = new AsyncLocalStorage<boolean>();
const currentMutation = new AsyncLocalStorage<string>();
/** Opt in only inside the already-owned preparation worker, never for unrelated writers. */
export function withV2PreparationCommits<T>(action: () => T): T { return preparationCommits.run(true, action); }
export async function withV2State<T>(fn: (state: V2State) => T | Promise<T>, root = process.cwd()): Promise<T> {
  runtimeRoot.assertV2RuntimeRoot(root);
  const key = path.resolve(root);
  if (currentMutation.getStore() === key) throw Error('V2 already has an active state mutation');
  const mutate = () => currentMutation.run(key, () => mutateV2State(fn, root));
  if (!preparationCommits.getStore()) return mutate();
  const previous = stateCommits.get(key) ?? Promise.resolve();
  let unlock!: () => void;
  const current = new Promise<void>(resolve => { unlock = resolve; });
  const tail = previous.then(() => current); stateCommits.set(key, tail);
  await previous;
  try { return await mutate(); }
  finally { unlock(); if (stateCommits.get(key) === tail) stateCommits.delete(key); }
}
export async function publicV2Snapshot(root = process.cwd()) {
  const [state, config, method, categories, batches] = await Promise.all([readV2State(root), readV2Config(root), historicalMethodReview(root), categoryReport(root),listV2ProcessingBatches(root)]);
  const uploader=await (await import('./card-processing-v2-uploader-admission.ts')).getV2UploaderStatus(root);
  const background=await (await import('./card-processing-v2-background-supervisor.ts')).getV2BackgroundStatus(root);
  const intake=await (await import('./card-processing-v2-identify-sort.ts')).getV2IdentifySortStatus(root,state);
  const readyBatches=await (await import('./card-processing-v2-ready-batches.ts')).listV2ReadyBatches(root,state);
  const browserJobs = await (await import("./card-processing-v2-browser-upload-workflow.ts")).listV2BrowserJobs(root);
  const running = state.lastRun?.status === "running" && processAlive(state.lastRun.pid);
  const latestBatch=batches.slice().sort((a,b)=>b.clickedAt.localeCompare(a.clickedAt)||a.jobId.localeCompare(b.jobId))[0];
  const batchActivity=latestBatch?await readV2ActivitySnapshot(root,latestBatch.jobId):undefined;
  // Presentation only: retain every original submission/archive ID in storage.
  const mergeOwners=await(await import('./card-processing-v2-draft-merge-owners.ts')).loadV2DraftMergeOwners(root,state);
  for(const [cardId,owner]of Object.entries(mergeOwners))state.cards[cardId].draftMergeOwner=owner;
  if(batchActivity?.controller&&latestBatch&&v2BatchProgress(state,latestBatch).complete)batchActivity.controller={...batchActivity.controller,status:'complete',overdueMs:0};
  return { state, batchActivity, uploader, background, intake, readyBatches, browserJobs:browserJobs.map(job=>({id:job.id,stage:job.stage,cardIds:job.groups.flatMap(group=>group.cardIds)})), batches:batches.map(batch=>reconcileV2ProcessingBatch(batch,state)), summary: v2Summary(state), running: Boolean(running||background.busy||intake?.busy), configuration: {
    folder: config.folder, pairing: config.pairing,
    identificationConfigured: Boolean(process.env.OPENAI_API_KEY && config.identification && Date.parse(config.identification.expiresAt) > Date.now()),
    categoryCount: config.categories.length, bulkMethodStatus: method.status,
    connection: v2ConnectionPrerequisites(),
    categoryCapabilities: categories?.capabilities.map(c => Date.parse(categories.observedAt) > Date.now() || Date.now() - Date.parse(categories.observedAt) > 7 * 86400000
      ? { ...c, status: "blocked" as const, detail: "Category evidence expired; refresh the supported eBay metadata before preparing drafts." } : c),
  } };
}
/** Launch a real bounded worker, not a request-lifetime promise. No shell interpolation. */
export async function startV2Worker(root = process.cwd(), selection?: unknown, clickedAt?:string,executionMode:'end-to-end'|'prepare-only'='end-to-end') {
 return withV2ConfigReads(()=>startV2WorkerAdmission(root,selection,clickedAt,executionMode));
}
async function startV2WorkerAdmission(root:string,selection:unknown,clickedAt:string|undefined,executionMode:'end-to-end'|'prepare-only') {
 runtimeRoot.assertV2RuntimeRoot(root);if(process.env.VERCEL)throw Error('The scanner worker requires the local Legends OS host with access to the scan folder.');
 const {acquireV2FlowStart,peekV2IdentifySort}=await import('./card-processing-v2-identify-sort.ts');const release=await acquireV2FlowStart(root);try{const intake=await peekV2IdentifySort(root);if(intake&&intake.phase!=='complete')throw Error('Finish or resume identification before creating another draft batch');return await startV2WorkerLocal(root,selection,clickedAt,executionMode);}finally{await release();}
}
async function startV2WorkerLocal(root:string,selection:unknown,clickedAt:string|undefined,executionMode:'end-to-end'|'prepare-only') {
  runtimeRoot.assertV2RuntimeRoot(root);
  if (process.env.VERCEL) throw Error("The scanner worker requires the local Legends OS host with access to the scan folder.");
  const originalClickedAt=validateV2ClickedAt(clickedAt);
  const intakeStartedAt=new Date().toISOString();
  const snapshot = await publicV2Snapshot(root);
  if (snapshot.running) throw Error("A processing run is already active. Wait for its checkpoint before choosing another selection.");
  const { listV2Candidates, resolveV2Selection } = await import("./card-processing-v2-selection.ts");
  const selected = await resolveV2Selection(root, selection ?? { mode: "all", token: (await listV2Candidates(root)).token });
  if(!selected.activationRequired){
    const {inspectV2Readiness,V2ReadinessError}=await import('./card-processing-v2-readiness.ts');
    const {v2SellerAccess}=await import('./card-processing-v2-connection.ts');
    const readiness=await inspectV2Readiness(root,{mode:'selected',token:selected.token,candidateIds:selected.candidateIds,...(selected.sourceTransferId?{sourceTransferId:selected.sourceTransferId}:{}),...(selected.readyBatchId?{readyBatchId:selected.readyBatchId}:{}),...(selected.readyBatchIds?{readyBatchIds:selected.readyBatchIds}:{})},{verifySeller:v2SellerAccess()});
    if(!readiness.report.ready)throw new V2ReadinessError(readiness.report);
  }
  if(!['end-to-end','prepare-only'].includes(executionMode))throw Error('Explicit supported processing mode required');
  if(executionMode==='end-to-end'&&!selected.activationRequired)return (await import('./card-processing-v2-background-start.ts')).startV2BackgroundBatch(root,selected,originalClickedAt);
  const jobId=randomUUID();
  const uploaderAdmission=!selected.activationRequired&&executionMode==='end-to-end'
    ?await (await import('./card-processing-v2-uploader-admission.ts')).admitV2Uploader(root,jobId,selected):undefined;
  const intakeEndedAt=new Date().toISOString();
  let batch;
  try {
    await fs.mkdir(v2Dir(root), { recursive: true });
    batch=newV2ProcessingBatch(jobId,selected,await readV2State(root),originalClickedAt);
    await writeV2ProcessingBatch(root,batch,true);
  } catch(error) {
    if(uploaderAdmission)await (await import('./card-processing-v2-uploader-admission.ts')).failV2UploaderAdmission(root,jobId);
    throw error;
  }
  const selectionFile = path.join(v2Dir(root), `selection-${jobId}.json`);
  let log:number|undefined,spawnedPid:number|undefined;
  try {
    if(selected.captures.length){
      const relative=`artifacts/card-processing-v2/readiness-interval-${jobId}.json`,bytes=JSON.stringify({kind:'observed-server-readiness-interval',source:'supported-startV2Worker',batchId:jobId,owner:'local-launcher',startedAt:intakeStartedAt,endedAt:intakeEndedAt,candidateIds:selected.candidateIds});
      await fs.writeFile(path.join(root,relative),bytes,{flag:'wx',flush:true});
      await recordV2ObservedActivity(root,{batchId:jobId,lane:'worker',phase:'preparation',owner:'local-launcher',evidence:{path:relative,sha256:createHash('sha256').update(bytes).digest('hex')}});
      await recordV2ActivityCheckpoint(root,{batchId:jobId,lane:'worker',phase:'preparation',owner:'local-launcher',candidateIds:selected.candidateIds,step:'Exact selection and seller/media readiness passed; worker launch pending'});
    }
    await fs.writeFile(selectionFile, JSON.stringify(selected.activationRequired ? { mode: "all", token: selected.token,...(selected.sourceTransferId?{sourceTransferId:selected.sourceTransferId}:{}),...(selected.readyBatchId?{readyBatchId:selected.readyBatchId}:{}),...(selected.readyBatchIds?{readyBatchIds:selected.readyBatchIds}:{}) } : { mode: "selected", token: selected.token, candidateIds: selected.candidateIds,...(selected.sourceTransferId?{sourceTransferId:selected.sourceTransferId}:{}),...(selected.readyBatchId?{readyBatchId:selected.readyBatchId}:{}),...(selected.readyBatchIds?{readyBatchIds:selected.readyBatchIds}:{}) }), { flag: "wx" });
    log = openSync(path.join(v2Dir(root), `worker-${jobId}.log`), "ax");
    const child = spawn(process.execPath, ["--experimental-strip-types", path.join(root, "scripts", "card-processing-v2.ts"), "run", jobId, selectionFile,executionMode], {
      cwd: root, windowsHide: true, detached: true, stdio: ["ignore", log, log], env: process.env,
    });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    if (!child.pid) throw Error("V2 worker did not start.");spawnedPid=child.pid;child.unref();
    return {...await acknowledgeV2ProcessingBatchSpawn(root,batch,spawnedPid),executionMode,...(uploaderAdmission?{uploaderAdmission}:{})};
  } catch(error){if(spawnedPid)return {pid:spawnedPid,jobId,executionMode,...(uploaderAdmission?{uploaderAdmission}:{})};if(uploaderAdmission)await (await import('./card-processing-v2-uploader-admission.ts')).failV2UploaderAdmission(root,jobId);await writeV2ProcessingBatch(root,{...batch,status:"failed",failure:"Worker could not start; no processing completion is claimed."});throw error;} finally { if(log!==undefined)closeSync(log); }
}
