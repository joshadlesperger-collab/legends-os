import nextEnv from "@next/env";
async function main(){
  await import("../lib/prisma.ts");
  const developmentDatabaseUrl=process.env.DATABASE_URL;
  const useProductionEbayReadOnly=process.argv.includes("--production-ebay-read-only");
  nextEnv.loadEnvConfig(process.cwd(),!useProductionEbayReadOnly);
  if(developmentDatabaseUrl)process.env.DATABASE_URL=developmentDatabaseUrl;
  if(!developmentDatabaseUrl||process.env.DATABASE_URL!==developmentDatabaseUrl)throw new Error("Development database isolation could not be guaranteed.");
  const {runFreeEvidenceBenchmark}=await import("../lib/seller-free-evidence-benchmark.ts");
  console.log(JSON.stringify(await runFreeEvidenceBenchmark(),null,2));
}
main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
