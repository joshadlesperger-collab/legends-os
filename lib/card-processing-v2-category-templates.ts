import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readV2FullCategoryTemplate, v2FullTemplateDraftOptionsSchema } from './card-processing-v2-transport.ts';
import { replaceV2Checkpoint } from './card-processing-v2-atomic-replace.ts';

const entry=v2FullTemplateDraftOptionsSchema.shape.template;
const registry=z.object({version:z.literal(1),templates:z.array(entry).max(10)}).strict();
const file=(root:string)=>path.join(root,'artifacts/card-processing-v2/category-templates.json');
export async function getV2CategoryTemplate(root:string,categoryId:string){
  let saved;try{saved=registry.parse(JSON.parse(await fs.readFile(file(root),'utf8')));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw Error('The current official category template must be connected before this batch can upload');throw error;}
  const matches=saved.templates.filter(t=>t.categoryId===categoryId);if(matches.length!==1)throw Error('The current official category template must be connected before this batch can upload');
  await readV2FullCategoryTemplate(root,matches[0]);return matches[0];
}
/** Registration consumes the actual download and receipt, never generated headers. */
export async function registerV2CategoryTemplate(root:string,raw:unknown){
 const source=entry.parse(raw);await readV2FullCategoryTemplate(root,source);let saved:z.infer<typeof registry>={version:1,templates:[]};
 try{saved=registry.parse(JSON.parse(await fs.readFile(file(root),'utf8')));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 saved.templates=saved.templates.filter(t=>t.categoryId!==source.categoryId).concat(source);
 const temporary=file(root)+'.'+randomUUID()+'.tmp';await fs.writeFile(temporary,JSON.stringify(saved,null,2),{flag:'wx',flush:true});await replaceV2Checkpoint(temporary,file(root));return{categoryId:source.categoryId,registered:true};
}

/** Refresh once only for a missing or demonstrably expired category source. */
export async function ensureV2CategoryTemplate(root:string,categoryId:string,download:(categoryId:'261328'|'183454'|'183050')=>Promise<z.infer<typeof entry>>){
 if(!['261328','183454','183050'].includes(categoryId))throw Error('Unsupported category template');
 try{return await getV2CategoryTemplate(root,categoryId);}catch(error){const message=error instanceof Error?error.message:'';let refresh=message==='The current official category template must be connected before this batch can upload';
  if(!refresh&&message==='Actual fresh category template receipt does not bind this source'){const saved=registry.parse(JSON.parse(await fs.readFile(file(root),'utf8'))),source=saved.templates.find(t=>t.categoryId===categoryId);if(source){const receipt=JSON.parse(await fs.readFile(path.resolve(root,source.receipt.path),'utf8'));refresh=Number.isFinite(Date.parse(receipt.downloadedAt))&&Date.now()-Date.parse(receipt.downloadedAt)>7*86400000;}}
  if(!refresh)throw error;const source=await download(categoryId as '261328'|'183454'|'183050');if(source.categoryId!==categoryId)throw Error('Downloaded category template differs');await registerV2CategoryTemplate(root,source);return await getV2CategoryTemplate(root,categoryId);
 }
}
