import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import sharp from "sharp";
import { prepareBenchmarkPacket } from "../lib/benchmark-preparation.ts";
import { cardPreviewCache, renderCardPreview } from "../lib/card-preview-cache.ts";

async function main() {
  const args=process.argv.slice(2);
  if(args.length!==0&&args.length!==2)throw Error("Supply both saved selected-input.json and handoff-input.json paths, or neither.");
  const pinnedInputs=args.length===2?{selected:args[0],handoff:args[1]}:undefined;
  const root = `artifacts/model-benchmark/preparation-timing-${Date.now()}`;
  mkdirSync(root, { recursive: true });
  const rounds = [];
  const cache = cardPreviewCache(`${root}/preview-cache`);
  const coldOut = `${root}/cold-cache`; mkdirSync(coldOut);
  const cold = await prepareBenchmarkPacket(coldOut, cache.render,pinnedInputs);
  assert.equal(cold.cards,5,"Full-pipeline timing requires all five selected cards; inspect cold-cache/exceptions.json.");
  assert.equal(cold.exceptions.length,0,"Resolve preparation exceptions before measuring throughput.");
  const inputs={selected:`${coldOut}/selected-input.json`,handoff:`${coldOut}/handoff-input.json`};
  for (let i = 0; i < 5; i++) {
    const out = `${root}/baseline-${i}`; mkdirSync(out);
    const cachedOut = `${root}/cached-${i}`; mkdirSync(cachedOut);
    let cached, result;
    if (i % 2) { cached = await prepareBenchmarkPacket(cachedOut, cache.render,inputs); result = await prepareBenchmarkPacket(out, renderCardPreview,inputs); }
    else { result = await prepareBenchmarkPacket(out, renderCardPreview,inputs); cached = await prepareBenchmarkPacket(cachedOut, cache.render,inputs); }
    for (const name of ["five-card-cases.json", "case-lineage.json", "exceptions.json"]) assert.equal(readFileSync(`${out}/${name}`, "utf8"), readFileSync(`${cachedOut}/${name}`, "utf8"));
    if (i) assert.equal(readFileSync(`${out}/five-card-cases.json`, "utf8"), readFileSync(`${root}/baseline-0/five-card-cases.json`, "utf8"));
    rounds.push({ baseline: result, cached });
  }
  const median = (values: number[]) => [...values].sort((a,b) => a-b)[Math.floor(values.length/2)];
  const before = median(rounds.map(r=>r.baseline.timings.total)), after = median(rounds.map(r=>r.cached.timings.total));
  const report = { root, cold, rounds, cache: cache.stats, beforeMs: before, afterMs: after, reductionPercent: 100*(1-after/before), byteIdenticalOutputs: true };
  writeFileSync(`${root}/timings.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Preparation measurement failed"); process.exitCode = 1; });
