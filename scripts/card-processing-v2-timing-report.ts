import fs from 'node:fs/promises';
import path from 'node:path';
import {readV2State,v2Dir} from '../lib/card-processing-v2-store.ts';
import {processingBatchSchema} from '../lib/card-processing-v2-processing-batches.ts';
import {compareV2BatchTiming,evaluateV2TimingRollout} from '../lib/card-processing-v2-batch-comparison.ts';
async function main(){
const args=process.argv.slice(2),id=args.shift();let observedAt:string|undefined,baselineId:string|undefined;
while(args.length){const next=args.shift()!;if(next==='--baseline'){if(baselineId)throw Error('One baseline only');baselineId=args.shift();if(!/^[a-f0-9-]{36}$/.test(baselineId??''))throw Error('Exact baseline UUID required');}else if(!observedAt&&!next.startsWith('--')&&Number.isFinite(Date.parse(next)))observedAt=next;else throw Error('Use BATCH_UUID [OBSERVED_AT] [--baseline BASELINE_UUID]');}
if(!/^[a-f0-9-]{36}$/.test(id??''))throw Error('Exact retained batch UUID required');
const root=process.cwd(),batch=processingBatchSchema.parse(JSON.parse(await fs.readFile(path.join(v2Dir(root),'processing-batches',`${id}.json`),'utf8')));
const state=await readV2State(root),current=compareV2BatchTiming(state,batch,observedAt);
if(baselineId){const prior=processingBatchSchema.parse(JSON.parse(await fs.readFile(path.join(v2Dir(root),'processing-batches',baselineId+'.json'),'utf8'))),baseline=compareV2BatchTiming(state,prior,observedAt);console.log(JSON.stringify({current,baseline,comparison:evaluateV2TimingRollout(baseline,current)},null,2));}else console.log(JSON.stringify(current,null,2));

}
main().catch(()=>{console.error('Timing report stopped; no state or provider changes were made.');process.exitCode=1;});
