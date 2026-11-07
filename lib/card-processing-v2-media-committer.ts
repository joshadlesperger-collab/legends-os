import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {digest,event,type V2Card,type V2State} from './card-processing-v2.ts';
import {v2Dir,withV2State} from './card-processing-v2-store.ts';

const ackSchema=z.object({version:z.literal(1),attemptId:z.string().uuid(),cardId:z.string(),captureId:z.string(),hash:z.string().regex(/^[a-f0-9]{64}$/),orientationHash:z.string().regex(/^[a-f0-9]{64}$/),url:z.string().url(),expiresAt:z.string().datetime(),observedAt:z.string().datetime()}).strict();
type Ack=z.infer<typeof ackSchema>;
type Hosted={url:string;expiresAt:string};
type Commit=(fn:(state:V2State)=>void)=>Promise<unknown>;
/** Successful EPS acknowledgements are retained before bounded checkpoint batching.
 * No network operation is retried here. A recovered acknowledgement is not a new upload. */
export function createV2MediaCommitter(root:string,cards:V2Card[],orientationHashes:ReadonlyMap<string,string>,commit:Commit=fn=>withV2State(fn,root)){
 const owners=new Map(cards.map(c=>[c.id,c]));
 const waiting:{ack:Ack;resolve:()=>void;reject:(e:unknown)=>void}[]=[];
 let scheduled:ReturnType<typeof setTimeout>|undefined,flushing=false;
 const assertOwner=(card:V2Card,hash:string)=>{
  const owner=owners.get(card.id);
  if(!orientationHashes.has(hash)||!owner||owner.captureId!==card.captureId||!owner.photos.some(p=>p.hash===hash))throw Error('Hosted acknowledgement requires exact selected capture');
 };
 const folder=(card:V2Card,hash:string)=>path.join(v2Dir(root),'hosted-media-acks',digest({cardId:card.id,captureId:card.captureId,hash,orientationHash:orientationHashes.get(hash)}));
 const flush=async()=>{
  if(flushing)return;flushing=true;if(scheduled)clearTimeout(scheduled);scheduled=undefined;
  try{while(waiting.length){const batch=waiting.splice(0,3);
   try{await commit(s=>{
    for(const {ack} of batch){const c=s.cards[ack.cardId];
     if(!c||c.draftId||c.inventoryArchive||c.activeQuantityOperationId||c.captureId!==ack.captureId||!c.photos.some(p=>p.hash===ack.hash))throw Error('Hosted acknowledgement current capture changed');
     if(Date.parse(ack.expiresAt)<=Date.now()+86400000)throw Error('Hosted acknowledgement expired before checkpoint');
    }
    for(const {ack} of batch){s.media[ack.hash]={hash:ack.hash,url:ack.url,expiresAt:ack.expiresAt,upright:true,orientationHash:ack.orientationHash};event(s,'photo-hosted','Exact reviewed original hosted; no draft created',ack.cardId);}
   });batch.forEach(p=>p.resolve());}catch(e){batch.forEach(p=>p.reject(e));}
  }}finally{flushing=false;if(scheduled)clearTimeout(scheduled);scheduled=undefined;if(waiting.length)scheduled=setTimeout(()=>void flush(),15);}
 };
 const enqueue=(ack:Ack)=>new Promise<void>((resolve,reject)=>{
  waiting.push({ack,resolve,reject});
  if(waiting.length>=3)void flush();else if(!scheduled)scheduled=setTimeout(()=>void flush(),15);
 });
 const unresolved=async(card:V2Card,hash:string)=>{
  const directory=folder(card,hash),attemptDir=path.join(directory,'attempts');let attempts:string[];
  try{attempts=await fs.readdir(attemptDir);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
  if(attempts.length>100)throw Error('Hosted attempt scope exceeds bound');
  const names=await fs.readdir(directory),settled=new Set<string>();
  for(const name of names.filter(n=>/^[a-f0-9]{64}\.json$/.test(n))){const a=ackSchema.parse(JSON.parse(await fs.readFile(path.join(directory,name),'utf8')));if(name!==digest(a)+'.json'||a.cardId!==card.id||a.captureId!==card.captureId||a.hash!==hash||a.orientationHash!==orientationHashes.get(hash))throw Error('Hosted acknowledgement binding changed');settled.add(a.attemptId);}
  for(const name of attempts){if(!/^[a-f0-9-]{36}\.json$/.test(name))throw Error('Invalid hosted attempt fence');const a=JSON.parse(await fs.readFile(path.join(attemptDir,name),'utf8'));if(a.id+'.json'!==name||a.cardId!==card.id||a.captureId!==card.captureId||a.hash!==hash||a.orientationHash!==orientationHashes.get(hash))throw Error('Hosted attempt binding changed');if(!settled.has(a.id))throw Error('Unsettled photo upload attempt; do not repeat EPS request');}
 };
 const begin=async(card:V2Card,hash:string)=>{assertOwner(card,hash);await unresolved(card,hash);const id=randomUUID(),directory=path.join(folder(card,hash),'attempts');await fs.mkdir(directory,{recursive:true});const fd=await fs.open(path.join(directory,id+'.json'),'wx');try{await fd.writeFile(JSON.stringify({id,cardId:card.id,captureId:card.captureId,hash,orientationHash:orientationHashes.get(hash),startedAt:new Date().toISOString()}));await fd.sync();}finally{await fd.close();}return id;};
 return {
  begin,
  async retain(card:V2Card,hash:string,hosted:Hosted,attemptId?:string){
   assertOwner(card,hash);
   const ack=ackSchema.parse({version:1,attemptId:attemptId??await begin(card,hash),cardId:card.id,captureId:card.captureId,hash,orientationHash:orientationHashes.get(hash),...hosted,observedAt:new Date().toISOString()});
   const directory=folder(card,hash);const attempt=JSON.parse(await fs.readFile(path.join(directory,'attempts',ack.attemptId+'.json'),'utf8'));if(attempt.id!==ack.attemptId||attempt.cardId!==card.id||attempt.captureId!==card.captureId||attempt.hash!==hash||attempt.orientationHash!==ack.orientationHash)throw Error('Hosted acknowledgement attempt mismatch');await fs.mkdir(directory,{recursive:true});
   const file=path.join(directory,digest(ack)+'.json'),bytes=JSON.stringify(ack);
   try{const fd=await fs.open(file,'wx');try{await fd.writeFile(bytes);await fd.sync();}finally{await fd.close();}}
   catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST'||await fs.readFile(file,'utf8')!==bytes)throw e;}
   await enqueue(ack);
  },
  async recover(card:V2Card,hash:string){
   assertOwner(card,hash);await unresolved(card,hash);const directory=folder(card,hash);let names:string[];
   try{names=await fs.readdir(directory);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}
   if(names.length>100)throw Error('Hosted acknowledgement scope exceeds bound');
   const valid:Ack[]=[];
   for(const name of names){if(name==='attempts')continue;if(!/^[a-f0-9]{64}\.json$/.test(name))throw Error('Invalid hosted acknowledgement filename');
    const ack=ackSchema.parse(JSON.parse(await fs.readFile(path.join(directory,name),'utf8')));
    if(name!==digest(ack)+'.json'||ack.cardId!==card.id||ack.captureId!==card.captureId||ack.hash!==hash||ack.orientationHash!==orientationHashes.get(hash)||Date.parse(ack.observedAt)>Date.now())throw Error('Hosted acknowledgement binding changed');
    if(Date.parse(ack.expiresAt)>Date.now()+86400000)valid.push(ack);
   }
   valid.sort((a,b)=>Date.parse(b.observedAt)-Date.parse(a.observedAt));if(!valid.length)return false;
   await enqueue(valid[0]);return true;
  }
 };
}

/** Legacy media remains usable for legacy captures. Provider-oriented captures require exact derivative provenance. */
export function matchesV2MediaOrientation(media:V2State['media'][string]|undefined,expected:string,providerOriented:boolean){
 return !!media&&(!providerOriented||media.orientationHash===expected);
}

export function shouldRecoverV2MediaAck(media:V2State['media'][string]|undefined,expected:string,providerOriented:boolean){
 return !media || (providerOriented&&!matchesV2MediaOrientation(media,expected,true));
}
