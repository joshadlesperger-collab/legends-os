import {v2IdentificationAccounting} from './card-processing-v2-accounting.ts';
import {inspectV2SelectedMedia,inspectV2KnownCategories} from './card-processing-v2-media-preflight.ts';
import fs from 'node:fs/promises';
import path from 'node:path';
import {digest,type V2State} from './card-processing-v2.ts';
import {readV2Config,readV2State,v2Dir,type V2Config} from './card-processing-v2-store.ts';
import {resolveV2Selection,type ResolvedV2Selection} from './card-processing-v2-selection.ts';
import {loadV2IdentificationContext,validateV2BatchContextPacket,registerV2BatchContext} from './card-processing-v2-batch-context.ts';
import {replaceV2Checkpoint} from './card-processing-v2-atomic-replace.ts';

export class V2ReadinessError extends Error {report:V2ReadinessReport;constructor(report:V2ReadinessReport){super('Batch readiness needs attention before processing.');this.report=report;}}
/** Worst-case bounds, not an estimate or permission to increase the existing cumulative cap. */
export function v2BatchBudget(state:V2State,config:V2Config,selected:ResolvedV2Selection,now=Date.now()){
 const accounting=v2IdentificationAccounting(state.calls),pending=accounting.pendingUsage;
 const required=selected.captures.filter(c=>{
  const card=c.cardId?state.cards[c.cardId]:undefined;
  return !card?.identity&&!state.knowledge[digest(c.photos.map(p=>p.hash))];
 }).length;
 const settings=config.identification;
 const reserve=settings?Math.ceil(settings.maxInputTokens*settings.inputUsdPerMillion+settings.maxOutputTokens*settings.outputUsdPerMillion):0;
 const committed=accounting.committedMicros;
 const upperBound=reserve*required,available=(settings?.capMicros??0)-committed;
 const valid=[reserve,committed,upperBound,available].every(Number.isSafeInteger);
 return {requiredCalls:required,committedMicros:committed,availableMicros:available,reservePerCallMicros:reserve,batchUpperBoundMicros:upperBound,shortfallMicros:Math.max(0,upperBound-available),pendingUsage:pending,
  boundedPendingReservationMicros:accounting.boundedPendingReservationMicros,unboundedPendingUsage:!accounting.safe,
  ready:required===0||!!settings&&Date.parse(settings.expiresAt)>now&&accounting.safe&&valid&&reserve>0&&upperBound<=available,
  costIsEstimate:false,capAutomaticallyRaised:false};
}
type ContextPlan={packet:Awaited<ReturnType<typeof validateV2BatchContextPacket>>['packet'];candidateIds:string[]};
async function contextPlan(root:string,selected:ResolvedV2Selection):Promise<ContextPlan|undefined>{
 const file=path.join(v2Dir(root),'next-batch-context.json');let profile;
 try{const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>262144)throw Error('Invalid prepared context');profile=JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
 if(profile.version!==1||!Array.isArray(profile.candidateIds)||profile.candidateIds.length===0||new Set(profile.candidateIds).size!==profile.candidateIds.length)throw Error('Invalid prepared context');
 // A different product batch never inherits the previous batch's profile.
 const matches=selected.candidateIds.filter(id=>profile.candidateIds.includes(id));
 if(!matches.length)return;
 if(matches.length!==selected.candidateIds.length)throw Error('Mixed prepared and unprepared context selection');
 const packet={...profile.packet,selection:{mode:'selected',token:selected.token,candidateIds:selected.candidateIds}};
 const checked=await validateV2BatchContextPacket(root,packet);
 return {packet:checked.packet,candidateIds:matches};
}
/** Explicit setup binds a reusable verified reference only to the current original pairs. */
export async function prepareV2NextBatchContext(root:string,raw:unknown){
 const checked=await validateV2BatchContextPacket(root,raw),dir=v2Dir(root);await fs.mkdir(dir,{recursive:true});
 const file=path.join(dir,'next-batch-context.json'),tmp=file+'.'+crypto.randomUUID()+'.tmp';
 await fs.writeFile(tmp,JSON.stringify({version:1,preparedAt:new Date().toISOString(),candidateIds:checked.selection.candidateIds,packet:checked.packet}),{flag:'wx',flush:true});await replaceV2Checkpoint(tmp,file);
 return {prepared:checked.selection.captures.length,registered:0,providerCalls:0,processingStarted:false};
}
export type V2ReadinessReport={version:1;observedAt:string;selectedCards:number;selectedPhotos:number;ready:boolean;blockers:string[];budget:ReturnType<typeof v2BatchBudget>;seller:'not-checked'|'verified'|'failed';contextPairs:number;photoUploadAccess:'not-tested-until-upload';providerCalls:0;listingWrites:0;selectionToken:string;media?:Awaited<ReturnType<typeof inspectV2SelectedMedia>>;categories?:ReturnType<typeof inspectV2KnownCategories>};
/** Real start gate. Reads originals and existing accounting; never sends an AI request or uploads a photo. */
export async function inspectV2Readiness(root:string,selection:unknown,options:{verifySeller?:()=>Promise<unknown>;providerConfigured?:boolean}={}){
 const selected=await resolveV2Selection(root,selection),[state,config]=await Promise.all([readV2State(root),readV2Config(root)]);
 const budget=v2BatchBudget(state,config,selected),blockers:string[]=[];
 if(selected.activationRequired)return {selected,report:{version:1,observedAt:new Date().toISOString(),selectedCards:0,selectedPhotos:0,ready:true,blockers:[],budget,seller:'not-checked',contextPairs:0,photoUploadAccess:'not-tested-until-upload',providerCalls:0,listingWrites:0,selectionToken:selected.token} as V2ReadinessReport};
 if(!budget.ready)blockers.push(budget.unboundedPendingUsage?'Reconcile pending identification usage without a valid worst-case bound before starting.':`Identification budget needs ${budget.batchUpperBoundMicros/1e6} USD worst-case headroom; ${Math.max(0,budget.availableMicros)/1e6} USD remains. The spending limit was not increased.`);
 if(budget.requiredCalls&&!(options.providerConfigured??!!process.env.OPENAI_API_KEY?.trim()))blockers.push('Identification provider is not configured.');
 let contextPairs=0;
 try{const needsIdentification=selected.captures.some(c=>!c.cardId||!state.cards[c.cardId]?.identity);const plan=needsIdentification?await contextPlan(root,selected):undefined;if(plan)contextPairs=plan.candidateIds.length;else for(const c of selected.captures)if((!c.cardId||!state.cards[c.cardId]?.identity)&&await loadV2IdentificationContext(root,{photos:c.photos}))contextPairs++;}catch{blockers.push('Prepared product context is stale, changed or mixed. Refresh the exact selected batch context.');}
 const media=await inspectV2SelectedMedia(root,selected.captures),categories=inspectV2KnownCategories(state,config,selected.captures);
 if(!media.ready)blockers.push('A selected original photo is changed, unsupported or cannot be fully decoded. No paid identification may start.');
 if(!categories.ready)blockers.push('Known selected categories need fresh supported item-specific and condition metadata before processing.');
 let seller:V2ReadinessReport['seller']='not-checked';
 if(!blockers.length&&options.verifySeller){try{await options.verifySeller();seller='verified';}catch{seller='failed';blockers.push('Seller connection could not be verified. Restore the existing seller connection before processing.');}}
 const report:V2ReadinessReport={version:1,observedAt:new Date().toISOString(),selectedCards:selected.captures.length,selectedPhotos:selected.captures.length*2,ready:blockers.length===0,blockers:Array.from(new Set(blockers)),budget,seller,contextPairs,photoUploadAccess:'not-tested-until-upload',providerCalls:0,listingWrites:0,selectionToken:selected.token,media,categories};
 return {selected,report};
}
export async function activateV2PreparedContext(root:string,selected:ResolvedV2Selection){const state=await readV2State(root);if(selected.captures.every(c=>c.cardId&&state.cards[c.cardId]?.identity))return {registered:0};const plan=await contextPlan(root,selected);if(plan)return registerV2BatchContext(root,plan.packet);return {registered:0};}
