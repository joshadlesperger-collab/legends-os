import {z} from 'zod';
import {categorySchema,digest,type V2Category} from './card-processing-v2.ts';
const date=z.string().datetime(),id=z.enum(['183454','261328','183050']);
const capability=z.object({categoryId:id,status:z.enum(['ready','blocked']),detail:z.string(),conditionHelpText:z.string().optional(),descriptorId:z.string().optional(),descriptorValueId:z.string().optional(),diagnostic:z.object({phase:z.literal('category-aspects'),code:z.enum(['READ_FAILED','SCHEMA_INVALID','UNSUPPORTED_CONTRACT']),httpStatus:z.number().int().optional(),paths:z.array(z.string().max(300)).max(20).optional()}).strict().optional()}).strict();
const evidence=z.object({resource:z.enum(['category-tree','category-aspects','condition-policies']),url:z.string().url(),observedAt:date,sha256:z.string().regex(/^[a-f0-9]{64}$/),body:z.unknown()}).strict();
const report=z.object({observedAt:date,categories:z.array(categorySchema),capabilities:z.array(capability),evidence:z.array(evidence).default([]),capabilityObservedAt:z.record(z.string(),date).default({})}).passthrough();
/** A partial category acquisition never replaces another category's facts or
 * observation time. Top-level time belongs to the newest acquisition only. */
export function mergeV2CategoryReports(retained:unknown,incoming:unknown,fallbackCategories:readonly V2Category[]=[],now=Date.now()){
 const next=report.parse(incoming),prior=retained==null?null:report.parse(retained),categories=new Map<string,V2Category>(),capabilities=new Map<string,z.infer<typeof capability>>(),capabilityObservedAt:Record<string,string>={};
 const validAt=(at:string)=>{if(Date.parse(at)>now)throw Error('Future category evidence cannot be merged');};
 for(const c of fallbackCategories){const parsed=categorySchema.parse(c);validAt(parsed.observedAt);categories.set(parsed.categoryId,parsed);}
 for(const r of [prior,next]){if(!r)continue;validAt(r.observedAt);if(new Set(r.categories.map(c=>c.categoryId)).size!==r.categories.length||new Set(r.capabilities.map(c=>c.categoryId)).size!==r.capabilities.length)throw Error('Duplicate category observation');
  for(const c of r.categories){validAt(c.observedAt);const old=categories.get(c.categoryId);if(old&&old.observedAt===c.observedAt&&digest(old)!==digest(c))throw Error('Conflicting same-time category evidence');if(!old||Date.parse(c.observedAt)>=Date.parse(old.observedAt))categories.set(c.categoryId,c);}
  for(const c of r.capabilities){const at=r.capabilityObservedAt[c.categoryId]??r.observedAt;validAt(at);if(!capabilities.has(c.categoryId)||Date.parse(at)>=Date.parse(capabilityObservedAt[c.categoryId])){capabilities.set(c.categoryId,c);capabilityObservedAt[c.categoryId]=at;}}
 }
 const allEvidence=new Map<string,z.infer<typeof evidence>>();for(const r of [prior,next])for(const e of r?.evidence??[]){validAt(e.observedAt);allEvidence.set(digest([e.resource,e.url,e.sha256,e.observedAt]),e);}
 return{observedAt:prior&&Date.parse(prior.observedAt)>Date.parse(next.observedAt)?prior.observedAt:next.observedAt,categories:Array.from(categories.values()),capabilities:Array.from(capabilities.values()),capabilityObservedAt,evidence:Array.from(allEvidence.values())};
}
