import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {z} from 'zod';
import {v2ReadyBatchIdsSchema,v2SelectionSchema} from '../lib/card-processing-v2-selection.ts';

// Execute the real route with read-only dependency doubles; malformed scopes must
// never reach candidate loading or the GET recovery/status path.
function route(){
 const calls:unknown[][]=[];const exports:{GET?:(request:unknown)=>Promise<{body:unknown;status:number}>}={};
 const source=ts.transpileModule(fs.readFileSync('app/api/card-processing-v2/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(source,{exports,process:{cwd:()=>'/test'},require:(name:string)=>{
  if(name==='next/server')return{NextResponse:{json:(body:unknown,options:{status?:number}={})=>({body,status:options.status??200})}};
  if(name==='zod')return{z};
  if(name==='@/lib/operator-auth')return{OPERATOR_SESSION_COOKIE:'operator',readOperatorSession:async()=>true};
  if(name==='@/lib/card-processing-v2-selection')return{v2ReadyBatchIdsSchema,v2SelectionSchema,listV2Candidates:async(...args:unknown[])=>{calls.push(args);return{token:'retained',candidates:[]};}};
  if(name==='@/lib/card-processing-v2-store')return{publicV2Snapshot:async()=>{throw Error('Unexpected status read');}};
  if(name==='@/lib/card-processing-v2-identify-sort')return{peekV2IdentifySort:async()=>{throw Error('Unexpected recovery read');}};
  return{};
 }});
 return{calls,get:(query:string)=>exports.GET!({nextUrl:new URL('http://localhost/api/card-processing-v2'+query),cookies:{get:()=>undefined}})};
}
const a='828c03ec-12dc-47bc-9d6b-e3c905850ed9',b='46445f44-fcb5-4257-8b85-48928e2d7b81';
test('candidate GET preserves exact canonical named batch set without loose scope',async()=>{
 const r=route(),response=await r.get(`?candidates=1&readyBatchIds=${a},${b}`);assert.equal(response.status,200);assert.deepEqual(r.calls,[['/test',undefined,undefined,[b,a]]]);
});
test('single named batch and loose candidate routes remain supported',async()=>{
 const r=route();assert.equal((await r.get(`?candidates=1&readyBatchId=${a}`)).status,200);assert.equal((await r.get('?candidates=1')).status,200);assert.deepEqual(r.calls,[['/test',undefined,a,undefined],['/test',undefined,undefined,undefined]]);
});
test('candidate GET rejects ambiguous repeated malformed and unbounded scopes before reads',async()=>{
 for(const query of [`?readyBatchIds=${a}`,`?candidates=1&readyBatchId=${a}&readyBatchIds=${b}`,`?candidates=1&readyBatchIds=${a},${a}`,'?candidates=1&readyBatchIds=','?candidates=1&readyBatchId=','?candidates=1&readyBatchIds=not-a-uuid',`?candidates=1&readyBatchIds=${a}&readyBatchIds=${b}`,'?candidates=1&candidates=1',`?candidates=1&folder=C:/CardScans`,`?candidates=1&readyBatchIds=${Array.from({length:101},(_,i)=>`${i.toString(16).padStart(8,'0')}-12dc-47bc-9d6b-e3c905850ed9`).join(',')}`]){
  const r=route();assert.equal((await r.get(query)).status,400,query);assert.equal(r.calls.length,0,query);
 }
});
