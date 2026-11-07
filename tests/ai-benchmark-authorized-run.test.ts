import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AuthorizedFiveCardRun,safeBenchmarkFailure} from '../lib/ai-benchmark-authorized-run.ts';
import {listingBenchmarkSchema} from '../lib/ai-benchmark-listing.ts';
import {pricingGenerationSchema} from '../lib/card-pricing-agent.ts';
import {zodSchema} from 'ai';
test('scoped journal rejects unrelated cards and durable repeated attempts',()=>{
 const dir=mkdtempSync(join(tmpdir(),'five-card-journal-'));const file=join(dir,'calls.jsonl');
 try{let j=new AuthorizedFiveCardRun(file,'fixture');assert.throws(()=>j.begin('other-card','openai','test'));j.begin('cactus-five-0001-recognition','openai','test');j.close();
 j=new AuthorizedFiveCardRun(file,'fixture');assert.throws(()=>j.begin('cactus-five-0001-recognition','openai','test'));j.close();assert.equal(readFileSync(file,'utf8').trim().split('\n').length,1);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('diagnostics retain categories without provider message or secret data',()=>{
 for(const [error,category] of [[{statusCode:400,message:'Invalid schema with secret-token abc'},'invalid-output-schema'],[{statusCode:429,message:'Quota exceeded secret-token abc'},'quota-or-rate-limit'],[{name:'TimeoutError',message:'secret-token abc'},'timeout-or-abort']] as const){
  const result=safeBenchmarkFailure(error);assert.equal(result.category,category);assert.equal(JSON.stringify(result).includes('secret-token'),false);
 }
});
test('explicit retest preserves original and rejects repeated labels',()=>{
 const dir=mkdtempSync(join(tmpdir(),'five-card-retest-'));const file=join(dir,'calls.jsonl');
 try{let j=new AuthorizedFiveCardRun(file,'original');j.begin('cactus-five-0001-pricing','openai','test');j.close();
 j=new AuthorizedFiveCardRun(file,'diagnostic',{label:'diagnostic-1',reason:'Preserved failure investigation'});j.begin('cactus-five-0001-pricing','openai','test');assert.throws(()=>j.begin('cactus-five-0001-pricing','openai','test'));assert.throws(()=>j.begin('cactus-five-0002-pricing','openai','test'));j.close();
 const rows=readFileSync(file,'utf8').trim().split('\n').map(line=>JSON.parse(line));assert.equal(rows.length,2);assert.equal(rows[1].retestOf,rows[0].key);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('listing schema requires bounded title and explicit unresolved price',()=>{
 const row={title:'Verified player card',description:'One card',specifics:[],price:null,ready:false,warnings:['Price unknown']};
 assert.equal(listingBenchmarkSchema.parse(row).price,null);assert.equal(listingBenchmarkSchema.safeParse({...row,title:'x'.repeat(81)}).success,false);
});
test('wire schemas satisfy strict required properties and forbid dynamic object keys',async()=>{
 const inspect=(value:any)=>{if(value&&typeof value==='object'){if(value.type==='object'){assert.equal(value.additionalProperties,false);assert.deepEqual([...value.required].sort(),Object.keys(value.properties).sort());}for(const child of Object.values(value))inspect(child);}};
 inspect(await zodSchema(pricingGenerationSchema).jsonSchema);inspect(await zodSchema(listingBenchmarkSchema).jsonSchema);
});
