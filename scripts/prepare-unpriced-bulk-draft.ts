import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {prepareUnpricedBulkDraft} from '../lib/card-unpriced-bulk-preparation.ts';
import {readHostedCardPhotos} from '../lib/card-bulk-draft-service.ts';
import {readQueue} from '../lib/card-orchestrator-store.ts';
import {readReviews} from '../lib/card-workflow-store.ts';
async function main(){
  const args=process.argv.slice(2),value=(name:string)=>{const at=args.indexOf(name);return at<0?'':args[at+1]??'';};
  const ids=value('--cards').split(',').filter(Boolean),output=value('--out');
  if(!output)throw Error('Use --cards ID,ID --out NEW_FILE.json; offline only');
  const state=await readQueue(path.resolve('artifacts/card-orchestrator'));
  // Re-read all selected original bytes. No queue, photo or network mutations.
  for(const id of ids)for(const p of state.cards[id]?.input.photos??[]){
    if(createHash('sha256').update(await fs.readFile(p.path)).digest('hex')!==p.sha256.toLowerCase())throw Error(`Original changed for ${id}`);
  }
  const reviews=await readReviews(),reviewChecks:Record<string,string>={};
  // A source-bound decision must pass normal preflight; this offline utility
  // cannot silently resolve or reinterpret historical seller decisions.
  for(const id of ids){
    const capture=`capture:${state.cards[id]?.input.photos.find(p=>p.side==='front')?.sha256.toLowerCase()}`;
    if(reviews.events.some(e=>e.cardId===capture&&e.action!=='note'))reviewChecks[id]='Source-bound seller decisions require normal supported preflight';
  }
  const result=prepareUnpricedBulkDraft(state,ids,await readHostedCardPhotos(),Date.now(),reviewChecks);
  await fs.writeFile(path.resolve(output),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({output:path.resolve(output),physicalCards:result.physicalCards,preparedRows:result.preparedRows,exceptions:result.exceptions.length,canUpload:false,draftsCreated:0}));
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Unpriced preparation failed');process.exitCode=1;});
