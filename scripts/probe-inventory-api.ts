import nextEnv from '@next/env';
import {writeFileSync} from 'node:fs';
import {prisma} from '../lib/prisma.ts';
import {getValidAccessToken} from '../lib/ebay.ts';
import {probeInventoryOffers} from '../lib/inventory-api-probe.mjs';
nextEnv.loadEnvConfig(process.cwd(),true);
const output='artifacts/bulk-import-proof-20261025/inventory-live-probe.json';
async function main() {
const start=performance.now();
let result: Record<string,unknown>;
try {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL unavailable');
  const stores=await prisma.store.findMany({where:{ebaySellerUsername:'imaydit58',isActive:true,connectionStatus:'connected'},take:2});
  if(stores.length!==1) throw new Error('Exactly one connected imaydit58 store required');
  const {accessToken}=await getValidAccessToken(stores[0]);
  result=await probeInventoryOffers({token:accessToken,skus:['TEST-CSV-cactus13-0001','TEST-CSV-cactus13-0010']});
} catch(error) {
  const known=error instanceof Error && ['DATABASE_URL unavailable','Exactly one connected imaydit58 store required'].includes(error.message);
  result={kind:'blocked-live-inventory-probe',writesPerformed:0,blocker:known?(error as Error).message:'Database/OAuth access failed; raw error suppressed to protect credentials'};
} finally { await prisma.$disconnect(); }
writeFileSync(output,JSON.stringify({...result,at:new Date().toISOString(),elapsedMs:performance.now()-start},null,2),{flag:'wx'});
console.log(JSON.stringify(result));
}
main().catch(()=>{console.error('Probe could not save evidence; existing evidence is never overwritten.');process.exitCode=1;});
