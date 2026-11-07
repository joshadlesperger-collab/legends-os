import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {createV2MediaCommitter,matchesV2MediaOrientation,shouldRecoverV2MediaAck} from '../lib/card-processing-v2-media-committer.ts';
import {digest,emptyV2State,type V2Card} from '../lib/card-processing-v2.ts';
import {readV2Config,withV2ConfigReads,v2Dir} from '../lib/card-processing-v2-store.ts';
const at=new Date().toISOString(),expiresAt=new Date(Date.now()+30*864e5).toISOString();
const card=(id:string):V2Card=>({id,sku:id,captureId:digest(id),photos:[{hash:digest(id+'f'),path:'front.jpg',side:'front'},{hash:digest(id+'b'),path:'back.jpg',side:'back'}],stage:'identified',condition:'Near mint or better',title:'',description:'',descriptionSource:'factual',issues:[],nextAction:'Prepare',createdAt:at,updatedAt:at});
async function fixture(fn:(root:string)=>Promise<void>){const root=await fs.mkdtemp(path.join(os.tmpdir(),'v2-prep-io-'));try{await fn(root);}finally{await fs.rm(root,{recursive:true,force:true});}}
test('three successful acknowledgements share one durable commit; capture rebinding and late ownership reject',()=>fixture(async root=>{
 const cards=[card('a'),card('b')],state=emptyV2State();cards.forEach(c=>state.cards[c.id]=c);const hashes=new Map(cards.flatMap(c=>c.photos.map(p=>[p.hash,digest('upright')])));let commits=0;
 const queue=createV2MediaCommitter(root,cards,hashes,async fn=>{commits++;fn(state);});
 await Promise.all([queue.retain(cards[0],cards[0].photos[0].hash,{url:'https://i.ebayimg.com/a.jpg',expiresAt}),queue.retain(cards[0],cards[0].photos[1].hash,{url:'https://i.ebayimg.com/b.jpg',expiresAt}),queue.retain(cards[1],cards[1].photos[0].hash,{url:'https://i.ebayimg.com/c.jpg',expiresAt})]);
 assert.equal(commits,1);assert.equal(Object.keys(state.media).length,3);
 state.cards.a={...cards[0],captureId:digest('rebound')};await assert.rejects(queue.retain(cards[0],cards[0].photos[0].hash,{url:'https://i.ebayimg.com/d.jpg',expiresAt}),/capture changed/);
 state.cards.a={...cards[0],draftId:'saved'};await assert.rejects(queue.retain(cards[0],cards[0].photos[0].hash,{url:'https://i.ebayimg.com/e.jpg',expiresAt}),/capture changed/);
}));
test('ack retained before failed state commit recovers with no upload; changed orientation cannot reuse it',()=>fixture(async root=>{
 const c=card('a'),hash=c.photos[0].hash,hashes=new Map([[hash,digest('270')]]),state=emptyV2State();state.cards.a=c;
 const first=createV2MediaCommitter(root,[c],hashes,async()=>{throw Error('checkpoint interrupted');});
 await assert.rejects(first.retain(c,hash,{url:'https://i.ebayimg.com/ack.jpg',expiresAt}),/interrupted/);
 state.media[hash]={hash,url:'https://i.ebayimg.com/old-unoriented.jpg',expiresAt,upright:true};assert.equal(shouldRecoverV2MediaAck(state.media[hash],hashes.get(hash)!,true),true);
 let commits=0;const resumed=createV2MediaCommitter(root,[c],hashes,async fn=>{commits++;fn(state);});assert.equal(await resumed.recover(c,hash),true);assert.equal(commits,1);assert.equal(state.media[hash].url,'https://i.ebayimg.com/ack.jpg');assert.equal(state.media[hash].orientationHash,hashes.get(hash));
 const rotated=createV2MediaCommitter(root,[c],new Map([[hash,digest('90')]]),async()=>{throw Error('must not commit');});assert.equal(await rotated.recover(c,hash),false);
 const rebound={...c,captureId:digest('different')};assert.equal(await createV2MediaCommitter(root,[rebound],hashes,async()=>{}).recover(rebound,hash),false);
}));
test('config cache is run scoped and invalidates same-run source replacement and invalid JSON',()=>fixture(async root=>{
 await fs.mkdir(v2Dir(root),{recursive:true});const file=path.join(v2Dir(root),'config.json');await fs.writeFile(file,JSON.stringify({folder:'first'}));
 await withV2ConfigReads(async()=>{const a=await readV2Config(root);assert.strictEqual(await readV2Config(root),a);await fs.writeFile(file,JSON.stringify({folder:'second'}));assert.equal((await readV2Config(root)).folder,'second');await fs.writeFile(file,'invalid');await assert.rejects(readV2Config(root),/invalid/);});
 await fs.writeFile(file,JSON.stringify({folder:'third'}));assert.equal((await readV2Config(root)).folder,'third');
}));

test('pre-request fence survives missing acknowledgement and blocks automatic external replay',()=>fixture(async root=>{
 const c=card('pending'),hash=c.photos[0].hash,hashes=new Map([[hash,digest('upright')]]),q=createV2MediaCommitter(root,[c],hashes,async()=>{});
 await q.begin(c,hash);const resumed=createV2MediaCommitter(root,[c],hashes,async()=>{});
 await assert.rejects(resumed.recover(c,hash),/Unsettled photo upload/);await assert.rejects(resumed.begin(c,hash),/Unsettled photo upload/);
}));
test('config scoped reads preserve category time gates without source replacement',()=>fixture(async root=>{
 await fs.mkdir(v2Dir(root),{recursive:true});await fs.writeFile(path.join(v2Dir(root),'config.json'),JSON.stringify({folder:'scan'}));
 const observed=Date.parse('2026-01-01T00:00:00.000Z'),report={observedAt:new Date(observed).toISOString(),categories:[{categoryId:'261328',source:'fixture',observedAt:new Date(observed).toISOString(),requiredAspects:['Sport'],conditionId:'4000',conditionDescriptorName:'Card Condition',conditionDescriptorValue:'400010',conditionLabel:'Near mint or better'}],capabilities:[]};
 await fs.writeFile(path.join(v2Dir(root),'category-metadata.json'),JSON.stringify(report));const originalNow=Date.now;let clock=observed-1000;Date.now=()=>clock;
 try{await withV2ConfigReads(async()=>{assert.equal((await readV2Config(root)).categories.length,0);clock=observed+1000;assert.equal((await readV2Config(root)).categories.length,1);clock=observed+7*86400000+1;assert.equal((await readV2Config(root)).categories.length,0);});}finally{Date.now=originalNow;}
}));

test('provider-oriented originals reject untagged/different old URL and only reuse exact derivative tag; legacy unaffected',()=>{
 const hash=digest('original'),expected=digest('270'),media={hash,url:'https://i.ebayimg.com/legacy.jpg',expiresAt,upright:true as const};
 assert.equal(matchesV2MediaOrientation(media,expected,true),false);
 assert.equal(matchesV2MediaOrientation({...media,orientationHash:digest('0')},expected,true),false);
 assert.equal(matchesV2MediaOrientation({...media,orientationHash:expected},expected,true),true);
 assert.equal(matchesV2MediaOrientation(media,expected,false),true);
});

test('missing/mismatched derivative state can recover a confirmed acknowledgement; expired matching-tag state stays authoritative',()=>{
 const expected=digest('270'),hash=digest('original'),media={hash,url:'https://i.ebayimg.com/old.jpg',expiresAt:new Date(0).toISOString(),upright:true as const};
 assert.equal(shouldRecoverV2MediaAck(undefined,expected,true),true);
 assert.equal(shouldRecoverV2MediaAck(media,expected,true),true);
 assert.equal(shouldRecoverV2MediaAck({...media,orientationHash:expected},expected,true),false);
 assert.equal(shouldRecoverV2MediaAck(media,expected,false),false);
});
