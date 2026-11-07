import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {digest,type V2Card,type V2Payload} from '../lib/card-processing-v2.ts';
import {readV2State,withV2State,v2Dir} from '../lib/card-processing-v2-store.ts';
import {archiveV2ListedPhotos,parseV2ActiveGrid,parseV2SellerApiInventoryMatch} from '../lib/card-processing-v2-listed-archive.ts';

const sku='V2-123456789012345678901234',itemId='128173822784',soldSource='https://api.ebay.com/sell/fulfillment/v1/order',activeSource='Trading GetMyeBaySelling ActiveList,200 entries per page';
const sha=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
type Ref={path:string;sha256:string};
async function fixture(fn:(root:string,context:any)=>Promise<void>){const root=await fs.mkdtemp(path.join(os.tmpdir(),'v2-api-inventory-archive-')),folder=path.join(root,'scans'),at=new Date().toISOString();try{
 await fs.mkdir(folder);const photos:V2Card['photos']=[];for(const side of ['front','back']as const){const file=path.join(folder,side+'.jpg'),bytes=Buffer.from('untouched-'+side);await fs.writeFile(file,bytes);photos.push({path:file,hash:sha(bytes),side});}
 const card:V2Card={id:'api-card',sku,captureId:digest('api-capture'),photos,stage:'prepared',condition:'Near mint or better',groupId:'api-group',draftId:'5430000000011',title:'2025 Topps Chrome Synthetic Player #1 Blue 17/99',description:'Factual frozen description',descriptionSource:'factual',issues:[],nextAction:'Keep existing work',createdAt:at,updatedAt:at,identity:{name:'Synthetic Player',year:'2025',manufacturer:'Topps',product:'Chrome',number:'1',categoryId:'261328',language:'English',variant:'Blue',artwork:'Portrait',sportOrGame:'Baseball',team:'',serial:'17/99',graded:false,damage:false,specifics:{}}};
 const payload:V2Payload={sku,captureIds:[card.captureId],title:card.title,categoryId:'261328',specifics:{Sport:['Baseball']},quantity:1,photos:photos.map(p=>({hash:p.hash,url:`https://i.ebayimg.com/images/g/${p.hash}/s-l1600.jpg`,expiresAt:at,upright:true})),conditionId:'4000',conditionDescriptorName:'Card Condition',conditionDescriptorValue:'400010',condition:card.condition,description:card.description,descriptionSource:'factual',pricing:'unpriced-grok-pending'};
 await withV2State(s=>{s.cards[card.id]=card;s.submissions[digest('api-intent')]={key:digest('api-intent'),groupId:card.groupId!,payload,status:'submitted',draftId:card.draftId,at};s.calls.push({id:'settled-before-archive',cardId:card.id,key:digest('settled'),provider:'openai',model:'fixture',status:'settled',reservedMicros:20000,actualMicros:12000,at});},root);await fs.writeFile(path.join(v2Dir(root),'config.json'),JSON.stringify({folder}));
 const instruction={id:'api-archive-authority',text:'Move confirmed listed and sold photo pairs only; leave uncertain work and prices untouched',taskIds:['api-archive-fixture'],policyRefs:['v2-listed-photo-archive']};await fs.mkdir(path.join(root,'artifacts/engineering-mission'),{recursive:true});await fs.writeFile(path.join(root,'artifacts/engineering-mission/work-queue.json'),JSON.stringify({instructions:[instruction]}));
 const retain=async(body:unknown):Promise<Ref>=>{const relative='artifacts/evidence-'+randomUUID()+'.json',bytes=JSON.stringify(body);await fs.writeFile(path.join(root,relative),bytes);return{path:relative,sha256:sha(bytes)};};const authority={instructionId:instruction.id,evidence:await retain({instruction})};
 const make=async(disposition:'listed'|'sold'='listed',edit?:(parts:any)=>void)=>{
  const scope=disposition==='listed'?'active':'sold',observedAt=new Date().toISOString(),row={id:itemId,sku,title:card.title,text:[itemId,sku,card.title].join('\n'),skuAliases:[sku]},snapshot:any={scope,seller:'imaydit58',observedAt,complete:true,rows:[row]},provenance:any={kind:'official-read-only-inventory-api-projection',seller:'imaydit58',scope,startedAt:observedAt,observedAt,source:scope==='active'?activeSource:soldSource,coverage:scope==='active'?'all-current-active-listings':{from:new Date(Date.now()-86400000).toISOString(),to:observedAt,clockSkewMarginMs:60000},pages:1,sourceRows:1,uniqueItemRows:1,buyerFieldsRetained:false,priceFieldsRetained:false,listingWrites:0},soldProof:any={kind:'official-read-only-sold-disposition-projection',seller:'imaydit58',scope:'sold',observedAt,source:soldSource,complete:true,rows:[{itemId,sku,title:card.title,orderPaymentStatus:'PAID',orderFulfillmentStatus:'FULFILLED',cancelState:'NONE_REQUESTED'}]},claim:any={kind:'actual-seller-api-inventory-match',seller:'imaydit58',scope,observedAt,rows:[{itemId,sku,title:card.title}]};
  edit?.({snapshot,provenance,soldProof,claim});const snapshotRef=await retain(snapshot);provenance.snapshot=snapshotRef;claim.snapshot=snapshotRef;claim.provenance=await retain(provenance);if(disposition==='sold')claim.soldProof=await retain(soldProof);return{packet:{cardIds:[card.id],disposition,authority,observation:await retain(claim)},claim,snapshot,provenance,soldProof};
 };
 await fn(root,{card,payload,make,retain});
 }finally{const resolved=await fs.realpath(root),temp=await fs.realpath(os.tmpdir()),relative=path.relative(temp,resolved);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(resolved).startsWith('v2-api-inventory-archive-'));await fs.rm(resolved,{recursive:true,force:true,maxRetries:4,retryDelay:100});}}

test('fresh official active API projection archives exact originals without inventing native browser evidence or changing paid/listing work',()=>fixture(async(root,c)=>{
 const evidence=await c.make(),before=await readV2State(root);assert.throws(()=>parseV2ActiveGrid(evidence.claim));const parsed=await parseV2SellerApiInventoryMatch(root,evidence.claim,'listed');assert.equal(parsed.kind,'actual-seller-api-inventory-match');assert.equal(parsed.apiEvidence,true);
 assert.deepEqual(await archiveV2ListedPhotos(root,evidence.packet),[{cardId:c.card.id,status:'moved'}]);const after=await readV2State(root),card=after.cards[c.card.id];assert.deepEqual(after.calls,before.calls);assert.deepEqual(after.submissions,before.submissions);assert.deepEqual(card.photos,c.card.photos);assert.equal(card.inventoryArchive?.disposition,'listed');assert.equal(card.inventoryArchive?.observation.sha256,evidence.packet.observation.sha256);
 for(const archived of card.inventoryArchive!.files){assert.equal(path.basename(path.dirname(path.dirname(archived.destination))),'Listed');assert.equal(sha(await fs.readFile(archived.destination)),archived.hash);await assert.rejects(fs.stat(archived.source),{code:'ENOENT'});}const eventCount=after.events.length;await archiveV2ListedPhotos(root,evidence.packet);assert.equal((await readV2State(root)).events.length,eventCount);
}));

test('fresh paid fulfilled and explicitly noncancelled official order projection archives exact originals to Sold',()=>fixture(async(root,c)=>{const evidence=await c.make('sold');assert.deepEqual(await archiveV2ListedPhotos(root,evidence.packet),[{cardId:c.card.id,status:'moved'}]);const card=(await readV2State(root)).cards[c.card.id];assert.equal(card.inventoryArchive?.disposition,'sold');for(const archived of card.inventoryArchive!.files){assert.equal(path.basename(path.dirname(path.dirname(archived.destination))),'Sold');assert.equal(sha(await fs.readFile(archived.destination)),archived.hash);}}));

test('API archive rejects wrong primary SKU, title, item ID and alias-only matches before moving sources',()=>fixture(async(root,c)=>{
 for(const edit of [({claim}:any)=>{claim.rows[0].sku='V2-aaaaaaaaaaaaaaaaaaaaaaaa';},({claim}:any)=>{claim.rows[0].title+=' Different parallel';},({claim}:any)=>{claim.rows[0].itemId='999999999999';},({snapshot}:any)=>{snapshot.rows[0].sku='V2-bbbbbbbbbbbbbbbbbbbbbbbb';}]){const evidence=await c.make('listed',edit);await assert.rejects(archiveV2ListedPhotos(root,evidence.packet),/Exact actual API/);for(const photo of c.card.photos)assert.equal(sha(await fs.readFile(photo.path)),photo.hash);}
 assert.equal((await readV2State(root)).cards[c.card.id].inventoryArchive,undefined);
}));

test('API source title must equal frozen title exactly, while native-only normalization does not authorize API archival',()=>fixture(async(root,c)=>{const evidence=await c.make();await withV2State(s=>{Object.values(s.submissions)[0].payload.title='Different exact serial 18/99';},root);assert.deepEqual(await archiveV2ListedPhotos(root,evidence.packet),[{cardId:c.card.id,status:'held'}]);for(const photo of c.card.photos)assert.equal(sha(await fs.readFile(photo.path)),photo.hash);}));

test('stale, partial, foreign-seller, wrong endpoint, mismatched row counts and changed SHA-bound source cannot archive',()=>fixture(async(root,c)=>{
 const mutations=[({snapshot}:any)=>{snapshot.observedAt=new Date(Date.now()-3600001).toISOString();},({snapshot}:any)=>{snapshot.complete=false;},({snapshot}:any)=>{snapshot.seller='another-seller';},({provenance}:any)=>{provenance.source='Trading GetSellerList historical items';},({provenance}:any)=>{provenance.uniqueItemRows=2;},({provenance}:any)=>{provenance.scope='sold';}];
 for(const edit of mutations){const evidence=await c.make('listed',edit);await assert.rejects(archiveV2ListedPhotos(root,evidence.packet));for(const photo of c.card.photos)assert.equal(sha(await fs.readFile(photo.path)),photo.hash);}
 const changed=await c.make();await fs.appendFile(path.join(root,changed.claim.snapshot.path),' ');await assert.rejects(archiveV2ListedPhotos(root,changed.packet),/hash mismatch/);assert.equal((await readV2State(root)).cards[c.card.id].inventoryArchive,undefined);
}));

test('historical order membership is insufficient without exact paid noncancelled disposition evidence',()=>fixture(async(root,c)=>{
 const edits=[({soldProof}:any)=>{soldProof.rows[0].orderPaymentStatus='PENDING';},({soldProof}:any)=>{soldProof.rows[0].cancelState='CANCELED';},({soldProof}:any)=>{soldProof.rows[0].cancelState='CANCEL_REQUESTED';},({soldProof}:any)=>{delete soldProof.rows[0].cancelState;},({soldProof}:any)=>{soldProof.rows[0].orderFulfillmentStatus='CANCELLED';},({soldProof}:any)=>{soldProof.rows[0].itemId='999999999999';},({soldProof}:any)=>{soldProof.rows[0].title+=' Different card';},({soldProof}:any)=>{soldProof.complete=false;}];
 for(const edit of edits){const evidence=await c.make('sold',edit);await assert.rejects(archiveV2ListedPhotos(root,evidence.packet));for(const photo of c.card.photos)assert.equal(sha(await fs.readFile(photo.path)),photo.hash);}
 const missing=await c.make('sold');delete missing.claim.soldProof;missing.packet.observation=await c.retain(missing.claim);await assert.rejects(archiveV2ListedPhotos(root,missing.packet),/history alone/);assert.equal((await readV2State(root)).cards[c.card.id].inventoryArchive,undefined);
}));

test('wrong disposition, duplicate selected IDs or multiple actual primary SKU matches refuse API ownership',()=>fixture(async(root,c)=>{
 const wrongScope=await c.make('listed');await assert.rejects(archiveV2ListedPhotos(root,{...wrongScope.packet,disposition:'sold'}),/source scope differ/);
 const duplicate=await c.make('listed',({claim}:any)=>{claim.rows.push({...claim.rows[0]});});await assert.rejects(archiveV2ListedPhotos(root,duplicate.packet),/Ambiguous selected/);
 const ambiguous=await c.make('listed',({snapshot,provenance}:any)=>{snapshot.rows.push({...snapshot.rows[0],id:'999999999999'});provenance.sourceRows=2;provenance.uniqueItemRows=2;});await assert.rejects(archiveV2ListedPhotos(root,ambiguous.packet),/Exact actual API/);for(const photo of c.card.photos)assert.equal(sha(await fs.readFile(photo.path)),photo.hash);
}));
