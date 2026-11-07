import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {parseCsv} from '../lib/cost-basis-import.ts';
import {reviewedIdentity,type QueueState} from '../lib/card-orchestrator.ts';

// Explicit local rebuild. Never downloads reports, queries providers, or changes card jobs/prices.
const reportDir=path.resolve(process.argv[2]??'reports/inventory-snapshots/2026-10-25-five-card-test');
if(!reportDir.startsWith(path.resolve('reports/inventory-snapshots')+path.sep))throw Error('Use a saved inventory snapshot directory');
const names=['active-listings.csv','orders-2025.csv','orders-2026-ytd.csv','orders-last-90-days.csv'];
// Node supports Unicode properties; construct dynamically for the app's ES5 TS target.
const combiningMarks=new RegExp('\\p{M}','gu');
const normalize=(s:string)=>s.normalize('NFKD').replace(combiningMarks,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const sourceEvidence:{path:string;sha256:string;modifiedAt:string}[]=[];
const rows=names.flatMap((name,index)=>{
 const file=path.join(reportDir,name),bytes=fs.readFileSync(file);let text=bytes.toString('utf8');
 sourceEvidence.push({path:path.relative(process.cwd(),file),sha256:createHash('sha256').update(bytes).digest('hex'),modifiedAt:fs.statSync(file).mtime.toISOString()});
 if(index){const header=text.indexOf('"Sales Record Number"');if(header<0)throw Error('Missing sold-report header');text=text.slice(header);}
 return (parseCsv(text) as unknown as Record<string,string>[]).map(r=>({source:name,itemId:r.item_number,title:index?r.item_title:r.title,
 itemPrice:index?r.sold_for:r.current_price,shipping:index?r.shipping_and_handling:null,saleDate:index?r.sale_date:null,
 sku:index?r.custom_label:r['custom_label_(sku)'],kind:index?'sold':'active'})).filter(r=>r.itemId&&r.title);
});
const state=JSON.parse(fs.readFileSync('artifacts/card-orchestrator/state.json','utf8')) as QueueState;
const cards=Object.values(state.cards).filter(c=>c.jobs.identity.state==='done'&&!c.exclusion&&!c.input.knownLive).map(c=>{
 const identity=reviewedIdentity(c)!;const needle=normalize(identity.player),seen=new Set<string>();
 const candidates=rows.filter(r=>normalize(r.title).includes(needle)).filter(r=>{const key=JSON.stringify([r.kind,r.itemId,r.saleDate,r.itemPrice,r.shipping]);if(seen.has(key))return false;seen.add(key);return true;});
 return {cardId:c.input.id,identity,candidates};
});
const target='artifacts/card-orchestrator/saved-source-index.json',run=randomUUID();
if(fs.existsSync(target))fs.copyFileSync(target,`artifacts/card-orchestrator/saved-source-index-before-${run}.json`,fs.constants.COPYFILE_EXCL);
const tmp=target+'.'+run+'.tmp';
fs.writeFileSync(tmp,JSON.stringify({observedAt:new Date().toISOString(),sourceEvidence,cards},null,2),{flag:'wx'});
fs.renameSync(tmp,target);
console.log(JSON.stringify({cards:cards.length,sourceRows:rows.length,index:target,priorEvidencePreserved:true,externalCalls:0}));
