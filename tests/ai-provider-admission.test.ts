import {test} from 'node:test';import assert from 'node:assert/strict';
import {admitGenerationProvider} from '../lib/ai-provider-admission.ts';
import {safeBenchmarkFailure} from '../lib/ai-benchmark-authorized-run.ts';
test('quota evidence strips secrets and honors daily limits',async()=>{
 const diagnostic=safeBenchmarkFailure({statusCode:429,message:'quota secret',responseBody:JSON.stringify({error:{message:'secret',details:[{'@type':'type.googleapis.com/google.rpc.QuotaFailure',violations:[{quotaId:'PerDay',quotaValue:'0',project:'secret'}]},{'@type':'type.googleapis.com/google.rpc.RetryInfo',retryDelay:'42s'}]}})});
 assert.deepEqual(diagnostic,{category:'quota-or-rate-limit',httpStatus:429,quota:{daily:true,zeroLimit:true},retryAfterMs:42000});
 const result=await admitGenerationProvider(async()=>({ok:false,diagnostic}),{sleep:async()=>{throw Error('Must not retry hard quota');}});assert.equal(result.attempts.length,1);
});
test('short server retry delay is respected; long delay is deferred',async()=>{
 const delays:number[]=[];await admitGenerationProvider(async i=>i?{ok:true}:{ok:false,diagnostic:{category:'quota-or-rate-limit',httpStatus:429,retryAfterMs:42000}},{sleep:async ms=>{delays.push(ms);}});assert.deepEqual(delays,[42000]);
 const result=await admitGenerationProvider(async()=>({ok:false,diagnostic:{category:'quota-or-rate-limit',httpStatus:429,retryAfterMs:120000}}),{sleep:async()=>{throw Error('Do not wait beyond bound');}});assert.equal(result.attempts.length,1);
});
test('HTTP503 is service unavailability even when message mentions unavailable model',()=>{
 assert.deepEqual(safeBenchmarkFailure({statusCode:503,message:'Model not available; secret fixture'}),{category:'service-unavailable',httpStatus:503});
});
test('transient recovery uses bounded backoff and admits only after generation succeeds',async()=>{
 const delays:number[]=[];const result=await admitGenerationProvider(async i=>i<2?{ok:false,diagnostic:{httpStatus:503,category:'service-unavailable'}}:{ok:true},{sleep:async ms=>{delays.push(ms);},random:()=>0});
 assert.equal(result.ready,true);assert.equal(result.attempts.length,3);assert.deepEqual(delays,[1000,2000]);
});
test('exhausted outage never admits the card batch',async()=>{
 let batchCalls=0;const result=await admitGenerationProvider(async()=>({ok:false,diagnostic:{httpStatus:503,category:'service-unavailable'}}),{sleep:async()=>{}});if(result.ready)batchCalls++;
 assert.equal(batchCalls,0);assert.equal(result.attempts.length,3);
});
test('nonretryable credentials and schema errors stop after one attempt',async()=>{
 for(const status of [400,401,402,403,404]){const result=await admitGenerationProvider(async()=>({ok:false,diagnostic:{httpStatus:status,category:'provider-error'}}),{sleep:async()=>{throw Error('Unexpected retry');}});assert.equal(result.attempts.length,1);assert.equal(result.ready,false);}
});
test('journal refusal propagates without another attempt',async()=>{
 let attempts=0;await assert.rejects(admitGenerationProvider(async()=>{attempts++;throw Error('Journal lock');}),/Journal lock/);assert.equal(attempts,1);
});
