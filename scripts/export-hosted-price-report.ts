import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readV2PriceCheckReport,exportV2HostedPriceReport,V2_HOSTED_PRICE_REPORT} from '../lib/card-processing-v2-price-check-report.ts';

async function main(){
const destination=process.argv[2];
if(!destination||!path.isAbsolute(destination))throw Error('An absolute deployment source directory is required');
const report=await readV2PriceCheckReport();
const bytes=exportV2HostedPriceReport(report),file=path.join(destination,V2_HOSTED_PRICE_REPORT);
await fs.mkdir(path.dirname(file),{recursive:true});
await fs.writeFile(file,bytes,{flag:'wx'});
console.log(JSON.stringify({reportId:report.reportId,rows:report.rows.length,snapshotObservedAt:report.snapshotObservedAt,
 sha256:createHash('sha256').update(bytes).digest('hex'),destination:file,readOnly:true}));
}
main().catch(()=>{console.error('Price report export failed; existing files were preserved.');process.exitCode=1;});
