import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import type {V2FullTemplateDraftOptions} from '../../lib/card-processing-v2-transport.ts';

/** Isolated fixture from the retained actual 261328 technical header/condition
 * guide. Its sample Add/price/shipping row must never be exported. */
export async function fullTemplateFixture(root:string):Promise<V2FullTemplateDraftOptions>{
  await fs.mkdir(path.join(root,'artifacts'),{recursive:true});
  const reference=async(name:string,bytes:string|Uint8Array)=>{const relative=`artifacts/${name}`;await fs.writeFile(path.join(root,relative),bytes,{flag:'wx'});return{path:relative,sha256:createHash('sha256').update(bytes).digest('hex')};};
  const bytes=await fs.readFile(path.join(process.cwd(),'tests/fixtures/ebay-sports-261328-full-template-v1.csv'));
  const template=await reference('full-category-template.csv',bytes);
  const receipt=await reference('full-category-template-receipt.json',JSON.stringify({source:'actual Seller Hub Get template UI',sourcePage:'https://www.ebay.com/sh/reports/uploads',categoryId:'261328',artifact:template.path,sha256:template.sha256,bytes:bytes.length,downloadedAt:new Date().toISOString(),uploaded:false}));
  const defaults={location:'Waxahachie, Texas',paymentProfileName:'eBay Managed Payments (248164941010)',returnProfileName:'No Return Accepted (248164940010)',returnsAcceptedOption:'ReturnsNotAccepted' as const};
  const evidence=await reference('seller-policy-proof.json',JSON.stringify({kind:'actual-seller-owned-background-policy-read',seller:'imaydit58',observedAt:new Date().toISOString(),returnsAcceptedOption:defaults.returnsAcceptedOption,policies:{location:defaults.location,returns:'No Return Accepted'},observedProfiles:{payment:{name:defaults.paymentProfileName},returns:{name:defaults.returnProfileName}}}));
  return{template:{categoryId:'261328',template,receipt},defaults:{...defaults,evidence}};
}
