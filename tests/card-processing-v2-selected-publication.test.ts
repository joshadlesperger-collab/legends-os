import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {enqueueV2SelectedPublication,getV2SelectedPublicationStatus,handleV2PublicationWorker,projectV2UnpublishedPriceReport,selectedPublicationRequestSchema,V2_NATIVE_PUBLISHER_VERSION,type V2PublicationDatabase} from '../lib/card-processing-v2-selected-publication.ts';
import {createV2PublicationBridgeClient} from '../lib/card-processing-v2-publication-bridge-client.ts';
import type {V2PriceCheckReport} from '../lib/card-processing-v2-price-check-report.ts';

const at=new Date('2026-11-07T02:00:00Z'),operator='owner',workerId=randomUUID();
function memory(){
 const records={jobs:[] as any[],items:[] as any[],workers:[] as any[]};let lane=Promise.resolve();
 const matches=(row:any,where:any):boolean=>Object.entries(where??{}).every(([key,value]:[string,any])=>{
  if(key==='seller_draftId')return row.seller===value.seller&&row.draftId===value.draftId;
  const actual=row[key];if(value&&typeof value==='object'&&!(value instanceof Date)){if('in'in value)return value.in.includes(actual);if('lt'in value)return new Date(actual).getTime()<new Date(value.lt).getTime();if('gte'in value)return new Date(actual).getTime()>=new Date(value.gte).getTime();}return actual===value;
 });
 const model=(key:keyof typeof records)=>({findUnique:async({where}:any)=>records[key].find(row=>matches(row,where))??null,
  findFirst:async({where,orderBy}:any)=>{const rows=records[key].filter(row=>matches(row,where));if(orderBy){const[field,sort]=Object.entries(orderBy)[0];rows.sort((a,b)=>(new Date(a[field]).getTime()-new Date(b[field]).getTime())*(sort==='desc'?-1:1));}return rows[0]??null;},
  findMany:async({where}:any)=>records[key].filter(row=>matches(row,where)),
  create:async({data}:any)=>{const row={...data};if(key==='jobs'){for(const item of data.items?.create??[])records.items.push({...item,jobId:data.id});delete row.items;}records[key].push(row);return row;},
  update:async({where,data}:any)=>{const row=records[key].find(row=>matches(row,where));if(!row)throw Error('missing');Object.assign(row,data);return row;},
  updateMany:async({where,data}:any)=>{const rows=records[key].filter(row=>matches(row,where));rows.forEach(row=>Object.assign(row,data));return{count:rows.length};},
  upsert:async({where,create,update}:any)=>{const old=records[key].find(row=>matches(row,where));if(old){Object.assign(old,update);return old;}records[key].push({...create});return records[key].at(-1);},
 });
 const db={v2DraftPublicationJob:model('jobs'),v2DraftPublicationItem:model('items'),v2DraftPublisherHeartbeat:model('workers'),$transaction:async<T>(fn:(db:V2PublicationDatabase)=>Promise<T>):Promise<T>=>{
  let release!:()=>void;const before=lane;lane=new Promise(resolve=>{release=resolve;});await before;const snapshot=structuredClone(records);try{return await fn(db);}catch(e){records.jobs=snapshot.jobs;records.items=snapshot.items;records.workers=snapshot.workers;throw e;}finally{release();}
 }} as V2PublicationDatabase;
 return{db,records};
}
const row=(draftId='5290000000001')=>({draftId,sku:'V2-'+'a'.repeat(24),title:'Fixture exact card',quantity:1,currentItemCents:179,shippingCents:149,flags:['comp-uncertain']});
function setup(rows=[row()]){const m=memory(),report={reportId:'current-fixture',rows} as unknown as V2PriceCheckReport;return{...m,deps:{database:m.db,report:async()=>report,now:()=>at},report};}
const request=(draftId='5290000000001',manualItemCents?:number)=>({action:'publish-selected',requestId:randomUUID(),reportId:'current-fixture',rows:[{draftId,...(manualItemCents===undefined?{}:{manualItemCents})}],reviewAcknowledged:true});
async function ready(f:ReturnType<typeof setup>){await handleV2PublicationWorker(operator,{action:'heartbeat',workerId,seller:'imaydit58',version:V2_NATIVE_PUBLISHER_VERSION,status:'READY',sellerObservedAt:at.toISOString()},f.deps);}
async function claimed(f:ReturnType<typeof setup>,manual?:number){await ready(f);const queued=await enqueueV2SelectedPublication(operator,request(undefined,manual),f.deps);const c=await handleV2PublicationWorker(operator,{action:'claim',workerId},f.deps) as any;return{queued,claim:{workerId,jobId:c.job.id,leaseToken:c.job.leaseToken},target:c.job.targets[0]};}
const published=(target:any)=>({draftId:target.draftId,sku:target.sku,title:target.title,quantity:target.quantity,itemCents:target.manualItemCents??target.itemCents,shippingCents:target.shippingCents,itemId:'128180000001'});

test('selected publication contract rejects duplicates, unknown write options and malformed manual cents',()=>{
 const r=request();assert.equal(selectedPublicationRequestSchema.parse(r).rows.length,1);
 for(const value of [{...r,rows:[...r.rows,...r.rows]},{...r,reviewAcknowledged:false},{...r,publishAll:true},{...r,rows:[{draftId:r.rows[0].draftId,manualItemCents:148}]},{...r,rows:[{draftId:r.rows[0].draftId,itemCents:179}]}])assert.throws(()=>selectedPublicationRequestSchema.parse(value));
});
test('disconnected, stale or absent publisher cannot enqueue any work',async()=>{
 const f=setup();assert.equal((await getV2SelectedPublicationStatus(operator,undefined,f.deps)).transportReady,false);
 await assert.rejects(enqueueV2SelectedPublication(operator,request(),f.deps),/Connect/);assert.equal(f.records.jobs.length,0);
 await ready(f);f.records.workers[0].seenAt=new Date(at.getTime()-45001);assert.equal((await getV2SelectedPublicationStatus(operator,undefined,f.deps)).transportReady,false);
 await assert.rejects(enqueueV2SelectedPublication(operator,request(),f.deps),/Connect/);
});
test('manual review freezes exact selected scope and prices, retry is idempotent, duplicate jobs are prevented',async()=>{
 const f=setup();await ready(f);const r=request(undefined,249),first=await enqueueV2SelectedPublication(operator,r,f.deps);assert.equal(first.requestId,r.requestId);assert.equal(first.status,'QUEUED');assert.equal(f.records.jobs.length,1);assert.equal(f.records.jobs[0].selection[0].itemCents,179);assert.equal(f.records.jobs[0].selection[0].manualItemCents,249);
 const retry=await enqueueV2SelectedPublication(operator,r,f.deps);assert.equal(retry.reused,true);assert.equal(f.records.jobs.length,1);
 await assert.rejects(enqueueV2SelectedPublication(operator,{...r,rows:[{draftId:r.rows[0].draftId,manualItemCents:250}]},f.deps),/already bound/);
 await assert.rejects(enqueueV2SelectedPublication(operator,request(),f.deps),/already belongs/);
 assert.equal((await getV2SelectedPublicationStatus(operator,r.requestId,f.deps)).status,'QUEUED');
});
test('unknown original values and foreign report IDs stop selection before a durable job',async()=>{
 for(const mutation of [{shippingCents:null},{currentItemCents:null},{sku:''},{quantity:undefined}]){const f=setup([{...row(),...mutation}as any]);await ready(f);await assert.rejects(enqueueV2SelectedPublication(operator,request(undefined,249),f.deps));assert.equal(f.records.jobs.length,0);}
 const f=setup();await ready(f);await assert.rejects(enqueueV2SelectedPublication(operator,{...request(),reportId:'foreign'},f.deps),/changed/);
});
test('native write checkpoint is at-most-once under concurrent duplicate delivery',async()=>{
 const f=setup(),c=await claimed(f),checkpoint={action:'checkpoint',...c.claim,phase:'before-final-submit',draftIds:[c.target.draftId]};
 const results=await Promise.allSettled([handleV2PublicationWorker(operator,checkpoint,f.deps),handleV2PublicationWorker(operator,checkpoint,f.deps)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);assert.equal(f.records.items[0].status,'SUBMISSION_ATTEMPTED');
});
test('price-edit checkpoint is separate and original price remains frozen through exact live completion',async()=>{
 const f=setup(),c=await claimed(f,249);await handleV2PublicationWorker(operator,{action:'checkpoint',...c.claim,phase:'before-price-edit',draftIds:[c.target.draftId]},f.deps);assert.equal(f.records.items[0].status,'PRICE_EDITING');
 await handleV2PublicationWorker(operator,{action:'checkpoint',...c.claim,phase:'before-final-submit',draftIds:[c.target.draftId]},f.deps);
 await assert.rejects(handleV2PublicationWorker(operator,{action:'complete',...c.claim,published:[{...published(c.target),shippingCents:0}],exceptions:[]},f.deps),/differs/);
 const result=await handleV2PublicationWorker(operator,{action:'complete',...c.claim,published:[published(c.target)],exceptions:[],archives:[{draftId:c.target.draftId,status:'moved'}]},f.deps);assert.equal(result.status,'COMPLETE');assert.equal(f.records.items[0].liveItemId,'128180000001');assert.equal(f.records.jobs[0].selection[0].itemCents,179);
 await assert.rejects(handleV2PublicationWorker(operator,{action:'complete',...c.claim,published:[published(c.target)],exceptions:[]},f.deps),/lease/);
});
test('published receipts are durable before photos; missing archives require archive review',async()=>{
 const f=setup(),c=await claimed(f);await handleV2PublicationWorker(operator,{action:'checkpoint',...c.claim,phase:'before-final-submit',draftIds:[c.target.draftId]},f.deps);
 await handleV2PublicationWorker(operator,{action:'checkpoint',...c.claim,phase:'published-group',draftIds:[c.target.draftId],observations:[published(c.target)]},f.deps);assert.equal(f.records.items[0].status,'PUBLISHED');
 const result=await handleV2PublicationWorker(operator,{action:'complete',...c.claim,published:[published(c.target)],exceptions:[]},f.deps);assert.equal(result.status,'ARCHIVE_REVIEW');assert.equal(f.records.items[0].liveItemId,'128180000001');
});
test('expired leases never requeue ambiguous publication or accept late completion',async()=>{
 const f=setup(),c=await claimed(f);f.records.jobs[0].leaseExpiresAt=new Date(at.getTime()-1);
 await assert.rejects(handleV2PublicationWorker(operator,{action:'complete',...c.claim,published:[published(c.target)],exceptions:[]},f.deps),/lease/);
 const result=await handleV2PublicationWorker(operator,{action:'claim',workerId},f.deps)as any;assert.equal(result.job,null);assert.equal(f.records.jobs[0].status,'REVIEW_REQUIRED');
 await assert.rejects(enqueueV2SelectedPublication(operator,request(),f.deps),/already belongs/);
});
test('bridge sends password only to the trusted normal login and serializes authenticated worker checkpoints',async()=>{
 let calls=0;const urls:string[]=[],bodies:string[]=[];const client=createV2PublicationBridgeClient('https://legends-os-beta.vercel.app','fixture-password',{fetch:async(url,init)=>{calls++;urls.push(String(url));bodies.push(String(init?.body));if(String(url).endsWith('/api/auth/login'))return new Response(null,{status:303,headers:{'Set-Cookie':'legends_operator=fixture; HttpOnly; Secure'}});assert.equal(new Headers(init?.headers).get('origin'),'https://legends-os-beta.vercel.app');assert.equal(new Headers(init?.headers).get('cookie'),'legends_operator=fixture');return Response.json({accepted:true});}});
 await client.heartbeat(client.workerId,'READY',at.toISOString());assert.equal(calls,2);assert.equal(bodies[0].includes('fixture-password'),true);assert.equal(bodies[1].includes('fixture-password'),false);assert.ok(urls.every(url=>url.startsWith('https://legends-os-beta.vercel.app/')));
 for(const url of['https://evil.example','http://legends-os-beta.vercel.app','https://legends-os-beta.vercel.app/other','https://legends-os-beta.vercel.app:444'])assert.throws(()=>createV2PublicationBridgeClient(url,'fixture-password'));
});

test('known published projection is operator-bound and exact-report bounded without changing source prices or metrics',async()=>{
 const f=setup([row(),{...row('5290000000002'),sku:'V2-'+'b'.repeat(24)}]);
 Object.assign(f.report,{totalDrafts:2,completedDrafts:2,snapshotObservedAt:at.toISOString(),elapsedMs:1000,unpublishedMembership:{observedAt:at.toISOString(),source:'ebay-seller-hub-drafts',sourceDraftCount:3,excludedDraftIds:['5290000000003']}});
 let observed:any;f.db.v2DraftPublicationItem.findMany=async args=>{observed=args;return[{draftId:'5290000000001'}];};
 const before=JSON.stringify(f.report),projected=await projectV2UnpublishedPriceReport(f.report,operator,f.deps);
 assert.deepEqual(observed.where,{seller:'imaydit58',status:'PUBLISHED',draftId:{in:['5290000000001','5290000000002']},job:{operatorId:operator}});
 assert.equal(projected.totalDrafts,1);assert.equal(projected.rows[0].draftId,'5290000000002');assert.equal(projected.rows[0].currentItemCents,179);assert.equal(projected.elapsedMs,1000);assert.equal(projected.unpublishedMembership?.sourceDraftCount,3);assert.deepEqual(projected.unpublishedMembership?.excludedDraftIds,['5290000000003','5290000000001']);assert.equal(JSON.stringify(f.report),before);
 f.db.v2DraftPublicationItem.findMany=async()=>{throw Object.assign(Error('missing'),{code:'P2021'});};assert.equal(await projectV2UnpublishedPriceReport(f.report,operator,f.deps),f.report);
 f.db.v2DraftPublicationItem.findMany=async()=>{throw Error('connection');};await assert.rejects(projectV2UnpublishedPriceReport(f.report,operator,f.deps),/connection/);
});
