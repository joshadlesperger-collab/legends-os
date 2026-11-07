import env from '@next/env';
import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {generateText} from 'ai';
import {createLanguageModel,defaultModelFor,providerConfigured} from '../lib/ai-providers.ts';
import {BenchmarkBudget,singleRequestFetch,validateBenchmarkBound,type BenchmarkBound} from '../lib/ai-benchmark-budget.ts';
import {INSPECTOR_SYSTEM,inspectorPreflight} from '../lib/engineering-inspector.ts';
async function main(){
 env.loadEnvConfig(process.cwd());
 const base='artifacts/bulk-import-proof-20261025/';
 const runRoot=base+'inspector-runs/'+new Date().toISOString().replace(/[:.]/g,'-')+'/';
 mkdirSync(runRoot,{recursive:true});
 const files=['lib/inventory-offer-review.ts','app/inventory-review/page.tsx','tests/inventory-offer-review.test.ts',base+'recovery-checkpoint.md',base+'review-evidence.md'];
 // Explicit non-secret allowlist; never send env files, database rows, broad diffs or logs.
 const evidence=files.map(path=>({path,text:readFileSync(path,'utf8')}));
 const prompt=JSON.stringify(evidence);
 if(Buffer.byteLength(prompt)>40000)throw Error('Inspector packet exceeds fixed evidence limit');
 const digest=createHash('sha256').update(prompt).digest('hex');
 const model=defaultModelFor('anthropic','recognition');
 const ledger='artifacts/model-benchmark/spending-ledger.jsonl';
 const boundsFile=process.argv[process.argv.indexOf('--bounds')+1];
 const boundsExists=process.argv.includes('--bounds')&&!!boundsFile&&existsSync(boundsFile);
 const preflight=inspectorPreflight({configured:providerConfigured('anthropic'),ledgerExists:existsSync(ledger),boundsExists});
 const report={at:new Date().toISOString(),provider:'anthropic',model,digest,files, ...preflight,live:false};
 writeFileSync(runRoot+'preflight.json',JSON.stringify(report,null,2),{flag:'wx'});
 writeFileSync(runRoot+'evidence.json',prompt,{flag:'wx'});
 if(!process.argv.includes('--run')||!preflight.ready){console.log(JSON.stringify(report));return;}
 const bounds=JSON.parse(readFileSync(boundsFile,'utf8')) as BenchmarkBound[];
 const bound=validateBenchmarkBound(bounds.find(b=>b.provider==='anthropic'&&b.model===model),'anthropic',model,1200);
 const budget=new BenchmarkBudget(ledger,undefined,'retest');
 try{
  budget.assertPlanAffordable([{bound,provider:'anthropic',model,outputLimit:1200}]);
  const id=budget.reserve(bound,'anthropic',model,1200);
  // Durable reservation and immutable packet receipt precede a single no-tools request.
  try{
   const start=performance.now();
   const result=await generateText({model:createLanguageModel('anthropic',model,'recognition',singleRequestFetch(fetch,bound.maxRequestBytes)),system:INSPECTOR_SYSTEM,prompt,maxOutputTokens:1200,maxRetries:0,abortSignal:AbortSignal.timeout(90000)});
   const cost=budget.settle(id,result.usage);
   writeFileSync(runRoot+'claude-inspection.json',JSON.stringify({at:new Date().toISOString(),digest,model,elapsedMs:performance.now()-start,usage:result.usage,costUsd:cost,review:result.text},null,2),{flag:'wx'});
   console.log('Claude inspection saved; findings require evidence validation before changes.');
  }catch{budget.stop();throw Error('Inspector failed; shared ledger stopped for reconciliation. No automatic retry.');}
 }finally{budget.close();}
}
main().catch(()=>{console.error('Inspector did not complete; inspect retained preflight and shared ledger. Raw provider errors suppressed.');process.exitCode=1;});
