import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {digest,type V2Card,type V2Payload} from '../lib/card-processing-v2.ts';
import {readV2State,withV2State,v2Dir} from '../lib/card-processing-v2-store.ts';
import {archiveV2DraftPhotos,resolveV2ArchivedPhoto,type V2DraftArchiveAuthority} from '../lib/card-processing-v2-draft-archive.ts';
const sha=(b:string)=>createHash('sha256').update(b).digest('hex'),mode={mode:'batch-checkpoints-v1' as const};
async function fixture(run:(root:string,cards:V2Card[],authority:V2DraftArchiveAuthority)=>Promise<void>,count=20){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'v2-batch-archive-')),folder=path.join(root,'scans'),at=new Date().toISOString(),cards:V2Card[]=[],payloads:V2Payload[]=[];
 try{
  await fs.mkdir(folder);
  for(let n=0;n<count;n++){
   const id='card-'+n,draftId=String(100000+n),photos:V2Card['photos']=[];
   for(const side of ['front','back'] as const){const value=id+'-'+side,file=path.join(folder,value+'.jpg');await fs.writeFile(file,value);photos.push({path:file,hash:sha(value),side});}
   const c:V2Card={id,sku:id,captureId:digest(id),photos,stage:'prepared',condition:'Near mint or better',groupId:digest('group-'+id),draftId,title:'Player '+n,description:'Factual original',descriptionSource:'factual',issues:[],nextAction:'Archive',createdAt:at,updatedAt:at,nonpriceVerification:{scope:'non-price-fields',observedAt:at,evidence:'artifacts/saved-review#original',draftId,pricing:'deferred-preserved'},identity:{name:'Player '+n,year:'2025',manufacturer:'Panini',product:'Prizm',number:String(n),categoryId:'261328',language:'English',variant:'Blue',artwork:'Player pose',sportOrGame:'Basketball',team:'Team',serial:'',graded:false,damage:false,specifics:{}}};cards.push(c);
   payloads.push({sku:id,captureIds:[c.captureId],title:c.title,categoryId:'261328',specifics:{Sport:['Basketball']},quantity:1,photos:photos.map(p=>({hash:p.hash,url:'https://i.ebayimg.com/images/g/'+p.hash+'/s-l1600.jpg',expiresAt:at,upright:true})),conditionId:'4000',conditionDescriptorName:'Card Condition',conditionDescriptorValue:'400010',condition:c.condition,description:c.description,descriptionSource:'factual',pricing:'unpriced-grok-pending'});
  }
  await withV2State(s=>{for(let n=0;n<cards.length;n++){const c=cards[n],key=digest('intent-'+c.id);s.cards[c.id]=c;s.submissions[key]={key,groupId:c.groupId!,payload:payloads[n],status:'submitted',draftId:c.draftId,at};}},root);
  await fs.writeFile(path.join(v2Dir(root),'config.json'),JSON.stringify({folder}));
  const instruction={id:'batch-archive-authority',text:'Preserve originals and archive exact verified drafts',taskIds:['v2-draft-archive-enforcement-20261103']},bytes=JSON.stringify({instruction}),relative='artifacts/batch-authority.json';await fs.writeFile(path.join(root,relative),bytes);await fs.mkdir(path.join(root,'artifacts/engineering-mission'));await fs.writeFile(path.join(root,'artifacts/engineering-mission/work-queue.json'),JSON.stringify({instructions:[instruction]}));
  await run(root,cards,{instructionId:instruction.id,evidence:{path:relative,sha256:sha(bytes)}});
 }finally{await fs.rm(root,{recursive:true,force:true});}
}
test('twenty physical archives use exactly three state commits and preserve frozen history; completed retry writes none',()=>fixture(async(root,cards,a)=>{
 const before=await readV2State(root),phases:string[]=[],result=await archiveV2DraftPhotos(root,cards.map(c=>c.id),a,{...mode,afterCheckpoint:async phase=>{phases.push(phase);}}),after=await readV2State(root);
 assert.equal(after.revision-before.revision,3);assert.deepEqual(phases,['planned','copied','moved']);assert.ok(result.every(r=>r.status==='moved'));assert.deepEqual(after.submissions,before.submissions);
 for(const c of cards){assert.deepEqual(after.cards[c.id].photos,c.photos);for(const p of c.photos){await assert.rejects(fs.stat(p.path),{code:'ENOENT'});assert.equal(sha(await fs.readFile(await resolveV2ArchivedPhoto(root,after.cards[c.id],p),'utf8')),p.hash);}}
 const archives=cards.map(c=>after.cards[c.id].draftArchive),events=after.events;
 await archiveV2DraftPhotos(root,cards.map(c=>c.id),a,mode);const retry=await readV2State(root);assert.equal(retry.revision,after.revision);assert.deepEqual(retry.events,events);assert.deepEqual(cards.map(c=>retry.cards[c.id].draftArchive),archives);
}));
for(const phase of ['planned','copied','moved'] as const)test('batch archive recovers exact originals after interruption at '+phase,()=>fixture(async(root,cards,a)=>{
 await assert.rejects(archiveV2DraftPhotos(root,cards.map(c=>c.id),a,{...mode,afterCheckpoint:async p=>{if(p===phase)throw Error('synthetic interruption');}}),/synthetic interruption/);
 const checkpoint=await readV2State(root);assert.ok(cards.every(c=>checkpoint.cards[c.id].draftArchive?.status===phase));
 if(phase==='copied')await fs.unlink(cards[0].photos[0].path); // Simulate crash after one unlink, before moved commit.
 const revision=checkpoint.revision,result=await archiveV2DraftPhotos(root,cards.map(c=>c.id),a,mode),done=await readV2State(root);assert.ok(result.every(r=>r.status==='moved'));assert.equal(done.revision-revision,phase==='moved'?0:3);
 for(const c of cards)for(const p of c.photos){await assert.rejects(fs.stat(p.path),{code:'ENOENT'});assert.equal(sha(await fs.readFile(await resolveV2ArchivedPhoto(root,done.cards[c.id],p),'utf8')),p.hash);}
},3));
test('changed original holds only that physical card; independent valid copies complete in three commits',()=>fixture(async(root,cards,a)=>{
 await fs.writeFile(cards[0].photos[1].path,'changed');const before=await readV2State(root),result=await archiveV2DraftPhotos(root,cards.map(c=>c.id),a,mode),after=await readV2State(root);
 assert.equal(after.revision-before.revision,3);assert.equal(result[0].status,'held');assert.ok(result.slice(1).every(r=>r.status==='moved'));assert.equal(after.cards[cards[0].id].draftArchive,undefined);for(const p of cards[0].photos)await fs.stat(p.path);
},3));
test('foreign destination holds one pair without deleting originals or foreign bytes; others archive',()=>fixture(async(root,cards,a)=>{
 const c=cards[0],dir=path.join(path.dirname(c.photos[0].path),'Drafted',c.draftId!),dest=path.join(dir,'front-'+c.photos[0].hash+'.jpg');await fs.mkdir(dir,{recursive:true});await fs.writeFile(dest,'foreign');
 const result=await archiveV2DraftPhotos(root,cards.map(c=>c.id),a,mode),state=await readV2State(root);assert.equal(result[0].status,'held');assert.equal(state.cards[c.id].draftArchive?.status,'held');assert.equal(await fs.readFile(dest,'utf8'),'foreign');for(const p of c.photos)await fs.stat(p.path);assert.ok(result.slice(1).every(r=>r.status==='moved'));
},3));
for(const phase of ['planned','copied'] as const)test('ownership mutation after '+phase+' is held before source removal and independent copies progress',()=>fixture(async(root,cards,a)=>{
 const c=cards[0],result=await archiveV2DraftPhotos(root,cards.map(c=>c.id),a,{...mode,afterCheckpoint:async p=>{if(p===phase)await withV2State(s=>{s.cards[c.id].title='Changed by independent owner';},root);}}),state=await readV2State(root);
 assert.equal(result[0].status,'held');assert.equal(state.cards[c.id].title,'Changed by independent owner');assert.equal(state.cards[c.id].draftArchive?.status,'held');for(const p of c.photos)await fs.stat(p.path);assert.ok(result.slice(1).every(r=>r.status==='moved'));
},3));
test('forged authority rejects before any mutation or source deletion',()=>fixture(async(root,cards,a)=>{
 const before=await readV2State(root);await assert.rejects(archiveV2DraftPhotos(root,cards.map(c=>c.id),{...a,evidence:{...a.evidence,sha256:digest('forged')}},mode),/hash/);assert.equal((await readV2State(root)).revision,before.revision);for(const c of cards)for(const p of c.photos)await fs.stat(p.path);
},3));
