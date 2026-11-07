import nextEnv from '@next/env';
import {resolve} from 'node:path';
import {writeFileSync} from 'node:fs';
import {prisma} from '../lib/prisma.ts';
import {getValidAccessToken} from '../lib/ebay.ts';
import {probeInventoryOffers} from '../lib/inventory-api-probe.mjs';
async function main(){
 nextEnv.loadEnvConfig(resolve(process.cwd(),'../legends-os'),true);
 let result:Record<string,unknown>={status:'blocked',writesPerformed:0};
 let stage='database';
 try {
  const stores=await prisma.store.findMany({where:{ebaySellerUsername:'imaydit58',isActive:true,connectionStatus:'connected'},take:2});
  if(stores.length!==1) result.blocker='Expected exactly one connected imaydit58 store';
  else {
   stage='oauth';
   const {accessToken}=await getValidAccessToken(stores[0]);
   result={status:'database-and-oauth-accessible',seller:'imaydit58',...(await probeInventoryOffers({token:accessToken,skus:['TEST-CSV-cactus13-0001','TEST-CSV-cactus13-0010']}))};
  }
 }catch(e){result.blocker='Existing configuration failed database/OAuth access';result.stage=stage;result.errorType=e instanceof Error?e.constructor.name:'unknown';result.errorCode=typeof e==='object'&&e&&'errorCode'in e?String(e.errorCode):'unclassified';const m=e instanceof Error?e.message:'';result.failureCategory=/URL|protocol|connection string/i.test(m)?'invalid-database-url':/reach database|connect/i.test(m)?'database-unreachable':/authentication|password/i.test(m)?'database-authentication':'unclassified';}
 finally{await prisma.$disconnect();}
 writeFileSync('artifacts/bulk-import-proof-20261025/existing-connection-classified.json',JSON.stringify(result,null,2),{flag:'wx'});
 console.log(JSON.stringify(result));
}
main().catch(()=>{console.error('Connection check could not complete; raw details suppressed');process.exitCode=1;});
