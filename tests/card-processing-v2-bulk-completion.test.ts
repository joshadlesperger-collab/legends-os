import test from 'node:test';import assert from 'node:assert/strict';
import {planV2BulkCompletion} from '../lib/card-processing-v2-bulk-completion.ts';
import {digest,type V2Payload} from '../lib/card-processing-v2.ts';
const payload=(n:number):V2Payload=>({sku:`V2-${n}`,captureIds:[digest(`capture${n}`)],title:`2024 Optic Player ${n}`,categoryId:'261328',specifics:{Sport:['Basketball']},quantity:1,photos:[{hash:digest(`front${n}`),url:`https://i.ebayimg.com/front${n}.jpg`,expiresAt:'2026-12-01T00:00:00Z',upright:true},{hash:digest(`back${n}`),url:`https://i.ebayimg.com/back${n}.jpg`,expiresAt:'2026-12-01T00:00:00Z',upright:true}],conditionId:'4000',conditionDescriptorName:'Card Condition - (ID: 40001)',conditionDescriptorValue:'Near mint or better - (ID: 400010)',condition:'Near mint or better',description:'Actual card shown in photos.',descriptionSource:'factual',pricing:'unpriced-grok-pending'});
const group=(n:number)=>({groupId:`group-${n}`,cardIds:[`card-${n}`],payload:payload(n)});
test('common edits group only exact compatible category/condition selected SKUs',()=>{
 const job={id:digest('job'),groups:[group(1),group(2),{...group(3),payload:{...payload(3),categoryId:'183454',conditionDescriptorName:'TCG condition'}}]},before=JSON.stringify(job),plan=planV2BulkCompletion(job);
 assert.equal(plan.commonRepairs.conditionBatches.length,2);assert.deepEqual(plan.commonRepairs.conditionBatches[0].skus,['V2-1','V2-2']);assert.deepEqual(plan.commonRepairs.conditionBatches[1].skus,['V2-3']);assert.deepEqual(plan.selectedSkus,['V2-1','V2-2','V2-3']);assert.equal(JSON.stringify(job),before);
});
test('prior policy candidates cannot authorize an action, completion or any price/shipping change',()=>{
 const plan=planV2BulkCompletion({id:digest('job'),groups:[group(1)]});assert.equal(plan.commonRepairs.policyCandidates.freshAuthority,false);assert.equal(plan.status,'requires-fresh-internal-browser-observation');assert.equal(plan.automaticWritesAllowed,false);assert.equal(plan.complete,false);assert.equal(plan.canPublish,false);assert.deepEqual(plan.deferredUntouched,['item price','shipping amount','shipping policy']);assert.ok(plan.timingBoundaries.includes('same-ID-save-reopen-readback'));
});
test('duplicate physical captures and oversized bulk scope refuse repair planning',()=>{
 assert.throws(()=>planV2BulkCompletion({id:digest('job'),groups:[group(1),{...group(2),payload:{...payload(2),captureIds:payload(1).captureIds}}]}),/ownership/);
 assert.throws(()=>planV2BulkCompletion({id:digest('job'),groups:Array.from({length:21},(_,n)=>group(n+1))}));
});

import {auditV2BulkCompletion} from '../lib/card-processing-v2-bulk-completion.ts';
import {emptyV2State,type V2Card} from '../lib/card-processing-v2.ts';
function auditFixture(){const state=emptyV2State(),p=payload(1),at=new Date().toISOString(),draftId='5431111111111',key=digest('imported-intent');
 const card:V2Card={id:'card-1',sku:p.sku,captureId:p.captureIds[0],photos:p.photos.map((photo,n)=>({path:`synthetic${n}.jpg`,hash:photo.hash,side:n?'back':'front'})),stage:'prepared',identity:{name:'Player 1',year:'2024',manufacturer:'Panini',product:'Optic',number:'1',categoryId:'261328',language:'English',variant:'Base',artwork:'Player',sportOrGame:'Basketball',team:'Team',serial:'',graded:false,damage:false,specifics:{}},condition:'Near mint or better',title:p.title,description:p.description,descriptionSource:'factual',issues:[],nextAction:'Review',createdAt:at,updatedAt:at,groupId:'group-1',draftId};
 state.cards[card.id]=card;state.submissions[key]={key,groupId:'group-1',payload:p,status:'submitted',draftId,at};const job={id:digest('audit-job'),groups:[{groupId:'group-1',cardIds:[card.id],payload:p,key}]};
 const description='2024 Optic Player 1 #1 Team. Near mint or better. Exact card shown in photos.';
 const observation:any={kind:'saved-reopened-draft-nonprice-observation',draftId,url:`https://www.ebay.com/lstng?draftId=${draftId}`,observedAt:at,scope:'non-price-fields; pricing left untouched per seller',priceWritePerformed:false,ax:'Sports Mem, Cards & Fan Shop > Sports Trading Cards\nCard Condition Near mint or better:\nItem location 75167 (Waxahachie, Texas, United States)\nReturn policy : No Return Accepted (248164940010)',dom:{category:[{text:'Trading Card Singles'}],photos:p.photos.map((photo,n)=>({background:`url(https://i.ebayimg.com/z/resource${n}/photo.jpg)`})),fields:Object.entries({title:p.title,customLabel:p.sku,quantity:'1',condition:'4000','40001':'400010','attributes.Sport':'Basketball',description,paymentPolicyId:'eBay Managed Payments (248164941010)',shippingPolicyId:'Observed preserved policy'}).map(([name,value])=>({name,value})).concat([{name:'scheduleListingSelection',checked:false}] as any)},features:{ax:''}};
 p.photos=p.photos.map((photo,n)=>({...photo,url:`https://i.ebayimg.com/images/g/resource${n}/s-l1600.jpg`}));
 const entry={cardId:card.id,evidence:{path:'artifacts/actual-observation.json',sha256:digest('evidence')},observation};return{state,job,entry};}
test('valid actual first pass preserves acceptable Base content and directs finish/archive without editor saves',()=>{
 const f=auditFixture(),before=JSON.stringify(f),audit=auditV2BulkCompletion(f.job,f.state,[f.entry]);assert.equal(audit.readyForStrictFinish,true);assert.equal(audit.rows[0].route,'finish-archive-without-editor-writes');assert.equal(audit.correctionBatches.length,0);assert.equal(audit.automaticEditorWrites,false);assert.equal(JSON.stringify(f),before);
});
test('only actual observed compatible defects form correction targets with proof refs',()=>{
 const f=auditFixture();f.entry.observation.dom.fields.find((x:any)=>x.name==='40001').value='';const audit=auditV2BulkCompletion(f.job,f.state,[f.entry]);assert.equal(audit.rows[0].route,'correct-observed-defects-only');assert.equal(audit.correctionBatches.length,1);assert.equal(audit.correctionBatches[0].field,'condition-descriptor');assert.equal(audit.correctionBatches[0].targets[0].evidence.sha256,f.entry.evidence.sha256);assert.equal(audit.readyForStrictFinish,false);
});
test('missing, stale or partially unobserved cards grant no correction targets',()=>{
 const f=auditFixture();assert.equal(auditV2BulkCompletion(f.job,f.state,[]).rows[0].route,'hold');f.entry.observation.observedAt=new Date(Date.now()-61*60000).toISOString();assert.equal(auditV2BulkCompletion(f.job,f.state,[f.entry]).correctionBatches.length,0);f.entry.observation.observedAt=new Date().toISOString();f.entry.observation.dom.fields=f.entry.observation.dom.fields.filter((x:any)=>x.name!=='title');f.entry.observation.dom.fields.find((x:any)=>x.name==='40001').value='';const audit=auditV2BulkCompletion(f.job,f.state,[f.entry]);assert.equal(audit.rows[0].route,'hold');assert.equal(audit.correctionBatches.length,0);
});
test('quantity/foreign mapping holds never propose quantity or price changes',()=>{
 const f=auditFixture();f.entry.observation.dom.fields.find((x:any)=>x.name==='quantity').value='2';const audit=auditV2BulkCompletion(f.job,f.state,[f.entry]);assert.equal(audit.rows[0].route,'hold');assert.equal(audit.priceAndQuantityEditsAllowed,false);assert.equal(audit.correctionBatches.length,0);assert.throws(()=>auditV2BulkCompletion(f.job,f.state,[{...f.entry,cardId:'outside-job'}]),/selected/);
});

test('generic location/returns labels and an unexpanded Features summary are holds, never defect targets',()=>{
 for(const field of ['location','returns','features']){const f=auditFixture();if(field==='location')f.entry.observation.ax=f.entry.observation.ax.replace('Item location 75167 (Waxahachie, Texas, United States)','Item location');if(field==='returns')f.entry.observation.ax=f.entry.observation.ax.replace('Return policy : No Return Accepted (248164940010)','Return policy');if(field==='features'){f.job.groups[0].payload.specifics.Features=['Serial Numbered'];f.entry.observation.features.ax='button Features Serial Numbered (+1)';}const audit=auditV2BulkCompletion(f.job,f.state,[f.entry]);assert.equal(audit.rows[0].route,'hold',field);assert.equal(audit.correctionBatches.length,0,field);}
});

test('factual-equivalent title formatting is reconciliation-only, not a style correction target',()=>{
 const f=auditFixture();f.entry.observation.dom.fields.find((x:any)=>x.name==='title').value='2024 Optic Player 1 #1';const audit=auditV2BulkCompletion(f.job,f.state,[f.entry]);assert.equal(audit.rows[0].route,'hold');assert.equal(audit.correctionBatches.length,0);assert.ok(audit.rows[0].holds.some(h=>h.includes('style rewrite')));
});

test('definite damaged or graded identity never acquires correction or archive readiness',()=>{
 for(const kind of ['damage','graded'] as const){const f=auditFixture();f.state.cards['card-1'].identity![kind]=true;const audit=auditV2BulkCompletion(f.job,f.state,[f.entry]);assert.equal(audit.rows[0].route,'hold');assert.equal(audit.correctionBatches.length,0);assert.equal(audit.readyForStrictFinish,false);}
});


test('expanded native Features checked controls override collapsed summary text',()=>{
 const f=auditFixture();f.job.groups[0].payload.specifics.Features=['Parallel/Variety','Serial Numbered'];
 f.entry.observation.ax+='\n101 button (collapsed) Features, ID: item-specific-dropdown-label-features\n102 button (collapsed) Parallel/Variety (+1), Secondary Actions: Expand';
 f.entry.observation.features.ax='104 Parallel/Variety, Value: 1\n105 Serial Numbered, Value: 1';
 const audit=auditV2BulkCompletion(f.job,f.state,[f.entry]);assert.equal(audit.rows[0].route,'finish-archive-without-editor-writes');assert.equal(audit.rows[0].defects.length,0);assert.equal(audit.correctionBatches.length,0);
 f.entry.observation.features.ax='Features Parallel/Variety (+1)';const missing=auditV2BulkCompletion(f.job,f.state,[f.entry]);assert.equal(missing.rows[0].route,'hold');assert.equal(missing.correctionBatches.length,0);
});

test('actual expanded Parallel label remains distinct from unselected Parallel/Variety',()=>{
 const f=auditFixture();f.job.groups[0].payload.specifics.Features=['Serial Numbered','Parallel'];
 f.entry.observation.features.ax='379 button (expanded) Serial Numbered (+1), Secondary Actions: Collapse\n392 Serial Numbered, Value: 1\n393 Parallel, Value: 1\n420 Parallel/Variety, Value: 0\n426 Serial Numbered, Value: 1\n431 Parallel, Value: 1';
 const audit=auditV2BulkCompletion(f.job,f.state,[f.entry]);assert.equal(audit.rows[0].route,'finish-archive-without-editor-writes');assert.equal(audit.correctionBatches.length,0);
 f.job.groups[0].payload.specifics.Features=['Serial Numbered','Parallel/Variety'];const mismatch=auditV2BulkCompletion(f.job,f.state,[f.entry]);assert.equal(mismatch.rows[0].route,'correct-observed-defects-only');assert.deepEqual(mismatch.rows[0].defects.find(d=>d.field==='specifics:Features')?.observed,['Serial Numbered','Parallel']);
 f.entry.observation.features.ax+='\n432 Parallel, Value: 0';const ambiguous=auditV2BulkCompletion(f.job,f.state,[f.entry]);assert.equal(ambiguous.rows[0].route,'hold');assert.equal(ambiguous.correctionBatches.length,0);
});

test('actual selected Rookie is read independently of collapsed Rookie plus-two summary',()=>{
 const f=auditFixture();f.job.groups[0].payload.specifics.Features=['Rookie','Serial Numbered','Parallel'];
 f.entry.observation.features.ax='379 button (expanded) Rookie (+2), Secondary Actions: Collapse\n393 Rookie, Value: 1\n394 Serial Numbered, Value: 1\n395 Parallel, Value: 1\n420 Parallel/Variety, Value: 0\n426 Rookie, Value: 1\n427 Serial Numbered, Value: 1\n431 Parallel, Value: 1';
 const actual=auditV2BulkCompletion(f.job,f.state,[f.entry]);assert.equal(actual.rows[0].route,'finish-archive-without-editor-writes');assert.equal(actual.correctionBatches.length,0);
 f.job.groups[0].payload.specifics.Features=['Serial Numbered','Parallel'];const extra=auditV2BulkCompletion(f.job,f.state,[f.entry]);assert.equal(extra.rows[0].route,'correct-observed-defects-only');assert.deepEqual(extra.rows[0].defects.find(d=>d.field==='specifics:Features')?.observed,['Rookie','Serial Numbered','Parallel']);
 f.entry.observation.features.ax+='\n432 Rookie, Value: 0';const conflict=auditV2BulkCompletion(f.job,f.state,[f.entry]);assert.equal(conflict.rows[0].route,'hold');assert.equal(conflict.correctionBatches.length,0);
});


test('Autographed inline checkbox proof is read before following aspect labels and missing states hold',()=>{
 const f=auditFixture();f.job.groups[0].payload.specifics.Autographed=['No'];f.entry.observation.ax+='\n101 button (collapsed) Autographed, ID: item-specific-dropdown-label-autographed\n102 checkbox No, Value: 1\n103 checkbox Yes, Value: 0\n104 button (collapsed) Signed By, ID: item-specific-dropdown-label-signed-by';
 const audit=auditV2BulkCompletion(f.job,f.state,[f.entry]);assert.equal(audit.rows[0].route,'finish-archive-without-editor-writes');assert.equal(audit.correctionBatches.length,0);
 f.entry.observation.ax=f.entry.observation.ax.replace('103 checkbox Yes, Value: 0','103 generic Yes');const ambiguous=auditV2BulkCompletion(f.job,f.state,[f.entry]);assert.equal(ambiguous.rows[0].route,'hold');assert.equal(ambiguous.correctionBatches.length,0);
});

test('generic category audit binds numeric actual category and never grants edits from label-only proof',()=>{
 const f=auditFixture();f.job.groups[0].payload.categoryId='183050';f.state.cards['card-1'].identity!.categoryId='183050';
 f.entry.observation.ax=f.entry.observation.ax.replace('Sports Mem, Cards & Fan Shop > Sports Trading Cards','Collectibles > Non-Sport Trading Cards > Trading Card Singles');
 f.entry.observation.dom.category=[{text:'Trading Card Singles',href:'https://www.ebay.com/b/Non-Sport-Trading-Card-Singles/183050/bn_123'}];
 const ready=auditV2BulkCompletion(f.job,f.state,[f.entry]);assert.equal(ready.rows[0].route,'finish-archive-without-editor-writes');
 f.entry.observation.dom.category=[{text:'Trading Card Singles'}];const held=auditV2BulkCompletion(f.job,f.state,[f.entry]);assert.equal(held.rows[0].route,'hold');assert.equal(held.correctionBatches.length,0);
});
test('new imports complete required shared fields before first save with no-returns policy and one readback',()=>{const plan=planV2BulkCompletion({id:digest('job'),groups:[group(1)]});assert.equal(plan.mode,'new-import');assert.deepEqual(plan.firstSaveCompletion?.fields,['item location','card condition','return policy','payment policy']);assert.equal(plan.firstSaveCompletion?.returnsPolicy.label,'No Return Accepted');assert.equal(plan.firstSaveCompletion?.returnsPolicy.alternativesAllowed,false);assert.equal(plan.firstSaveCompletion?.missingSharedFieldsPermitSave,false);assert.equal(plan.firstSaveCompletion?.readbackPasses,1);assert.ok(plan.sequence.some(s=>s.includes('Before the FIRST Save')));assert.equal(plan.sequence.some(s=>s.startsWith('Audit actual saved observations first.')),false);assert.equal(plan.automaticWritesAllowed,false);assert.equal(plan.complete,false);});
test('existing saved draft repair retains observed mismatch-only sequencing',()=>{const plan=planV2BulkCompletion({id:digest('job'),groups:[group(1)]},'existing-draft-repair');assert.equal(plan.firstSaveCompletion,null);assert.ok(plan.sequence.some(s=>s.startsWith('Audit actual saved observations first.')));assert.equal(plan.sequence.some(s=>s.includes('Before the FIRST Save')),false);assert.ok(plan.sequence.some(s=>s.includes('save/reopen only changed IDs')));});

test('rendered saved condition linebreak and return colon spacing go directly to strict finish',()=>{const f=auditFixture();f.entry.observation.ax=f.entry.observation.ax.replace('Card Condition Near mint or better:','Card Condition\nNear mint or better:').replace('Return policy :','Return policy:');const result=auditV2BulkCompletion(f.job,f.state,[f.entry]);assert.equal(result.readyForStrictFinish,true);assert.equal(result.rows[0].route,'finish-archive-without-editor-writes');assert.deepEqual(result.rows[0].defects,[]);assert.deepEqual(result.rows[0].holds,[]);});
