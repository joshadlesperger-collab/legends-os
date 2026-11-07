import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseBenchmarkCases, type BenchmarkCase } from "./ai-benchmark.ts";

// Read-only source selection. Derived previews and evidence copies remain local.
export async function prepareBenchmarkPacket(outputRoot: string, preview: (bytes: Buffer) => Promise<Buffer>, inputs?: { selected: string; handoff: string }) {
const started = performance.now();
const timings = { readInputs: 0, verifyOriginals: 0, previews: 0, assemble: 0, validate: 0, write: 0, total: 0 };
let tick = performance.now();
const root = "artifacts/model-benchmark";
const selectedPath=inputs?.selected ?? `${root}/selected-cards.json`;
const handoffPath=inputs?.handoff ?? "artifacts/card-orchestrator/handoff.json";
const selectedText=readFileSync(selectedPath,"utf8"),handoffText=readFileSync(handoffPath,"utf8");
const selected = JSON.parse(selectedText),handoff = JSON.parse(handoffText);
const outputNames=["five-card-cases.json","case-lineage.json","exceptions.json","selected-input.json","handoff-input.json","input-provenance.json"];
if(outputNames.some(name=>existsSync(`${outputRoot}/${name}`)))throw Error("Prepared output already exists; choose a new directory to preserve evidence.");
timings.readInputs = performance.now() - tick;
const cases: BenchmarkCase[] = [];
const lineage = [];
const exceptions = [];
for (const card of selected.cards) {
const caseStart = cases.length;
try {
  const packet = handoff.cards.find((row: { id: string }) => row.id === card.id);
  if (!packet) throw Error("Fresh exact-card preflight required.");
  const images = [];
  for (const photo of card.photos) {
    tick = performance.now();
    const bytes = readFileSync(photo.resolvedPath);
    if (createHash("sha256").update(bytes).digest("hex") !== photo.sha256) throw Error("Original photo hash mismatch.");
    timings.verifyOriginals += performance.now() - tick;
    tick = performance.now();
    const prepared = await preview(bytes);
    timings.previews += performance.now() - tick;
    images.push(`data:image/jpeg;base64,${prepared.toString("base64")}`);
  }
  tick = performance.now();
  const identity = card.identity;
  cases.push({ kind: "recognition", id: `${card.id}:recognition`, images,
    expected: { pairMatches: true, frontImageIndex: "0", identity: {
      player: identity.player, manufacturer: identity.manufacturer, set: identity.set,
      cardNumber: identity.cardNumber, parallel: identity.parallel, serialNumber: identity.serial || null,
      numberedTo: identity.printRun, autograph: identity.autograph,
    } } });
  const pricing = card.source.jobs.pricing;
  const projection = pricing.result?.projection;
  const current = projection?.policyVersion === handoff.policyVersion;
  const expectedHold = !current || pricing.state !== "done" || pricing.result?.comps?.some((comp: { shipping: unknown }) => comp.shipping == null);
  cases.push({ kind: "pricing", id: `${card.id}:pricing`,
    evidence: { identity, comps: pricing.result?.comps ?? [], basis: pricing.result?.basis ?? null,
      exactSearchEvidence: pricing.result?.exactSearchEvidence ?? null,
      reviewEstimate: pricing.result?.reviewEstimate ?? true, evidence: pricing.result?.evidence ?? pricing.reason,
      policyReconciliationRequired: !current, retainedPolicy: projection?.policyVersion ?? null },
    ...(expectedHold ? { expectedHold: true } : { baseline: { buyerTotal: projection.buyerTotal, shipping: projection.shipping } }) });
  // Validate this card before admitting its lineage; malformed evidence must not
  // invalidate independent cards at the final packet validation step.
  parseBenchmarkCases({ cases: cases.slice(caseStart) });
  lineage.push({ id: card.id, category: card.category, pricingExpected: expectedHold ? "hold" : "current-policy-proposal",
    sourceDigest: card.sourceDigest, pricingReview: packet.pricing, nextOwner: packet.nextOwner, blockers: packet.blockers });
  timings.assemble += performance.now() - tick;
} catch (error) {
  cases.splice(caseStart);
  exceptions.push({ cardId: card.id, reason: error instanceof Error ? error.message : "Preparation failed" });
}
}
tick = performance.now();
const parsed = cases.length ? parseBenchmarkCases({ cases }) : { cases: [] };
timings.validate = performance.now() - tick;
tick = performance.now();
const save=(name:string,text:string)=>writeFileSync(`${outputRoot}/${name}`,text,{flag:"wx"});
save("selected-input.json",selectedText);save("handoff-input.json",handoffText);
save("input-provenance.json",JSON.stringify({selected:{path:selectedPath,sha256:createHash("sha256").update(selectedText).digest("hex")},handoff:{path:handoffPath,sha256:createHash("sha256").update(handoffText).digest("hex")},scope:"Saved benchmark evidence only; not a fresh listing authorization"},null,2));
save("five-card-cases.json", JSON.stringify({ schema: "legends-model-benchmark-cases-v1", cases: parsed.cases }, null, 2));
save("case-lineage.json", JSON.stringify({ asOf: handoff.asOf, cards: lineage }, null, 2));
save("exceptions.json", JSON.stringify(exceptions, null, 2));
timings.write = performance.now() - tick;
timings.total = performance.now() - started;
return { timings, cards: lineage.length, cases: parsed.cases.length, exceptions };
}
