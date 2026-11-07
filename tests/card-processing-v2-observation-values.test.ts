import {observedV2NearMintCondition,observedV2NoReturnsPolicy} from '../lib/card-processing-v2-observation-values.ts';
import test from "node:test";
import assert from "node:assert/strict";
import { observedV2DraftId, observedV2PolicyName } from "../lib/card-processing-v2-observation-values.ts";

test("current canonical and legacy editor URLs identify the same exact draft", () => {
  for (const url of ["https://www.ebay.com/lstng?draftId=5289381326721", "https://www.ebay.com/sl/sell?draft_id=5289381326721", "https://www.ebay.com/sl/list?mode=AddItem&draft_id=5289381326721"]) assert.equal(observedV2DraftId(url), "5289381326721");
});

test("conflicting or repeated URL aliases and untrusted origins never identify an owned draft", () => {
  for (const url of [
    "https://www.ebay.com/lstng?draftId=123&draft_id=456", "https://www.ebay.com/lstng?draftId=123&draft_id=123",
    "https://www.ebay.com/lstng?draftId=123&draftId=123", "https://www.ebay.com/sl/sell?draft_id=123&draft_id=123",
    "https://www.ebay.com/lstng?draftID=123", "https://www.ebay.com/lstng?draftId=123&draftid=456",
    "https://www.ebay.com/lstng?draftId=not-numeric", "https://www.ebay.com.evil.example/lstng?draftId=123",
    "https://user:password@www.ebay.com/lstng?draftId=123", "https://www.ebay.com:8443/lstng?draftId=123", "http://www.ebay.com/lstng?draftId=123",
    "https://www.ebay.com/lstng?draftId=123#different-editor", "not-a-url",
  ]) assert.equal(observedV2DraftId(url), null);
});

test("policy presentation counts normalize without dropping policy IDs or arbitrary names", () => {
  assert.equal(observedV2PolicyName("eBay Managed Payments (248164941010) [7590 listings]"), "eBay Managed Payments (248164941010)");
  assert.equal(observedV2PolicyName("No Return Accepted (248164940010) (6368 listings)"), "No Return Accepted (248164940010)");
  assert.equal(observedV2PolicyName("PWE - $1.95 (875 listings)"), "PWE - $1.95");
  assert.equal(observedV2PolicyName("Seller policy [7,590 listings]"), "Seller policy");
  assert.equal(observedV2PolicyName("Seller policy (1 listing)"), "Seller policy");
  for (const name of ["eBay Managed Payments (248164941010)", "PWE ($1.95)", "No Return Accepted (not a policy ID)", "Seller policy (12,34 listings)"]) assert.equal(observedV2PolicyName(name), name);
});

test('rendered condition wraps and return colon spacing preserve exact observed values',()=>{assert.equal(observedV2NearMintCondition('Card Condition\nNear mint or better: Comparable to a fresh pack'),true);assert.equal(observedV2NearMintCondition('Card Condition Near mint or better:'),true);assert.equal(observedV2NearMintCondition('Card Condition\nExcellent: Different condition'),false);assert.equal(observedV2NoReturnsPolicy('Return policy: No Return Accepted (248164940010)'),true);assert.equal(observedV2NoReturnsPolicy('99 button Return policy : No Return Accepted (248164940010)'),true);assert.equal(observedV2NoReturnsPolicy('Return policy: No Return Accepted (258732704010)'),false);assert.equal(observedV2NoReturnsPolicy('Return policy: Returns Accepted (248164940010)'),false);assert.equal(observedV2NoReturnsPolicy('Return policy: No Return Accepted (248164940010)\nReturn policy: Returns Accepted (999)'),false);});

import {observedV2SemanticFeatures} from '../lib/card-processing-v2-observation-values.ts';
const semanticFeatures='  - button "Features"\n  - button "Rookie (+1)" [expanded]\n  - menu:\n    - menu "Selected List of selected values":\n      - menuitemcheckbox "Rookie" [checked]\n      - menuitemcheckbox "Serial Numbered" [checked]\n    - menu "All options (total 3 options)":\n      - menuitemcheckbox "Rookie" [checked]\n      - menuitemcheckbox "Serial Numbered" [checked]\n      - menuitemcheckbox "Parallel/Variety"';
test('legacy actual Features selected menu reads exact checked values only',()=>{assert.deepEqual(observedV2SemanticFeatures(semanticFeatures),{observed:true,values:['Rookie','Serial Numbered']});});
test('Features summary, unselected, conflicting, foreign and ambiguous menus fail closed',()=>{for(const text of [semanticFeatures.replace('"Rookie" [checked]','"Rookie"'),semanticFeatures.replace('"Serial Numbered" [checked]','"Serial Numbered"'),semanticFeatures.replace('button "Features"','button "Team"'),semanticFeatures+'\n'+semanticFeatures,semanticFeatures.replace('button "Rookie (+1)" [expanded]','button "Rookie (+1)"'),semanticFeatures.replace('"Parallel/Variety"','"Parallel/Variety" [checked]')])assert.equal(observedV2SemanticFeatures(text).observed,false);});
