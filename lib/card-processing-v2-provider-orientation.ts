/** First-pass derivative instructions from the single paid original-pair result.
 * Originals and the raw upright=false observation are never changed. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {digest,identificationSchema,photoSchema,type V2State} from './card-processing-v2.ts';
import {readV2State} from './card-processing-v2-store.ts';
import {retainedV2BackOrientation} from './card-processing-v2-retained-orientation.ts';

const hash=z.string().regex(/^[a-f0-9]{64}$/),ref=z.object({path:z.string().min(1),sha256:hash}).strict();
const originalSchema=z.object({kind:z.literal('original-openai-identification-result'),callId:z.string().uuid(),cardId:z.string(),model:z.string(),observedAt:z.string().datetime(),inputPhotos:z.array(photoSchema).length(2),finding:identificationSchema,inputTokens:z.number().int().nonnegative(),outputTokens:z.number().int().nonnegative()}).passthrough();
const registrySchema=z.object({kind:z.literal('provider-derived-photo-orientation-v1'),callId:z.string().uuid(),cardId:z.string(),captureId:hash,original:ref,inputClockwiseDegrees:z.tuple([z.literal(270),z.literal(0)])}).strict();
export type V2ProviderOrientation={kind:'provider-derived';callId:string;original:z.infer<typeof ref>;registry:z.infer<typeof ref>};
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
async function evidence(root:string,r:z.infer<typeof ref>){
 if(path.isAbsolute(r.path)||r.path.split(/[\\/]/).includes('..'))throw Error('Provider orientation evidence outside artifacts');
 const base=await fs.realpath(path.join(root,'artifacts')),absolute=path.join(root,r.path),actual=await fs.realpath(absolute),relative=path.relative(base,actual),stat=await fs.lstat(absolute);
 if(!relative||relative.startsWith('..')||path.isAbsolute(relative)||!stat.isFile()||stat.isSymbolicLink()||stat.size>1_000_000)throw Error('Bounded immutable provider orientation evidence required');
 const bytes=await fs.readFile(actual);if(sha(bytes)!==r.sha256)throw Error('Provider orientation evidence changed');return bytes;
}
function binding(state:V2State,cardId:string,original:z.infer<typeof originalSchema>){
 const card=state.cards[cardId],call=state.calls.find(c=>c.id===original.callId);
 if(!card||original.cardId!==cardId||!call||call.cardId!==cardId||call.status!=='settled'||call.model!==original.model||call.inputTokens!==original.inputTokens||call.outputTokens!==original.outputTokens
  ||!call.bound||original.inputTokens>call.bound.maxInputTokens||original.outputTokens>call.bound.maxOutputTokens||call.actualMicros!==Math.ceil(original.inputTokens*call.bound.inputUsdPerMillion+original.outputTokens*call.bound.outputUsdPerMillion)
  ||call.key!==digest(['openai-identification-v2',original.inputPhotos.map(p=>p.hash),call.model])
  ||new Set(original.inputPhotos.map(p=>p.hash)).size!==2||digest(card.photos.map(p=>p.hash).sort())!==digest(original.inputPhotos.map(p=>p.hash).sort()))throw Error('Exact settled original-pair accounting and photo binding required');
 const orientation=retainedV2BackOrientation(original.finding);if(!orientation)throw Error('Original finding has unresolved identity, damage or orientation');
 return{card,call,orientation};
}
/** Called only in the already-owned identification result commit, after usage
 * settlement. A failed state commit leaves an unreferenced immutable file, not
 * permission to repeat a provider call or use an unsettled rotation. */
export async function retainV2ProviderOrientation(root:string,state:V2State,cardId:string,originalRef:z.infer<typeof ref>):Promise<V2ProviderOrientation|undefined>{
 const original=originalSchema.parse(JSON.parse((await evidence(root,originalRef)).toString('utf8')));
 if(!retainedV2BackOrientation(original.finding))return undefined;
 const {card}=binding(state,cardId,original);
 if(state.lastRun?.status!=='running'||state.lastRun.pid!==process.pid||card.draftId||card.inventoryArchive||card.nonpriceVerification||state.calls.filter(c=>c.cardId===cardId).length!==1
  ||Object.values(state.submissions).some(s=>s.payload.captureIds.includes(card.captureId))
  ||originalRef.path!==`artifacts/card-processing-v2/identification-results/${original.callId}.json`)throw Error('Only the current unsubmitted first-pass worker may register orientation');
 const body=registrySchema.parse({kind:'provider-derived-photo-orientation-v1',callId:original.callId,cardId,captureId:card.captureId,original:originalRef,inputClockwiseDegrees:[270,0]}),bytes=Buffer.from(JSON.stringify(body,null,2));
 const relative=`artifacts/card-processing-v2/provider-orientations/${original.callId}.json`,file=path.join(root,relative);await fs.mkdir(path.dirname(file),{recursive:true});
 if((await fs.lstat(path.dirname(file))).isSymbolicLink())throw Error('Provider orientation directory must be local');
 try{await fs.writeFile(file,bytes,{flag:'wx',flush:true});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST'||!bytes.equals(await fs.readFile(file)))throw e;}
 return{kind:'provider-derived',callId:original.callId,original:originalRef,registry:{path:relative,sha256:sha(bytes)}};
}
export async function readV2ProviderPhotoRotations(root:string,options:{state?:V2State;cardIds?:string[]}={}){
 const state=options.state??await readV2State(root),selected=options.cardIds?new Set(options.cardIds):undefined;
 const rows:Array<{cardId:string;captureId:string;photo:z.infer<typeof photoSchema>&{clockwiseDegrees:0|90|180|270;visualEvidence:z.infer<typeof ref>};source:z.infer<typeof ref>}>=[];
 for(const card of Object.values(state.cards)){
  if(selected&&!selected.has(card.id)||!card.providerOrientation)continue;
  const marker=card.providerOrientation,record=registrySchema.parse(JSON.parse((await evidence(root,marker.registry)).toString('utf8')));
  if(record.callId!==marker.callId||record.cardId!==card.id||record.captureId!==card.captureId||digest(record.original)!==digest(marker.original)||record.original.path!==`artifacts/card-processing-v2/identification-results/${record.callId}.json`
   ||marker.registry.path!==`artifacts/card-processing-v2/provider-orientations/${record.callId}.json`)throw Error('Provider orientation marker ownership changed');
  const original=originalSchema.parse(JSON.parse((await evidence(root,record.original)).toString('utf8'))),{call}=binding(state,card.id,original);
  if(card.identificationKey!==call.key)throw Error('Provider orientation identification ownership changed');
  for(const p of card.photos){const index=original.inputPhotos.findIndex(q=>q.hash===p.hash);rows.push({cardId:card.id,captureId:card.captureId,photo:{...p,clockwiseDegrees:record.inputClockwiseDegrees[index],visualEvidence:record.original},source:marker.registry});}
 }
 return rows;
}
