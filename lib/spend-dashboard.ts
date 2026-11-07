import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {stateSchema} from './card-processing-v2.ts';
import {v2IdentificationAccounting} from './card-processing-v2-accounting.ts';

export type SpendProviderId='chatgpt'|'openai'|'anthropic'|'xai'|'google'|'meta'|`tool-${string}`;
export type SpendMetric={id:string;label:string;kind:'provider_balance'|'app_budget'|'allowance';unit:'usd'|'percent'|'credits';available:number|null;limit:number|null;used:number|null;reserved:number|null;period:string;source:'local'|'manual'|'unavailable';observedAt:string|null;note?:string};
export type SpendSummary={updatedAt:string;providers:Array<{id:SpendProviderId;label:string;configured:boolean;metrics:SpendMetric[];billingUrl?:string}>};
const providers:[SpendProviderId,string,string,string][]=[['chatgpt','ChatGPT','','https://chatgpt.com/settings/billing'],['openai','OpenAI API','OPENAI_API_KEY','https://platform.openai.com/settings/organization/billing/overview'],['anthropic','Claude API','ANTHROPIC_API_KEY','https://console.anthropic.com/settings/billing'],['xai','Grok API','XAI_API_KEY','https://console.x.ai/'],['google','Gemini API','GOOGLE_GENERATIVE_AI_API_KEY','https://aistudio.google.com/'],['meta','Muse API','MODEL_API_KEY','']];
const number=z.number().finite().nonnegative().nullable();
export const spendSnapshotSchema=z.object({providerId:z.union([z.enum(['chatgpt','openai','anthropic','xai','google','meta']),z.string().max(64).regex(/^tool-[a-z0-9]+(?:-[a-z0-9]+)*$/)]),providerLabel:z.string().trim().min(1).max(80).optional(),metric:z.object({id:z.enum(['provider-balance','allowance']),label:z.string().trim().min(1).max(80),kind:z.enum(['provider_balance','allowance']),unit:z.enum(['usd','percent','credits']),available:number,limit:number,used:number,reserved:number,period:z.string().trim().min(1).max(100),observedAt:z.string().datetime({offset:true}),note:z.string().trim().max(300).optional()}).strict()}).strict().superRefine((v,ctx)=>{if(v.providerId.startsWith('tool-')&&!v.providerLabel)ctx.addIssue({code:'custom',message:'Tool name required'});if((v.metric.id==='allowance')!==(v.metric.kind==='allowance'))ctx.addIssue({code:'custom',message:'Metric type differs'});if(v.metric.unit==='percent'&&[v.metric.available,v.metric.limit,v.metric.used,v.metric.reserved].some(n=>n!==null&&n>100))ctx.addIssue({code:'custom',message:'Percent exceeds 100'});});
type Snapshot=z.infer<typeof spendSnapshotSchema>;
const snapshotsSchema=z.object({version:z.literal(1),snapshots:z.array(spendSnapshotSchema).max(50)}).strict();
const cache=new Map<string,{at:number;value:Promise<SpendSummary>}>();
const dir=(root:string)=>path.join(root,'artifacts','spend-dashboard');
async function readJson(file:string,max:number){const st=await fs.lstat(file);if(!st.isFile()||st.isSymbolicLink()||st.size>max)throw Error('Invalid dashboard record');return {value:JSON.parse(await fs.readFile(file,'utf8')),observedAt:st.mtime.toISOString()};}
async function manual(root:string){try{return snapshotsSchema.parse((await readJson(path.join(dir(root),'manual-snapshots.json'),65536)).value).snapshots;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return[];throw e;}}
function unavailable(kind:SpendMetric['kind'],id:string,label:string,unit:SpendMetric['unit'],note:string):SpendMetric{return{id,label,kind,unit,available:null,limit:null,used:null,reserved:null,period:'Not connected',source:'unavailable',observedAt:null,note};}
async function localBudget(root:string):Promise<SpendMetric>{
 const empty=()=>unavailable('app_budget','card-identification-budget','Card processing budget','usd','V2 card-identification spending records are unavailable. This is not provider credit or account-wide spending.');
 try{
  const base=path.join(root,'artifacts','card-processing-v2');
  const [state,config]=await Promise.all([readJson(path.join(base,'state.json'),128*1024*1024),readJson(path.join(base,'config.json'),2*1024*1024)]);
  const calls=stateSchema.shape.calls.parse((state.value as {calls?:unknown}).calls),cap=z.number().int().positive().parse((config.value as {identification?:{capMicros?:unknown}}).identification?.capMicros);
  const accounting=v2IdentificationAccounting(calls,new Set(calls.filter(c=>c.status==='reserved').map(c=>c.id)));
  const used=calls.reduce((n,c)=>n+(c.status==='settled'&&c.actualMicros!==null?c.actualMicros:0),0),reserved=accounting.committedMicros-used;
  return{id:'card-identification-budget',label:'Card processing budget',kind:'app_budget',unit:'usd',available:accounting.safe?Math.max(0,cap-accounting.committedMicros)/1e6:null,limit:cap/1e6,used:used/1e6,reserved:reserved/1e6,period:'Current local cumulative guard',source:'local',observedAt:state.observedAt,note:accounting.safe?'V2 card-identification calls only: actual settled usage plus bounded pending reservations. Not provider credit; excludes harness and other app/account spending.':'Pending usage has an unverified bound; remaining budget is unknown. Reservations are shown, not claimed actual cost.'};
 }catch{return empty();}
}
async function build(root:string):Promise<SpendSummary>{
 let saved:Snapshot[]=[];let invalid=false;try{saved=await manual(root);}catch{invalid=true;}
 const local=await localBudget(root);
 const all=[...providers];for(const row of saved){if(!all.some(p=>p[0]===row.providerId))all.push([row.providerId as SpendProviderId,row.providerLabel!,'','']);}
 return{updatedAt:new Date().toISOString(),providers:all.map(([id,label,key,billingUrl])=>{
  const metrics:SpendMetric[]=id.startsWith('tool-')?[]:[unavailable(id==='chatgpt'?'allowance':'provider_balance',id==='chatgpt'?'allowance':'provider-balance',id==='chatgpt'?'Plan allowance':'Provider credit',id==='chatgpt'?'percent':'usd',invalid?'Saved manual snapshots could not be read.':'No live balance connection. Add a verified manual snapshot; account usage and subscription allowances are separate from app budgets.')];
  for(const row of saved.filter(s=>s.providerId===id)){const m:SpendMetric={...row.metric,source:'manual'};const at=metrics.findIndex(x=>x.id===m.id);if(at<0)metrics.push(m);else metrics[at]=m;}
  if(id==='openai')metrics.push(local);
  return{id,label,configured:key?Boolean(process.env[key]):saved.some(s=>s.providerId===id),metrics,...(billingUrl?{billingUrl}:{})};
 })};
}
/** One coalesced aggregate read per minute, never a per-card ledger/schema scan on header polling. */
export function getSpendSummary(root=process.cwd(),now=Date.now()):Promise<SpendSummary>{const key=path.resolve(root),old=cache.get(key);if(old&&now-old.at<60000)return old.value;const value=build(key);cache.set(key,{at:now,value});return value;}
export async function saveSpendSnapshot(root:string,raw:unknown,now=Date.now()){
 const row=spendSnapshotSchema.parse(raw);if(row.metric.kind==='allowance'&&row.metric.unit==='usd')row.metric.label='Manual budget';if(Date.parse(row.metric.observedAt)>now)throw Error('Snapshot cannot be from the future');
 const directory=dir(path.resolve(root));await fs.mkdir(directory,{recursive:true});if((await fs.lstat(directory)).isSymbolicLink())throw Error('Invalid snapshot directory');
 const lock=path.join(directory,'manual-snapshots.lock'),handle=await fs.open(lock,'wx');let temporary:string|undefined;
 try{const rows=await manual(root),next=rows.filter(s=>s.providerId!==row.providerId||s.metric.id!==row.metric.id);next.push(row);temporary=path.join(directory,`manual-${randomUUID()}.tmp`);const h=await fs.open(temporary,'wx');try{await h.writeFile(JSON.stringify(snapshotsSchema.parse({version:1,snapshots:next}),null,2));await h.sync();}finally{await h.close();}await fs.rename(temporary,path.join(directory,'manual-snapshots.json'));temporary=undefined;cache.delete(path.resolve(root));}
 finally{await handle.close();await fs.unlink(lock);if(temporary)await fs.unlink(temporary).catch(()=>{});}
 return getSpendSummary(root);
}
