import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { draftCsv, historicalMethodReview, validateMethodProof, V2_TRANSPORT_CONTRACT, V2_LIVE_METHOD_CONTRACT, buildV2FullTemplateDraftCsv, readV2FullCategoryTemplate, fullCategoryDraftCsv, V2_FULL_CATEGORY_INFO } from "../lib/card-processing-v2-transport.ts";
import type { V2Payload } from "../lib/card-processing-v2.ts";
import {assertV2DraftOnlyCsv,parseV2FeedCsv} from '../lib/card-processing-v2-uploader.ts';
import {fullTemplateFixture} from './helpers/v2-full-template-fixture.ts';

const at = Date.parse("2026-11-03T10:00:00Z");
const payload = (n = 1): V2Payload => ({ sku: `V2-${n}`, captureIds: [String(n).repeat(64)], title: "2024 Topps Chrome Aaron Judge #1",
  categoryId: "261328", specifics: { Sport: ["Baseball"], Set: ["Topps Chrome"], "Player/Athlete": ["Aaron Judge"] }, quantity: 1,
  photos: [{ hash: "a".repeat(64), url: "https://i.ebayimg.com/front.jpg", expiresAt: "2026-11-05T00:00:00Z", upright: true },
    { hash: "b".repeat(64), url: "https://i.ebayimg.com/back.jpg", expiresAt: "2026-11-05T00:00:00Z", upright: true }],
  conditionId: "4000", conditionDescriptorName: "Card Condition - (ID: 40001)", conditionDescriptorValue: "Near mint or better - (ID: 400010)",
  condition: "Near mint or better", description: "The card shown in the photos. Near mint or better.", descriptionSource: "factual", pricing: "unpriced-grok-pending" });

async function fullFixture(run:(root:string,options:Awaited<ReturnType<typeof fullTemplateFixture>>)=>Promise<void>){const root=await fs.mkdtemp(path.join(os.tmpdir(),'v2-full-template-'));try{await run(root,await fullTemplateFixture(root));}finally{await fs.rm(root,{recursive:true,force:true});}}
test('full category contract preserves technical headers/long condition and observed defaults without sample, price or shipping values',()=>fullFixture(async(root,options)=>{
 const p=payload();p.specifics.Graded=['No'];p.specifics.Subset=['Verified subset'];const result=await buildV2FullTemplateDraftCsv(root,[p],options,at),parsed=assertV2DraftOnlyCsv(result.csv),headers=parsed.header.cells,row=parsed.rows[0].cells;
 const get=(name:string)=>row[headers.indexOf(name)];assert.ok(result.csv.startsWith(V2_FULL_CATEGORY_INFO+'\r\n'));assert.equal(headers.length,101);assert.equal(get('*ConditionID'),'4000');assert.equal(get('CD:Card Condition - (ID: 40001)'),p.conditionDescriptorValue);assert.equal(get('*Location'),options.defaults.location);assert.equal(get('ReturnProfileName'),options.defaults.returnProfileName);assert.equal(get('PaymentProfileName'),options.defaults.paymentProfileName);assert.equal(get('*ReturnsAcceptedOption'),'ReturnsNotAccepted');assert.equal(get('C:Graded'),'No');assert.equal(get('C:Subset'),'Verified subset');assert.deepEqual(result.binding.additionalSpecificHeaders,['C:Graded','C:Subset']);assert.equal(parsed.rows[0].lineNumber,3);
 for(const name of ['*StartPrice','BuyItNowPrice','BestOfferAutoAcceptPrice','MinimumBestOfferPrice','ShippingProfileName','ShippingType','ShippingService-1:Option','ShippingService-1:Cost','*DispatchTimeMax'])assert.equal(get(name),'');assert.equal(row[0],'Draft');assert.equal(result.csv.includes('DO NOT COPY TEMPLATE EXAMPLE'),false);assert.equal(result.csv.includes('999.00'),false);assert.equal(result.binding.template.sha256,options.template.template.sha256);
}));
test('full export refuses foreign categories, missing required specifics, unknown condition labels and unsafe defaults',()=>fullFixture(async(root,options)=>{
 const template=await readV2FullCategoryTemplate(root,options.template);assert.throws(()=>fullCategoryDraftCsv([{...payload(),categoryId:'183454'}],template,options.defaults,at),/another category/);const p=payload();delete p.specifics.Sport;assert.throws(()=>fullCategoryDraftCsv([p],template,options.defaults,at),/Required category specific/);assert.throws(()=>fullCategoryDraftCsv([{...payload(),conditionDescriptorValue:'400010'}],template,options.defaults,at),/actual template guidance|supported Near mint/);assert.throws(()=>fullCategoryDraftCsv([{...payload(),conditionDescriptorValue:'Excellent - (ID: 400011)'}],template,options.defaults,at),/supported Near mint/);assert.throws(()=>fullCategoryDraftCsv([payload()],template,{...options.defaults,location:'=FORMULA()'},at),/Unsafe seller/);
}));
test('template/category receipts and policy names cannot be supplied independently of bound evidence',()=>fullFixture(async(root,options)=>{
 await assert.rejects(buildV2FullTemplateDraftCsv(root,[payload()],{...options,defaults:{...options.defaults,returnProfileName:'Another return profile'}},at),/policy evidence/);await assert.rejects(readV2FullCategoryTemplate(root,{...options.template,categoryId:'183454'}),/receipt/);await fs.appendFile(path.join(root,options.template.template.path),'changed');await assert.rejects(readV2FullCategoryTemplate(root,options.template),/SHA changed/);
}));
test('Draft-only guard supports the exact full Info family and rejects any publishing or extra metadata row',()=>{
 const header='*Action(SiteID=US),CustomLabel\r\n';assert.equal(assertV2DraftOnlyCsv(V2_FULL_CATEGORY_INFO+'\r\n'+header+'Draft,sku\r\n').rows[0].lineNumber,3);for(const action of ['Add','Revise','Relist'])assert.throws(()=>assertV2DraftOnlyCsv(V2_FULL_CATEGORY_INFO+'\r\n'+header+action+',sku\r\n'),/Only bounded Draft/);assert.throws(()=>assertV2DraftOnlyCsv('Info,Version=9.9,Template=other\r\n'+header+'Draft,sku'),/Unsupported full/);assert.throws(()=>assertV2DraftOnlyCsv(V2_FULL_CATEGORY_INFO+'\r\n'+header+'Draft,sku\r\nInfo,extra'),/Only bounded Draft/);assert.equal(parseV2FeedCsv(V2_FULL_CATEGORY_INFO+'\r\n'+header+'Draft,sku')[2].lineNumber,3);
});

test("CSV preserves reviewed inert HTML while rejecting active tags, attributes and encoded formula text",()=>{
 const description='<div dir="ltr"><p>2024 Topps Chrome Aaron Judge #1.</p><br><b>Near mint or better.</b></div>';
 const csv=draftCsv([{...payload(),description}],at);assert.ok(csv.includes(description.replace(/"/g,'""')));
 for(const unsafe of ['<script>alert(1)</script>','<p onclick="bad()">Card</p>','<img src="https://bad.test">','<a href="https://bad.test">Card</a>','<div>&#61;HYPERLINK("x")</div>','<p>Card</p><style>x</style>'])assert.throws(()=>draftCsv([{...payload(),description:unsafe}],at),/Unsafe description/);
});

test("candidate CSV is Draft-only, unpriced, with explicit condition and category-specific values", () => {
  const csv = draftCsv([payload()], at);
  assert.match(csv, /"Draft","V2-1","261328"/);
  assert.match(csv, /"Price"/); assert.match(csv, /#1","","1"/);
  assert.match(csv, /"CD:Card Condition - \(ID: 40001\)"/);
  assert.match(csv, /"C:Player\/Athlete"/);
  assert.match(csv, /Near mint or better - \(ID: 400010\)/);
  assert.doesNotMatch(csv, /"Add"|Shipping profile|Payment profile|Return profile/);
});

test("CSV rejects duplicate SKU, capture reuse, invalid quantity and formula injection", () => {
  assert.throws(() => draftCsv([payload(), payload()], at), /duplicate/);
  assert.throws(() => draftCsv([payload(), { ...payload(2), captureIds: payload().captureIds }], at), /more than one draft/);
  assert.throws(() => draftCsv([{ ...payload(), quantity: 2 }], at), /quantity/);
  assert.throws(() => draftCsv([{ ...payload(), title: " =HYPERLINK(\"bad\")" }], at), /Unsafe/);
  assert.throws(() => draftCsv([{ ...payload(), specifics: { Sport: ["Baseball|Football"] } }], at), /specific/);
});

test("CSV requires exact distinct eBay-hosted upright photos with sufficient lifetime", () => {
  for (const photos of [
    [payload().photos[0], payload().photos[0]],
    payload().photos.map(p => ({ ...p, url: "https://example.org/photo.jpg" })),
    payload().photos.map(p => ({ ...p, expiresAt: "2026-11-03T11:00:00Z" })),
  ]) assert.throws(() => draftCsv([{ ...payload(), photos }], at), /photos/);
});

async function withRoot(fn: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "card-v2-transport-"));
  try { await fs.mkdir(path.join(root, "artifacts/card-processing-v2"), { recursive: true }); await fn(root); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}
const policies = { payment: "Established payment policy", returns: "No Return Accepted" as const, shipping: null, location: "Established seller location", pricingShippingUnresolved: true };
async function fixtureProof(root: string) {
  const ref = async (filename: string, content: unknown) => {
    const bytes = Buffer.from(JSON.stringify(content)); await fs.writeFile(path.join(root, filename), bytes);
    return { path: filename, sha256: createHash("sha256").update(bytes).digest("hex") };
  };
  const observations = [];
  for (const n of [1, 2]) observations.push({ expected: payload(n), expectedPolicies: policies,
    savedReadback: await ref(`artifacts/card-processing-v2/readback-${n}.json`, {
      kind: "saved-reopened-ebay-draft", seller: "imaydit58", draftId: `543000000000${n}`,
      url: `https://www.ebay.com/sl/sell?draft_id=543000000000${n}`, observedAt: "2026-11-03T10:00:30Z", payload: payload(n), policies, editorErrors: [],
    }) });
  return { version: 1 as const, contract: V2_TRANSPORT_CONTRACT, method: "seller-hub-draft-csv" as const, kind: "live" as const,
    importAction: "Draft" as const, importJobId: "12345678", startedAt: "2026-11-03T10:00:00Z", finishedAt: "2026-11-03T10:01:00Z",
    published: false as const, duplicateInventory: false as const, ebayIdentityAIUsed: false as const, fieldRepairs: 0 as const, observations,
    importReport: await ref("artifacts/card-processing-v2/import-report.json", { kind: "live-ebay-import-result", action: "Draft", jobId: "12345678",
      rows: [1, 2].map(n => ({ sku: `V2-${n}`, draftId: `543000000000${n}`, result: "Success" })) }) };
}

test("historical documentation alone never certifies the bulk method", () => withRoot(async root => {
  await fs.mkdir(path.join(root, "docs"));
  await fs.writeFile(path.join(root, "docs/LISTING_WORKFLOW.md"), "Historical counts: 176 drafts. Claim: works.");
  const result = await historicalMethodReview(root);
  assert.equal(result.status, "not-validated");
  assert.ok(result.findings.some(f => f.includes("bindings remained blank")));
  assert.ok(result.findings.some(f => f.includes("Harry Potter")));
  assert.equal(result.evidence.length, 1);
}));

test("pilot contract accepts bound synthetic regression fixture but does not itself perform eBay work", () => withRoot(async root => {
  const proof = await fixtureProof(root);
  const refs = await validateMethodProof(root, proof);
  assert.equal(refs.length, 3);
  assert.ok(refs.every(r => /^[a-f0-9]{64}$/.test(r.sha256)));
}));

test("pilot rejects altered readbacks, missing policies, mocked source and duplicate mappings", () => withRoot(async root => {
  const proof = await fixtureProof(root);
  await assert.rejects(validateMethodProof(root, { ...proof, kind: "mock" }));
  await assert.rejects(validateMethodProof(root, { ...proof, fieldRepairs: 1 }));
  const mismatch = structuredClone(proof); mismatch.observations[0].expected.title = "Wrong title";
  await assert.rejects(validateMethodProof(root, mismatch), /did not persist/);
  const missing = structuredClone(proof); missing.observations[0].expectedPolicies.payment = "";
  await assert.rejects(validateMethodProof(root, missing));
  const readback = path.join(root, proof.observations[0].savedReadback.path);
  await fs.appendFile(readback, " ");
  await assert.rejects(validateMethodProof(root, proof), /hash changed/);
}));

test("current V2 method records same-ID repairs and measured time without inheriting the old zero-repair speed benchmark", () => withRoot(async root => {
  const legacy = await fixtureProof(root);
  for (const observation of legacy.observations) {
    const file = path.join(root, observation.savedReadback.path), data = JSON.parse(await fs.readFile(file, "utf8"));
    data.savedItemPrice = null; data.savedShippingAmount = null;
    const bytes = Buffer.from(JSON.stringify(data)); await fs.writeFile(file, bytes);
    observation.savedReadback.sha256 = createHash("sha256").update(bytes).digest("hex");
  }
  const repairPath = "artifacts/card-processing-v2/repair-contract-fixture.json", repairBytes = Buffer.from(JSON.stringify({ kind: "synthetic-local-contract-fixture-not-live-evidence", field: "payment policy", repairedSameDraft: true }));
  await fs.writeFile(path.join(root, repairPath), repairBytes);
  const proof = { ...legacy, version: 2, contract: V2_LIVE_METHOD_CONTRACT, method: "seller-hub-fx-listing", finishedAt: "2026-11-03T10:15:00Z", fieldRepairs: 1,
    repairs: [{ draftId: "5430000000001", field: "payment policy", reason: "Retained repair observation", evidence: { path: repairPath, sha256: createHash("sha256").update(repairBytes).digest("hex") } }] };
  assert.equal((await validateMethodProof(root, proof)).length, 4);
  await assert.rejects(validateMethodProof(root, { ...proof, fieldRepairs: 0 }), /Every field repair/);
  await assert.rejects(validateMethodProof(root, { ...proof, repairs: [{ ...proof.repairs[0], draftId: "9999999999999" }] }), /unrelated draft/);
  await assert.rejects(validateMethodProof(root, { ...legacy, fieldRepairs: 1 }), "Legacy acceptance must retain its old strict contract");
}));

test("pilot rejects unbound evidence outside artifacts and time/capture throughput substitutions", () => withRoot(async root => {
  const proof = await fixtureProof(root);
  await assert.rejects(validateMethodProof(root, { ...proof, importReport: { path: "../private.json", sha256: "a".repeat(64) } }), /within artifacts/);
  await assert.rejects(validateMethodProof(root, { ...proof, finishedAt: "2026-11-03T10:10:00Z" }), /throughput/);
  const duplicate = structuredClone(proof); duplicate.observations[1] = duplicate.observations[0];
  await assert.rejects(validateMethodProof(root, duplicate), /Duplicate/);
}));

import { browserDraftCsv, browserDraftCsvAmendment, V2_BROWSER_DRAFT_INFO } from '../lib/card-processing-v2-transport.ts';
test('browser envelope uses exact unquoted official INFO line and preserves every original CSV body byte', async()=>{
 const cards=[payload(),payload(2)],before=JSON.stringify(cards),body=draftCsv(cards,at),csv=browserDraftCsv(cards,at);
 // Contract fixture transcribed from the retained official US template first line.
 assert.equal(V2_BROWSER_DRAFT_INFO,'#INFO,Version=0.0.2,Template= eBay-draft-listings-template_US,,,,,,,,');
 assert.equal(csv.split('\r\n')[0],V2_BROWSER_DRAFT_INFO);assert.ok(!csv.startsWith('"#INFO'));
 assert.equal(csv.slice(csv.indexOf('\r\n')+2),body);assert.equal(JSON.stringify(cards),before);
 assert.equal(csv.split('\r\n').filter(line=>line.startsWith('"Draft",')).length,2);assert.doesNotMatch(csv,/"Add"|"Revise"/);
 const amendment=browserDraftCsvAmendment(cards,at);assert.equal(amendment.csv,csv);assert.equal(amendment.originalBodySha256,createHash('sha256').update(body).digest('hex'));assert.equal(amendment.browserCsvSha256,createHash('sha256').update(csv).digest('hex'));assert.equal(amendment.listingBodyUnchanged,true);assert.equal(amendment.canPublish,false);
 assert.throws(()=>browserDraftCsv([payload(),payload()],at),/duplicate/);
});
