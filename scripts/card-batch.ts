import { readBatchOperations } from "../lib/card-batch-metrics.ts";
import { verifiedBulkDraftExport } from "../lib/card-bulk-draft-service.ts";
import { readBatch,saveBatch } from "../lib/card-batch-store.ts";
import { BATCH_STAGES,batchTiming,batchPacket,type BatchStage } from "../lib/card-batch.ts";
import { loadCardBacklog } from "../lib/card-backlog-store.ts";
import { withWorkflow } from "../lib/card-workflow-store.ts";
import { verifiedBatchPacket } from "../lib/card-batch-service.ts";

async function main(){
const [command,value]=process.argv.slice(2);
try{
  const current=await readBatch();
  if(command==="status")console.log(JSON.stringify(current?{...current,timing:batchTiming(current),metrics:await readBatchOperations(current)}:null,null,2));
  else if(command==="bulk"){
    if(!current)throw Error("No batch selected.");
    console.log(JSON.stringify(await verifiedBulkDraftExport(current),null,2));
  }else if(command==="packet"){
    if(!current)throw Error("No timed batch selected.");
    console.log(JSON.stringify(await verifiedBatchPacket(current),null,2));
  }else if(command==="start"){
    const snapshot=await withWorkflow(await loadCardBacklog()),ids=(value||"").split(",");
    for(const id of ids){const c=snapshot.cards.find(c=>c.id===id);if(!c||!c.physicalUnits||!c.frontHash||c.backHashes.length!==1||c.receipts.length||c.excludedFromNewListing||c.issues.length||snapshot.workflow[id]?.holdReason)throw Error("Use exact backlog capture IDs without receipts or conflicts.");}
    console.log(JSON.stringify(await saveBatch({revision:0,cardIds:ids}),null,2));
  }else if(command==="stage"||command==="pause"||command==="archive"){
    if(!current)throw Error("No timed batch selected.");
    if(command==="stage"&&!BATCH_STAGES.includes(value as BatchStage))throw Error(`Stage must be ${BATCH_STAGES.join(", ")}`);
    console.log(JSON.stringify(await saveBatch({batchId:current.id,revision:current.revision,stage:command==="stage"?value as BatchStage:null,finish:command==="archive"}),null,2));
  }else throw Error("Use start ID,ID (1 to 500), stage NAME, pause, status, packet, bulk, or archive. No eBay writes.");
}catch(e){console.error(e instanceof Error?e.message:"Batch command failed");process.exitCode=1;}
}
void main();
