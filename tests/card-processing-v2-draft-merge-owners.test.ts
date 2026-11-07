import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {digest,emptyV2State,type V2Card} from '../lib/card-processing-v2.ts';
import {loadV2DraftMergeOwners} from '../lib/card-processing-v2-draft-merge-owners.ts';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
async function fixture(run:(f:any)=>Promise<void>){const root=await fs.mkdtemp(path.join(os.tmpdir(),'v2-owner-view-'));try{
 const folder=path.join(root,'artifacts/card-processing-v2/draft-merges');await fs.mkdir(folder,{recursive:true});const now=new Date().toISOString(),proof={path:'artifacts/proof.json',sha256:sha('proof')};
 const photos=(n:string)=>[{path:path.join(root,n+'-front.jpg'),hash:sha(n+'-front'),side:'front' as const},{path:path.join(root,n+'-back.jpg'),hash:sha(n+'-back'),side:'back' as const}];
 const card=(n:string,draftId:string):V2Card=>({id:n,sku:n,captureId:sha(n),photos:photos(n),stage:'prepared',condition:'Near mint or better',draftId,title:n,description:'',descriptionSource:'factual',issues:[],nextAction:'Retained historical receipt',createdAt:now,updatedAt:now});
 const state=emptyV2State();state.cards.a=card('a','101');state.cards.b=card('b','102');state.cards.c=card('c','101');
 const plan={version:1 as const,seller:'imaydit58' as const,scanRoot:path.join(root,'scans'),survivorDraftId:'101',sources:[{draftId:'101',sku:'a',quantity:1,captureIds:[sha('a')]},{draftId:'102',sku:'b',quantity:1,captureIds:[sha('b')]}],newCaptures:[{cardId:'c',captureId:sha('c'),photos:photos('c')}],survivorProtectedHash:sha('protected'),authority:proof,snapshot:proof};
 const id=digest(plan),archives=photos('c').map(p=>({captureId:sha('c'),source:p.path,destination:path.join(root,'Drafted','101',path.basename(p.path)),hash:p.hash,side:p.side,status:'moved'}));
 const op={version:1,id,plan,targetQuantity:3,claim:{owner:'worker',token:randomUUID()},stage:'complete',createdAt:now,updatedAt:now,quantityEvidence:proof,deletionEvidence:proof,deletionRequestedIds:['102'],deletedDraftIds:['102'],archives,completedCaptureArchives:['a','b','c'].map(n=>({captureId:sha(n),files:photos(n)}))};
 const file=path.join(folder,id+'.json'),bytes=JSON.stringify(op,null,2);await fs.writeFile(file,bytes);const evidence={path:`artifacts/card-processing-v2/draft-merges/${id}.json`,sha256:sha(bytes)};
 state.cards.c.draftMergeReceipt={operationId:id,survivorDraftId:'101',captureId:sha('c'),observedAt:now,evidence,files:archives.map(p=>({source:p.source,destination:p.destination,hash:p.hash,side:p.side}))};
 await run({root,state,op,file,evidence});
}finally{await fs.rm(root,{recursive:true,force:true});}}
test('current ownership maps deleted donor and attached new copy to survivor without changing history',()=>fixture(async f=>{const before=structuredClone(f.state),owners=await loadV2DraftMergeOwners(f.root,f.state);assert.equal(owners.a.survivorDraftId,'101');assert.equal(owners.b.survivorDraftId,'101');assert.equal(owners.c.survivorDraftId,'101');assert.deepEqual(owners.b.evidence,f.evidence);assert.deepEqual(f.state,before);assert.equal(f.state.cards.b.draftId,'102');}));
test('foreign historical capture ownership and incomplete deletion do not produce a false current owner',()=>fixture(async f=>{f.state.cards.b.draftId='999';await assert.rejects(loadV2DraftMergeOwners(f.root,f.state),/historical or completed current owner/);f.state.cards.b.draftId='102';f.op.deletedDraftIds=[];await fs.writeFile(f.file,JSON.stringify(f.op));await assert.rejects(loadV2DraftMergeOwners(f.root,f.state),/Only complete exact/);}));
test('new card is not marked complete until receipt attachment; missing registry is read-only empty',()=>fixture(async f=>{delete f.state.cards.c.draftId;delete f.state.cards.c.draftMergeReceipt;const owners=await loadV2DraftMergeOwners(f.root,f.state);assert.equal(owners.c,undefined);assert.equal(owners.b.survivorDraftId,'101');await fs.rm(path.dirname(f.file),{recursive:true});assert.deepEqual(await loadV2DraftMergeOwners(f.root,f.state),{});}));
