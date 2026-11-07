import {createHash} from 'node:crypto';
import {closeSync,existsSync,fsyncSync,openSync,readFileSync,unlinkSync,writeSync} from 'node:fs';

/** Seller's explicit five-card budget waiver. This does not edit or reset the legacy budget. */
export class AuthorizedFiveCardRun {
  private fd:number;
  private lock:string;
  private seen=new Set<string>();
  private packetDigest:string;
  private retest?:{label:string;reason:string};
  constructor(file:string, packetDigest:string, retest?:{label:string;reason:string}) {
    if(retest && (!/^[a-z0-9-]{1,40}$/.test(retest.label)||!retest.reason.trim()))throw Error('Explicit retest label and reason required');
    this.retest=retest;
    this.packetDigest=packetDigest;
    const instruction=JSON.parse(readFileSync('artifacts/model-benchmark/cactus-five-20261025/budget-waiver.json','utf8')).instruction;
    if(instruction.id!=='cactus-five-budget-waiver-20261025'||instruction.text!=='ignore the benchmark budget for this')throw Error('Five-card authorization missing');
    this.lock=file+'.lock'; const lockFd=openSync(this.lock,'wx');closeSync(lockFd);
    try {
      if(existsSync(file))for(const line of readFileSync(file,'utf8').trim().split('\n').filter(Boolean)){
        const row=JSON.parse(line);if(row.event==='begin')this.seen.add(row.key);
      }
      this.fd=openSync(file,'a');
    }catch(error){unlinkSync(this.lock);throw error;}
  }
  begin(caseId:string,provider:string,model:string){
    if(!/^cactus-five-000[1-5]-(recognition|pricing|listing)$/.test(caseId))throw Error('Outside authorized five-card scope');
    const originalKey=`${caseId}:${provider}`;
    if(this.retest&&!this.seen.has(originalKey))throw Error('Retest requires a journaled original attempt');
    const key=originalKey+(this.retest?`:retest-${this.retest.label}`:'');
    if(this.seen.has(key))throw Error('Attempt already journaled; no silent retry');
    this.append({event:'begin',key,model,packetDigest:this.packetDigest,...(this.retest?{retestOf:originalKey,retestReason:this.retest.reason}:{})});this.seen.add(key);return key;
  }
  append(record:Record<string,unknown>){writeSync(this.fd,JSON.stringify({at:new Date().toISOString(),...record})+'\n');fsyncSync(this.fd);}
  close(){closeSync(this.fd);unlinkSync(this.lock);}
}
export const benchmarkDigest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Fixed categories only: never persist arbitrary provider text, headers, URLs or bodies. */
export function safeBenchmarkFailure(error:unknown):{category:string;httpStatus:number|null;quota?:{daily:boolean;zeroLimit:boolean};retryAfterMs?:number}{
 const e=error as {name?:unknown;message?:unknown;statusCode?:unknown;responseBody?:unknown};
 const message=typeof e?.message==='string'?e.message.toLowerCase():'';
 const status=typeof e?.statusCode==='number'&&e.statusCode>=100&&e.statusCode<=599?e.statusCode:null;
 const category=status===503?'service-unavailable':/invalid.*schema|schema.*invalid|additionalproperties|required.*properties/.test(message)?'invalid-output-schema'
  :/quota|resource.exhausted|rate.limit|too many requests/.test(message)?'quota-or-rate-limit'
  :/not found|not supported|not available/.test(message)?'model-or-feature-unavailable'
  :e?.name==='TimeoutError'||e?.name==='AbortError'||/timed out|timeout|aborted/.test(message)?'timeout-or-abort'
  :/no object generated|no output generated/.test(message)?'no-structured-output'
  :status===401||status===403?'access-denied':'provider-or-schema-error';
 const extra:{quota?:{daily:boolean;zeroLimit:boolean};retryAfterMs?:number}={};
 if(status===429&&typeof e.responseBody==='string')try{
  const details=JSON.parse(e.responseBody)?.error?.details;
  if(Array.isArray(details))for(const detail of details){
   if(detail['@type']==='type.googleapis.com/google.rpc.QuotaFailure'&&Array.isArray(detail.violations)){
    extra.quota={daily:detail.violations.some((v:{quotaId?:unknown})=>typeof v.quotaId==='string'&&/perday/i.test(v.quotaId)),zeroLimit:detail.violations.some((v:{quotaValue?:unknown})=>v.quotaValue===0||v.quotaValue==='0')};
   }
   if(detail['@type']==='type.googleapis.com/google.rpc.RetryInfo'&&typeof detail.retryDelay==='string'&&/^\d+(\.\d+)?s$/.test(detail.retryDelay))extra.retryAfterMs=Math.ceil(parseFloat(detail.retryDelay)*1000);
  }
 }catch{/* Malformed provider data must never escape into evidence. */}
 return {category,httpStatus:status,...extra};
}
