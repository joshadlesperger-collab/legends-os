import env from '@next/env';import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {generateText,Output} from 'ai';import {z} from 'zod';
import {admitGenerationProvider} from '../lib/ai-provider-admission.ts';
import {AuthorizedFiveCardRun,benchmarkDigest,safeBenchmarkFailure} from '../lib/ai-benchmark-authorized-run.ts';
import {createLanguageModel,type AiProvider} from '../lib/ai-providers.ts';
import {singleRequestFetch} from '../lib/ai-benchmark-budget.ts';
import {normalizeUsage,parseBenchmarkCases,runModelBenchmark,saveBenchmarkReport} from '../lib/ai-benchmark.ts';
import {runListingBenchmark} from '../lib/ai-benchmark-listing.ts';
async function main(){
 env.loadEnvConfig(process.cwd());const [runId,model='gemini-3.8-flash',attemptLimit='3']=process.argv.slice(2);
 if(!runId||!/^gemini-[a-z0-9-]{1,18}$/.test(runId))throw Error('Explicit unique run id required: gemini- followed by up to18 lowercase letters/digits/hyphens');
 if(!['gemini-3.8-flash','gemini-3.5-flash','gemini-3.1-flash-lite'].includes(model))throw Error('Model not reviewed for this comparison');
 const root='artifacts/model-benchmark/cactus-five-20261025';const resultFile=root+'/'+runId+'-recovery.json';if(existsSync(resultFile))throw Error('Run evidence exists; preserve it');
 const admission=await admitGenerationProvider(async index=>{
  const prompt='Return JSON with ok:true.';const journal=new AuthorizedFiveCardRun(root+'/authorized-calls.jsonl',benchmarkDigest({model,prompt,maxOutputTokens:256}),{label:runId+'-admit-'+index,reason:'Structured generation admission for user-requested Gemini recovery; diagnostic only.'});
  const key=journal.begin('cactus-five-0001-recognition','google',model);const started=performance.now();
  try{const result=await generateText({model:createLanguageModel('google',model,'recognition',singleRequestFetch(fetch,10000)),prompt,output:Output.object({schema:z.object({ok:z.boolean()})}),maxOutputTokens:256,maxRetries:0,abortSignal:AbortSignal.timeout(30000)});
   const ok=result.output?.ok===true;journal.append({event:ok?'result':'failure',key,diagnosticOnly:true,output:result.output,usage:normalizeUsage(result.usage),latencyMs:Math.round(performance.now()-started)});return {ok};
  }catch(error){const diagnostic=safeBenchmarkFailure(error);journal.append({event:'failure',key,diagnosticOnly:true,diagnostic,latencyMs:Math.round(performance.now()-started)});return {ok:false,diagnostic};}finally{journal.close();}
 },{maxAttempts:Number(attemptLimit)});
 const recognition=parseBenchmarkCases(JSON.parse(readFileSync(root+'/recognition-cases.json','utf8'))).cases;
 const pricing=parseBenchmarkCases(JSON.parse(readFileSync(root+'/pricing-cases-live.json','utf8'))).cases;
 const listing=JSON.parse(readFileSync(root+'/listing-cases-live.json','utf8'));
 if(!admission.ready){writeFileSync(resultFile,JSON.stringify({model,admission,status:'blocked-before-card-batch',cardCalls:0,remainingCells:15,reason:'Minimal structured generation failed; saved inputs preserved; no card-batch calls sent.'},null,2),{flag:'wx'});console.log('Generation admission failed; evidence saved; zero card-batch calls.');return;}
 const journal=new AuthorizedFiveCardRun(root+'/authorized-calls.jsonl',benchmarkDigest({recognition,pricing,listing,model}),{label:runId+'-cards',reason:'Resume saved five-card comparison after verified structured generation; explicit recovery round.'});
 const reports=[];const listingRows=[];let serviceBlocked=false;
 try{
  for(const c of [...recognition,...pricing]){
   const report=await runModelBenchmark({cases:[c],providers:['google'],models:{google:model},authorizedFiveCardRun:journal,timeoutMs:90000});saveBenchmarkReport(report,root+'/'+runId+'-'+c.kind);reports.push(report);
   if(report.runs.some(r=>r.failures.some(f=>/HTTP (429|5\d\d)|timeout-or-abort/.test(f)))){serviceBlocked=true;break;}
  }
  if(!serviceBlocked)for(const c of listing){const rows=await runListingBenchmark([c],{google:model} as Record<AiProvider,string>,journal);listingRows.push(...rows);if(rows.some(r=>'diagnostic' in r&&r.diagnostic&&((r.diagnostic.httpStatus??0)>=500||r.diagnostic.httpStatus===429||r.diagnostic.category==='timeout-or-abort'))){serviceBlocked=true;break;}}
 }finally{journal.close();}
 writeFileSync(resultFile,JSON.stringify({model,admission,status:serviceBlocked?'service-blocked':'attempts-finished',reports,listingRows,remainingCells:15-reports.reduce((s,r)=>s+r.runs.length,0)-listingRows.length},null,2),{flag:'wx'});console.log('Recovery results saved.');
}
main().catch(()=>{console.error('Recovery stopped; inspect preserved evidence; no implicit rerun.');process.exitCode=1;});
