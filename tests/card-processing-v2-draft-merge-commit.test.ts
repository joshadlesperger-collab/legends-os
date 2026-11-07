import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {withV2State,readV2State} from '../lib/card-processing-v2-store.ts';
import {type V2Card} from '../lib/card-processing-v2.ts';
import {beginV2DraftMerge,requestV2MergeQuantity,recordV2MergeQuantity,archiveNewV2MergedPhotos,requestV2MergeDeletion,completeV2DraftMerge} from '../lib/card-processing-v2-draft-merge-store.ts';
import {commitV2DraftMergeCards} from '../lib/card-processing-v2-draft-merge-commit.ts';
const sha=(x:string)=>createHash('sha256').update(x).digest('hex');
async function fixture(run:(f:any)=>Promise<void>){const root=await fs.mkdtemp(path.join(os.tmpdir(),'v2-merge-commit-')),scan=path.join(root,'scans');await fs.mkdir(path.join(root,'artifacts'),{recursive:true});await fs.mkdir(scan);try{
 const proof='artifacts/proof.json';await fs.writeFile(path.join(root,proof),'scoped saved evidence fixture');const evidence={path:proof,sha256:sha('scoped saved evidence fixture')};
 const identity={name:'Buddy Hield',year:'2024-25',manufacturer:'Panini',product:'Prizm Basketball',number:'200',categoryId:'261328' as const,language:'English',variant:'Red Sparkle Prizms',artwork:'Player pose',sportOrGame:'Basketball',team:'Golden State Warriors',serial:'',graded:false,damage:false,specifics:{}};
 const photos=async(folder:string,prefix:string)=>{await fs.mkdir(folder,{recursive:true});return Promise.all((['front','back'] as const).map(async side=>{const file=path.join(folder,prefix+'-'+side+'.jpg'),bytes=prefix+side;await fs.writeFile(file,bytes);return{path:file,hash:sha(bytes),side};}));};
 const now=new Date().toISOString(),base={stage:'identified' as const,identity,condition:'Near mint or better' as const,title:'',description:'',descriptionSource:'factual' as const,issues:[],nextAction:'Prepare',createdAt:now,updatedAt:now};
 const old:V2Card={...base,id:'old',sku:'oldsku',captureId:sha('old'),photos:await photos(path.join(scan,'Drafted','101'),'old'),draftId:'101',stage:'prepared'},fresh:V2Card={...base,id:'new',sku:'newsku',captureId:sha('new'),photos:await photos(scan,'new')};
 await withV2State(s=>{s.cards.old=old;s.cards.new=fresh;},root);
 const op=await beginV2DraftMerge(root,{version:1,seller:'imaydit58',scanRoot:scan,survivorDraftId:'101',sources:[{draftId:'101',sku:'oldsku',quantity:1,captureIds:[old.captureId]}],newCaptures:[{cardId:'new',captureId:fresh.captureId,photos:fresh.photos}],survivorProtectedHash:sha('protected'),authority:evidence,snapshot:evidence},'worker');
 await run({root,scan,old,fresh,op,evidence,complete:async()=>{await requestV2MergeQuantity(root,op.id,op.claim);await recordV2MergeQuantity(root,op.id,op.claim,{draftId:'101',quantity:2,protectedHash:sha('protected'),evidence});const moved=await archiveNewV2MergedPhotos(root,op.id,op.claim);await requestV2MergeDeletion(root,op.id,op.claim);return completeV2DraftMerge(root,op.id,op.claim,[{captureId:old.captureId,files:old.photos},{captureId:fresh.captureId,files:moved.archives.map(p=>({path:p.destination,hash:p.hash,side:p.side}))}]);}});
}finally{await fs.rm(root,{recursive:true,force:true});}}
test('completed merge commits only new-card overlay, preserves old records and retries without a state write',()=>fixture(async f=>{
 await assert.rejects(commitV2DraftMergeCards(f.root,f.op.id,f.op.claim),/Complete saved/);await f.complete();
 const before=await readV2State(f.root),result=await commitV2DraftMergeCards(f.root,f.op.id,f.op.claim),after=await readV2State(f.root);
 assert.deepEqual(result.committedCardIds,['new']);assert.deepEqual(after.cards.old,before.cards.old);assert.deepEqual(after.submissions,before.submissions);assert.equal(after.cards.new.draftId,'101');assert.equal(after.cards.new.stage,'prepared');
 assert.equal(after.cards.new.nonpriceVerification,undefined);assert.equal(after.cards.new.verification,undefined);assert.equal(after.cards.new.draftArchive,undefined);
 const receipt=(after.cards.new as V2Card&{draftMergeReceipt:{operationId:string;files:any[]}}).draftMergeReceipt;assert.equal(receipt.operationId,f.op.id);assert.equal(receipt.files.length,2);
 const bytes=await fs.readFile(path.join(f.root,'artifacts/card-processing-v2/state.json'),'utf8');const retry=await commitV2DraftMergeCards(f.root,f.op.id,f.op.claim);assert.equal(retry.alreadyCommitted,true);assert.equal(await fs.readFile(path.join(f.root,'artifacts/card-processing-v2/state.json'),'utf8'),bytes);
}));
test('foreign ownership and changed catalog/photo facts cannot attach a merge receipt',()=>fixture(async f=>{
 await f.complete();await assert.rejects(commitV2DraftMergeCards(f.root,f.op.id,{owner:'foreign',token:f.op.claim.token}),/owner/);
 await withV2State(s=>{s.cards.new.identity!.variant='Blue Sparkle Prizms';},f.root);await assert.rejects(commitV2DraftMergeCards(f.root,f.op.id,f.op.claim),/catalog identity/);assert.equal((await readV2State(f.root)).cards.new.draftId,undefined);
}));
test('changed archived bytes block local attachment',()=>fixture(async f=>{
 const complete=await f.complete();await fs.appendFile(complete.archives[0].destination,'changed');await assert.rejects(commitV2DraftMergeCards(f.root,f.op.id,f.op.claim),/archive changed/);assert.equal((await readV2State(f.root)).cards.new.draftId,undefined);
}));
test('newly rebound draft ownership cannot be overwritten by merge attachment',()=>fixture(async f=>{
 await f.complete();await withV2State(s=>{s.cards.new.draftId='999';},f.root);await assert.rejects(commitV2DraftMergeCards(f.root,f.op.id,f.op.claim),/frozen or terminal ownership/);assert.equal((await readV2State(f.root)).cards.new.draftId,'999');
}));
