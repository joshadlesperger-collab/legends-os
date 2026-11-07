import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {digest,type V2Card,type V2State} from './card-processing-v2.ts';
import {readV2State,withV2State} from './card-processing-v2-store.ts';
import {readV2DraftMerge,type V2DraftMergeClaim,type V2DraftMergeOperation} from './card-processing-v2-draft-merge-store.ts';
import {v2StableCatalogIdentityKey} from './card-processing-v2-stable-identity.ts';

type Receipt={operationId:string;survivorDraftId:string;captureId:string;observedAt:string;evidence:{path:string;sha256:string};files:Array<{source:string;destination:string;hash:string;side:'front'|'back'}>};
type MergeCard=V2Card&{draftMergeReceipt?:Receipt};
const sha=(v:Uint8Array)=>createHash('sha256').update(v).digest('hex');
const normalized=(p:string)=>path.resolve(p).toLowerCase();
class AlreadyCommitted extends Error{}
async function exactArchive(file:string,hash:string){const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>35_000_000||normalized(await fs.realpath(file))!==normalized(file)||sha(await fs.readFile(file))!==hash)throw Error('Merged original archive changed');}
async function absent(file:string){try{await fs.lstat(file);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}throw Error('Merged original source still exists');}
function checkMembership(state:V2State,operation:V2DraftMergeOperation,receipts:Map<string,Receipt>){
 const survivorSource=operation.plan.sources.find(s=>s.draftId===operation.plan.survivorDraftId)!;
 const survivor=Object.values(state.cards).find(c=>c.draftId===survivorSource.draftId&&c.sku===survivorSource.sku&&survivorSource.captureIds.includes(c.captureId));
 if(!survivor?.identity||survivor.identity.serial||survivor.identity.damage||survivor.identity.graded||survivor.inventoryArchive||survivor.activeQuantityOperationId)throw Error('Retained unnumbered survivor identity ownership required');
 const key=v2StableCatalogIdentityKey(survivor);
 let committed=0;
 for(const capture of operation.plan.newCaptures){
  const card=state.cards[capture.cardId] as MergeCard|undefined,receipt=receipts.get(capture.cardId)!;
  if(!card||card.captureId!==capture.captureId||!card.identity||card.identity.serial||card.identity.damage||card.identity.graded||card.issues.length
   ||v2StableCatalogIdentityKey(card)!==key||card.photos.length!==2||!card.photos.every(p=>capture.photos.some(q=>normalized(p.path)===normalized(q.path)&&p.hash===q.hash&&p.side===q.side)))throw Error('Merged new capture/photo/catalog identity changed');
  if(card.draftMergeReceipt){if(digest(card.draftMergeReceipt)!==digest(receipt)||card.draftId!==operation.plan.survivorDraftId||card.stage!=='prepared'||card.nextAction!=='Merged into saved draft; original photos archived; pricing preserved')throw Error('Different merged-card receipt already owns this capture');committed++;continue;}
  if(card.draftId||card.draftArchive||card.inventoryArchive||card.activeQuantityOperationId||card.activeQuantityReceipt||card.nonpriceVerification||card.verification
   ||!['identified','consolidated','prepared'].includes(card.stage)||Object.values(state.submissions).some(s=>s.payload.captureIds.includes(card.captureId)))throw Error('New merge capture already has frozen or terminal ownership');
 }
 return committed;
}

/** Attach a completed overlay only to its new physical copies. Frozen source
 * submissions and historical archives remain unchanged; this is not a synthetic
 * nonprice review, import receipt, or new upload authorization.
 */
export async function commitV2DraftMergeCards(root:string,operationId:string,claim:V2DraftMergeClaim){
 const operation=await readV2DraftMerge(root,operationId);
 if(operation.claim.owner!==claim.owner||operation.claim.token!==claim.token)throw Error('Matching merge owner claim required');
 if(operation.stage!=='complete'||!operation.quantityEvidence)throw Error('Complete saved/deleted/archive merge proof required');
 const relative=`artifacts/card-processing-v2/draft-merges/${operation.id}.json`,absolute=path.join(root,relative),bytes=await fs.readFile(absolute);
 if(digest(JSON.parse(bytes.toString('utf8')))!==digest(operation))throw Error('Completed merge operation changed during commit');
 const evidence={path:relative,sha256:sha(bytes)},receipts=new Map<string,Receipt>();
 for(const capture of operation.plan.newCaptures){
  const files=operation.archives.filter(p=>p.captureId===capture.captureId);
  const completed=operation.completedCaptureArchives.find(c=>c.captureId===capture.captureId);
  if(files.length!==2||new Set(files.map(p=>p.side)).size!==2||files.some(p=>p.status!=='moved'||!capture.photos.some(q=>normalized(q.path)===normalized(p.source)&&q.hash===p.hash&&q.side===p.side)
   ||!completed?.files.some(q=>normalized(q.path)===normalized(p.destination)&&q.hash===p.hash&&q.side===p.side)))throw Error('Complete exact merged front/back archive mapping required');
  for(const p of files){await exactArchive(p.destination,p.hash);await absent(p.source);}
  receipts.set(capture.cardId,{operationId:operation.id,survivorDraftId:operation.plan.survivorDraftId,captureId:capture.captureId,observedAt:operation.updatedAt,evidence,
   files:files.map(({source,destination,hash,side})=>({source,destination,hash,side}))});
 }
 const count=operation.plan.newCaptures.length,state=await readV2State(root);
 if(checkMembership(state,operation,receipts)===count)return{operationId,survivorDraftId:operation.plan.survivorDraftId,committedCardIds:[],alreadyCommitted:true,evidence};
 let committedCardIds:string[]=[];
 try{await withV2State(async current=>{
  if(sha(await fs.readFile(absolute))!==evidence.sha256)throw Error('Immutable completed merge receipt changed');
  if(checkMembership(current,operation,receipts)===count)throw new AlreadyCommitted();
  for(const capture of operation.plan.newCaptures){const c=current.cards[capture.cardId] as MergeCard;if(c.draftMergeReceipt)continue;
   for(const p of receipts.get(c.id)!.files){await exactArchive(p.destination,p.hash);await absent(p.source);}
   c.draftMergeReceipt=receipts.get(c.id)!;c.draftId=operation.plan.survivorDraftId;c.stage='prepared';c.nextAction='Merged into saved draft; original photos archived; pricing preserved';committedCardIds.push(c.id);
  }
 },root);}catch(error){if(!(error instanceof AlreadyCommitted))throw error;committedCardIds=[];}
 return{operationId,survivorDraftId:operation.plan.survivorDraftId,committedCardIds,alreadyCommitted:committedCardIds.length===0,evidence};
}
