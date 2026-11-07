import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import runtimeRoot from './card-processing-v2-runtime-root.cjs';
import {timingSchema,type V2Timing} from './card-processing-v2.ts';
import {replaceV2Checkpoint} from './card-processing-v2-atomic-replace.ts';

/** Timing has its own append-only commit lane. It never writes inventory or
 * increments a card-state revision. A torn final line is not a committed event. */
const bodySchema=z.object({version:z.literal(1),id:z.string().min(1).max(300),spans:z.array(timingSchema).min(1).max(400)}).strict();
type Body=z.infer<typeof bodySchema>;
const envelopeSchema=bodySchema.extend({sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const directory=(root:string)=>path.join(root,'artifacts/card-processing-v2/timing-journal');
const signature=(span:V2Timing)=>{const{status:_status,endedAt:_end,durationMs:_duration,...identity}=span;return JSON.stringify(identity);};
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch(e){return(e as NodeJS.ErrnoException).code==='EPERM';}};
const cache=new Map<string,{prefix:string;offset:number;events:Body[]}>();
const commitLanes=new Map<string,Promise<void>>();
async function regular(file:string,max:number){const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>max)throw Error('Timing journal file exceeds its regular-file boundary');return stat;}
async function lock(root:string){
 const key=path.resolve(root),previous=commitLanes.get(key)??Promise.resolve();let unlock!:()=>void;const barrier=new Promise<void>(resolve=>{unlock=resolve;}),tail=previous.then(()=>barrier);commitLanes.set(key,tail);await previous;
 try{const release=await fileLock(root);return async()=>{try{await release();}finally{unlock();if(commitLanes.get(key)===tail)commitLanes.delete(key);}};}catch(e){unlock();if(commitLanes.get(key)===tail)commitLanes.delete(key);throw e;}
}
async function fileLock(root:string){
 runtimeRoot.assertV2RuntimeRoot(root);const dir=directory(root);await fs.mkdir(dir,{recursive:true});if((await fs.lstat(dir)).isSymbolicLink())throw Error('Timing journal cannot be a symbolic link');
 const file=path.join(dir,'writer.lock'),token=randomUUID();
 for(let n=0;n<500;n++){
  try{const out=await fs.open(file,'wx');try{await out.writeFile(JSON.stringify({pid:process.pid,token}));}finally{await out.close();}return async()=>{const current=JSON.parse(await fs.readFile(file,'utf8'));if(current.token!==token)throw Error('Timing journal ownership changed');await fs.unlink(file);};}
  catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
   try{await regular(file,1024);const bytes=await fs.readFile(file,'utf8');if(!bytes){await new Promise(r=>setTimeout(r,10));continue;}const old=JSON.parse(bytes);if(!Number.isSafeInteger(old.pid)||old.pid<1||typeof old.token!=='string')throw Error('Unresolved timing journal owner');if(!alive(old.pid)&&await fs.readFile(file,'utf8')===bytes){await fs.rename(file,file+'.recovered-'+randomUUID());continue;}}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
   await new Promise(r=>setTimeout(r,10));
  }
 }
 throw Error('Timing journal is owned by another live writer');
}
function applySpan(rows:Map<string,V2Timing>,span:V2Timing){
 const old=rows.get(span.id);if(old){if(signature(old)!==signature(span))throw Error('Timing journal span identity changed');if(old.status!=='running'&&JSON.stringify(old)!==JSON.stringify(span))throw Error('Terminal timing journal span changed');if(old.status==='running'&&span.status==='running'&&JSON.stringify(old)!==JSON.stringify(span))throw Error('Running timing span changed');}
 if(span.status==='running'&&(span.endedAt!==undefined||span.durationMs!==undefined)||span.status==='interrupted'&&span.durationMs!==undefined)throw Error('Unfinished timing cannot claim duration');
 if(span.endedAt&&Date.parse(span.endedAt)<Date.parse(span.startedAt))throw Error('Timing journal chronology changed');rows.set(span.id,span);
}
export async function readV2TimingJournal(root:string){
 const dir=directory(root);let names:string[];try{const stat=await fs.lstat(dir);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Timing journal directory changed');names=await fs.readdir(dir);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return{spans:[] as V2Timing[],events:new Map<string,string>(),warnings:[] as string[]};throw e;}
 if(names.includes('active.json')){const file=path.join(dir,'active.json');await regular(file,1024);const active=z.object({version:z.literal(1),segment:z.string().regex(/^\d{13}-[a-f0-9-]{36}\.jsonl$/)}).strict().parse(JSON.parse(await fs.readFile(file,'utf8')));if(!names.includes(active.segment))throw Error('Active timing journal segment is unavailable; do not recreate history');}
 const warnings=names.filter(n=>/^coverage-warning-[a-f0-9-]{36}\.json$/.test(n)).map(n=>'Uncommitted timing completion evidence retained: '+n);
 names=names.filter(n=>/^\d{13}-[a-f0-9-]{36}\.jsonl$/.test(n)).sort();if(names.length>1024)throw Error('Timing journal segment bound exceeded');
 const spans=new Map<string,V2Timing>(),events=new Map<string,string>();
 for(const name of names){const file=path.join(dir,name);await regular(file,12_000_000);const bytes=await fs.readFile(file),offset=bytes.lastIndexOf(10)+1,old=cache.get(file),prefix=sha(bytes.subarray(0,old?.offset??0));let records:Body[],from:number;
  if(old&&old.offset<=offset&&prefix===old.prefix){records=[...old.events];from=old.offset;}else{records=[];from=0;}
  for(const line of bytes.subarray(from,offset).toString('utf8').split('\n').filter(Boolean)){const envelope=envelopeSchema.parse(JSON.parse(line)),{sha256,...body}=envelope;if(sha(JSON.stringify(body))!==sha256)throw Error('Timing journal checksum changed');records.push(body);}
  cache.set(file,{prefix:sha(bytes.subarray(0,offset)),offset,events:records});if(cache.size>2048)cache.delete(cache.keys().next().value!);
  if(offset!==bytes.length)warnings.push(`Uncommitted timing tail retained: ${name}`);
  for(const body of records){const hash=sha(JSON.stringify(body)),prior=events.get(body.id);if(prior&&prior!==hash)throw Error('Timing journal event identity changed');if(prior)continue;events.set(body.id,hash);for(const span of body.spans)applySpan(spans,span);}
 }
 return{spans:structuredClone(Array.from(spans.values())),events,warnings};
}
export function mergeV2JournalTimings(legacy:V2Timing[],journal:V2Timing[]){const rows=new Map(legacy.map(t=>[t.id,t]));for(const span of journal){const old=rows.get(span.id);if(old&&signature(old)!==signature(span))throw Error('Legacy/journal timing ownership differs');if(old&&old.status!=='running'&&JSON.stringify(old)!==JSON.stringify(span))throw Error('Historical timing cannot be rewritten');rows.set(span.id,span);}return Array.from(rows.values());}
export async function appendV2TimingEvent(root:string,id:string,raw:V2Timing[]){
 const body=bodySchema.parse({version:1,id,spans:raw}),hash=sha(JSON.stringify(body)),release=await lock(root);
 try{const current=await readV2TimingJournal(root),old=current.events.get(id);if(old){if(old!==hash)throw Error('Timing event already has different evidence');return{replayed:true,warnings:current.warnings};}const rows=new Map(current.spans.map(s=>[s.id,s]));for(const span of body.spans)applySpan(rows,span);
  const dir=directory(root),pointer=path.join(dir,'active.json');let segment:string|null=null;
  let active:unknown;try{await regular(pointer,1024);active=JSON.parse(await fs.readFile(pointer,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  if(active!==undefined){const parsed=z.object({version:z.literal(1),segment:z.string().regex(/^\d{13}-[a-f0-9-]{36}\.jsonl$/)}).strict().parse(active);segment=parsed.segment;const file=path.join(dir,segment);let stat;try{stat=await regular(file,12_000_000);}catch{throw Error('Active timing journal segment is unavailable; do not recreate history');}if(stat.size>=8_000_000||current.warnings.some(w=>w.endsWith(segment!)))segment=null;}
  if(!segment){const existing=(await fs.readdir(dir)).filter(n=>/^\d{13}-[a-f0-9-]{36}\.jsonl$/.test(n)).sort(),stamp=Math.max(Date.now(),Number(existing.at(-1)?.slice(0,13)??0)+1);segment=stamp+'-'+randomUUID()+'.jsonl';const file=await fs.open(path.join(dir,segment),'wx');await file.close();const tmp=pointer+'.'+randomUUID()+'.tmp';await fs.writeFile(tmp,JSON.stringify({version:1,segment}),{flag:'wx',flush:true});await replaceV2Checkpoint(tmp,pointer);}
  const out=await fs.open(path.join(dir,segment),'a');try{await out.writeFile(JSON.stringify({...body,sha256:hash})+'\n');await out.sync();}finally{await out.close();}
  return{replayed:false,warnings:current.warnings};
 }finally{await release();}
}
