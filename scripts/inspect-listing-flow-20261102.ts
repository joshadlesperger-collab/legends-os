import env from '@next/env';
import {readFileSync,writeFileSync,openSync,writeSync,fsyncSync,closeSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {generateText} from 'ai';
import {createLanguageModel,providerConfigured} from '../lib/ai-providers.ts';
import {singleRequestFetch,validateBenchmarkBound} from '../lib/ai-benchmark-budget.ts';
import {INSPECTOR_SYSTEM} from '../lib/engineering-inspector.ts';

// A single authorized inspection, separate from the missing historical benchmark ledger.
// The exclusive reservation persists across failure/restart; this script cannot replay a call.
const root='artifacts/engineering-mission/claude-listing-flow-20261102/';
async function main(){
 env.loadEnvConfig(process.cwd());
 const authorization=JSON.parse(readFileSync(root+'budget-authorization.json','utf8'));
 if(authorization.instruction.id!=='user-claude-review-five-dollar-cap-20261102'||!providerConfigured('anthropic'))throw Error('Prerequisites missing');
 const availableModel=process.argv.includes('--available-model');
 const model=availableModel?'claude-sonnet-4-6':'claude-sonnet-4-5';
 const bound=validateBenchmarkBound({provider:'anthropic',model,inputTokens:200000,outputTokens:3000,maxRequestBytes:120000,inputUsdPerMillion:6,outputUsdPerMillion:30,source:'https://platform.claude.com/docs/en/about-claude/pricing',justification:'Text-only request under 200K context; no tools, cache directives, thinking, or retries. Conservative double standard input/output rates bound the full context and maximum response.',expiresAt:'2026-11-04T00:00:00Z',allBillableTokensBounded:true},'anthropic',model,3000);
 const packet=JSON.parse(readFileSync(root+'review-packet.json','utf8'));
 packet.status='Current authorized independent inspection. Earlier blocked preflight was not a model review.';
 packet.evidence.push(...['lib/engineering-inspector.ts','scripts/engineering-inspector.ts'].map(path=>({path,text:readFileSync(path,'utf8')})));
 packet.evidence.push({path:'commerce/lib/listing-factory.ts',text:readFileSync('C:/Users/josha/CascadeProjects/legends-os/lib/listing-factory.ts','utf8')});
 packet.evidence.push({path:'current-state-excerpt',text:readFileSync('C:/Users/josha/CascadeProjects/legends-os/CURRENT_STATE.md','utf8').split('## Card listing RCCA')[0]});
 const prompt=JSON.stringify(packet);
 if(Buffer.byteLength(prompt)>100000)throw Error('Evidence exceeds request allowance');
 const digest=createHash('sha256').update(prompt).digest('hex');
 const maximumUsd=(bound.inputTokens*bound.inputUsdPerMillion+bound.outputTokens*bound.outputUsdPerMillion)/1e6;
 if(maximumUsd>5)throw Error('Reservation exceeds authorized budget');
 const diagnostic=process.argv.includes('--diagnostic')||availableModel;
 if(diagnostic){if(readFileSync(root+'submitted-evidence.json','utf8')!==prompt)throw Error('Evidence changed');}
 else writeFileSync(root+'submitted-evidence.json',prompt,{flag:'wx'});
 const ledgerName=availableModel?'inspection-available-model-spending.jsonl':diagnostic?'inspection-diagnostic-spending.jsonl':'inspection-spending.jsonl';
 if(diagnostic){
  const prior=readFileSync(root+'inspection-spending.jsonl','utf8').trim().split('\n').map(line=>JSON.parse(line));
  let previousMaximum=prior[0].maximumUsd;
  if(availableModel){
   const diagnosticHistory=readFileSync(root+'inspection-diagnostic-spending.jsonl','utf8').trim().split('\n').map(line=>JSON.parse(line));
   if(!diagnosticHistory.some(row=>row.event==='http-response'&&row.status===404))throw Error('Model recovery requires retained 404 evidence');
   previousMaximum+=diagnosticHistory[0].maximumUsd;
  }
  if(previousMaximum+maximumUsd>5||prior.at(-1).event!=='stopped')throw Error('Diagnostic budget prerequisite failed');
 }
 const fd=openSync(root+ledgerName,'wx');
 const record=(value:unknown)=>{writeSync(fd,JSON.stringify(value)+'\n');fsyncSync(fd);};
 record({at:new Date().toISOString(),event:'reserved',scope:'new inspection only',authorization:authorization.instruction,capUsd:5,maximumUsd,bound,digest,historicalBenchmarkSpend:'unknown, unchanged'});
 try{
  const started=performance.now();
  const observedFetch:typeof fetch=async(input,init)=>{
   record({event:'http-started'});
   const response=await fetch(input,init);
   let providerErrorType:string|undefined;
   if(!response.ok){try{const body=await response.clone().json();const candidate=body?.error?.type;if(typeof candidate==='string'&&/^[a-z_]{1,60}$/.test(candidate))providerErrorType=candidate;}catch{}}
   record({event:'http-response',status:response.status,providerErrorType});
   return response;
  };
  const result=await generateText({model:createLanguageModel('anthropic',model,'recognition',singleRequestFetch(observedFetch,bound.maxRequestBytes)),system:INSPECTOR_SYSTEM,prompt,maxOutputTokens:3000,maxRetries:0,abortSignal:AbortSignal.timeout(90000)});
  // Retain the actual review even if usage reconciliation fails.
  writeFileSync(root+'claude-response.json',JSON.stringify({at:new Date().toISOString(),model,digest,elapsedMs:performance.now()-started,usage:result.usage,providerMetadata:result.providerMetadata,finishReason:result.finishReason,review:result.text},null,2),{flag:'wx'});
  const input=result.usage.inputTokens,output=result.usage.outputTokens;
  if(!Number.isSafeInteger(input)||!Number.isSafeInteger(output)||input!<0||output!<0||input!>bound.inputTokens||output!>bound.outputTokens)throw Error('Usage reconciliation required');
  const standardRateEstimateUsd=(input!*3+output!*15)/1e6;
  record({event:'completed',usage:result.usage,standardRateEstimateUsd,conservativeUsageCostUsd:(input!*6+output!*30)/1e6,maximumUsd,invoiceVerified:false});
  console.log(JSON.stringify({completed:true,model,usage:result.usage,standardRateEstimateUsd,maximumUsd,response:root+'claude-response.json'}));
 }catch(error){
  const safe=error as {name?:string;statusCode?:number;cause?:{code?:string}};
  record({event:'stopped',errorName:safe.name,statusCode:safe.statusCode,causeCode:safe.cause?.code,reason:'Request or usage reconciliation failed; reservation retained; no automatic retry'});
  process.exitCode=1;
  console.log('Inspection stopped. Inspect retained sanitized receipt; no automatic retry.');
 }finally{closeSync(fd);}
}
main().catch(()=>{console.error('Inspection prerequisites failed or reservation already exists; no retry sent.');process.exitCode=1;});
