import test from 'node:test';
import assert from 'node:assert/strict';
import {checkSavedDraft,parseSavedDraftAX} from '../lib/card-saved-draft-check.ts';
const url='https://www.ebay.com/lstng?draftId=123456789012&mode=AddItem';
function fixture(){
 const expected={draftId:'123456789012',sku:'capture-one',title:'Card Base',quantity:1,item:2.49,shipping:0,minimumOffer:2,autoAccept:2.25,condition:'Near mint or better',specifics:{'Parallel/Variety':'Base','Card Number':'1'},policies:{shipping:'123456789010',payment:'123456789011',returns:'123456789012'},originalHashes:['a'.repeat(64),'b'.repeat(64)],general:false,priority:false};
 const ax=`Browser tab: 1, Title: "Complete your listing", URL: "${url}".
1 text field (settable) Item title, Value: Card Base, ID: title
2 text field (settable) Custom label (SKU), Value: capture-one, ID: sku
3 text field (settable) Item price, Value: 2.49, ID: price
4 text field (settable) Quantity, Value: 1, ID: qty
5 text field (settable) Minimum offer, Value: 2.00, ID: min
6 text field (settable) Auto accept, Value: 2.25, ID: auto
7 switch (settable, boolean) Description: Allow offers, Value: 1
8 switch (settable, boolean) Description: Toggle General, Value: 0
9 switch (settable, boolean) Description: Toggle Priority, Value: 0
10 button (collapsed) Parallel/Variety, ID: item-specific-dropdown-label-1
11 button (collapsed) Base, Secondary Actions: Expand
12 button (collapsed) Card Number, ID: item-specific-dropdown-label-2
13 text field (settable) Description: Card Number, Value: 1, ID: card
14 combo box (collapsed, settable) Shipping policy, Value: Free (123456789010), ID: policy
15 combo box (collapsed, settable) Payment policy, Value: Managed (123456789011), ID: payment
16 text Return policy : No returns (123456789012)
17 pop up button (collapsed) Format Buy It Now, Secondary Actions: Expand
18 pop up button (collapsed) Condition type Ungraded: Not graded
19 pop up button (collapsed) Card Condition Near mint or better: pack fresh
20 text 2 out of 25 photos or videos uploaded`;
 const capture={url,savedAt:'2026-10-24T23:00:00Z',reopenedAt:'2026-10-24T23:00:10Z',capturedAt:'2026-10-24T23:00:11Z',ax,
  shipping:{amount:0,policyId:expected.policies.shipping,evidence:'Policy details displayed free buyer shipping'},
  issues:{inspected:true as const,errors:[] as string[],evidence:'Visible issue summary inspected'},
  visual:{draftId:expected.draftId,originalHashes:expected.originalHashes,screenshotSha256:'c'.repeat(64),frontMain:true as const,backSecond:true as const,upright:true as const,identityMatches:true as const,reviewedAt:'2026-10-24T23:00:12Z',evidence:'Compared saved images against original pair'}};
 return {expected,capture,now:Date.parse('2026-10-24T23:00:15Z')};
}
test('complete reopened snapshot passes while never granting publication',()=>{const f=fixture(),r=checkSavedDraft(f.expected,f.capture,f.now);assert.equal(r.allChecksPassed,true,JSON.stringify(r.checks));assert.equal(r.photoIdentityVerified,true);assert.equal(r.canPublish,false);});
for(const [name,from,to] of [['price','Value: 2.49','Value: 2.95'],['parallel',') Base,',') Refractor,'],['policy','Free (123456789010)','Free (987654321000)'],['sku','Value: capture-one','Value: other'],['photo count','2 out of','1 out of'],['offer toggle','Allow offers, Value: 1','Allow offers, Value: 0'],['format','Format Buy It Now','Format Auction']])test(`detects persisted ${name} mismatch`,()=>{const f=fixture();f.capture.ax=f.capture.ax.replace(from,to);assert.equal(checkSavedDraft(f.expected,f.capture,f.now).allChecksPassed,false);});
test('absent price is missing, never zero',()=>{const f=fixture();f.capture.ax=f.capture.ax.replace(/.*Item price.*\n/,'');assert.equal(checkSavedDraft(f.expected,f.capture,f.now).checks.find(c=>c.field==='item')?.status,'missing');});
test('duplicate controls fail closed',()=>{const f=fixture();f.capture.ax+='\n99 text field Item price, Value: 2.49';assert.equal(parseSavedDraftAX(f.capture.ax).field('Item price'),undefined);});
test('missing issue, shipping, visual evidence cannot pass',()=>{const f=fixture();const {issues,shipping,visual,...capture}=f.capture;const r=checkSavedDraft(f.expected,capture,f.now);assert.equal(r.allChecksPassed,false);assert.equal(r.photoIdentityVerified,false);});
test('wrong draft / stale / pre-save snapshot cannot verify photos',()=>{for(const changes of [{url:url.replace('123456789012','999999999999')},{savedAt:'2026-10-24T23:00:14Z'},{capturedAt:'2026-10-24T21:00:00Z'}]){const f=fixture();assert.equal(checkSavedDraft(f.expected,{...f.capture,...changes},f.now).photoIdentityVerified,false);}});
test('visual evidence cannot transfer between capture pairs',()=>{const f=fixture();f.capture.visual.originalHashes=['d'.repeat(64),'b'.repeat(64)];assert.equal(checkSavedDraft(f.expected,f.capture,f.now).photoIdentityVerified,false);});
test('issue errors keep archive photo verification separate from field pass',()=>{const f=fixture();f.capture.issues.errors.push('Missing required field');const r=checkSavedDraft(f.expected,f.capture,f.now);assert.equal(r.allChecksPassed,false);assert.equal(r.photoIdentityVerified,true);});

test('floor-price offers cannot pass even when saved values match',()=>{const f=fixture();f.expected.item=1.49;f.expected.minimumOffer=1.49;f.expected.autoAccept=1.49;f.capture.ax=f.capture.ax.replace('Value: 2.49','Value: 1.49').replace('Value: 2.00','Value: 1.49').replace('Value: 2.25','Value: 1.49');assert.equal(checkSavedDraft(f.expected,f.capture,f.now).allChecksPassed,false);});
test('disabled offers at floor pass without hidden thresholds',()=>{const f=fixture();f.expected.item=1.49;f.capture.ax=f.capture.ax.replace('Value: 2.49','Value: 1.49').replace('Allow offers, Value: 1','Allow offers, Value: 0').replace(/^.*(?:Minimum offer|Auto accept).*\n/gm,'');assert.equal(checkSavedDraft({...f.expected,offersEnabled:false,minimumOffer:undefined,autoAccept:undefined},f.capture,f.now).allChecksPassed,true);});
test('missing return policy fails saved readiness',()=>{const f=fixture();f.capture.ax=f.capture.ax.replace(/^.*Return policy.*\n/gm,'');assert.equal(checkSavedDraft(f.expected,f.capture,f.now).allChecksPassed,false);});
test('disabled planned offers explain hidden thresholds without granting edits or readiness',()=>{const f=fixture();f.capture.ax=f.capture.ax.replace('Allow offers, Value: 1','Allow offers, Value: 0').replace(/^.*(?:Minimum offer|Auto accept).*\n/gm,'');const r=checkSavedDraft(f.expected,f.capture,f.now);assert.equal(r.allChecksPassed,false);assert.equal(r.offerRecovery?.canEdit,false);assert.match(r.offerRecovery!.reason,/disabled/);assert.equal(r.checks.find(c=>c.field==='autoAccept')?.status,'missing');assert.equal(checkSavedDraft({...f.expected,offersEnabled:false},f.capture,f.now).offerRecovery,null);});

test('custom serial is read only with its explicit remove control',()=>{const f=fixture();const serial='\n30 text Serial Number\n31 text field (settable) Description: Serial Number, Value: 154/400, ID: x@ATTRIBUTES-custom\n32 button Remove Serial Number attribute';assert.equal(parseSavedDraftAX(f.capture.ax+serial).specifics['Serial Number'],'154/400');assert.equal(parseSavedDraftAX(f.capture.ax+serial.split('\n32')[0]).specifics['Serial Number'],undefined);});

test('named shipping policy requires same-draft matching policy view',()=>{const f=fixture();f.capture.ax=f.capture.ax.replace('Free (123456789010)','Free (503 listings)');const policyAX=`Browser tab: 1, URL: "${url}".\n1 AXWebArea Business Policies - Shipping Policy, URL: ebay.com/bp/ship/view/123456789010?renderType=overlay\n2 text field (disabled) Policy name, Value: Free, ID: name`;const c={...f.capture,shipping:{...f.capture.shipping,policyAX}};assert.equal(checkSavedDraft(f.expected,c,f.now).allChecksPassed,true);assert.equal(checkSavedDraft(f.expected,{...c,shipping:{...c.shipping,policyAX:policyAX.replace('Value: Free','Value: Wrong')}},f.now).allChecksPassed,false);});

test('capture assembly copies full observed URL including ReturnURL without weakening verifier',async()=>{const {captureDraftSnapshot}=await import('../lib/card-saved-draft-check.ts');const f=fixture();const full=f.capture.url+'&ReturnURL=https%3A%2F%2Fwww.ebay.com%2Fsh%2Flst%2Fdrafts';const ax=f.capture.ax.replace(f.capture.url,full);const {url,ax:old,...observations}=f.capture;const result=captureDraftSnapshot(ax,observations);assert.equal(result.url,full);assert.equal(result.ax,ax);assert.equal(checkSavedDraft(f.expected,result,f.now).allChecksPassed,true);});
test('capture assembly rejects invented URL, mismatched AX and missing header',async()=>{const {captureDraftSnapshot}=await import('../lib/card-saved-draft-check.ts');const f=fixture();assert.throws(()=>captureDraftSnapshot(f.capture.ax,{...f.capture,url:f.capture.url+'&extra=1'}));assert.throws(()=>captureDraftSnapshot(f.capture.ax,{...f.capture,ax:'other'}));assert.throws(()=>captureDraftSnapshot(f.capture.ax.split('\n').slice(1).join('\n'),f.capture));});
