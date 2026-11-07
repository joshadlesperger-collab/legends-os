import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {listV2Candidates,resolveV2Selection,v2SelectionSchema,candidateId} from './card-processing-v2-selection.ts';
import {listV2ProcessingBatches} from './card-processing-v2-processing-batches.ts';
import {digest,type V2Card} from './card-processing-v2.ts';
import {readV2State} from './card-processing-v2-store.ts';
import {resolveV2ArchivedPhoto} from './card-processing-v2-draft-archive.ts';
const pairKey=(photos:Array<{hash:string;side:string}>)=>digest(photos.map(p=>p.hash).sort());
async function retained(root:string,file:string,max:number){const requested=path.resolve(root,file),st=await fs.lstat(requested);if(!st.isFile()||st.isSymbolicLink()||st.size>max)throw Error('Bounded original selection artifact required');const base=await fs.realpath(path.join(root,'artifacts')),actual=await fs.realpath(requested),relative=path.relative(base,actual);if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw Error('Original selection scope escaped artifacts');return JSON.parse(await fs.readFile(actual,'utf8'));}
async function unchangedPhoto(root:string,photo:V2Card['photos'][number],card:V2Card|undefined){const file=card?await resolveV2ArchivedPhoto(root,card,photo):photo.path;let st;try{st=await fs.lstat(file);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')throw Error('Accepted original is missing without a verified archive');throw e;}if(!st.isFile()||st.isSymbolicLink()||st.size>35000000||path.resolve(await fs.realpath(file)).toLowerCase()!==path.resolve(file).toLowerCase())throw Error('Accepted original path changed');const bytes=await fs.readFile(file),after=await fs.lstat(file);if(st.size!==after.size||st.mtimeMs!==after.mtimeMs||after.isSymbolicLink()||createHash('sha256').update(bytes).digest('hex')!==photo.hash)throw Error('Accepted original photo hashes changed');}
/** Resume refreshes a token, never accepted membership, source scope or bytes.
 * A disappeared candidate is not completion; exact verified archives may supply
 * its original bytes. No inventory, clock, identity or upload record is changed. */
export async function resolveV2BackgroundRemainingSelection(root:string,batchId:string,selectionFile:string){
 const batch=(await listV2ProcessingBatches(root)).find(b=>b.jobId===batchId);if(!batch||batch.status==='failed')throw Error('Original accepted batch missing');
 const original=v2SelectionSchema.parse(await retained(root,selectionFile,262144));
 if(original.mode!=='selected'||!original.candidateIds||new Set(original.candidateIds).size!==original.candidateIds.length||new Set(batch.captures.map(c=>c.candidateId)).size!==batch.captures.length||original.candidateIds.length!==batch.captures.length||batch.captures.some(c=>!original.candidateIds!.includes(c.candidateId)))throw Error('Original selected batch membership changed');
 const saved=await retained(root,`artifacts/card-processing-v2/selections/${original.token}.json`,2000000);
 if(saved.token!==original.token||digest(saved.content)!==original.token||saved.content.sourceTransferId!==original.sourceTransferId||saved.content.readyBatchId!==original.readyBatchId||digest(saved.content.readyBatchIds??null)!==digest(original.readyBatchIds??null)||digest(batch.readyBatchIds??null)!==digest(original.readyBatchIds??null)||!Array.isArray(saved.content.candidates))throw Error('Original selection token or source-transfer scope changed');
 const state=await readV2State(root);
 for(const accepted of batch.captures){const source=saved.content.candidates.filter((c:{id:string})=>c.id===accepted.candidateId);if(source.length!==1||candidateId(source[0].photos)!==accepted.candidateId||pairKey(source[0].photos)!==pairKey(accepted.photos))throw Error('Original selected photo hashes or membership changed');
  const matches=Object.values(state.cards).filter(c=>pairKey(c.photos)===pairKey(accepted.photos));if(matches.length>1||accepted.cardId&&(matches.length!==1||matches[0].id!==accepted.cardId))throw Error('Original accepted capture owner changed');const card=matches[0];
  for(const photo of source[0].photos as V2Card['photos']){if(card&&!card.photos.some(p=>p.hash===photo.hash&&path.resolve(p.path).toLowerCase()===path.resolve(photo.path).toLowerCase()))throw Error('Original accepted photo ownership changed');await unchangedPhoto(root,card?card.photos.find(p=>p.hash===photo.hash&&path.resolve(p.path).toLowerCase()===path.resolve(photo.path).toLowerCase())!:photo,card);}
 }
 const current=await listV2Candidates(root,original.sourceTransferId,original.readyBatchId,original.readyBatchIds),ids=current.candidates.filter(c=>c.eligible&&original.candidateIds!.includes(c.id)).map(c=>c.id);
 for(const accepted of batch.captures)if(!current.candidates.some(c=>c.id===accepted.candidateId)){const cards=Object.values(state.cards).filter(c=>pairKey(c.photos)===pairKey(accepted.photos));if(cards.length!==1||!(cards[0].draftId||cards[0].inventoryArchive||cards[0].draftArchive||cards[0].issues.length||Object.values(state.submissions).some(s=>s.payload.captureIds.includes(cards[0].captureId))))throw Error('Accepted original is missing from the remaining selection without a retained outcome');}
 if(!ids.length)return null;
 const raw={mode:'selected' as const,token:current.token,candidateIds:ids,...(original.sourceTransferId?{sourceTransferId:original.sourceTransferId}:{}),...(original.readyBatchId?{readyBatchId:original.readyBatchId}:{}),...(original.readyBatchIds?{readyBatchIds:original.readyBatchIds}:{})},selected=await resolveV2Selection(root,raw);
 for(const capture of selected.captures){const accepted=batch.captures.find(c=>c.candidateId===capture.candidateId);if(!accepted||pairKey(capture.photos)!==pairKey(accepted.photos))throw Error('Original selected photo hashes changed');}
 return{raw,selected};
}
