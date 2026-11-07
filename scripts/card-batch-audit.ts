import fs from 'node:fs/promises';
import { readQueue } from '../lib/card-orchestrator-store.ts';
import { validDraftGroup } from '../lib/card-orchestrator.ts';
import { auditBatch, batchAuditSchema, draftHoldSchema } from '../lib/card-batch-audit.ts';
async function main() { try {
  const file=process.argv[2]; if(!file)throw Error('Usage: node --experimental-strip-types scripts/card-batch-audit.ts PACKET.json');
  const packet=batchAuditSchema.parse(JSON.parse(await fs.readFile(file,'utf8')));
  // The canonical hold registry is mandatory: callers cannot omit known stale drafts.
  const holds=draftHoldSchema.array().parse(JSON.parse(await fs.readFile('artifacts/card-orchestrator/draft-handoff-holds.json','utf8')));
  packet.draftHolds.push(...holds);
  const evidence=[...packet.outcomes.flatMap(row=>[row.evidence,row.photos?.evidence,row.inventory?.evidence]),...packet.draftHolds.map(h=>h.evidence)];
  for(const path of evidence) if(path&&(!(await fs.stat(path)).isFile()||!(await fs.readFile(path,'utf8')).trim())) throw Error('Evidence must be a retained nonempty file');
  const queue=await readQueue('artifacts/card-orchestrator');
  const verifiedGroups:Record<string,{members:string[];sku:string;photoCount?:number}>={};
  for(const g of Object.values(queue.draftCreationGroups??{})) {
    if(!g.draftId||!validDraftGroup(queue,g.draftId,g.members))continue;
    if(!g.members.every(id=>{const c=queue.cards[id],v=c.draftLifecycle;return v?.unpricedVerification?.binding===g.bindings[id]||v?.verification?.photoIdentityVerified&&v.verification.binding===g.bindings[id];}))continue;
    verifiedGroups[g.draftId]={members:g.members,sku:g.sku,photoCount:g.representativePhotos?2:g.members.length*2};
  }
  for(const g of Object.values(queue.draftAppends??{})) {
    const members=[...g.packet.existing,...g.packet.added];
    if(g.completedAt&&validDraftGroup(queue,g.packet.draftId,members))verifiedGroups[g.packet.draftId]={members,sku:queue.cards[g.packet.primary].input.sku,photoCount:g.photoCount};
  }
  const result=auditBatch(packet,verifiedGroups);
  console.log(JSON.stringify(result,null,2));
  if(!result.complete)process.exitCode=1;
} catch(e) {console.error(e instanceof Error?e.message:'Audit failed');process.exitCode=1;} }
void main();
