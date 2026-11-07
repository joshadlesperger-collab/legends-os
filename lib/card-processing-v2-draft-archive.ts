import {v2BulkResultReceiptBound} from './card-processing-v2-archive-status.ts';
import { measureV2 } from "./card-processing-v2-timing.ts";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {readV2ResetTransfers} from "./card-processing-v2-reset.ts";
import { digest, event, type V2Card, type V2State } from "./card-processing-v2.ts";
import { acquireV2Lock, readV2Config, readV2State, withV2State, v2Dir } from "./card-processing-v2-store.ts";

const authoritySchema = z.object({ instructionId: z.string().min(1), evidence: z.object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict() }).strict();
export type V2DraftArchiveAuthority = z.infer<typeof authoritySchema>;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const now = () => new Date().toISOString();
function inside(base: string, file: string) { const relative = path.relative(base,file); if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw Error("Archive path outside configured root"); }
async function verifyAuthority(root: string, raw: unknown) {
  const a=authoritySchema.parse(raw), p=a.evidence.path;
  if(path.isAbsolute(p)||p.split(/[\\/]/).includes(".."))throw Error("Authority must stay under artifacts");
  const base=await fs.realpath(path.join(root,"artifacts")),file=await fs.realpath(path.join(root,p));inside(base,file);
  const stat=await fs.stat(file);if(!stat.isFile()||stat.size>1000000)throw Error("Invalid bounded authority");
  const bytes=await fs.readFile(file);if(hash(bytes)!==a.evidence.sha256)throw Error("Authority hash mismatch");
  const packet=JSON.parse(bytes.toString("utf8")),instruction=packet.instruction;
  if(instruction?.id!==a.instructionId||typeof instruction.text!=="string"||!instruction.text.trim()||!((instruction.taskIds??[]).includes("v2-draft-archive-enforcement-20261103")||(instruction.policyRefs??[]).includes("v2-draft-photo-archive")))throw Error("Captured draft archive instruction required");
  const queue=JSON.parse(await fs.readFile(path.join(root,"artifacts","engineering-mission","work-queue.json"),"utf8"));
  if(!Array.isArray(queue.instructions)||!queue.instructions.some((i:unknown)=>digest(i)===digest(instruction)))throw Error("Archive authority is not captured in the engineering queue");
  if(queue.instructions.some((i:{supersedes?:string[]})=>i.supersedes?.includes(a.instructionId)))throw Error("Archive authority was superseded; reconcile current instructions");
  return a;
}
async function checked(file: string, expected: string, missing=false) {
  try {const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>35000000)throw Error("Archive file is not a bounded original");const bytes=await fs.readFile(file);if(hash(bytes)!==expected)throw Error("Original or archive hash changed");return bytes;}
  catch(e){if(missing&&(e as NodeJS.ErrnoException).code==="ENOENT")return null;throw e;}
}
function eligible(c: V2Card, submissions: Awaited<ReturnType<typeof readV2State>>["submissions"]) {
  if(c.inventoryArchive)throw Error("Inventory archive owns these originals; do not recreate a draft archive");
  const sub=Object.values(submissions).filter(s=>s.draftId===c.draftId&&s.payload.captureIds.includes(c.captureId));
  if(!c.draftId||c.issues.length||!c.identity||c.identity.damage||c.identity.graded||sub.length!==1||sub[0].groupId!==c.groupId||!["submitted","verified"].includes(sub[0].status)||!((c.nonpriceVerification?.draftId===c.draftId&&c.nonpriceVerification.scope==="non-price-fields")||c.verification||v2BulkResultReceiptBound(c)))throw Error("Verified saved draft original pair and unheld ownership required");
  if(c.bulkResultVerification&&c.bulkResultVerification.payloadHash!==digest(sub[0].payload))throw Error('Bulk receipt frozen payload binding changed');
  if(c.photos.length!==2||new Set(c.photos.map(p=>p.side)).size!==2)throw Error("Exact original pair required");
  if(sub[0].payload.captureIds.length===1&&digest(c.photos.map(p=>p.hash))!==digest(sub[0].payload.photos.map(p=>p.hash)))throw Error("Saved draft no longer binds this original pair");
}
/** Two durable phases: verify both exclusive copies, checkpoint, then unlink only unchanged originals. */
async function archiveV2DraftPhotosTimedLocal(root: string, cardIds: string[], rawAuthority: V2DraftArchiveAuthority) {
  if(!cardIds.length||cardIds.length>20||new Set(cardIds).size!==cardIds.length)throw Error("Bounded unique archive scope required");
  const authority=await verifyAuthority(root,rawAuthority),release=await acquireV2Lock("worker",root),results: {cardId:string;status:string}[]=[];
  try {
    const authorityFile=path.join(v2Dir(root),"draft-archive-authority.json"),temporary=`${authorityFile}.${randomUUID()}.tmp`;
    await fs.mkdir(v2Dir(root),{recursive:true});const handle=await fs.open(temporary,"wx");try{await handle.writeFile(JSON.stringify(authority));await handle.sync();}finally{await handle.close();}await fs.rename(temporary,authorityFile);
    const cfg=await readV2Config(root),sourceRoot=await fs.realpath(cfg.folder),archiveRoot=path.join(sourceRoot,"Drafted"),transfers=await readV2ResetTransfers(root);
    await fs.mkdir(archiveRoot,{recursive:true});inside(sourceRoot,await fs.realpath(archiveRoot));if((await fs.lstat(archiveRoot)).isSymbolicLink())throw Error("Archive root cannot be a symbolic link");
    for(const cardId of cardIds) {
      try {
        let s=await readV2State(root),c=s.cards[cardId];if(!c)throw Error("Card missing");eligible(c,s.submissions);
        if(Object.values(s.cards).some(other=>other.id!==c.id&&other.photos.some(p=>c.photos.some(own=>own.path===p.path||own.hash===p.hash))))throw Error("Original ownership overlaps another card");
        const directory=path.join(archiveRoot,c.draftId!);await fs.mkdir(directory,{recursive:true});inside(archiveRoot,await fs.realpath(directory));if((await fs.lstat(directory)).isSymbolicLink())throw Error("Archive directory cannot be a symbolic link");
        const files=c.photos.map(p=>({source:path.resolve(p.path),destination:path.join(directory,`${p.side}-${p.hash}${path.extname(p.path).toLowerCase()}`),hash:p.hash,side:p.side}));
        const transferred=c.resetTransfer?transfers.receipts.find(r=>r.resetId===c.resetTransfer!.resetId)?.pairs.find(p=>p.legacyCardId===c.resetTransfer!.legacyCardId):undefined;
        const transferBound=!!transferred&&!transferred.guards.hardHolds.length&&!transferred.guards.positiveDispositions.length&&transferred.photos.length===c.photos.length&&c.photos.every(p=>transferred.photos.some(q=>q.side===p.side&&path.resolve(q.path).toLowerCase()===path.resolve(p.path).toLowerCase()&&q.sha256.toLowerCase()===p.hash))&&transfers.transfers[transferred.legacyCardId]?.receipt===c.resetTransfer?.receipt;
        const readyBound=c.readyBatch?!!await (await import("./card-processing-v2-ready-batches.ts")).assertV2ReadyCardOriginals(root,c):false;
        for(const f of files){if(path.dirname(f.source)!==sourceRoot&&!transferBound&&!readyBound)throw Error("Original is outside top-level configured scan folder or exact committed transfer/ready batch");if(path.resolve(await fs.realpath(path.dirname(f.source))).toLowerCase()!==path.dirname(f.source).toLowerCase())throw Error("Original parent is a redirected source");inside(directory,f.destination);}
        if(c.draftArchive&&(c.draftArchive.captureId!==c.captureId||c.draftArchive.draftId!==c.draftId||digest(c.draftArchive.files)!==digest(files)))throw Error("Existing archive binding changed");
        const previous=c.draftArchive;
        // Missing originals are recoverable only from a durable prior plan and exact verified destinations.
        for(const f of files){const bytes=await checked(f.source,f.hash,true);if(!bytes&&(!previous||!await checked(f.destination,f.hash,true)))throw Error("Original missing before archive plan");}
        if(previous?.status==="moved"){for(const f of files)await checked(f.destination,f.hash);results.push({cardId,status:"moved"});continue;}
        await withV2State(state=>{const current=state.cards[cardId];eligible(current,state.submissions);current.draftArchive={status:"planned",instructionId:authority.instructionId,authority:authority.evidence,draftId:c.draftId!,captureId:c.captureId,files,updatedAt:now()};},root);
        for(const f of files){const bytes=await checked(f.source,f.hash,true);if(bytes){try{const handle=await fs.open(f.destination,"wx");try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}}catch(e){if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;}}await checked(f.destination,f.hash);}
        await withV2State(state=>{eligible(state.cards[cardId],state.submissions);state.cards[cardId].draftArchive!.status="copied";state.cards[cardId].draftArchive!.updatedAt=now();},root);
        for(const f of files){await checked(f.destination,f.hash);if(await checked(f.source,f.hash,true))await fs.unlink(f.source);}
        await withV2State(state=>{state.cards[cardId].draftArchive!.status="moved";state.cards[cardId].draftArchive!.updatedAt=now();event(state,"draft-photos-archived",`Original pair moved to Drafted/${c.draftId}`,cardId);},root);
        results.push({cardId,status:"moved"});
      } catch(e) {
        await withV2State(state=>{const a=state.cards[cardId]?.draftArchive;if(a){a.status="held";a.error="Archive stopped: original, destination, authority or ownership requires reconciliation";a.updatedAt=now();}},root);
        results.push({cardId,status:"held"});
      }
    }
    return results;
  } finally {await release();}
}
export async function recoverV2DraftArchives(root: string) {
  let standing:V2DraftArchiveAuthority;try{standing=authoritySchema.parse(JSON.parse(await fs.readFile(path.join(v2Dir(root),"draft-archive-authority.json"),"utf8")));}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return [];throw Error("Standing archive authority is invalid");}
  await verifyAuthority(root,standing);
  const s=await readV2State(root),pending=Object.values(s.cards).filter(c=>{if(c.draftArchive?.status==="moved")return false;try{eligible(c,s.submissions);return true;}catch{return false;}}).slice(0,20);
  if(!pending.length)return [];return archiveV2DraftPhotos(root,pending.map(c=>c.id),standing);
}
export async function resolveV2ArchivedPhoto(root: string, card: V2Card, photo: V2Card["photos"][number]) {
  if(!card.photos.some(p=>p.path===photo.path&&p.hash===photo.hash&&p.side===photo.side))throw Error("Photo is not owned by this capture");
  if(card.draftMergeReceipt){
    if(card.draftMergeReceipt.evidence.path.replaceAll('\\','/')!==`artifacts/card-processing-v2/draft-merges/${card.draftMergeReceipt.operationId}.json`)throw Error('Exact merge operation evidence path required');
    const r=card.draftMergeReceipt,bytes=await fs.readFile(path.join(root,r.evidence.path));
    if(hash(bytes)!==r.evidence.sha256||r.captureId!==card.captureId||r.survivorDraftId!==card.draftId)throw Error('Merged archive receipt changed');
    const operation=await(await import('./card-processing-v2-draft-merge-store.ts')).readV2DraftMerge(root,r.operationId);
    if(operation.stage!=='complete'||operation.plan.survivorDraftId!==card.draftId||!operation.plan.newCaptures.some(c=>c.cardId===card.id&&c.captureId===card.captureId))throw Error('Completed exact merged capture receipt required');
    const file=r.files.find(f=>f.source===photo.path&&f.hash===photo.hash&&f.side===photo.side);if(!file)throw Error('Merged original binding missing');
    const cfg=await readV2Config(root),base=await fs.realpath(path.join(cfg.folder,'Drafted')),actual=await fs.realpath(file.destination);inside(base,actual);
    if(path.dirname(file.destination)!==path.join(base,card.draftId!))throw Error('Merged destination outside exact survivor');await checked(actual,photo.hash);return actual;
  }
  const inventory=card.inventoryArchive;
  if(inventory){
    if(inventory.captureId!==card.captureId||inventory.sku!==card.sku||inventory.draftId!==card.draftId)throw Error("Inventory archive binding mismatch");
    const file=inventory.files.find(f=>f.original===path.resolve(photo.path)&&f.hash===photo.hash&&f.side===photo.side);if(!file)throw Error("Inventory archive photo binding missing");
    const cfg=await readV2Config(root),base=await fs.realpath(path.join(cfg.folder,inventory.disposition==='sold'?'Sold':'Listed')),actual=await fs.realpath(file.destination).catch(()=>null);
    if(actual){inside(base,actual);if(path.dirname(file.destination)!==path.join(base,inventory.itemId))throw Error("Inventory destination outside exact item");await checked(file.destination,photo.hash);return file.destination;}
    if(inventory.status==='moved')throw Error("Moved inventory photo missing");
  }
  const archive=card.draftArchive;
  if(!archive||archive.status!=="moved")return photo.path;
  if(archive.captureId!==card.captureId||archive.draftId!==card.draftId)throw Error("Archived capture binding mismatch");
  const file=archive.files.find(f=>f.source===path.resolve(photo.path)&&f.hash===photo.hash&&f.side===photo.side);if(!file)throw Error("Archived photo binding missing");
  const cfg=await readV2Config(root),base=await fs.realpath(path.join(cfg.folder,"Drafted")),actual=await fs.realpath(file.destination);inside(base,actual);
  if(path.dirname(file.destination)!==path.join(base,archive.draftId))throw Error("Archived destination outside exact draft");await checked(file.destination,photo.hash);return file.destination;
}
/** Post-operation integration: a corrupt archive authority must not erase a successful review checkpoint. */
export async function recoverV2DraftArchivesAfterOperation(root: string) {
  try{return await recoverV2DraftArchives(root);}catch{await withV2State(s=>{const message="Draft photo archive recovery requires reconciliation; original capture records and pricing are preserved.";if(!s.notices.includes(message))s.notices.push(message);},root);return [{cardId:"",status:"held"}];}
}

export type V2BatchArchiveOptions={mode:'batch-checkpoints-v1';afterCheckpoint?:(phase:'planned'|'copied'|'moved')=>Promise<void>};
/** Explicit opt-in for future runs. Existing callers retain the legacy path.
 * The observer is for crash/recovery fixtures; throwing leaves the last durable
 * phase intact and never replays an external effect (there are none here).
 */
export async function archiveV2DraftPhotos(root:string,cardIds:string[],authority:V2DraftArchiveAuthority,options?:V2BatchArchiveOptions){return measureV2(root,"photo-archive",()=>options?.mode==='batch-checkpoints-v1'&&cardIds.length>1?archiveV2DraftPhotosBatchLocal(root,cardIds,authority,options):archiveV2DraftPhotosTimedLocal(root,cardIds,authority),{cardIds});}

/** Same per-copy guards and copy/hash/checkpoint/unlink protocol, with three
 * bounded state commits instead of three full-state commits for every copy.
 * Frozen submissions, old archives, source identity and original paths survive.
 */
async function archiveV2DraftPhotosBatchLocal(root:string,cardIds:string[],rawAuthority:V2DraftArchiveAuthority,options:V2BatchArchiveOptions){
 if(!cardIds.length||cardIds.length>20||new Set(cardIds).size!==cardIds.length)throw Error('Bounded unique archive scope required');
 const authority=await verifyAuthority(root,rawAuthority),release=await acquireV2Lock('worker',root);
 type Archive=NonNullable<V2Card['draftArchive']>;
 type Plan={card:V2Card;binding:string;submissionKey:string;submissionHash:string;files:Archive['files'];receipt?:Archive;failed:boolean;moved:boolean};
 const plans:Plan[]=[],results=new Map<string,string>(),preflightHeld=new Map<string,Archive>();
 const cardBinding=(c:V2Card)=>digest({...c,draftArchive:undefined});
 const error='Archive stopped: original, destination, authority or ownership requires reconciliation';
 const markHeld=(s:V2State,p:Plan)=>{const a=s.cards[p.card.id]?.draftArchive;if(a&&a.status!=='moved'&&a.captureId===p.card.captureId&&a.draftId===p.card.draftId&&digest(a.files)===digest(p.files)){a.status='held';a.error=error;a.updatedAt=now();p.receipt=structuredClone(a);}};
 const assertCurrent=(s:V2State,p:Plan)=>{const c=s.cards[p.card.id];if(!c||cardBinding(c)!==p.binding||!s.submissions[p.submissionKey]||digest(s.submissions[p.submissionKey])!==p.submissionHash||digest(c.draftArchive??null)!==digest(p.receipt??null))throw Error('Archive phase ownership changed');eligible(c,s.submissions);};
 try{
  const authorityFile=path.join(v2Dir(root),'draft-archive-authority.json'),temporary=`${authorityFile}.${randomUUID()}.tmp`;
  await fs.mkdir(v2Dir(root),{recursive:true});const authorityHandle=await fs.open(temporary,'wx');try{await authorityHandle.writeFile(JSON.stringify(authority));await authorityHandle.sync();}finally{await authorityHandle.close();}await fs.rename(temporary,authorityFile);
  const cfg=await readV2Config(root),sourceRoot=await fs.realpath(cfg.folder),archiveRoot=path.join(sourceRoot,'Drafted'),transfers=await readV2ResetTransfers(root),snapshot=await readV2State(root);
  await fs.mkdir(archiveRoot,{recursive:true});inside(sourceRoot,await fs.realpath(archiveRoot));if((await fs.lstat(archiveRoot)).isSymbolicLink())throw Error('Archive root cannot be a symbolic link');
  for(const cardId of cardIds){
   const c=snapshot.cards[cardId];
   try{
    if(!c)throw Error('Card missing');eligible(c,snapshot.submissions);
    if(Object.values(snapshot.cards).some(other=>other.id!==c.id&&other.photos.some(p=>c.photos.some(own=>own.path===p.path||own.hash===p.hash))))throw Error('Original ownership overlaps another card');
    const directory=path.join(archiveRoot,c.draftId!);await fs.mkdir(directory,{recursive:true});inside(archiveRoot,await fs.realpath(directory));if((await fs.lstat(directory)).isSymbolicLink())throw Error('Archive directory cannot be a symbolic link');
    const files=c.photos.map(p=>({source:path.resolve(p.path),destination:path.join(directory,`${p.side}-${p.hash}${path.extname(p.path).toLowerCase()}`),hash:p.hash,side:p.side}));
    const transferred=c.resetTransfer?transfers.receipts.find(r=>r.resetId===c.resetTransfer!.resetId)?.pairs.find(p=>p.legacyCardId===c.resetTransfer!.legacyCardId):undefined;
    const transferBound=!!transferred&&!transferred.guards.hardHolds.length&&!transferred.guards.positiveDispositions.length&&transferred.photos.length===c.photos.length&&c.photos.every(p=>transferred.photos.some(q=>q.side===p.side&&path.resolve(q.path).toLowerCase()===path.resolve(p.path).toLowerCase()&&q.sha256.toLowerCase()===p.hash))&&transfers.transfers[transferred.legacyCardId]?.receipt===c.resetTransfer?.receipt;
    const readyBound=c.readyBatch?!!await(await import('./card-processing-v2-ready-batches.ts')).assertV2ReadyCardOriginals(root,c):false;
    for(const f of files){if(path.dirname(f.source)!==sourceRoot&&!transferBound&&!readyBound)throw Error('Original is outside top-level configured scan folder or exact committed transfer/ready batch');if(path.resolve(await fs.realpath(path.dirname(f.source))).toLowerCase()!==path.dirname(f.source).toLowerCase())throw Error('Original parent is a redirected source');inside(directory,f.destination);}
    if(c.draftArchive&&(c.draftArchive.captureId!==c.captureId||c.draftArchive.draftId!==c.draftId||digest(c.draftArchive.files)!==digest(files)))throw Error('Existing archive binding changed');
    for(const f of files){const bytes=await checked(f.source,f.hash,true);if(!bytes&&(!c.draftArchive||!await checked(f.destination,f.hash,true)))throw Error('Original missing before archive plan');}
    if(c.draftArchive?.status==='moved'){for(const f of files)await checked(f.destination,f.hash);results.set(cardId,'moved');continue;}
    const sub=Object.values(snapshot.submissions).find(s=>s.draftId===c.draftId&&s.payload.captureIds.includes(c.captureId))!;
    plans.push({card:c,binding:cardBinding(c),submissionKey:sub.key,submissionHash:digest(sub),files,receipt:c.draftArchive?structuredClone(c.draftArchive):undefined,failed:false,moved:false});
   }catch{results.set(cardId,'held');if(c?.draftArchive&&c.draftArchive.status!=='moved')preflightHeld.set(cardId,structuredClone(c.draftArchive));}
  }
  if(!plans.length&&!preflightHeld.size)return cardIds.map(cardId=>({cardId,status:results.get(cardId)??'held'}));
  await withV2State(s=>{
   for(const[cardId,prior]of Array.from(preflightHeld)){const current=s.cards[cardId]?.draftArchive;if(current&&current.status!=='moved'&&digest(current)===digest(prior)){current.status='held';current.error=error;current.updatedAt=now();}}
   for(const p of plans){try{assertCurrent(s,p);const receipt:Archive={status:'planned',instructionId:authority.instructionId,authority:authority.evidence,draftId:p.card.draftId!,captureId:p.card.captureId,files:p.files,updatedAt:now()};s.cards[p.card.id].draftArchive=receipt;p.receipt=structuredClone(receipt);}catch{p.failed=true;results.set(p.card.id,'held');markHeld(s,p);}}
  },root);
  await options.afterCheckpoint?.('planned');
  for(const p of plans.filter(p=>!p.failed))try{for(const f of p.files){const bytes=await checked(f.source,f.hash,true);if(bytes){try{const h=await fs.open(f.destination,'wx');try{await h.writeFile(bytes);await h.sync();}finally{await h.close();}}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}}await checked(f.destination,f.hash);}}catch{p.failed=true;results.set(p.card.id,'held');}
  await withV2State(s=>{for(const p of plans){if(p.failed){markHeld(s,p);continue;}try{assertCurrent(s,p);const a=s.cards[p.card.id].draftArchive!;a.status='copied';a.updatedAt=now();p.receipt=structuredClone(a);}catch{p.failed=true;results.set(p.card.id,'held');markHeld(s,p);}}},root);
  await options.afterCheckpoint?.('copied');
  const beforeRemoval=await readV2State(root);
  for(const p of plans.filter(p=>!p.failed))try{
   assertCurrent(beforeRemoval,p);
   // Both destination copies are checked before any source removal. The copied
   // receipt is already durable, so any interruption can resume without guessing.
   for(const f of p.files)await checked(f.destination,f.hash);
   for(const f of p.files)if(await checked(f.source,f.hash,true))await fs.unlink(f.source);
   p.moved=true;
  }catch{p.failed=true;results.set(p.card.id,'held');}
  await withV2State(s=>{for(const p of plans){if(p.failed||!p.moved){markHeld(s,p);continue;}try{assertCurrent(s,p);const a=s.cards[p.card.id].draftArchive!;a.status='moved';a.updatedAt=now();delete a.error;event(s,'draft-photos-archived',`Original pair moved to Drafted/${p.card.draftId}`,p.card.id);results.set(p.card.id,'moved');}catch{p.failed=true;results.set(p.card.id,'held');markHeld(s,p);}}},root);
  await options.afterCheckpoint?.('moved');
  return cardIds.map(cardId=>({cardId,status:results.get(cardId)??'held'}));
 }finally{await release();}
}
