import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {digest,type V2State} from './card-processing-v2.ts';
import {readV2DraftMerge,type V2DraftMergeOperation} from './card-processing-v2-draft-merge-store.ts';

export type V2DraftMergeOwner={operationId:string;survivorDraftId:string;evidence:{path:string;sha256:string}};
const sha=(v:Uint8Array)=>createHash('sha256').update(v).digest('hex');
const sameSet=(a:string[],b:string[])=>new Set(a).size===a.length&&new Set(b).size===b.length&&digest(a.slice().sort())===digest(b.slice().sort());

/** Presentation-only current ownership from completed immutable merge overlays.
 * Never rewrites historical draft IDs, frozen submissions or photo archive paths.
 * Prior completed ownership supports later merges of a previously merged group.
 */
export async function loadV2DraftMergeOwners(root:string,state:V2State):Promise<Record<string,V2DraftMergeOwner>>{
 const folder=path.join(root,'artifacts/card-processing-v2/draft-merges');let names:string[];
 try{names=await fs.readdir(folder);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return{};throw error;}
 const files=names.filter(name=>/^[a-f0-9]{64}\.json$/.test(name));
 if(files.length>10000)throw Error('Draft merge owner registry exceeds supported bound');
 const completed:Array<{operation:V2DraftMergeOperation;evidence:{path:string;sha256:string}}>=[];
 for(const name of files){const absolute=path.join(folder,name),stat=await fs.lstat(absolute);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16_000_000)throw Error('Bounded regular merge owner record required');
  const operation=await readV2DraftMerge(root,name.slice(0,-5));if(operation.stage!=='complete')continue;
  const bytes=await fs.readFile(absolute);if(digest(JSON.parse(bytes.toString('utf8')))!==digest(operation))throw Error('Completed merge owner record changed while reading');
  completed.push({operation,evidence:{path:`artifacts/card-processing-v2/draft-merges/${name}`,sha256:sha(bytes)}});
 }
 completed.sort((a,b)=>a.operation.createdAt.localeCompare(b.operation.createdAt)||a.operation.id.localeCompare(b.operation.id));
 const owners:Record<string,V2DraftMergeOwner>={},cardsByCapture=new Map<string,Array<V2State['cards'][string]>>();
 for(const c of Object.values(state.cards))cardsByCapture.set(c.captureId,[...(cardsByCapture.get(c.captureId)??[]),c]);
 for(const {operation:op,evidence} of completed){
  const expectedDonors=op.plan.sources.map(s=>s.draftId).filter(id=>id!==op.plan.survivorDraftId),captures=op.plan.sources.flatMap(s=>s.captureIds).concat(op.plan.newCaptures.map(c=>c.captureId));
  if(!op.quantityEvidence||!sameSet(op.deletionRequestedIds,expectedDonors)||!sameSet(op.deletedDraftIds,expectedDonors)
   ||expectedDonors.length&&!op.deletionEvidence||!sameSet(op.completedCaptureArchives.map(c=>c.captureId),captures)
   ||op.archives.length!==op.plan.newCaptures.length*2||op.archives.some(p=>p.status!=='moved'))throw Error('Only complete exact quantity/deletion/archive merges provide current ownership');
  const owner:V2DraftMergeOwner={operationId:op.id,survivorDraftId:op.plan.survivorDraftId,evidence};
  for(const source of op.plan.sources)for(const captureId of source.captureIds){const cards=cardsByCapture.get(captureId)??[];
   if(cards.length!==1)throw Error('Exact single historical source capture owner required');const card=cards[0],previous=owners[card.id];
   if(card.draftId!==source.draftId&&previous?.survivorDraftId!==source.draftId)throw Error('Merge source no longer matches historical or completed current owner');
   if(!card.inventoryArchive&&!card.activeQuantityOperationId)owners[card.id]=owner;
  }
  for(const capture of op.plan.newCaptures){const cards=cardsByCapture.get(capture.captureId)??[];
   if(cards.length!==1||cards[0].id!==capture.cardId)throw Error('Exact merged new capture owner required');const card=cards[0];
   // Complete operation and state attachment are separate durable commits.
   // Do not claim an uncommitted new card is finished in that short interval.
   if(!card.draftMergeReceipt&&!card.draftId)continue;
   if(card.draftId!==op.plan.survivorDraftId||card.draftMergeReceipt?.operationId!==op.id||card.draftMergeReceipt.captureId!==capture.captureId
    ||card.draftMergeReceipt.survivorDraftId!==op.plan.survivorDraftId||digest(card.draftMergeReceipt.evidence)!==digest(evidence))throw Error('New card merge receipt differs from completed operation');
   if(!card.inventoryArchive&&!card.activeQuantityOperationId)owners[card.id]=owner;
  }
 }
 return owners;
}
