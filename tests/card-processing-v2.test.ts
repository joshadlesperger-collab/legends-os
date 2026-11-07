import test from "node:test";
import {planV2BatchConsolidation} from '../lib/card-processing-v2-batch-consolidation.ts';
import { factualV2Description, assessV2Description } from "../lib/card-processing-v2-description.ts";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { draftCsv, historicalMethodReview, validateMethodProof } from "../lib/card-processing-v2-transport.ts";
import {
  completeness, consolidate, consolidationKey, emptyV2State, identitySpecifics,
  preparePayload, searchableTitle, v2ProductTitleForms, stateSchema, v2Summary, verifyReadback,
  type V2Card, type V2Category, type V2Identity, type V2Payload,
} from "../lib/card-processing-v2.ts";

const hash = (character: string) => character.repeat(64);
test("review holds keep34photos and17cards visible without pretending they are unstarted", () => {
  const s = emptyV2State();
  for (let n = 0; n < 17; n++) {
    const c = card("a", { id: `C${n}`, captureId: n.toString(16).padStart(64, "0"), stage: "exception", identity: undefined,
      photos: [{ path: `C:/CardScans/${n}-front.jpg`, hash: (2 * n).toString(16).padStart(64, "0"), side: "front" }, { path: `C:/CardScans/${n}-back.jpg`, hash: (2 * n + 1).toString(16).padStart(64, "0"), side: "back" }],
      issues: [{ code: "IDENTITY_REVIEW", detail: "Exact parallel requires a verified reference", owner: "Identity review" }] });
    s.cards[c.id] = c;
  }
  const before = JSON.stringify(s), summary = v2Summary(s);
  assert.equal(summary.photoCount, 34); assert.equal(summary.physicalCards, 17); assert.equal(summary.awaitingDrafts, 17);
  assert.equal(summary.counts.waiting, 0); assert.equal(summary.counts.exception, 17); assert.equal(JSON.stringify(s), before);
  s.cards.C0.stage = "verified";
  assert.equal(v2Summary(s).awaitingDrafts, 17, "a stage label alone is not saved-draft evidence");
});
function identity(overrides: Partial<V2Identity> = {}): V2Identity {
  return { name: "Pikachu", year: "2025", manufacturer: "Pokemon", product: "Journey Together", number: "35",
    categoryId: "183454", language: "English", variant: "Base", artwork: "Pikachu standing with blue sky",
    sportOrGame: "Pokemon TCG", team: "", serial: "", graded: false, damage: false, specifics: {}, ...overrides };
}
test('long Chrome Update titles use an equivalent product display name without losing identity',()=>{
  for(const [name,number,serial] of [['Mike Yastrzemski','USC44','54/99'],['Chase Dollander','USC175','32/99']]){
    const i=identity({name,number,serial,manufacturer:'Topps',product:'Chrome Update Series',year:'2025',categoryId:'261328',variant:'Green Geometric Refractor',sportOrGame:'Baseball'});
    const title=searchableTitle(i);assert.ok(title.length<=80);for(const value of [name,number,serial,i.variant])assert.ok(title.includes(value));assert.equal(identitySpecifics(i).Set[0],'Chrome Update Series');
    assert.ok(searchableTitle({...i,product:'An unrelated very long product with no approved shortened display name'}).length>80);
  }
});
function card(character = "a", overrides: Partial<V2Card> = {}): V2Card {
  const i = identity();
  return { id: `V2-${character}`, sku: `V2-${character}`, captureId: hash(character),
    photos: [{ path: "C:/CardScans/001-front.jpg", hash: hash(character), side: "front" }, { path: "C:/CardScans/001-back.jpg", hash: hash("b"), side: "back" }],
    stage: "identified", identity: i, identification: { pairMatches: true, frontImageIndex: "0", upright: true, identity: structuredClone(i), warnings: [] },
    condition: "Near mint or better", title: searchableTitle(i), description: factualV2Description(i), descriptionSource: "factual",
    issues: [], nextAction: "Consolidate reviewed copies", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...overrides };
}
function category(overrides: Partial<V2Category> = {}): V2Category {
  return { categoryId: "183454", source: "Verified eBay category template", observedAt: new Date(Date.now() - 1000).toISOString(),
    requiredAspects: ["Game", "Card Number", "Language", "Manufacturer", "Character", "Graded"], allowedValues: { Graded: ["No", "Yes"] },
    conditionId: "4000", conditionDescriptorName: "Card Condition", conditionDescriptorValue: "400010", conditionLabel: "Near mint or better", ...overrides };
}
function hosted(c: V2Card): V2Payload["photos"] {
  return c.photos.map((p, index) => ({ hash: p.hash, url: `https://i.ebayimg.com/images/g/test${index}/s-l1600.jpg`, expiresAt: new Date(Date.now() + 3 * 86400000).toISOString(), upright: true as const }));
}
function prepared() {
  const s = emptyV2State(); const c = card(); s.cards[c.id] = c; consolidate(s);
  return { s, c, payload: preparePayload(c, [c], category(), hosted(c)) };
}

test('payload construction keeps internal media provenance out of frozen eBay fields without changing cache input',()=>{
  const {c}=prepared(),base=hosted(c),cached=base.map(photo=>({...photo,orientationHash:hash('c')})),before=JSON.stringify(cached);
  const payload=preparePayload(c,[c],category(),cached);
  assert.deepEqual(payload.photos,base);assert.equal(JSON.stringify(cached),before);
  assert.ok(payload.photos.every(photo=>!Object.hasOwn(photo,'orientationHash')));
});

test("a complete identified CCG card passes pre-draft validation and retains searchable identity", () => {
  const c = card();
  assert.equal(c.title, "2025 Journey Together Pikachu #35");
  assert.deepEqual(completeness(c, category(), hosted(c)), []);
  const specifics = identitySpecifics(c.identity!);
  assert.deepEqual(specifics.Game, ["Pokemon TCG"]);
  assert.deepEqual(specifics.Character, ["Pikachu"]);
  assert.equal(specifics.Sport, undefined);
});

test("sports specifics and non-sport franchise specifics stay category-specific", () => {
  const sport = identitySpecifics(identity({ categoryId: "261328", name: "Jalen Williams", sportOrGame: "Basketball", team: "Oklahoma City Thunder" }));
  assert.deepEqual(sport.Sport, ["Basketball"]);
  assert.deepEqual(sport["Player/Athlete"], ["Jalen Williams"]);
  assert.deepEqual(sport.Team, ["Oklahoma City Thunder"]);
  assert.equal(sport.Game, undefined);
  const nonSport = identitySpecifics(identity({ categoryId: "183050", name: "Harry Potter", sportOrGame: "Harry Potter" }));
  assert.deepEqual(nonSport.Franchise, ["Harry Potter"]);
  assert.equal(nonSport.Sport, undefined);
});

test("title validation retains full serial and parallel and rejects overflow instead of truncating", () => {
  const c = card(); c.identity!.serial = "056/115"; c.identity!.variant = "Snakeskin";
  c.identification!.identity = structuredClone(c.identity!);
  c.title = searchableTitle(c.identity!);
  assert.match(c.title, /Snakeskin 056\/115$/);
  assert.ok(!completeness(c, category(), hosted(c)).some(i => i.code === "TITLE"));
  c.title = c.title.replace("056/115", "");
  assert.ok(completeness(c, category(), hosted(c)).some(i => i.code === "TITLE"));
  c.identity!.product = "A".repeat(80); c.title = searchableTitle(c.identity!);
  assert.ok(c.title.length > 80);
  assert.ok(completeness(c, category(), hosted(c)).some(i => i.code === "TITLE"));
});

test("owned serial-numbered cards require complete valid individual serials, never denominator-only evidence", () => {
  for (const serial of ["/99", "100/99", "0/99", "1/0", "unknown", "1 of 99"]) {
    const c = card(); c.identity!.serial = serial; c.identification!.identity = structuredClone(c.identity!); c.title = searchableTitle(c.identity!);
    assert.ok(completeness(c, category(), hosted(c)).some(i => i.code === "IDENTITY"), `invalid owned serial ${serial} must remain held`);
  }
  const valid = card(); valid.identity!.serial = "001/099"; valid.identification!.identity = structuredClone(valid.identity!); valid.title = searchableTitle(valid.identity!);
  assert.ok(!completeness(valid, category(), hosted(valid)).some(i => i.code === "IDENTITY"));
});

test("unknown required identity placeholders cannot substitute for observed card facts", () => {
  for (const placeholder of ["Unknown", "N/A", "Unsure", "Not visible", "Unidentified", "  unknown  "]) {
    for (const field of ["name", "year", "manufacturer", "product", "number", "language", "variant", "artwork", "sportOrGame"] as const) {
      const c = card(); c.identity![field] = placeholder; c.identification!.identity = structuredClone(c.identity!); c.title = searchableTitle(c.identity!);
      assert.ok(completeness(c, category(), hosted(c)).some(i => i.code === "IDENTITY"), `${field} placeholder ${placeholder} must remain held`);
    }
  }
});

test("missing, stale, future and wrong-category requirements prevent preparation", () => {
  const c = card(), photos = hosted(c), at = Date.now();
  for (const template of [undefined, category({ observedAt: new Date(at - 8 * 86400000).toISOString() }), category({ observedAt: new Date(at + 60000).toISOString() }), category({ categoryId: "261328" })]) {
    assert.ok(completeness(c, template, photos, at).some(i => i.code === "CATEGORY"));
  }
});

test("required category specifics and constrained values block incomplete drafts", () => {
  const c = card();
  const missing = completeness(c, category({ requiredAspects: ["Game", "Card Type"] }), hosted(c));
  assert.ok(missing.some(i => i.code === "SPECIFICS" && i.detail.includes("Card Type")));
  c.identity!.specifics["Card Type"] = ["Unknown"];
  assert.ok(completeness(c, category({ requiredAspects: ["Card Type"] }), hosted(c)).some(i => i.code === "SPECIFICS"));
  assert.ok(completeness(c, category({ allowedValues: { Game: ["Magic: The Gathering"] } }), hosted(c)).some(i => i.code === "SPECIFICS"));
});

test("pairing, orientation, unresolved warnings and absent identity remain exceptions", () => {
  const cases: Array<(c: V2Card) => void> = [
    c => { c.identification!.pairMatches = false; }, c => { c.identification!.upright = false; },
    c => { c.identification!.warnings = ["Card number partly obscured"]; }, c => { delete c.identity; },
  ];
  for (const mutate of cases) {
    const c = card(); mutate(c);
    assert.ok(completeness(c, category(), hosted(c)).some(i => i.code === "IDENTITY"));
  }
});

test("raw condition default cannot override graded cards or visible damage", () => {
  for (const field of ["graded", "damage"] as const) {
    const c = card(); c.identity![field] = true;
    assert.ok(completeness(c, category(), hosted(c)).some(i => i.code === "CONDITION"));
  }
});

test("draft photos require exact hash, original order, upright review and usable eBay hosting", () => {
  const c = card();
  const mutations: Array<(photos: V2Payload["photos"]) => void> = [
    photos => { photos.reverse(); }, photos => { photos[0].hash = hash("f"); },
    photos => { photos[0].url = "http://i.ebayimg.com/image.jpg"; },
    photos => { photos[0].url = "https://i.ebayimg.com.evil.example/image.jpg"; },
    photos => { photos[0].url = "https://user:password@i.ebayimg.com/image.jpg"; },
    photos => { photos[0].expiresAt = new Date(Date.now() + 3600000).toISOString(); },
    photos => { photos.pop(); },
  ];
  for (const mutate of mutations) {
    const photos = hosted(c); mutate(photos);
    assert.ok(completeness(c, category(), photos).some(i => i.code === "PHOTOS"));
  }
});

test("exact unnumbered copies consolidate without collapsing physical capture attribution", () => {
  const s = emptyV2State(); const one = card("a"), two = card("c");
  s.cards[one.id] = one; s.cards[two.id] = two;
  assert.equal(consolidationKey(one), consolidationKey(two));
  consolidate(s);
  assert.equal(one.groupId, two.groupId);
  assert.equal(one.stage, "consolidated");
  const payload = preparePayload(one, [one, two], category(), hosted(one));
  assert.equal(payload.quantity, 2);
  assert.deepEqual(payload.captureIds, [one.captureId, two.captureId].sort());
});

test('batch plan combines selected duplicates only before payload preparation and preserves every original',()=>{
  const s=emptyV2State();const one=card('a'),two=card('c'),outside=card('e');
  for(const c of [one,two,outside])s.cards[c.id]=c;
  const before=structuredClone(s),plan=planV2BatchConsolidation(s,[two.id,one.id]);
  assert.equal(plan.physicalCards,2);assert.equal(plan.draftGroups,1);
  assert.equal(plan.groups[0].quantity,2);assert.deepEqual(plan.groups[0].captureIds,[one.captureId,two.captureId]);
  assert.deepEqual(s,before,'Planning is read-only, including all photo paths/hashes and outside inventory');
  consolidate(s,new Set([one.id,two.id]));
  const payload=preparePayload(one,[one,two],category(),hosted(one));
  assert.equal(payload.quantity,plan.groups[0].quantity);assert.deepEqual(payload.captureIds,plan.groups[0].captureIds);
  assert.match(payload.description,/representative copy/i);assert.equal(outside.stage,'identified');
  assert.equal(payload.pricing,'unpriced-grok-pending');assert.equal(Object.keys(s.submissions).length,0);
});

test('batch plan isolates serialized and different variant copies and rejects duplicated captures',()=>{
  const s=emptyV2State();const one=card('a'),two=card('c',{identity:identity({serial:'1/99'})}),three=card('e',{identity:identity({variant:'Foil'})});
  for(const c of [one,two,three])s.cards[c.id]=c;
  assert.equal(planV2BatchConsolidation(s,[one.id,two.id,three.id]).draftGroups,3);
  assert.throws(()=>planV2BatchConsolidation(s,[one.id,one.id]),/unique/);
  two.captureId=one.captureId;
  assert.throws(()=>planV2BatchConsolidation(s,[one.id,two.id]),/Copied capture/);
});

test("different serials, variants, language and artwork never share a draft group", () => {
  const one = card("a"), two = card("c");
  for (const change of [{ serial: "1/25" }, { variant: "Gold" }, { language: "Japanese" }, { artwork: "Alternate illustrated artwork" }]) {
    two.identity = identity(change);
    assert.notEqual(consolidationKey(one), consolidationKey(two));
  }
  one.identity!.serial = "1/25"; two.identity = identity({ serial: "1/25" });
  assert.notEqual(consolidationKey(one), consolidationKey(two), "numbered physical captures stay separate even when serial text coincides");
});

test("new captures matching an existing intent cannot silently increment or recreate a draft", () => {
  const { s, c, payload } = prepared();
  const key = hash("e");
  s.submissions[key] = { key, groupId: c.groupId!, payload, status: "intent", at: new Date().toISOString() };
  const additional = card("c"); s.cards[additional.id] = additional;
  consolidate(s);
  assert.equal(additional.stage, "exception");
  assert.ok(additional.issues.some(i => i.code === "EXISTING_GROUP"));
  assert.equal(s.submissions[key].payload.quantity, 1);
  assert.equal(Object.keys(s.submissions).length, 1);
});

test("group preparation refuses duplicate capture IDs, wrong groups, holds and ineligible stages", () => {
  const { c } = prepared();
  assert.throws(() => preparePayload(c, [], category(), hosted(c)), /capture group/);
  assert.throws(() => preparePayload(c, [c, structuredClone(c)], category(), hosted(c)), /capture group/);
  for (const mutate of [
    (other: V2Card) => { other.groupId = "another-group"; },
    (other: V2Card) => { other.stage = "waiting"; },
    (other: V2Card) => { other.issues = [{ code: "SELLER_HOLD", detail: "Inspect condition", owner: "Seller" }]; },
  ]) {
    const other = card("c", { stage: "consolidated", groupId: c.groupId }); mutate(other);
    assert.throws(() => preparePayload(c, [c, other], category(), hosted(c)), /capture group/);
  }
});

test("saved draft readback compares title, specifics, capture attribution, quantity, photos and condition", () => {
  const { payload } = prepared();
  assert.equal(verifyReadback(payload, structuredClone(payload)), true);
  const mutations: Array<(p: V2Payload) => void> = [
    p => { p.title = "Wrong card"; }, p => { p.sku = "Wrong SKU"; }, p => { p.quantity = 2; },
    p => { p.specifics.Game = ["Wrong game"]; }, p => { p.photos.reverse(); },
    p => { p.captureIds = [hash("f")]; }, p => { p.conditionDescriptorValue = "wrong-condition"; },
    p => { p.description = "Another card description"; }, p => { p.categoryId = "261328"; },
  ];
  for (const mutate of mutations) {
    const actual = structuredClone(payload); mutate(actual);
    assert.equal(verifyReadback(payload, actual), false);
  }
});

test("cost reporting retains unresolved billing instead of inventing cost per card", () => {
  const s = emptyV2State(); s.cards.one = card();
  s.calls.push({ id: "call-1", cardId: s.cards.one.id, key: hash("e"), provider: "openai", model: "identification-model", status: "reserved", reservedMicros: 5000, actualMicros: null, at: new Date().toISOString() });
  let summary = v2Summary(s);
  assert.equal(summary.cost.usdPerIdentifiedCard, null);
  assert.equal(summary.cost.unsettledCalls, 1);
  s.calls[0].status = "settled"; s.calls[0].actualMicros = 2500;
  summary = v2Summary(s);
  assert.equal(summary.cost.measuredUsd, 0.0025);
  assert.equal(summary.cost.usdPerIdentifiedCard, 0.0025);
  assert.equal(summary.counts.identified, 1);
  assert.equal(summary.physicalCards, 1);
});

test("durable state rejects arbitrary stages and malformed schema rather than hiding corruption", () => {
  const s = emptyV2State(); s.cards.one = card();
  assert.doesNotThrow(() => stateSchema.parse(s));
  assert.throws(() => stateSchema.parse({ ...s, version: 1 }));
  assert.throws(() => stateSchema.parse({ ...s, cards: { one: { ...s.cards.one, stage: "published" } } }));
  assert.throws(() => stateSchema.parse({ ...s, cards: { one: { ...s.cards.one, captureId: "bad-hash" } } }));
});

test("recognition must bind the exact identity and confirmed front/back order being prepared", () => {
  const mutations: Array<(c: V2Card) => void> = [
    c => { c.identification!.frontImageIndex = "unknown"; },
    c => { c.identification!.frontImageIndex = "1"; },
    c => { c.photos[0].side = "back"; c.photos[1].side = "front"; },
    c => { c.identification!.identity!.name = "Different character"; },
    c => { c.identification!.identity = null; },
  ];
  for (const mutate of mutations) {
    const c = card(); mutate(c);
    assert.ok(completeness(c, category(), hosted(c)).some(i => i.code === "IDENTITY"), "unbound recognition or side order cannot authorize a draft");
  }
});

test("invalid date strings never bypass category freshness or photo expiry checks", () => {
  const c = card(), photos = hosted(c);
  assert.ok(completeness(c, category({ observedAt: "not-a-date" }), photos).some(i => i.code === "CATEGORY"));
  photos[0].expiresAt = "not-a-date";
  assert.ok(completeness(c, category(), photos).some(i => i.code === "PHOTOS"));
});

test("each physical copy must have verified matching identity and no visual exceptions before group preparation", () => {
  const { c } = prepared();
  const mutations: Array<(other: V2Card) => void> = [
    other => { other.identity!.name = "Raichu"; other.identification!.identity = structuredClone(other.identity!); },
    other => { other.identity!.graded = true; other.identification!.identity = structuredClone(other.identity!); },
    other => { other.identity!.damage = true; other.identification!.identity = structuredClone(other.identity!); },
    other => { other.identification!.pairMatches = false; },
    other => { other.identification!.warnings = ["Back image unreadable"]; },
    other => { other.identification!.upright = false; },
  ];
  for (const mutate of mutations) {
    const other = card("c", { stage: "consolidated", groupId: c.groupId }); mutate(other);
    assert.throws(() => preparePayload(c, [c, other], category(), hosted(c)), "a copied groupId must not bypass per-copy review");
  }
});

test("readback comparison accepts equivalent object ordering while retaining ordered photo checks", () => {
  const { payload } = prepared(); const actual = structuredClone(payload);
  actual.specifics = Object.fromEntries(Object.entries(actual.specifics).reverse());
  assert.equal(verifyReadback(payload, actual), true);
  actual.photos.reverse();
  assert.equal(verifyReadback(payload, actual), false);
});

test("bulk transport produces Draft-only rows with blank price and category specifics", () => {
  const { payload } = prepared(); payload.description = 'Pictured card, "exact" front and back.';
  const csv = draftCsv([payload]); const lines = csv.trimEnd().split("\r\n");
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^"Draft","V2-a"/);
  assert.match(lines[1], /"Pictured card, ""exact"" front and back\."/);
  assert.match(lines[0], /"C:Game"/);
  assert.match(lines[0], /"CD:Card Condition"/);
  assert.ok(!lines[1].includes('"Add"'));
  assert.ok(lines[1].includes('"","1"'), "item price remains blank rather than using an invented placeholder");
});

test("bulk transport rejects repeated captures, duplicate SKUs and attribution mismatch", () => {
  const { payload } = prepared();
  assert.throws(() => draftCsv([payload, structuredClone(payload)]), /duplicate|capture/i);
  const another = structuredClone(payload); another.sku = "V2-another";
  assert.throws(() => draftCsv([payload, another]), /capture/i);
  another.captureIds = [hash("f")]; another.quantity = 2;
  assert.throws(() => draftCsv([another]), /quantity/i);
  another.quantity = 1; another.captureIds = [hash("f"), hash("f")];
  assert.throws(() => draftCsv([another]), /quantity/i);
});

test("bulk transport refuses spreadsheet formulas and unsafe specifics without losing CSV quoting", () => {
  const { payload } = prepared();
  for (const field of ["sku", "title", "description", "conditionDescriptorValue"] as const) {
    const input = structuredClone(payload); input[field] = " =HYPERLINK(\"https://evil.example\")";
    assert.throws(() => draftCsv([input]), /unsafe/i);
  }
  const unsafeValue = structuredClone(payload); unsafeValue.specifics.Game = ["@formula"];
  assert.throws(() => draftCsv([unsafeValue]), /unsafe/i);
  const unsafeName = structuredClone(payload); unsafeName.specifics["Game\r\nAction"] = ["Pokemon"];
  assert.throws(() => draftCsv([unsafeName]), /unsafe/i);
});

test("bulk transport does not reuse expired media or substitute two copies of one image", () => {
  const { payload } = prepared();
  const sameImage = structuredClone(payload); sameImage.photos[1].hash = sameImage.photos[0].hash;
  assert.throws(() => draftCsv([sameImage]), /photos/i);
  const expired = structuredClone(payload); expired.photos[0].expiresAt = new Date(Date.now() + 1000).toISOString();
  assert.throws(() => draftCsv([expired]), /photos/i);
  const externalHost = structuredClone(payload); externalHost.photos[0].url = "https://example.com/image.jpg";
  assert.throws(() => draftCsv([externalHost]), /photos/i);
});

test("historical upload success does not establish a validated complete V2 route", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "v2-method-"));
  try {
    const review = await historicalMethodReview(root);
    assert.equal(review.status, "not-validated");
    assert.ok(review.findings.some(f => /Draft creation remains gated/.test(f)));
    assert.ok(review.findings.some(f => /Harry Potter/.test(f)));
    assert.ok(review.findings.some(f => /policy bindings remained blank/.test(f)));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("method validation rejects mock/preflight evidence and never silently promotes invalid proof", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "v2-proof-"));
  try {
    await assert.rejects(validateMethodProof(root, { version: 1, kind: "mock", importAction: "Draft" }));
    const directory = path.join(root, "artifacts/card-processing-v2"); await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "method-proof.json"), JSON.stringify({ version: 1, kind: "live", importAction: "Add" }));
    const review = await historicalMethodReview(root);
    assert.equal(review.status, "not-validated");
    assert.ok(review.findings.some(f => /proof is invalid or incomplete/.test(f)));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('optional non-sports Not specified year is omitted consistently while required year still holds',()=>{const i=identity({name:'DON!!',year:'Not specified',product:'One Piece Card Game',number:'DON-1',sportOrGame:'One Piece',specifics:{'Year Manufactured':['Not specified']}}),c=card('c',{identity:i,identification:{pairMatches:true,frontImageIndex:'0',upright:true,identity:structuredClone(i),warnings:[]},title:searchableTitle(i),description:factualV2Description(i)});assert.equal(c.title,'One Piece Card Game DON!! #DON-1');assert.equal(identitySpecifics(i)['Year Manufactured'],undefined);assert.equal(c.description.includes('Not specified'),false);assert.deepEqual(completeness(c,category(),hosted(c)),[]);assert.ok(completeness(c,category({requiredAspects:['Year Manufactured']}),hosted(c)).some(e=>e.code==='SPECIFICS'&&e.detail.includes('Year Manufactured')));const saved=assessOptionalDescription(c.description,i);assert.equal(saved,true);});
function assessOptionalDescription(text:string,i:V2Identity){return assessV2Description(text,i).acceptable;}
test('printed non-sports year remains factual and sports absent-year sentinel stays blocked',()=>{const i=identity({year:'2026'}),c=card('c',{identity:i,identification:{pairMatches:true,frontImageIndex:'0',upright:true,identity:structuredClone(i),warnings:[]},title:searchableTitle(i),description:factualV2Description(i)});assert.equal(identitySpecifics(i)['Year Manufactured'][0],'2026');assert.ok(c.title.startsWith('2026 '));assert.equal(assessV2Description(c.description.replace('2026 ',''),i).acceptable,false);const sport=identity({categoryId:'261328',year:'Not specified',name:'Player',team:'Team',sportOrGame:'Basketball'}),sportsCard=card('d',{identity:sport,identification:{pairMatches:true,frontImageIndex:'0',upright:true,identity:structuredClone(sport),warnings:[]},title:searchableTitle(sport),description:factualV2Description(sport)});assert.ok(completeness(sportsCard,category({categoryId:'261328',requiredAspects:['Season']}),hosted(sportsCard)).some(e=>e.code==='IDENTITY'));});

test('grounded standard-insert title display solves83characters while identity and specifics remain unchanged',()=>{
 const i=identity({name:'Garrett Mitchell',year:'2023',manufacturer:'Topps',product:'Bowman',number:'ROYF-7',categoryId:'261328',variant:'Rookie of the Year Favorites — standard insert',sportOrGame:'Baseball',specifics:{'Insert Set':['Rookie of the Year Favorites'],Features:['Rookie','Insert']}}),before=JSON.stringify(i),original='2023 Bowman Garrett Mitchell #ROYF-7 Rookie of the Year Favorites — standard insert';assert.equal(original.length,83);const title=searchableTitle(i);assert.equal(title,'2023 Bowman Garrett Mitchell #ROYF-7 Rookie of the Year Favorites');assert.equal(title.length,65);const c=card('c',{identity:i,title,description:factualV2Description(i)});assert.equal(completeness(c,category({categoryId:'261328',requiredAspects:[]}),hosted(c)).some(e=>e.code==='TITLE'),false);assert.equal(JSON.stringify(i),before);assert.equal(identitySpecifics(i)['Parallel/Variety'][0],i.variant);assert.equal(searchableTitle({...i,specifics:{}}),original);
});
test('title display preserves real parallel wording and exact serial without generic truncation',()=>{
 const i=identity({name:'Garrett Mitchell',year:'2023',manufacturer:'Topps',product:'Bowman',number:'ROYF-7',categoryId:'261328',variant:'Rookie of the Year Favorites Refractor',serial:'05/99',sportOrGame:'Baseball',specifics:{'Insert Set':['Rookie of the Year Favorites']}});const title=searchableTitle(i);assert.ok(title.includes(i.variant));assert.ok(title.includes('05/99'));const missing=title.replace(' Refractor','');const c=card('d',{identity:i,title:missing,description:factualV2Description(i)});assert.ok(completeness(c,category({categoryId:'261328',requiredAspects:[]}),hosted(c)).some(e=>e.code==='TITLE'));assert.ok(searchableTitle({...i,product:'An unrelated extremely long product without approved display alias'}).length>80);
});

test('long Panini basketball product display alias retains exact player, season, card, parallel and serial',()=>{
 for(const product of ['Prizm Basketball','Mosaic Basketball']){const i=identity({name:'Nickeil Alexander-Walker',year:'2023-24',manufacturer:'Panini',product,number:'218',categoryId:'261328',sportOrGame:'Basketball',variant:'Blue Sparkle Prizms',serial:'030/144'}),before=structuredClone(i),title=searchableTitle(i);assert.ok(title.length<=80);for(const fact of [i.name,i.year,'#218',i.variant,i.serial])assert.ok(title.includes(fact));assert.equal(identitySpecifics(i).Set[0],product);assert.deepEqual(i,before);const c=card('a',{identity:i,identification:{pairMatches:true,frontImageIndex:'0',upright:true,identity:structuredClone(i),warnings:[]},title});assert.ok(!completeness(c,category({categoryId:'261328',requiredAspects:['Sport']}),hosted(c)).some(e=>e.code==='TITLE'));}
});
test('Panini basketball display aliases never apply to unrelated manufacturer, sport or category, and short full titles stay full',()=>{
 const base=identity({name:'Nickeil Alexander-Walker',year:'2023-24',manufacturer:'Panini',product:'Prizm Basketball',number:'218',categoryId:'261328',sportOrGame:'Basketball',variant:'Blue Sparkle Prizms',serial:'030/144'});for(const changes of [{manufacturer:'Topps'},{sportOrGame:'Baseball'},{categoryId:'183454' as const},{product:'Prizm Black Basketball'}]){const i={...base,...changes};assert.deepEqual(v2ProductTitleForms(i),[i.product]);assert.ok(searchableTitle(i).includes(i.product));}
 const short={...base,name:'LeBron James',variant:'Base',serial:''};assert.equal(searchableTitle(short),'2023-24 Prizm Basketball LeBron James #218');
});
