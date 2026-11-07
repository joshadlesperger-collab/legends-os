import { mkdirSync } from "node:fs";
import { prepareBenchmarkPacket } from "../lib/benchmark-preparation.ts";
import { cardPreviewCache } from "../lib/card-preview-cache.ts";
async function main() {
  const args=process.argv.slice(2);
  const value=(flag:string)=>{const i=args.indexOf(flag);return i<0?undefined:args[i+1];};
  const selected=value("--selected"),handoff=value("--handoff");
  if(args.length&&(!selected||!handoff||args.length!==4))throw Error("Supply both --selected FILE and --handoff FILE.");
  const out = "artifacts/model-benchmark/prepared-" + Date.now();
  mkdirSync(out, { recursive: true });
  const cache = cardPreviewCache("artifacts/model-benchmark/preview-cache-v1");
  const result = await prepareBenchmarkPacket(out, cache.render,selected&&handoff?{selected,handoff}:undefined);
  console.log(JSON.stringify({ out, ...result, cache: cache.stats, liveCalls: 0 }));
}
main().catch(() => { console.error("Benchmark preparation failed; existing packets and evidence preserved."); process.exitCode = 1; });
