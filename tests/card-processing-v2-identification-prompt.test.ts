import test from 'node:test';
import assert from 'node:assert/strict';
import {V2_IDENTIFICATION_SYSTEM_PROMPT,V2_BENIGN_HOLDER_NOTE} from '../lib/card-processing-v2-identification-prompt.ts';
import {classifyV2IdentificationWarnings} from '../lib/card-processing-v2-identification-warnings.ts';
import type {V2Identification} from '../lib/card-processing-v2.ts';
test('next-run provider instruction distinguishes raw NM default and benign protection from actual visible defects and unreadable serials',()=>{const p=V2_IDENTIFICATION_SYSTEM_PROMPT;assert.match(p,/owned raw cards default to Near mint or better/);assert.match(p,/not missing identity facts and do not by themselves require null identity or a condition hold/);assert.match(p,/does not lower the damage threshold/);assert.match(p,/exact location and visual basis/);assert.match(p,/preserve the condition exception/);assert.match(p,/set damage true when card damage is established/);assert.match(p,/never infer an unreadable serial numerator from batch context/);assert.match(p,/NEVER propose price or shipping/);assert.ok(p.includes(V2_BENIGN_HOLDER_NOTE));});
test('canonical prompt note is accepted only with actual identity/orientation and no damage; substantive edge concern stays blocking',()=>{const f:V2Identification={pairMatches:true,frontImageIndex:'0',upright:true,warnings:[V2_BENIGN_HOLDER_NOTE],identity:{name:'Player',year:'2025',manufacturer:'Panini',product:'Prizm Black',number:'1',categoryId:'261328',language:'English',variant:'Skewed Prizms',artwork:'Player',sportOrGame:'Basketball',team:'Team',serial:'001/249',graded:false,damage:false,specifics:{}}};assert.deepEqual(classifyV2IdentificationWarnings(f).blocking,[]);assert.equal(classifyV2IdentificationWarnings({...f,identity:{...f.identity!,damage:true}}).blocking.length,1);assert.equal(classifyV2IdentificationWarnings({...f,warnings:[V2_BENIGN_HOLDER_NOTE,'An uneven pale lower-back-edge line may be card-edge wear.']}).blocking.length,1);assert.equal(classifyV2IdentificationWarnings({...f,identity:null}).blocking.length,1);});
test('provider CCG absent-fact instructions map to supported honest identity fields while sports remains strict',async()=>{
 const {V2_CCG_OPTIONAL_FACTS_PROMPT}=await import('../lib/card-processing-v2-identification-prompt.ts');
 const {identificationSchema,searchableTitle}=await import('../lib/card-processing-v2.ts');
 const {factualV2Description,assessV2Description}=await import('../lib/card-processing-v2-description.ts');
 const finding=identificationSchema.parse({pairMatches:true,frontImageIndex:'1',upright:true,warnings:[],identity:{name:'DON!! Card',year:'Not specified',manufacturer:'Bandai',product:'One Piece',number:'Unnumbered',categoryId:'183454',language:'Japanese',variant:'Sharp Teeth Silhouette',artwork:'Black background with sharp teeth silhouette and maroon DON lettering',sportOrGame:'One Piece Card Game',team:'',serial:'',graded:false,damage:false,specifics:{}}});
 assert.equal(classifyV2IdentificationWarnings(finding).blocking.length,0);assert.doesNotMatch(searchableTitle(finding.identity!),/Not specified/);assert.equal(assessV2Description(factualV2Description(finding.identity!),finding.identity!).acceptable,true);
 assert.ok(V2_IDENTIFICATION_SYSTEM_PROMPT.includes(V2_CCG_OPTIONAL_FACTS_PROMPT));
 assert.match(V2_CCG_OPTIONAL_FACTS_PROMPT,/year exactly Not specified/);assert.match(V2_CCG_OPTIONAL_FACTS_PROMPT,/number exactly Unnumbered/);assert.match(V2_CCG_OPTIONAL_FACTS_PROMPT,/including043\/091; these are not physical serial/);assert.match(V2_CCG_OPTIONAL_FACTS_PROMPT,/do NOT apply to sports261328/);assert.match(V2_CCG_OPTIONAL_FACTS_PROMPT,/Genuine unresolved identity, materially different artwork\/foil variants/);
 assert.equal(classifyV2IdentificationWarnings({...finding,warnings:['Collector number is visible but unreadable.']}).blocking.length,1);
});


test('conditional Mosaic vocabulary uses pattern plus full serial and never denominator-only or null-finding conversion',async()=>{
 const {V2_MOSAIC_REFERENCE_PROMPT}=await import('../lib/card-processing-v2-product-references.ts');
 const p=V2_MOSAIC_REFERENCE_PROMPT;assert.ok(V2_IDENTIFICATION_SYSTEM_PROMPT.includes(p));
 assert.match(p,/ONLY for independently established 2024-25 Panini Mosaic Basketball, sports category261328/);
 for(const term of ['Choice Blue Mosaic /45','Choice White Mosaic /35','Orange Ice Mosaic /49','Orange Mosaic /249','Choice Fusion Red and Yellow Mosaic','Bronze Mosaic','Red Fluorescent Mosaic'])assert.ok(p.includes(term));
 assert.match(p,/\/75 denominator is NOT unique/);assert.match(p,/split\/fused red-and-yellow/);assert.match(p,/fine linear\/crosshatch/);
 assert.match(p,/denominator alone never establishes Choice/);assert.match(p,/never copy representative digits or infer an unreadable numerator/);
 assert.match(p,/unknown products\/years, unreadable stamps/);assert.match(p,/never auto-convert null findings/);
});
