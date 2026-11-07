import { createHash } from "node:crypto";
import { z } from "zod";

const hash=z.string().regex(/^[a-f0-9]{64}$/);
const money=z.number().finite().nonnegative();
export const draftExpectationSchema=z.object({
  draftId:z.string().regex(/^\d+$/),sku:z.string().min(1),title:z.string().min(1),quantity:z.number().int().positive(),
  item:money,shipping:money,offersEnabled:z.boolean().default(true),minimumOffer:money.optional(),autoAccept:money.optional(),condition:z.string().min(1),
  specifics:z.record(z.string(),z.string().min(1)),
  policies:z.object({shipping:z.string().min(1),payment:z.string().min(1),returns:z.string().min(1)}),
  originalHashes:z.array(hash).length(2),general:z.boolean(),priority:z.boolean(),
  photoLayout:z.object({count:z.number().int().min(4).max(24),frontPosition:z.number().int().positive(),backPosition:z.number().int().positive()}).optional(),
});
export const draftCaptureSchema=z.object({
  url:z.string().url(),savedAt:z.iso.datetime(),reopenedAt:z.iso.datetime(),capturedAt:z.iso.datetime(),ax:z.string().min(1),
  // Separate explicit observations: absence of an error string is not an issue audit.
  issues:z.object({inspected:z.literal(true),errors:z.array(z.string()),evidence:z.string().min(1)}).optional(),
  shipping:z.object({amount:money,policyId:z.string().min(1),evidence:z.string().min(1),policyAX:z.string().optional()}).optional(),
  visual:z.object({draftId:z.string(),originalHashes:z.array(hash).length(2),screenshotSha256:hash,
    frontMain:z.boolean(),backSecond:z.boolean(),upright:z.literal(true),identityMatches:z.literal(true),
    frontPosition:z.number().int().positive().optional(),backPosition:z.number().int().positive().optional(),
    reviewedAt:z.iso.datetime(),evidence:z.string().min(1)}).optional(),
});
export const evidenceHash=(value:string)=>createHash("sha256").update(value).digest("hex");
/** Copy the observed URL verbatim; never reconstruct it from a draft ID or alter AX evidence. */
export function captureDraftSnapshot(ax:string,observations:Record<string,unknown>){
  const first=ax.split(/\r?\n/)[0];
  const match=first.match(/^Browser tab: .+, Title: ".*", URL: "(https:\/\/www\.ebay\.com\/[^"\s]+)"\.$/);
  if(!match)throw Error('Full browser snapshot header required; do not infer URL from body text');
  const url=match[1],parsed=new URL(url);
  if(!['/lstng','/sl/list'].includes(parsed.pathname)||!/^\d+$/.test(parsed.searchParams.get('draftId')??parsed.searchParams.get('draft_id')??''))throw Error('Observed URL must identify an existing draft editor');
  if(observations.url!==undefined&&observations.url!==url)throw Error('Provided URL conflicts with observed snapshot; preserve evidence and correct metadata');
  if(observations.ax!==undefined&&observations.ax!==ax)throw Error('Provided AX differs from retained snapshot');
  return draftCaptureSchema.parse({...observations,url,ax});
}
const clean=(s:string)=>s.replace(/\s+/g," ").trim();
/** Read only the rendered saved editor. Unknown/ambiguous controls fail closed. */
export function parseSavedDraftAX(ax:string){
  const lines=ax.split(/\r?\n/).filter(l=>/^\s*\d+ /.test(l));
  const unique=(values:string[])=>values.length===1?values[0]:undefined;
  const field=(label:string)=>unique(lines.flatMap(l=>{
    const m=l.match(/^\s*\d+ (?:text field|combo box|switch)(?: \([^)]*\))? (?:Description: )?(.+?), Value: (.*?)(?:, ID:|, Secondary Actions:|$)/);
    if(m?.[1]===label)return [m[2].trim()];
    // AX omits Value entirely for a rendered empty input; distinguish it from an absent control.
    const empty=l.match(/^\s*\d+ text field(?: \([^)]*\))? (?:Description: )?(.+?), ID:/);
    return empty?.[1]===label?[""]:[];
  }));
  const specifics:Record<string,string>={};
  const seenSpecifics=new Set<string>();
  lines.forEach((l,i)=>{
    const m=l.match(/button .*?\) (.+), ID: .*item-specific-dropdown-label-/);if(!m)return;
    const next=lines.slice(i+1).find(x=>/button |text field|content list/.test(x));if(!next||next.includes('dropdown-label-'))return;
    const value=next.includes('text field')?next.match(/, Value: (.*?)(?:, ID:|$)/)?.[1]:next.match(/button \([^)]*\) (.*?)(?:, Secondary Actions:|$)/)?.[1];
    if(seenSpecifics.has(m[1])){delete specifics[m[1]];return;}
    seenSpecifics.add(m[1]);
    if(value&&!value.startsWith('Description:'))specifics[m[1]]=clean(value);
  });
  // Custom specifics use a text label followed by a field and explicit Remove control.
  lines.forEach((l,i)=>{
    const m=l.match(/^\s*\d+ text field \(settable\) Description: (.+?), Value: (.*?), ID: .*@ATTRIBUTES/);
    if(!m||!lines[i+1]?.includes(`button Remove ${m[1]} attribute`))return;
    if(seenSpecifics.has(m[1])){delete specifics[m[1]];return;}
    seenSpecifics.add(m[1]);specifics[m[1]]=clean(m[2]);
  });
  const policy=(label:string)=>unique(lines.filter(l=>l.includes(label)).flatMap(l=>Array.from(l.matchAll(/\((\d{9,})\)/g),m=>m[1])));
  return {field,specifics,policies:{shipping:policy('Shipping policy, Value:'),payment:policy('Payment policy, Value:'),returns:policy('Return policy :')},
    condition:unique(lines.filter(l=>l.includes('pop up button')&&l.includes('Card Condition ')).map(l=>l.split('Card Condition ')[1].split(':')[0])),
    photoCount:Number(unique(lines.map(l=>l.match(/text (\d+) out of \d+ photos or videos uploaded/)?.[1]).filter((v):v is string=>!!v))),
    format:lines.some(l=>/pop up button.*Format Buy It Now,/.test(l)),ungraded:lines.some(l=>/pop up button.*Condition type Ungraded:/.test(l))};
}
export function checkSavedDraft(expected:unknown,capture:unknown,now=Date.now()){
  const e=draftExpectationSchema.parse(expected),c=draftCaptureSchema.parse(capture),p=parseSavedDraftAX(c.ax);
  const checks:{field:string;status:"pass"|"missing"|"mismatch";expected:unknown;observed:unknown}[]=[];
  const compare=(field:string,want:unknown,got:unknown)=>checks.push({field,status:got===undefined||typeof got==='number'&&!Number.isFinite(got)?'missing':want===got?'pass':'mismatch',expected:want,observed:got??null});
  const u=new URL(c.url),id=u.searchParams.get('draftId')??u.searchParams.get('draft_id');
  compare('draftId',e.draftId,u.protocol==='https:'&&u.hostname==='www.ebay.com'?id:undefined);
  compare('snapshotURL',true,c.ax.split(/\r?\n/)[0].includes(`URL: "${c.url}"`));
  compare('save/reopen/freshness',true,Date.parse(c.savedAt)<Date.parse(c.reopenedAt)&&Date.parse(c.reopenedAt)<=Date.parse(c.capturedAt)&&Date.parse(c.capturedAt)<=now&&now-Date.parse(c.capturedAt)<=3600000);
  for(const [label,key] of [['Item title','title'],['Custom label (SKU)','sku']] as const)compare(key,e[key],p.field(label));
  for(const [label,key] of [['Item price','item'],['Quantity','quantity']] as const){const v=p.field(label);compare(key,e[key],v===undefined?undefined:Number(v));}
  if(e.offersEnabled){
    compare('offers.validThresholds',true,e.minimumOffer!==undefined&&e.autoAccept!==undefined&&e.minimumOffer>=1.49&&e.minimumOffer<=e.autoAccept&&e.autoAccept<e.item);
    for(const [label,key] of [['Minimum offer','minimumOffer'],['Auto accept','autoAccept']] as const){const v=p.field(label);compare(key,e[key],v===undefined?undefined:Number(v));}
  }
  compare('offers',e.offersEnabled?'1':'0',p.field('Allow offers'));compare('general',e.general?'1':'0',p.field('Toggle General'));compare('priority',e.priority?'1':'0',p.field('Toggle Priority'));
  compare('format',true,p.format);compare('ungraded',true,p.ungraded);compare('condition',e.condition,p.condition);
  for(const [key,value] of Object.entries(e.specifics))compare(`specifics.${key}`,clean(value),p.specifics[key]);
  const policyAX=c.shipping?.policyAX;
  const viewedPolicyId=policyAX?.match(/AXWebArea Business Policies - Shipping Policy, URL: ebay\.com\/bp\/ship\/view\/(\d+)\?/ )?.[1];
  const viewedPolicyName=policyAX?.match(/text field \(disabled\) Policy name, Value: (.*?), ID:/)?.[1];
  const savedPolicyName=p.field('Shipping policy')?.replace(/ \(\d+ listings?\)$/,'');
  const viewedPolicyBound=policyAX?.split(/\r?\n/)[0].includes(`URL: "${c.url}"`)&&viewedPolicyName===savedPolicyName;
  for(const key of ['shipping','payment','returns'] as const)compare(`policy.${key}`,e.policies[key],p.policies[key]??(key==='shipping'&&viewedPolicyBound?viewedPolicyId:undefined));
  compare('shipping.amount',e.shipping,c.shipping?.amount);compare('shipping.policy',e.policies.shipping,c.shipping?.policyId);
  compare('photos.count',e.photoLayout?.count??2,p.photoCount);
  const identityPassed=checks.filter(x=>['draftId','snapshotURL','save/reopen/freshness','sku','title','condition','ungraded','photos.count'].includes(x.field)||x.field.startsWith('specifics.')).every(x=>x.status==='pass');
  const v=c.visual;
  const layout=e.photoLayout;
  const positions=layout?layout.count===e.quantity*2&&layout.frontPosition%2===1&&layout.backPosition===layout.frontPosition+1&&layout.backPosition<=layout.count
    &&v?.frontPosition===layout.frontPosition&&v?.backPosition===layout.backPosition&&v.frontMain===(layout.frontPosition===1)&&v.backSecond===(layout.backPosition===2)
    :v?.frontMain===true&&v?.backSecond===true;
  compare('photos.visual',true,v? positions&&v.draftId===e.draftId&&JSON.stringify(v.originalHashes)===JSON.stringify(e.originalHashes)&&Date.parse(v.reviewedAt)>=Date.parse(c.reopenedAt)&&Date.parse(v.reviewedAt)<=now:undefined);
  compare('issues.inspected',true,c.issues?.inspected);compare('issues.errors',0,c.issues?.errors.length);
  return {checkedAt:new Date(now).toISOString(),draftId:e.draftId,sku:e.sku,expectationHash:evidenceHash(JSON.stringify(e)),captureHash:evidenceHash(JSON.stringify(c)),checks,
    offerRecovery:e.offersEnabled&&p.field('Allow offers')==='0'?{
      reason:'Offers are disabled in the captured editor; hidden thresholds are not evidence of lost saved values.',
      next:'Verify this ID is still a draft and writer ownership is current. Enable offers, set both planned thresholds, save and reopen once. If already live, preserve live settings and apply current seller instructions.',
      canEdit:false as const,
    }:null,
    additionalSpecificsForReview:Object.fromEntries(Object.entries(p.specifics).filter(([key])=>!(key in e.specifics))),
    fieldsPassed:checks.filter(x=>x.field!=='photos.visual').every(x=>x.status==='pass'),
    photoIdentityVerified:identityPassed&&checks.find(x=>x.field==='photos.visual')?.status==='pass',
    allChecksPassed:checks.every(x=>x.status==='pass'),canPublish:false as const,
    note:'Local comparison only. Visual attestation is required; no image identity inference. Does not record a receipt, move photos, certify publication readiness, or grant seller approval.'};
}
