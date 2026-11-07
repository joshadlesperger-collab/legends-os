import {observedV2SemanticFeatures} from './card-processing-v2-observation-values.ts';
import {validateV2NonpriceGroupOwnership,readV2BackgroundAuthority} from './card-processing-v2-draft-lifecycle.ts';
import { measureV2 } from "./card-processing-v2-timing.ts";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { digest, event, consolidationKey, type V2Card, type V2Payload } from "./card-processing-v2.ts";
import { acquireV2Lock, processAlive, withV2State } from "./card-processing-v2-store.ts";
import { observedV2DraftId, observedV2NearMintCondition, observedV2NoReturnsPolicy } from "./card-processing-v2-observation-values.ts";
import { recoverV2DraftArchivesAfterOperation } from "./card-processing-v2-draft-archive.ts";
import { assessV2Description } from "./card-processing-v2-description.ts";
import {isV2BatchRowObservation,assertV2BatchObservedCategory,buildV2BatchNonpriceReview,validateV2BatchObservationSources} from './card-processing-v2-batch-observation.ts';

const ref = z.object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const checkNames = ["sameId", "title", "sku", "quantity", "specifics", "rawCondition", "nearMint", "exactPhotosInOrder", "descriptionReviewed", "paymentPresent", "returnsPresent", "locationPresent", "notScheduled"] as const;
const reviewSchema = z.object({ cardId: z.string(), captureId: z.string(), sku: z.string(), draftId: z.string().regex(/^\d+$/), observedAt: z.string().datetime(), evidence: ref,
  scope: z.literal("non-price-fields"), checks: z.record(z.string(), z.boolean()), aspectChecks: z.record(z.string(), z.boolean()), specifics: z.record(z.string(), z.array(z.string())), description: z.string(),
  pricing: z.object({ status: z.literal("deferred-preserved"), owner: z.literal("Grok"), writesPerformed: z.literal(false), sourceNotInferred: z.literal(true) }).strict(),
  shipping: z.object({ status: z.literal("deferred-preserved"), observedPolicy: z.string(), writesPerformed: z.literal(false) }).strict(), fullUnpricedVerification: z.literal(false), passed: z.literal(true),
}).strict();
const reportSchema = z.object({ kind: z.enum(["five-saved-draft-nonprice-review", "saved-draft-nonprice-review"]), seller: z.literal("imaydit58"), reviewer: z.string().min(10), reviewedAt: z.string().datetime(), authority: z.string().min(1), reviews: z.array(reviewSchema).min(1).max(20), allPassed: z.literal(true), published: z.literal(false), priceWritesSinceDeferral: z.literal(false) }).strict();
async function evidence(root: string, r: z.infer<typeof ref>) {
  if (path.isAbsolute(r.path) || r.path.split(/[\\/]/).includes("..")) throw Error("Evidence must stay under artifacts");
  const base = await fs.realpath(path.join(root, "artifacts")), file = await fs.realpath(path.join(root, r.path)), relative = path.relative(base, file);
  if (!relative || path.isAbsolute(relative) || relative.startsWith("..")) throw Error("Evidence must stay under artifacts");
  const stat = await fs.stat(file); if (!stat.isFile() || stat.size > 1_000_000) throw Error("Invalid bounded evidence");
  const bytes = await fs.readFile(file); if (createHash("sha256").update(bytes).digest("hex") !== r.sha256) throw Error("Evidence hash mismatch");
  return JSON.parse(bytes.toString("utf8"));
}
function fresh(at: string, now = Date.now()) { const age = now - Date.parse(at); if (!Number.isFinite(age) || age < 0 || age > 3600000) throw Error("Fresh reopened evidence required"); }
const fieldSchema = z.object({ name: z.string().optional(), value: z.string().optional(), checked: z.boolean().optional() }).passthrough();
const observationSchema = z.object({ kind: z.literal("saved-reopened-draft-nonprice-observation"), draftId: z.string(), url: z.string(), observedAt: z.string().datetime(), scope: z.literal("non-price-fields; pricing left untouched per seller"), priceWritePerformed: z.literal(false), ax: z.string().min(100), dom: z.object({ fields: z.array(fieldSchema), category: z.array(z.object({ text: z.string() }).passthrough()), photos: z.array(z.object({ background: z.string() }).passthrough()) }).passthrough(), features: z.object({ ax: z.string() }).passthrough() }).passthrough();
const resource = (value: string) => /\/(?:z|images\/g)\/([^/]+)\//.exec(value)?.[1];
const norm = (value: string) => value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
/** Read actual expanded option states. Parallel and Parallel/Variety are
 * distinct observed labels; never alias one into an expected payload value. */
export function observedV2Features(ax:string):{observed:boolean;values:string[]}{
  const states=new Map<string,Set<string>>();
  for(const line of ax.split('\n')){const match=/^\s*\d+ (Parallel\/Variety|Serial Numbered|Parallel|Rookie), Value: ([01])(?:,|$)/.exec(line);if(match){const set=states.get(match[1])??new Set<string>();set.add(match[2]);states.set(match[1],set);}}
  if(!states.has('Parallel/Variety')||!states.has('Serial Numbered')||Array.from(states.values()).some(v=>v.size!==1))return{observed:false,values:[]};
  return{observed:true,values:Array.from(states).filter(([,v])=>v.has('1')).map(([name])=>name)};
}
/** Read only the native Autographed control, never a following aspect's label. */
export function observedV2Autographed(ax:string):string[]{
  const lines=ax.split("\n"), at=lines.findIndex(l=>/button \(collapsed\) Autographed, ID:/.test(l)&&l.includes("item-specific-dropdown-label-"));
  if(at<0)return [];
  const next=lines.findIndex((l,n)=>n>at&&l.includes("item-specific-dropdown-label-"));
  const states=lines.slice(at+1,next<0?undefined:next).flatMap(l=>{const m=/^\s*\d+ checkbox (Yes|No), Value: ([01])(?:,|$)/.exec(l);return m?[{name:m[1],selected:m[2]==="1"}]:[];});
  if(states.length!==2||new Set(states.map(v=>v.name)).size!==2||states.filter(v=>v.selected).length!==1)return [];
  return states.filter(v=>v.selected).map(v=>v.name);
}
/** Numeric category evidence must come from a visible native category link or
 * selected Category control. Labels alone cannot bind a different catalog. */
export function assertV2ObservedCategory(raw:unknown,categoryId:string){
  if(isV2BatchRowObservation(raw)){assertV2BatchObservedCategory(raw,categoryId);return;}
  const x=observationSchema.parse(raw);
  const categoryLines=x.ax.split('\n').map(l=>l.trim()).filter(Boolean);
  const primary=categoryLines.filter(l=>/^\d+ button .* Item category First category$/.test(l));
  if(categoryId==='183454'&&(primary.length>1||primary.some(l=>!/^\d+ button CCG Individual Cards Item category First category$/.test(l))||x.dom.category.some(v=>v.text.trim()==='Trading Card Singles')))throw Error('Actual CCG category labels are conflicting or duplicated');
  const bound=x.dom.category.flatMap(v=>{
    const e=v as {text:string;href?:string;categoryId?:string;source?:string};
    if(!e.text.trim())return [];
    if((e.href||e.source==='visible-category-select')&&!x.ax.includes(e.text.trim()))throw Error('Actual category ID lacks visible named AX evidence');
    if(e.source==='visible-category-select'&&e.categoryId&&/^\d+$/.test(e.categoryId))return [e.categoryId];
    if(e.href){try{const u=new URL(e.href);if(u.origin!=='https://www.ebay.com')return [];const match=/^\/b\/[^/]+\/(\d+)(?:\/|$)/.exec(u.pathname);if(match)return [match[1]];}catch{/* No inferred category. */}}
    return [];
  });
  if(bound.length){if(new Set(bound).size!==1||bound[0]!==categoryId)throw Error('Actual category ID is conflicting or different');return;}
  if(categoryId==='183454'&&primary.length===1){
    const start=categoryLines.findIndex(l=>/^\d+ heading ITEM CATEGORY, Value: 2$/.test(l));
    const end=categoryLines.findIndex((l,n)=>n>start&&/^\d+ heading Store category, Value: 3$/.test(l));
    const section=start>=0&&end>start?categoryLines.slice(start,end):[];
    if(section.some(l=>/^\d+ button Edit Item category$/.test(l))&&section.includes(primary[0])&&x.dom.category.every(v=>!v.text.trim()||v.text.trim()==='CCG Individual Cards'))return;
  }
  // Retained sports observations predate numeric link capture. Preserve their
  // existing two-part breadcrumb proof only for the original sports category.
  if(categoryId==='261328'&&x.dom.category.some(v=>v.text==='Trading Card Singles')&&x.ax.includes('Sports Mem, Cards & Fan Shop > Sports Trading Cards'))return;
  // Actual Seller Hub non-sport editor presents the category as a named
  // button followed immediately by its complete parent breadcrumb, without a
  // numeric link/control. Accept this exact catalog path, never the leaf alone.
  if(categoryId==='183050'&&x.dom.category.filter(v=>v.text==='Trading Card Singles').length===1){
    const lines=x.ax.split('\n').map(l=>l.trim()).filter(Boolean),matches=lines.flatMap((l,n)=>/^\d+ button Trading Card Singles Item category First category$/.test(l)?[n]:[]);
    if(matches.length===1&&/^\d+ text in Collectibles > Non-Sport Trading Cards$/.test(lines[matches[0]+1]??''))return;
  }
  throw Error('Actual named numeric category evidence required');
}
export function assertV2NonpriceObservation(raw: unknown, review: z.infer<typeof reviewSchema>, card: V2Card, payload: V2Payload, verificationAt = Date.now()) {
  if(isV2BatchRowObservation(raw)){
    const expected=buildV2BatchNonpriceReview(raw,card,payload,review.evidence,verificationAt);
    if(digest(expected)!==digest(review))throw Error('Reviewed batch fields are not bound to the actual saved row');
    return;
  }
  const x = observationSchema.parse(raw); fresh(x.observedAt,verificationAt);
  const f = (name: string) => {const controls=x.dom.fields.filter(v=>v.name===name);if(controls.length>1)throw Error(`Ambiguous duplicate actual control: ${name}`);return controls[0];};
  if (x.draftId !== review.draftId || observedV2DraftId(x.url) !== review.draftId || x.observedAt !== review.observedAt || card.id !== review.cardId || card.captureId !== review.captureId || card.sku !== review.sku || payload.sku !== review.sku) throw Error("Exact saved draft/capture binding required");
  if (checkNames.some(name => review.checks[name] !== true) || (review.checks.categoryMatched!==true && !(payload.categoryId==="261328" && review.checks.sportsSinglesCategory===true)) || Object.keys(review.checks).some(name => ![...checkNames,"sportsSinglesCategory","categoryMatched"].includes(name))) throw Error("All allowlisted nonprice checks required");
  assertV2ObservedCategory(x,payload.categoryId);
  if (payload.conditionId!=="4000" || !["400010","Near mint or better - (ID: 400010)"].includes(payload.conditionDescriptorValue) || !["Card Condition","Card Condition - (ID: 40001)"].includes(payload.conditionDescriptorName)) throw Error("Unsupported frozen raw condition metadata");
  if (f("title")?.value !== payload.title || f("customLabel")?.value !== payload.sku || f("quantity")?.value !== String(payload.quantity) || f("condition")?.value !== "4000" || f("40001")?.value !== "400010" || !observedV2NearMintCondition(x.ax) || f("scheduleListingSelection")?.checked !== false) throw Error("Actual saved nonprice fields mismatch");
  if (x.dom.photos.length !== 2 || x.dom.photos.some((p,n) => !resource(p.background) || resource(p.background) !== resource(payload.photos[n].url))) throw Error("Actual original-pair photo resources mismatch");
  const specifics: Record<string,string[]> = {}, lines = x.ax.split("\n");
  for (const name of Object.keys(payload.specifics)) {
    if(name==="Event"){
      // Sports Singles presents the retained Event aspect as Event/Tournament. Accept only observed values, never an expected-value fill.
      const values:string[]=[];for(const label of ["Event","Event/Tournament"]){const field=f(`attributes.${label}`)?.value;if(field)values.push(field);const at=lines.findIndex(l=>l.includes(`button (collapsed) ${label}, ID:`)&&l.includes("item-specific-dropdown-label-"));const next=at<0?"":lines.slice(at+1).find(l=>/button \(collapsed\)/.test(l))??"";const value=/button \(collapsed\) (.*), Secondary Actions: Expand/.exec(next)?.[1];if(value)values.push(value);}
      if(new Set(values).size>1)throw Error("Conflicting Event and Event/Tournament observations");specifics[name]=values.length?[values[0]]:[];
    }
    else if(name==="Autographed") {const field=f(`attributes.${name}`)?.value, inline=lines.some(l=>/button \(collapsed\) Autographed, ID:/.test(l)&&l.includes("item-specific-dropdown-label-"));specifics[name]=inline?observedV2Autographed(x.ax):field?[field]:[];if(inline&&field&&digest(specifics[name])!==digest([field]))throw Error("Conflicting Autographed observations");}
    else if (name === "Features") {const actual=observedV2FeaturesWithSemantic(x.features.ax,x.rawSemanticSnapshot);if(!actual.observed)throw Error('Actual expanded Features options are unobserved or conflicting');specifics[name]=actual.values;}
    else if (f(`attributes.${name}`)?.value) specifics[name] = [f(`attributes.${name}`)!.value!];
    else { const at = lines.findIndex(l => l.includes(`button (collapsed) ${name}, ID:`) && l.includes("item-specific-dropdown-label-")); const next = at < 0 ? "" : lines.slice(at + 1).find(l => /button \(collapsed\)/.test(l)) ?? ""; const value = /button \(collapsed\) (.*), Secondary Actions: Expand/.exec(next)?.[1]; specifics[name] = value ? [value] : []; }
    if (digest([...specifics[name]].sort()) !== digest([...payload.specifics[name]].sort()) || review.aspectChecks[name] !== true) throw Error("Actual category specifics mismatch");
  }
  if (digest(specifics) !== digest(review.specifics) || digest(Object.keys(review.aspectChecks).sort()) !== digest(Object.keys(payload.specifics).sort())) throw Error("Reviewed specifics not bound to actual controls");
  const description = f("description")?.value ?? "", i = card.identity;
  if (!i || description !== review.description || !assessV2Description(description,i).acceptable) throw Error("Actual description requires factual review");
  if (!/eBay Managed Payments \(248164941010\)/.test(f("paymentPolicyId")?.value ?? "") || !observedV2NoReturnsPolicy(x.ax) || !x.ax.includes("(Waxahachie, Texas, United States)") || f("shippingPolicyId")?.value !== review.shipping.observedPolicy) throw Error("Actual policy/location observations mismatch");
}
async function reviewV2NonpriceLocal(root: string, packet: {evidence:z.infer<typeof ref>}, report:z.infer<typeof reportSchema>, expectedCardIds?:string[]) {
  // The public boundary already parsed and hash-checked this exact immutable report.
  fresh(report.reviewedAt);
  if(report.authority==="v2-leave-pricing-alone-20261103" && (report.kind!=="five-saved-draft-nonprice-review" || report.reviews.length>5)) throw Error("Current captured authority required for expanded review scope");
  if(report.authority!=="v2-leave-pricing-alone-20261103") {
    const queue=JSON.parse(await fs.readFile(path.join(root,"artifacts/engineering-mission/work-queue.json"),"utf8"));
    const instruction=queue.instructions?.find((i:{id:string})=>i.id===report.authority);
    if(instruction?.policyRefs?.includes("dedicated-background-browser-authorized")){await readV2BackgroundAuthority(root,report.authority);}
    else if(!instruction || !(instruction.policyRefs??[]).includes("leave-pricing-alone") || !(instruction.policyRefs??[]).includes("internal-browser-only") || !(instruction.policyRefs??[]).includes("draft-only-no-publication") || !(instruction.taskIds??[]).includes("v2-draft-upload-workflow-connection-20261103") || queue.instructions.some((i:{supersedes?:string[]})=>i.supersedes?.includes(report.authority))) throw Error("Current captured internal-browser nonprice authority required");
  }
  if (new Set(report.reviews.map(r => r.cardId)).size !== report.reviews.length || new Set(report.reviews.map(r => r.draftId)).size !== report.reviews.length) throw Error("Repeated review ownership");
  const observations = await Promise.all(report.reviews.map(r => evidence(root, r.evidence)));
  const lock = await acquireV2Lock("worker", root);
  try { return await withV2State(async s => {
    if (s.lastRun?.status === "running" && processAlive(s.lastRun.pid)) throw Error("Wait for current worker");
    const reviewedCardIds:string[]=[];
    for(let n=0;n<report.reviews.length;n++){const r=report.reviews[n];
      const c = s.cards[r.cardId], owned = Object.values(s.submissions).filter(sub => sub.draftId === r.draftId && sub.payload.captureIds.includes(r.captureId));
      if (!c || c.stage !== "prepared" || c.draftId !== r.draftId || owned.length !== 1 || owned[0].groupId !== c.groupId || owned[0].status !== "submitted" || c.issues.length) throw Error("Exact unheld prepared submission required");
      const sub=owned[0],members=Object.values(s.cards).filter(v=>sub.payload.captureIds.includes(v.captureId));
      if(sub.payload.quantity!==sub.payload.captureIds.length||members.length!==sub.payload.quantity||new Set(members.map(v=>v.captureId)).size!==members.length||Object.values(s.cards).some(v=>v.groupId===sub.groupId&&!sub.payload.captureIds.includes(v.captureId)))throw Error("Exact frozen quantity capture group required");
      if(members.length>1){
        if(c.sku!==sub.payload.sku||members.some(v=>!v.identity||v.stage!=="prepared"||v.groupId!==sub.groupId||v.draftId!==r.draftId||v.condition!==c.condition||v.issues.length||v.identity.damage||v.identity.graded||consolidationKey(v)!==sub.groupId||Object.values(s.submissions).filter(x=>x.payload.captureIds.includes(v.captureId)).length!==1))throw Error("Exact unheld matching quantity members required");
        const bound=await validateV2NonpriceGroupOwnership(root,sub.key,s);if(digest([...bound].sort())!==digest(members.map(v=>v.id).sort()))throw Error('Quantity member scope changed');
      }
      await validateV2BatchObservationSources(root,observations[n],sub.at);
      assertV2NonpriceObservation(observations[n], r, c, sub.payload);
      for(const member of members){if(reviewedCardIds.includes(member.id))throw Error('Overlapping quantity review');reviewedCardIds.push(member.id);}
    }
    if(expectedCardIds&&digest([...reviewedCardIds].sort())!==digest([...expectedCardIds].sort()))throw Error('Quantity review exceeds exact caller-owned job scope');
    for (const cardId of reviewedCardIds) { const c = s.cards[cardId],r=report.reviews.find(r=>r.draftId===c.draftId)!; c.nonpriceVerification = { scope: "non-price-fields", observedAt: r.observedAt, evidence: `${packet.evidence.path}#${packet.evidence.sha256}`, draftId: r.draftId, pricing: "deferred-preserved" }; c.nextAction = "Non-price fields reviewed; pricing and shipping deferred to seller/Grok. Full verification pending"; }
    event(s, "nonprice-reviewed", `Partial saved-draft review retained: ${packet.evidence.path}`);
    return { reviewed: reviewedCardIds.length, reviewedCardIds, scope: "non-price-fields", fullVerification: false, pricing: "deferred-preserved" };
  }, root); } finally { await lock(); }
}
export async function reviewV2Nonprice(root: string, raw: unknown, expectedCardIds?:string[], options?:{archiveRecovery:"caller-owned-exact-scope"}) {
  const packet=z.object({evidence:ref}).strict().parse(raw), report=reportSchema.parse(await evidence(root,packet.evidence));
  if(options){z.object({archiveRecovery:z.literal("caller-owned-exact-scope")}).strict().parse(options);if(!expectedCardIds?.length||new Set(expectedCardIds).size!==expectedCardIds.length)throw Error("Caller-owned archive recovery requires exact expected capture scope");}
  const result=await measureV2(root,"saved-draft-review",()=>reviewV2NonpriceLocal(root,packet,report,expectedCardIds),{cardIds:report.reviews.map(r=>r.cardId)});
  const archiveRecovery=options?[]:await recoverV2DraftArchivesAfterOperation(root);
  return {...result,archiveRecovery,...(options?{archiveRecoveryDeferred:true}:{})};
}

export function observedV2FeaturesWithSemantic(ax:string,semantic:unknown){const legacy=observedV2Features(ax),native=observedV2SemanticFeatures(semantic);if(typeof semantic==='string'&&semantic.includes('menu "Selected List of selected values"')&&!native.observed)return{observed:false,values:[] as string[]};if(legacy.observed&&native.observed&&digest([...legacy.values].sort())!==digest([...native.values].sort()))return{observed:false,values:[] as string[]};return native.observed?native:legacy;}
