import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const folder='data/card-catalog/';
const catalog=JSON.parse(await readFile(folder+'topps-chrome-basketball-2025-26.json','utf8'));
const audit=JSON.parse(await readFile(folder+'topps-chrome-basketball-2025-26-audit.json','utf8'));
const save=(name,data)=>writeFile(folder+name,JSON.stringify(data,null,2)+'\n');
const checkedOn='2026-10-23';
const manufacturer=catalog.sources.map(s=>({...s,checkedOn,owner:'Topps',role:s.kind==='checklist'?'identity':'format-odds',
  access:'public-manufacturer-document',acquisitionStatus:'retained-and-audited',
  reuseStatus:'bulk-automation-and-redistribution-unconfirmed',retention:'Retain internal evidence with provenance; confirm terms before redistribution.',
  refresh:'Manual version check before a new import; compare SHA-256 and review changes.',automaticCollection:false,
  parser:s.kind==='checklist'?'recover-card-knowledge.py + independent line audit':'audit-card-catalog.py / PDF coordinates',
  permittedEvidence:s.kind==='checklist'?['printed player','card number','printed team','section','rookie flag']:['printed ratio','box-format column'],
  excludedUses:s.kind==='checklist'?['ownership','physical-copy condition','market value']:['inferred print run','price multiplier','proof of absence from blank cells']}));
const external=[
  {id:'cardhedge-openapi',url:'https://api.cardhedger.com/openapi.json',role:'integration-contract',access:'public-documentation',acquisitionStatus:'documentation-reviewed',reuseStatus:'enterprise-agreement-required',retention:'Confirm sale retention, caching and derived-model rights in writing.',refresh:'Recheck OpenAPI before adapter implementation.',parser:'Not connected; use api.cardhedger.com and X-API-Key from OpenAPI, not marketing snippets.',permittedEvidence:['documented API capabilities'],excludedUses:['verified coverage','verified sale price','approved commercial ingestion']},
  {id:'cardhedge-developer-trial',url:'https://ai.cardhedger.com/signup?target=developer',role:'trial-terms',access:'public-page',acquisitionStatus:'reviewed-not-enrolled',reuseStatus:'enterprise-agreement-required',retention:'No trial data acquired.',refresh:'Recheck at enrollment and obtain business-use confirmation.',parser:'Manual review',permittedEvidence:['advertised seven-day trial','credit-card requirement','developer plans from $49/month','commercial use requires Enterprise'],excludedUses:['Enterprise price quote','permission to charge','commercial evaluation approval']},
  {id:'cardhedge-terms',url:'https://ai.cardhedger.com/terms',role:'rights',access:'public-page',acquisitionStatus:'reviewed',reuseStatus:'written-permission-required-for-derivatives',retention:'Dataset retention and post-termination model rights remain unresolved.',refresh:'Recheck before agreement.',parser:'Manual review',permittedEvidence:['published service terms'],excludedUses:['assumed model-training license']},
];
const ownedSales={id:'legends-ebay-seller-orders',url:'https://www.ebay.com/sh/ord/',owner:'Legends OS seller',role:'observed-sale',access:'existing-authorized-order-sync',acquisitionStatus:'bounded-read-adapter-ready',reuseStatus:'internal-seller-analysis-only',retention:'Private order evidence; export excludes buyer information. No redistribution.',refresh:'Existing supported order sync; refresh transaction status within seven days before analysis.',parser:'card-parallel-sales-store.ts; reviewed checklist/variant mapping required',automaticCollection:false,sha256:null,checkedOn,permittedEvidence:['actual paid line amount','recorded shipping','refund/cancellation state'],excludedUses:['automatic identity confirmation','multi-quantity lines as independent sales','asking or estimated prices']};
await save('source-registry.json',{version:1,checkedOn,productId:catalog.product.id,sources:[...manufacturer,ownedSales,...external.map(s=>({...s,owner:'Card Hedge',checkedOn,automaticCollection:false,sha256:null,retrievedAt:null,acquisitionStatus:'archived-excluded-no-paid-subscriptions',refresh:'No enrollment or paid access under current user policy.'}))]});

const bases=catalog.cards.filter(c=>c.section==='BASE CARDS');
const stars=['LeBron James','Stephen Curry','Luka Doncic','Victor Wembanyama','Shai Gilgeous-Alexander'];
const starCards=stars.map(name=>bases.find(c=>c.player===name)).filter(Boolean);
const rookies=bases.filter(c=>c.rookie).slice(0,8);
const others=bases.filter(c=>!c.rookie&&!stars.includes(c.player)).filter((_,i)=>i%17===0).slice(0,20-starCards.length-rookies.length);
const selected=[...starCards,...rookies,...others];
if(selected.length!==20) throw Error('Need 20 representative base entries');
const variants=[['Base','Base'],['Refractor','Base Refractors'],['RayWave Refractor','Base Refractors RayWave'],['Gold RayWave Refractor','Base Refractors RayWave Gold']];
const cases=[];
function add(card,parallel,stratum,evidence) {
  cases.push({id:createHash('sha256').update(JSON.stringify([card.id,parallel])).digest('hex').slice(0,24),entryId:card.id,player:card.player,cardNumber:card.cardNumber,section:card.section,
    parallel,grade:'Raw',stratum,query:`${catalog.product.season} Topps Chrome Basketball ${card.player} #${card.cardNumber} ${card.section==='BASE CARDS'?'':card.section} ${parallel}`.replace(/\s+/g,' ').trim(),
    identitySourceId:card.sourceId,sourcePage:card.sourcePage,oddsEvidenceId:evidence?.oddsId??null,
    applicabilityStatus:parallel==='Base'&&card.section==='BASE CARDS'?'checklist-entry':'candidate-requires-per-card-confirmation',
    printRun:null,physicalCopyConfirmed:false,providerCardId:null,resultStatus:'not-run'});
}
for(const card of selected) for(const [parallel,label] of variants) {
  const evidence=audit.oddsRows.find(r=>r.label===label);
  if(!evidence) throw Error('Missing manufacturer parallel evidence: '+label);
  add(card,parallel,card.rookie?'rookie':stars.includes(card.player)?'star':'other-veteran',evidence);
}
for(const section of ['YOUTHQUAKE','SLEEK FINISHERS','DESTINY','INSTINCT','VOICES','LOADING','GENERATION RISING','TALL TALES','CLUTCH GENE','ROCK STARS']) {
  const card=catalog.cards.find(c=>c.section===section); if(!card) throw Error('Missing section'); add(card,'Standard','insert',null);
}
for(const card of catalog.cards.filter(c=>c.section==='BASE CARD VARIATIONS').slice(0,10)) add(card,'Base Variation','image-variation',null);
if(cases.length!==100||new Set(cases.map(c=>c.id)).size!==100) throw Error('Invalid trial sample');
await save('cardhedge-trial.json',{version:1,productId:catalog.product.id,preparedOn:checkedOn,status:'prepared-not-run',selection:'20 base entries × 4 parallel queries, 10 inserts, 10 image variations; catalog-derived, not verified physical inventory.',
  accessGate:'Written commercial evaluation permission and API key; no subscription purchased or request sent.',
  requestBudget:{maximumCalls:250,maximumCallsPerMinute:10,automaticRetries:0},
  evaluationFields:['exact edition/section/number/parallel match','raw grade','source marketplace sale ID and URL','sale date','accepted-offer price verification','currency','shipping completeness','duplicate/lot/cancel status','freshness','usable paired evidence'],
  acceptance:{identityPrecisionTarget:0.98,minimumUsableRawCoverage:0.70,interpretation:'Proposed pilot targets, not achieved results. Report coverage by stratum; any edition mismatch needs correction. No-price/no-match is a valid outcome.'},cases});
console.log(JSON.stringify({registrySources:manufacturer.length+external.length+1,trialCases:cases.length,status:'archived-no-paid-subscriptions'}));
