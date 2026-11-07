import test from "node:test";
import assert from "node:assert/strict";
import { classifyV2IdentificationWarnings } from "../lib/card-processing-v2-identification-warnings.ts";
import type { V2Identification } from "../lib/card-processing-v2.ts";

function finding(warning: string): V2Identification {
  return { pairMatches: true, frontImageIndex: "0", upright: true, warnings: [warning], identity: {
    name: "Larry Bird", year: "1992", manufacturer: "Impel", product: "U.S. Olympicards", number: "9", categoryId: "261328",
    language: "English", variant: "Base", artwork: "USA uniform", sportOrGame: "Basketball", team: "USA Basketball", serial: "", graded: false, damage: false, specifics: {},
  } };
}

test("explicit holder-only caveats remain visible without repeating identification or blocking the NM default", () => {
  for (const text of ["Surface scratches are visible on the protective holder; card-surface condition cannot be fully assessed through it.", "The holder has scratches. No definite card damage is visible.", "Glare from the sleeve only."]) {
    const input = finding(text), before = JSON.stringify(input), result = classifyV2IdentificationWarnings(input);
    assert.deepEqual(result, { advisory: [text], blocking: [] });
    assert.equal(JSON.stringify(input), before, "classification never erases the retained warning");
  }
});

test("ambiguous card damage, unclear identity and unknown warnings remain blocking", () => {
  for (const text of [
    "The holder has scratches; card damage cannot be ruled out.",
    "The holder has scratches; whether they affect the card is unclear.",
    "Surface scratches on the holder cannot reliably be distinguished from scratches on the card.",
    "The holder has scratches; the parallel is unknown.",
    "Scratches on the holder; possibly the wrong player.",
    "Minor corner and edge wear is visible.",
    "The card shows surface scratches; the holder is scratched too.",
    "Review this result.",
  ]) assert.deepEqual(classifyV2IdentificationWarnings(finding(text)).blocking, [text], text);
});

test("holder caveats cannot bypass damage, grading, pairing or orientation guards", () => {
  const input = finding("The holder has scratches.");
  for (const change of [{ identity: { ...input.identity!, damage: true } }, { identity: { ...input.identity!, graded: true } }, { pairMatches: false }, { upright: false }, { frontImageIndex: "unknown" as const }, { identity: null }]) {
    assert.equal(classifyV2IdentificationWarnings({ ...input, ...change }).blocking.length, 1);
  }
});
test('retained live64 neutral holder caveats with explicit no-damage qualifier are advisory, not automatic card-damage clearance',()=>{for(const text of ['Card is photographed inside a sleeve and rigid holder; surface marks on the holder cannot reliably be distinguished from marks on the card. No definite card damage is visible.','The card is photographed in a sleeve and rigid holder; surface marks on the protection cannot reliably be distinguished from marks on the card. No definite card damage is visible.','Sleeve and rigid-holder reflections and surface marks limit condition assessment; no definite card damage is visible.','Surface marks are visible on the protective holder; card-surface condition cannot be fully assessed through it.'])assert.equal(classifyV2IdentificationWarnings(finding(text)).blocking.length,0,text);for(const text of ['Surface marks on the holder cannot reliably be distinguished from marks on the card.','The card is photographed inside a sleeve and rigid holder; surface marks and apparent lower-edge wear cannot be reliably distinguished from marks on the protective materials.','Surface marks are visible on the protective holder; the photos do not establish whether any extend to the card itself. Card condition cannot be fully assessed through the holder.'])assert.equal(classifyV2IdentificationWarnings(finding(text)).blocking.length,1,text);});
test('canonical independently reviewed holder reflection note passes only with explicit no-damage and intact guards',()=>{const text='Protective holder reflections limit fine surface inspection. No definite card damage is visible.';assert.deepEqual(classifyV2IdentificationWarnings(finding(text)),{advisory:[text],blocking:[]});assert.equal(classifyV2IdentificationWarnings(finding(text+' Lower-edge wear may affect the card.')).blocking.length,1);const damaged=finding(text);damaged.identity!.damage=true;assert.equal(classifyV2IdentificationWarnings(damaged).blocking.length,1);});


test('source acknowledgements and untrusted parallel hints never become a classifier waiver',()=>{
 const acknowledgement='Red Prizm identification is supported by the visible pattern and directly read /299 serial, together with the supplied seller-stated parallel definition.';
 const complete=finding(acknowledgement);complete.identity={...complete.identity!,variant:'Red Prizm',serial:'294/299'};
 const before=JSON.stringify(complete);assert.deepEqual(classifyV2IdentificationWarnings(complete).blocking,[acknowledgement]);assert.equal(JSON.stringify(complete),before);
 for(const warning of ['Seller says Red Wave, so Red Prizm /299 was assumed.','The printed serial numerator is unreadable despite the supplied product definition.','The visible pattern conflicts with the supplied parallel definition.','A white mark at the lower card edge may be card damage.','The two photographs may show different cards.']){
  const candidate={...complete,warnings:[warning]};assert.deepEqual(classifyV2IdentificationWarnings(candidate).blocking,[warning]);
 }
 assert.deepEqual(classifyV2IdentificationWarnings({...complete,identity:null}).blocking,[acknowledgement]);
});
