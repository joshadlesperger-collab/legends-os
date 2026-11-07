import type {NormalizedListing} from './market-normalization.ts';
export const compCounts=[1,3,5,10,20];
export const median=(x:number[])=>{const a=[...x].sort((a,b)=>a-b);return a.length?a.length%2?a[Math.floor(a.length/2)]:(a[a.length/2-1]+a[a.length/2])/2:null;};
export type Sale={id:string;entry:string;player:string;scope:string;variant:string;day:string;item:number;shipping:number;uncertain:boolean};
export function prepareBacktest(rows:NormalizedListing[]){
 const excluded:Record<string,number>={},sales:Sale[]=[],seen=new Set<string>();
 for(const r of rows){const reasons=[];
  if(seen.has(r.itemId))throw Error('Duplicate listing ID');seen.add(r.itemId);
  if(r.price.tier==='held')reasons.push('held-price-or-identity');
  if(r.flags.includes('international_shipping_imports'))reasons.push('import-fees-in-price-basis');
  if(!r.entryId||!r.release||!r.parallel||!r.section||r.players.length!==1)reasons.push('unresolved-card-variant');
  if(!r.price.date||r.price.datePrecision==='approximate')reasons.push('missing-or-approximate-date');
  if(r.price.currency!=='USD'||!r.price.itemCents||r.price.shippingCents===null)reasons.push('incomplete-buyer-total');
  if(new Set(r.evidence.filter(e=>e.shippingCents!==null).map(e=>e.shippingCents)).size>1)reasons.push('shipping-conflict');
  if(new Set(r.evidence.filter(e=>e.soldDate&&e.datePrecision!=='approximate').map(e=>e.soldDate)).size>1)reasons.push('sale-date-conflict');
  for(const reason of reasons)excluded[reason]=(excluded[reason]??0)+1;
  if(reasons.length)continue;
  sales.push({id:r.itemId,entry:r.entryId!,player:r.players[0].id,scope:JSON.stringify([r.release!.id,r.section,r.condition,r.autograph,r.variation,r.language]),variant:r.parallel!.label,day:r.price.date!,item:r.price.itemCents!,shipping:r.price.shippingCents!,uncertain:r.price.tier!=='displayed-auction'});
 }
 return {sales:sales.sort((a,b)=>a.day.localeCompare(b.day)||a.id.localeCompare(b.id)),excluded};
}
export type Prediction={id:string;entry:string;day:string;n:number;method:string;actual:number;predicted:number;trainingIds:string[];uncertainTarget:boolean;uncertainTraining:number};
const total=(s:Sale)=>s.item+s.shipping;
const days=(a:string,b:string)=>(Date.parse(a)-Date.parse(b))/86400000;
export function runBacktest(input:Sale[],includeUncertain=false){
 const sales=input.filter(s=>includeUncertain||!s.uncertain),predictions:Prediction[]=[],parallel:Prediction[]=[],gaps:Record<string,number>={};
 for(const target of sales){
  const prior=sales.filter(s=>s.day<target.day&&days(target.day,s.day)<=90);
  const exact=prior.filter(s=>s.entry===target.entry&&s.scope===target.scope&&s.variant===target.variant).sort((a,b)=>b.day.localeCompare(a.day)||a.id.localeCompare(b.id));
  for(const n of compCounts){if(exact.length<n){gaps[`need-${n}-prior-comps`]=(gaps[`need-${n}-prior-comps`]??0)+1;continue;}
   const train=exact.slice(0,n),mItem=median(train.map(s=>s.item))!,mShip=median(train.map(s=>s.shipping))!;
   for(const [method,predicted] of [['item-only',mItem],['item-plus-historical-shipping',mItem+mShip],['landed-median',median(train.map(total))!]] as const)predictions.push({id:target.id,entry:target.entry,day:target.day,n,method,actual:total(target),predicted,trainingIds:train.map(s=>s.id),uncertainTarget:target.uncertain,uncertainTraining:train.filter(s=>s.uncertain).length});
  }
  if(target.variant==='base')continue;
  const recent=prior.filter(s=>days(target.day,s.day)<=14&&s.scope===target.scope);
  const anchors=recent.filter(s=>s.entry===target.entry&&s.variant==='base');
  if(anchors.length<3){gaps['parallel-target-needs-3-base']=(gaps['parallel-target-needs-3-base']??0)+1;continue;}
  const entries=Array.from(new Set(recent.filter(s=>s.player!==target.player).map(s=>s.entry)));
  const byPlayer=new Map<string,{ratios:number[];sales:Sale[]}>();
  for(const entry of entries){const b=recent.filter(s=>s.entry===entry&&s.variant==='base'&&s.player!==target.player),p=recent.filter(s=>s.entry===entry&&s.variant===target.variant&&s.player!==target.player);if(b.length<3||p.length<3)continue;const g=byPlayer.get(b[0].player)??{ratios:[],sales:[]};g.ratios.push(median(p.map(total))!/median(b.map(total))!);g.sales.push(...b,...p);byPlayer.set(b[0].player,g);}
  if(byPlayer.size<3){gaps['parallel-needs-3-other-players']=(gaps['parallel-needs-3-other-players']??0)+1;continue;}
  const multiplier=median(Array.from(byPlayer.values()).map(g=>median(g.ratios)!))!;
  const train=Array.from(new Map([...anchors,...Array.from(byPlayer.values()).flatMap(g=>g.sales)].map(s=>[s.id,s])).values());
  for(const [method,predicted] of [['learned-parallel',median(anchors.map(total))!*multiplier],['base-no-premium',median(anchors.map(total))!]] as const)parallel.push({id:target.id,entry:target.entry,day:target.day,n:anchors.length,method,actual:total(target),predicted,trainingIds:train.map(s=>s.id),uncertainTarget:target.uncertain,uncertainTraining:train.filter(s=>s.uncertain).length});
 }
 return {mode:includeUncertain?'including-uncertain':'displayed-auction-only',eligibleListings:sales.length,predictions,parallel,gaps};
}
export function metrics(rows:Prediction[]){return {targets:rows.length,distinctCards:new Set(rows.map(r=>r.entry)).size,maeCents:rows.length?rows.reduce((n,r)=>n+Math.abs(r.predicted-r.actual),0)/rows.length:null,medianAbsolutePercentError:median(rows.map(r=>Math.abs(r.predicted-r.actual)/r.actual*100)),biasCents:rows.length?rows.reduce((n,r)=>n+r.predicted-r.actual,0)/rows.length:null,within20Percent:rows.length?rows.filter(r=>Math.abs(r.predicted-r.actual)/r.actual<=.2).length/rows.length:null,uncertainTargets:rows.filter(r=>r.uncertainTarget).length,targetsUsingUncertainTraining:rows.filter(r=>r.uncertainTraining>0).length};}
export function summarizeBacktest(run:ReturnType<typeof runBacktest>){
 const summary=compCounts.map(n=>({n,...metrics(run.predictions.filter(r=>r.n===n&&r.method==='landed-median')),coverage:run.eligibleListings?run.predictions.filter(r=>r.n===n&&r.method==='landed-median').length/run.eligibleListings:0}));
 const paired=compCounts.filter(n=>n>1).map(n=>{const high=run.predictions.filter(r=>r.n===n&&r.method==='landed-median');const ids=new Set(high.map(r=>r.id));return {n,one:metrics(run.predictions.filter(r=>r.n===1&&r.method==='landed-median'&&ids.has(r.id))),many:metrics(high)};});
 const shipping=compCounts.flatMap(n=>['item-only','item-plus-historical-shipping','landed-median'].map(method=>({n,method,...metrics(run.predictions.filter(r=>r.n===n&&r.method===method))})));
 return {mode:run.mode,eligibleListings:run.eligibleListings,counts:summary,pairedCounts:paired,shipping,parallel:['learned-parallel','base-no-premium'].map(method=>({method,...metrics(run.parallel.filter(r=>r.method===method))})),gaps:run.gaps};
}
