import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {replaceV2Checkpoint} from './card-processing-v2-atomic-replace.ts';

const refSchema=z.object({path:z.string().min(1),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const rowSchema=z.object({draftId:z.string().regex(/^\d+$/),sku:z.string(),quantity:z.number().int().positive(),price:z.object({amount:z.string().nullable(),currency:z.string()}),protectedValues:z.record(z.string(),z.string())}).passthrough();
const bodySchema=z.object({scope:z.literal('drafts'),seller:z.literal('imaydit58'),complete:z.literal(true),observedAt:z.string().datetime(),rows:z.array(rowSchema),pages:z.array(refSchema).optional()}).passthrough();
const pointerSchema=z.object({observedAt:z.string().datetime(),evidence:refSchema}).strict();
type Evidence=z.infer<typeof refSchema>;
type Browser={status:()=>Promise<{ready:boolean}>;captureDraftMatchSnapshot:()=>Promise<{evidence:Evidence}>;close:()=>Promise<void>};
type Dependencies={now?:()=>number;acquire?:()=>Promise<()=>Promise<void>>;background?:()=>Promise<{busy:boolean}>;open?:()=>Promise<Browser>;timeoutMs?:number};
const active=new Map<string,Promise<DraftPriceSource>>();
export type DraftPriceSource={observedAt:string;rows:z.infer<typeof rowSchema>[];evidence:Evidence;cached:boolean;elapsedMs:number;draftPagesObserved:number};
async function checked(root:string,ref:Evidence){
 if(path.isAbsolute(ref.path)||!ref.path.replaceAll('\\','/').startsWith('artifacts/')||ref.path.split(/[\\/]/).includes('..'))throw Error('Draft-price evidence must remain in local artifacts');
 const base=await fs.realpath(path.join(root,'artifacts')),file=await fs.realpath(path.join(root,ref.path)),rel=path.relative(base,file),st=await fs.lstat(path.join(root,ref.path));
 if(!rel||rel.startsWith('..')||path.isAbsolute(rel)||st.isSymbolicLink()||!st.isFile()||st.size>8_000_000)throw Error('Draft-price evidence is invalid');
 const bytes=await fs.readFile(file);if(createHash('sha256').update(bytes).digest('hex')!==ref.sha256)throw Error('Draft-price evidence changed');
 const body=bodySchema.parse(JSON.parse(bytes.toString()));if(new Set(body.rows.map(r=>r.draftId)).size!==body.rows.length)throw Error('Draft-price source repeats draft IDs');return body;
}
async function cache(root:string,now:number){
 let raw;try{const file=path.join(root,'artifacts/card-processing-v2/price-check/draft-source.json'),st=await fs.lstat(file);if(st.isSymbolicLink()||!st.isFile()||st.size>8192)throw Error('Invalid draft-price source pointer');raw=pointerSchema.parse(JSON.parse(await fs.readFile(file,'utf8')));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
 const body=await checked(root,raw.evidence);if(body.observedAt!==raw.observedAt)throw Error('Draft-price observation timestamp differs');
 const age=now-Date.parse(body.observedAt);if(age<0)throw Error('Draft-price observation is from the future');if(age>600_000)return;
 return{observedAt:body.observedAt,rows:body.rows,evidence:raw.evidence,cached:true,elapsedMs:0,draftPagesObserved:body.pages?.length??0};
}
/** One read-only unpublished-draft snapshot per ten-minute window. Only browser
 * status/capture/close are invoked; this helper exposes no remote writer. */
export async function refreshV2PriceCheckDraftSource(root=process.cwd(),deps:Dependencies={}):Promise<DraftPriceSource>{
 const key=path.resolve(root),saved=await cache(key,(deps.now??Date.now)());if(saved)return saved;
 const prior=active.get(key);if(prior)return prior;
 const work=(async()=>{
  const started=Date.now();
  const acquire=deps.acquire??(async()=>{const {acquireV2FlowStart}=await import('./card-processing-v2-identify-sort.ts');return acquireV2FlowStart(key);});
  const release=await acquire();let browser:Browser|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  try{
   const racedCache=await cache(key,(deps.now??Date.now)());if(racedCache)return racedCache;
   const status=await(deps.background??(async()=>{const{getV2BackgroundStatus}=await import('./card-processing-v2-background-supervisor.ts');return getV2BackgroundStatus(key);}))();
   if(status.busy)throw Error('The eBay draft workflow is busy; price preview can be retried after it finishes');
   browser=await(deps.open??(async()=>{const{createV2BackgroundBrowser}=await import('./card-processing-v2-background-browser.ts');return createV2BackgroundBrowser({root:key,profileDir:path.join(key,'artifacts/card-processing-v2/background/profile'),evidenceDir:path.join(key,'artifacts/card-processing-v2/price-check/draft-evidence'),headless:false,minimized:true});}))();
   const current=browser;
   const observed=await Promise.race([(async()=>{if(!(await current.status()).ready)throw Error('Connect the dedicated eBay seller session before refreshing draft prices');return current.captureDraftMatchSnapshot();})(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{void current.close().catch(()=>{});reject(Error('Read-only draft-price refresh exceeded its deadline'));},deps.timeoutMs??45_000);})]);
   const evidence=refSchema.parse(observed.evidence),body=await checked(key,evidence),age=(deps.now??Date.now)()-Date.parse(body.observedAt);if(age<0||age>600_000)throw Error('Fresh actual draft-price evidence is required');
   const dir=path.join(key,'artifacts/card-processing-v2/price-check');await fs.mkdir(dir,{recursive:true});if((await fs.lstat(dir)).isSymbolicLink())throw Error('Invalid draft-price source folder');
   const pointer=path.join(dir,'draft-source.json'),temp=pointer+'.'+randomUUID()+'.tmp';await fs.writeFile(temp,JSON.stringify({observedAt:body.observedAt,evidence}),{flag:'wx',flush:true});await replaceV2Checkpoint(temp,pointer);
   return{observedAt:body.observedAt,rows:body.rows,evidence,cached:false,elapsedMs:Date.now()-started,draftPagesObserved:body.pages?.length??0};
  }finally{if(timer)clearTimeout(timer);await browser?.close().catch(()=>{});await release();}
 })().finally(()=>active.delete(key));active.set(key,work);return work;
}
