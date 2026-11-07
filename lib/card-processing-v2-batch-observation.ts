import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {digest,type V2Card,type V2Payload} from './card-processing-v2.ts';
import {assessV2Description} from './card-processing-v2-description.ts';

const ref=z.object({path:z.string().min(1),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const V2_BATCH_ROW_OBSERVATION='saved-reopened-draft-batch-row-nonprice-observation' as const;
export const v2BatchRowObservationSchema=z.object({
 kind:z.literal(V2_BATCH_ROW_OBSERVATION),draftId:z.string().regex(/^\d+$/),workspaceUrl:z.string().url(),observedAt:z.string().datetime(),
 scope:z.literal('non-price-fields; pricing left untouched per seller'),priceWritePerformed:z.literal(false),
 row:z.object({draftId:z.string().regex(/^\d+$/),sku:z.string().min(1),title:z.string(),quantity:z.string(),categoryPath:z.string(),conditionLabel:z.string(),schedulingLabel:z.string(),paymentPolicy:z.string(),returnPolicy:z.string(),shippingPolicy:z.string()}).strict(),
 specifics:z.record(z.string(),z.array(z.string())),description:z.string(),photos:z.array(z.string()).max(24),
 location:z.object({source:z.literal('saved-bulk-location-dialog'),postalCode:z.string(),city:z.string(),country:z.string(),eligibleCount:z.number().int().positive().max(20),targetDraftIds:z.array(z.string().regex(/^\d+$/)).min(1).max(20),evidence:ref}).strict(),
 observationSource:z.literal('dedicated-browser-visible-bulk-dom').optional(),
}).passthrough();
export type V2BatchRowObservation=z.infer<typeof v2BatchRowObservationSchema>;
export const isV2BatchRowObservation=(value:unknown):value is V2BatchRowObservation=>!!value&&typeof value==='object'&&'kind'in value&&value.kind===V2_BATCH_ROW_OBSERVATION;
const resource=(value:string)=>/\/(?:z|images\/g)\/([^/]+)\//.exec(value)?.[1];
const normalized=(value:string)=>value.replace(/\s+/g,' ').trim();
const categories:Record<string,{leaf:string;parent:string}>={
 '261328':{leaf:'Trading Card Singles',parent:'Sports Mem, Cards & Fan Shop > Sports Trading Cards'},
 '183454':{leaf:'CCG Individual Cards',parent:'Toys & Hobbies > Collectible Card Games'},
 '183050':{leaf:'Trading Card Singles',parent:'Collectibles > Non-Sport Trading Cards'},
};
export function assertV2BatchObservedCategory(raw:unknown,categoryId:string){
 const x=v2BatchRowObservationSchema.parse(raw),category=categories[categoryId],actual=normalized(x.row.categoryPath);
 if(!category||![`${category.leaf} in ${category.parent}`,`${category.leaf}in ${category.parent}`,`${category.parent} > ${category.leaf}`].includes(actual))throw Error('Actual batch category path differs from the supported catalog');
}
/** Actual bulk values remain a separate observation type. No individual-editor
 * URL, AX transcript, photos or item specifics are manufactured from a payload. */
export function assertV2BatchRowValues(raw:unknown,card:V2Card,payload:V2Payload,now=Date.now()){
 const x=v2BatchRowObservationSchema.parse(raw),url=new URL(x.workspaceUrl),age=now-Date.parse(x.observedAt);
 if(url.origin!=='https://www.ebay.com'||url.pathname!=='/bulksell'||!url.searchParams.get('workspaceId')||url.username||url.password||url.hash)throw Error('Actual native batch workspace required');
 if(!Number.isFinite(age)||age<0||age>3600000)throw Error('Fresh saved batch observation required');
 if(x.draftId!==x.row.draftId||card.draftId!==x.draftId||card.sku!==x.row.sku||payload.sku!==x.row.sku||x.row.title!==payload.title||x.row.quantity!==String(payload.quantity))throw Error('Actual batch DraftID/SKU/title/quantity binding differs');
 assertV2BatchObservedCategory(x,payload.categoryId);
 // Exact localized NM display grounded by native same-draft select[name=40001]=400010;
 // artifacts/sparkle-next38-20261106/native-condition-selected-code.json (2026-11-06).
 if(payload.conditionId!=='4000'||!['400010','Near mint or better - (ID: 400010)'].includes(payload.conditionDescriptorValue)||!['Card Condition','Card Condition - (ID: 40001)'].includes(payload.conditionDescriptorName)||!/^Ungraded,\s*(?:Near mint or better|几乎完好或更好)$/i.test(normalized(x.row.conditionLabel)))throw Error('Actual batch raw Near Mint condition differs');
 if(x.row.schedulingLabel!=='Immediate')throw Error('Actual batch scheduling is not immediate');
 if(x.photos.length!==2||x.photos.some((photo,n)=>!resource(photo)||resource(photo)!==resource(payload.photos[n].url)))throw Error('Actual batch original photo resources/order differ');
 const specifics:Record<string,string[]>={};for(const name of Object.keys(payload.specifics)){const actual=x.specifics[name];if(!actual||digest([...actual].sort())!==digest([...payload.specifics[name]].sort()))throw Error(`Actual batch specific differs: ${name}`);specifics[name]=actual;}
 if(!card.identity||!assessV2Description(x.description,card.identity).acceptable)throw Error('Actual batch description requires factual review');
 if(!/eBay Managed Payments \(248164941010\)/.test(x.row.paymentPolicy)||!/^No Return Accepted \(248164940010\)$/.test(x.row.returnPolicy))throw Error('Actual batch payment/no-return policy differs');
 if(!/^75167(?:-\d{4})?$/.test(x.location.postalCode)||!/^Waxahachie(?:,?\s+(?:TX|Texas))?$/i.test(x.location.city)||x.location.country!=='US')throw Error('Actual batch item location differs');
 if(x.location.eligibleCount!==x.location.targetDraftIds.length||new Set(x.location.targetDraftIds).size!==x.location.targetDraftIds.length||!x.location.targetDraftIds.includes(x.draftId))throw Error('Saved batch location eligibility differs from exact draft membership');
 return{x,specifics,description:x.description,shippingPolicy:x.row.shippingPolicy};
}
/** The final verification gate reads the saved common dialog source, rather
 * than trusting a location filled from expected values. */
export async function validateV2BatchObservationSources(root:string,raw:unknown,earliestObservedAt?:string){
 if(!isV2BatchRowObservation(raw))return;
 const x=v2BatchRowObservationSchema.parse(raw);
 const r=x.location.evidence;if(path.isAbsolute(r.path)||r.path.split(/[\\/]/).includes('..'))throw Error('Saved location source must remain under artifacts');
 const base=await fs.realpath(path.join(root,'artifacts')),file=await fs.realpath(path.resolve(root,r.path)),relative=path.relative(base,file),stat=await fs.lstat(file);
 if(!relative||relative.startsWith('..')||path.isAbsolute(relative)||!stat.isFile()||stat.isSymbolicLink()||stat.size>1000000)throw Error('Bounded shared-save source required');
 const bytes=await fs.readFile(file);if(createHash('sha256').update(bytes).digest('hex')!==r.sha256)throw Error('Saved location source SHA changed');
 const source=z.object({kind:z.literal('saved-bulk-location-dialog'),workspaceUrl:z.string().url(),observedAt:z.string().datetime(),postalCode:z.string(),city:z.string(),country:z.string(),eligibleCount:z.number().int().positive().max(20),targetDraftIds:z.array(z.string().regex(/^\d+$/)).min(1).max(20)}).passthrough().parse(JSON.parse(bytes.toString('utf8')));
 if(source.workspaceUrl!==x.workspaceUrl||source.postalCode!==x.location.postalCode||source.city!==x.location.city||source.country!==x.location.country||source.eligibleCount!==x.location.eligibleCount||digest(source.targetDraftIds)!==digest(x.location.targetDraftIds)||Math.abs(Date.parse(source.observedAt)-Date.parse(x.observedAt))>300000||earliestObservedAt&&Date.parse(source.observedAt)<Date.parse(earliestObservedAt))throw Error('Actual saved location dialog does not bind this batch row');
}
export function buildV2BatchNonpriceReview(raw:unknown,card:V2Card,payload:V2Payload,evidence:z.infer<typeof ref>,now=Date.now()){
 const{x,specifics,description,shippingPolicy}=assertV2BatchRowValues(raw,card,payload,now);
 return{cardId:card.id,captureId:card.captureId,sku:card.sku,draftId:x.draftId,observedAt:x.observedAt,evidence,scope:'non-price-fields' as const,checks:Object.fromEntries(['sameId','title','sku','quantity','categoryMatched','specifics','rawCondition','nearMint','exactPhotosInOrder','descriptionReviewed','paymentPresent','returnsPresent','locationPresent','notScheduled'].map(name=>[name,true])),aspectChecks:Object.fromEntries(Object.keys(specifics).map(name=>[name,true])),specifics,description,pricing:{status:'deferred-preserved' as const,owner:'Grok' as const,writesPerformed:false as const,sourceNotInferred:true as const},shipping:{status:'deferred-preserved' as const,observedPolicy:shippingPolicy,writesPerformed:false as const},fullUnpricedVerification:false as const,passed:true as const};
}
