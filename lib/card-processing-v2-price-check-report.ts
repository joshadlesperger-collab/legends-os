import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {PriceCheckRow} from './card-processing-v2-price-check.ts';
import {assessV2Publication,V2_PUBLICATION_POLICY,type V2PublicationAssessment} from './card-processing-v2-publication-policy.ts';

const amount=z.number().int().nonnegative().max(100_000_000);
const optionalAmount=amount.nullable();
const timestamp=z.string().datetime({offset:true});
const text=z.string().max(10_000);
const compSchema=z.object({
 itemId:text,title:text,url:z.string().url(),itemCents:amount,shippingCents:amount,totalCents:amount,
 seller:text,observedAt:timestamp,identityProof:z.array(text).max(100),
 confidence:z.enum(['structured','title-supported']).optional(),warnings:z.array(text).max(100).optional(),
}).refine(c=>c.totalCents===c.itemCents+c.shippingCents,'Inconsistent comparable total');
const rowSchema=z.object({
 draftId:z.string().regex(/^\d{6,25}$/),title:text,quantity:z.number().int().positive().optional(),
 status:z.string().min(1).max(80),reason:text,flags:z.array(text).max(100),
 current:z.object({itemCents:optionalAmount,shippingCents:optionalAmount,observedAt:timestamp,
  source:z.enum(['retained-ebay-observation','manual-preview'])}).nullable(),
 currentItemCents:optionalAmount,shippingCents:optionalAmount,ourTotalCents:optionalAmount,
 watcherItemCents:optionalAmount,watcherTotalCents:optionalAmount,lowestComp:compSchema.nullable(),
 allowanceCents:optionalAmount,minQualifyingTotalCents:optionalAmount,maxQualifyingTotalCents:optionalAmount,
 gapCents:z.number().int().nullable(),gapPercent:z.number().finite().nullable(),
 compCount:z.number().int().nonnegative(),excludedCompCount:z.number().int().nonnegative(),
 limitations:z.array(text).max(200),canPublish:z.literal(false),
});
const reportSchema=z.object({
 status:z.literal('complete'),startedAt:timestamp,endedAt:timestamp,snapshotObservedAt:timestamp,
 totalDrafts:z.number().int().nonnegative().max(10_000),completedDrafts:z.number().int().nonnegative(),
 elapsedMs:z.number().int().nonnegative(),marketRequestCount:z.number().int().nonnegative(),
 aiRequests:z.literal(0),unattempted:z.literal(0),rows:z.array(rowSchema).max(10_000),
}).superRefine((r,ctx)=>{
 if(r.completedDrafts!==r.totalDrafts||r.rows.length!==r.totalDrafts||new Set(r.rows.map(row=>row.draftId)).size!==r.totalDrafts)
  ctx.addIssue({code:z.ZodIssueCode.custom,message:'Report scope is incomplete or duplicated'});
 if(Date.parse(r.endedAt)<Date.parse(r.startedAt)||Date.parse(r.snapshotObservedAt)>Date.parse(r.endedAt))
  ctx.addIssue({code:z.ZodIssueCode.custom,message:'Report timestamps are inconsistent'});
});
const evidenceSchema=z.object({path:z.string().min(1),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const marketSchema=z.object({minDeliveredCents:optionalAmount,maxDeliveredCents:optionalAmount,
 medianDeliveredCents:z.number().nonnegative().nullable(),matchedListingCount:z.number().int().nonnegative(),
 independentSellerCount:z.number().int().nonnegative().nullable(),observedSearchResultCount:z.number().int().nonnegative().nullable(),
 reportedSearchTotal:z.number().int().nonnegative().nullable(),bounded:z.literal(true)});
const pointerSchema=z.object({version:z.literal(1),reportId:z.string().regex(/^[a-zA-Z0-9-]+$/),
 evidence:evidenceSchema,marketSummaryEvidence:evidenceSchema.optional()}).strict();

export type V2PriceCheckReport=Omit<z.infer<typeof reportSchema>,'rows'>&{reportId:string;mode:'preview';canPublish:false;
 publicationPolicy:typeof V2_PUBLICATION_POLICY;rows:Array<z.infer<typeof rowSchema>&{publicationAssessment:V2PublicationAssessment;marketSummary:z.infer<typeof marketSchema>}>};

async function regular(file:string,limit:number){
 const stat=await fs.lstat(file);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>limit)throw Error('Invalid saved price report');
 return fs.readFile(file);
}

/** Reads a frozen report only. No eBay, card-state or market-provider dependencies. */
export async function readV2PriceCheckReport(root=process.cwd()):Promise<V2PriceCheckReport>{
 const pointer=pointerSchema.parse(JSON.parse((await regular(path.join(root,'artifacts/card-processing-v2/price-check/reports/latest.json'),8192)).toString()));
 const checked=async(ref:z.infer<typeof evidenceSchema>)=>{
  if(path.isAbsolute(ref.path)||!ref.path.replaceAll('\\','/').startsWith('artifacts/')||ref.path.split(/[\\/]/).includes('..'))throw Error('Price report must stay in local artifacts');
  const base=await fs.realpath(path.join(root,'artifacts')),file=await fs.realpath(path.join(root,ref.path)),relative=path.relative(base,file);
  if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw Error('Price report escaped local artifacts');
  const bytes=await regular(path.join(root,ref.path),8_000_000);
  if(createHash('sha256').update(bytes).digest('hex')!==ref.sha256)throw Error('Saved price report changed');
  return JSON.parse(bytes.toString());
 };
 const report=reportSchema.parse(await checked(pointer.evidence));
 let summaries:Record<string,z.infer<typeof marketSchema>>={};
 if(pointer.marketSummaryEvidence){
  const side=z.object({sourceReportSha256:z.string(),rows:z.record(z.string(),marketSchema)}).parse(await checked(pointer.marketSummaryEvidence));
  if(side.sourceReportSha256!==pointer.evidence.sha256)throw Error('Market summary belongs to another report');
  summaries=side.rows;
 }
 const rows=report.rows.map(row=>({...row,publicationAssessment:assessV2Publication(row as PriceCheckRow),
  marketSummary:summaries[row.draftId]??{minDeliveredCents:row.lowestComp?.totalCents??null,
   maxDeliveredCents:row.compCount===1?row.lowestComp?.totalCents??null:null,
   medianDeliveredCents:row.compCount===1?row.lowestComp?.totalCents??null:null,
   matchedListingCount:row.compCount,independentSellerCount:row.compCount===1?1:null,
   observedSearchResultCount:null,reportedSearchTotal:null,bounded:true as const}}));
 return{...report,rows,publicationPolicy:V2_PUBLICATION_POLICY,reportId:pointer.reportId,mode:'preview',canPublish:false};
}
