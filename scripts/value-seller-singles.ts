import { valueLatestSellerSingles } from "../lib/seller-single-valuations.ts";

const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : undefined;
if (limit != null && (!Number.isInteger(limit) || limit <= 0)) throw new Error("--limit must be a positive integer");

async function main() {
  const result = await valueLatestSellerSingles({ limit });
  if (limit) console.log(JSON.stringify(result, null, 2));
  else {
    const counts=(key:"confidence"|"recommendation")=>Object.fromEntries(result.summaries.reduce((map,row)=>map.set(String(row[key]),(map.get(String(row[key]))??0)+1),new Map<string,number>()));
    console.log(JSON.stringify({runId:result.runId,processed:result.processed,telemetry:result.telemetry,valued:result.summaries.filter(row=>row.estimatedMarketValue!=null).length,confidence:counts("confidence"),recommendations:counts("recommendation")},null,2));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
