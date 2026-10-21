import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { CARD_POLICY, CARD_POLICY_VERSION, calculateCardPrice, money } from "./card-orchestrator-policy.ts";

export const kinds = ["photos", "identity", "reconcile", "pricing", "listing"] as const;
export type JobKind = typeof kinds[number];
export type Photo = { side: "front" | "back"; path: string; sha256: string };
const text = z.string().trim().min(1).max(500);
const identitySchema = z.object({
  player: text, season: text, set: text, manufacturer: text, cardNumber: text,
  sport: text, team: z.string().max(200), parallel: text, serial: z.string().max(50),
  printRun: z.number().int().positive().nullable(), condition: z.enum(["Near mint or better", "Excellent", "Very good", "Poor"]),
  autograph: z.boolean().nullable(), patch: z.boolean(),
}).strict();
export type Identity = z.infer<typeof identitySchema>;
export type PricingHandoff = {
  status: string; item: number | null; shipping: number | null; updatedAt: string;
  policyVersion: string; reason: string; source: string; matchesOriginals: boolean;
  needsReview: true;
};
export type CardInput = { id: string; sku: string; identity: Identity; photos: Photo[];
  candidates: unknown[]; override?: { item: number; shipping: number; evidence: string };
  pricingHandoff?: PricingHandoff;
  source: string; sourceHold?: string; identityIssue?: string;
  knownLive?: { itemId: string; url: string; observedAt: string; source: string };
  knownDraft?: string;
  savedReceipts?: {disposition:"live"|"draft";itemId:string;source:string}[];
};
type JobResult = Record<string, unknown>;
export type Job = { kind: JobKind; inputKey: string; state: "todo" | "leased" | "done" | "held";
  attempts: number; elapsedMs: number; reason?: string; result?: JobResult;
  lease?: { token: string; owner: string; startedAt: string; expiresAt: string } };
export type CardRecord = { input: CardInput; createdAt: string; updatedAt: string; jobs: Record<JobKind, Job>;
  exclusion?: { disposition: string; itemId: string; evidence: string } };
export type QueueState = { schemaVersion: 1; revision: number; policyVersion: string; seller: string;
  mode: "local-preparation-only"; externalWriterPossible: boolean; cards: Record<string, CardRecord>;
  rejectedImports?: Record<string, { inputKey: string; reason: string; sku?:string; player?:string }>;
  events: { at: string; cardId: string; kind: string; event: string; detail: string }[] };

export const fingerprint = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const newQueue = (): QueueState => ({schemaVersion:1,revision:0,policyVersion:CARD_POLICY_VERSION,seller:CARD_POLICY.seller,mode:"local-preparation-only",externalWriterPossible:true,cards:{},events:[]});
const event = (s:QueueState,id:string,kind:string,action:string,detail:string,now:string) => {
  s.events.push({at:now,cardId:id,kind,event:action,detail});
};
export function reviewedIdentity(card: CardRecord): Identity | undefined {
  return card.jobs.identity?.state === "done" ? card.jobs.identity.result?.identity as Identity : undefined;
}
function keys(card: CardRecord) {
  const i = card.input, identity = reviewedIdentity(card) ?? i.identity;
  return {
    photos:fingerprint(i.photos),
    identity:fingerprint([i.identity,i.photos,i.identityIssue??"",i.sourceHold??"",card.jobs.photos?.inputKey]),
    reconcile:fingerprint([CARD_POLICY.seller,identity,card.jobs.identity?.inputKey,i.photos,i.knownLive??null,i.knownDraft??null]),
    pricing:fingerprint([CARD_POLICY_VERSION,identity,card.jobs.identity?.inputKey,i.candidates,i.override??null]),
    listing:fingerprint(["local-review-v2",CARD_POLICY_VERSION,identity,card.jobs.identity?.inputKey,i.photos,card.jobs.pricing?.state,card.jobs.pricing?.result??null,i.sku]),
  };
}
export function refreshJobs(card: CardRecord, now: string) {
  // Dependents see the freshly invalidated identity before their own keys are calculated.
  for (const kind of kinds) {
    const key = keys(card)[kind], old = card.jobs[kind];
    if (!old || old.inputKey !== key) card.jobs[kind]={kind,inputKey:key,state:"todo",attempts:0,elapsedMs:0};
    const job = card.jobs[kind];
    if (job.state === "leased" && Date.parse(job.lease!.expiresAt) <= Date.parse(now)) {
      job.state = job.attempts >= CARD_POLICY.maxAttemptsPerInput ? "held" : "todo";
      job.reason = "Lease expired; prior worker is fenced from completing";
      job.elapsedMs += Math.max(0,Date.parse(job.lease!.expiresAt)-Date.parse(job.lease!.startedAt));
      delete job.lease;
    }
    if(kind==="pricing"&&job.state==="done") {
      try{validateComps(reviewedIdentity(card)??card.input.identity,job.result?.comps,now,job.result?.basis as CompBasis|undefined);}
      catch{job.state="held";job.reason="Saved comp evidence is no longer valid; fresh evidence required";delete job.result;}
    }
    if(kind==="reconcile"&&job.state==="done"&&job.result?.disposition==="clear"&&Date.parse(now)-Date.parse(String(job.result.checkedAt))>CARD_POLICY.reconciliationMaxAgeMinutes*60000) {
      job.state="held";job.reason="Previous inventory clearance expired; fresh four-scope check required";
    }
  }
}
export function upsertCard(s:QueueState,input:CardInput,now=new Date().toISOString()) {
  if (!/^[\w-]{1,100}$/.test(input.id) || !input.sku.trim() || input.photos.length!==2 || new Set(input.photos.map(p=>p.side)).size!==2) throw new Error("Invalid card ID, SKU or photo pair");
  if (input.photos.some(p=>!p.path || !/^[a-f0-9]{64}$/i.test(p.sha256))) throw new Error("Missing original photo hashes");
  identitySchema.parse(input.identity);
  const old = s.cards[input.id];
  input={...input,knownLive:input.knownLive??old?.input.knownLive,knownDraft:input.knownDraft??old?.input.knownDraft};
  if (old && fingerprint(old.input)===fingerprint(input)) { refreshJobs(old,now); return false; }
  const card = old ?? {input,createdAt:now,updatedAt:now,jobs:{} as Record<JobKind,Job>};
  // A missing legacy live marker must never erase a positive receipt already recorded here.
  card.input={...input,knownLive:input.knownLive??old?.input.knownLive,knownDraft:input.knownDraft??old?.input.knownDraft};
  card.updatedAt=now; refreshJobs(card,now); s.cards[input.id]=card;
  event(s,input.id,"import",old?"source-updated":"imported",input.source,now); return true;
}
export function alreadyListed(card:CardRecord) {
  return !!card.input.knownLive || !!card.input.knownDraft || !!card.exclusion || (card.jobs.reconcile.state==="done" && card.jobs.reconcile.result?.disposition!=="clear");
}
export function existingReceipt(card:CardRecord):{disposition:string;itemId:string}|null {
  if(card.input.knownLive)return {disposition:"live",itemId:card.input.knownLive.itemId};
  if(card.exclusion)return {disposition:card.exclusion.disposition,itemId:card.exclusion.itemId};
  if(card.input.knownDraft)return {disposition:"draft",itemId:card.input.knownDraft};
  const result=card.jobs.reconcile.state==="done"?card.jobs.reconcile.result:undefined;
  return result&&result.disposition!=="clear"&&result.itemId?{disposition:String(result.disposition),itemId:String(result.itemId)}:null;
}
function receiptOwnershipConflicts(s:QueueState) {
  const owners=new Map<string,Set<string>>();
  for(const c of Object.values(s.cards)) {
    const ids=[c.input.knownLive?.itemId,c.input.knownDraft,c.exclusion?.itemId,...(c.input.savedReceipts??[]).map(r=>r.itemId)].filter((id):id is string=>!!id);
    for(const id of ids){const cards=owners.get(id)??new Set<string>();cards.add(c.input.id);owners.set(id,cards);}
  }
  return Array.from(owners).filter(([,owners])=>owners.size>1).map(([itemId,owners])=>({itemId,cardIds:Array.from(owners).sort()}));
}
function duplicateReason(s:QueueState,c:CardRecord):string|undefined {
  const id = reviewedIdentity(c) ?? c.input.identity;
  const photoKey = c.input.photos.map(p=>p.sha256.toLowerCase()).sort().join(":");
  for (const other of Object.values(s.cards)) {
    if(other.input.id===c.input.id)continue;
    if(other.input.sku===c.input.sku)return `SKU also belongs to ${other.input.id}`;
    if(other.input.photos.map(p=>p.sha256.toLowerCase()).sort().join(":")===photoKey)return `Same original photo bytes as ${other.input.id}; no additional inventory assumed`;
    const oi=reviewedIdentity(other)??other.input.identity;
    if(id.serial && oi.serial && matchKey(id,true)===matchKey(oi,true))return `Exact serialized identity also belongs to ${other.input.id}`;
  }
  return undefined;
}
export function jobBlockers(s:QueueState,c:CardRecord,kind:JobKind):string[] {
  const reasons:string[]=[];
  // A draft receipt prevents another Add, but must not hide unfinished pricing.
  const draftLocal = ["photos","identity","pricing"].includes(kind) && existingReceipt(c)?.disposition === "draft";
  if(alreadyListed(c) && !draftLocal) reasons.push("Already live or existing draft/scheduled/sold match: do not create Add");
  if(draftLocal && receiptOwnershipConflicts(s).some(conflict=>conflict.cardIds.includes(c.input.id))) reasons.push("Conflicting draft receipt ownership; reconcile before local work");
  const duplicate=duplicateReason(s,c); if(duplicate)reasons.push(duplicate);
  if(kind!=="photos" && c.jobs.photos.state!=="done")reasons.push("Original photo audit required");
  if(["pricing","reconcile","listing"].includes(kind) && !reviewedIdentity(c))reasons.push("Reviewed identity required");
  return reasons;
}
export function claimJob(s:QueueState,owner:string,kind?:JobKind,cardId?:string,now=new Date().toISOString()) {
  if(!owner.trim()||owner.length>200)throw new Error("Worker name required");
  for(const c of Object.values(s.cards).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.input.id.localeCompare(b.input.id))) {
    if(cardId && c.input.id!==cardId)continue;
    refreshJobs(c,now);
    for(const k of kind?[kind]:kinds) {
      const j=c.jobs[k];
      if(j.state!=="todo" || jobBlockers(s,c,k).length)continue;
      if(k==="pricing"&&Object.values(s.cards).some(other=>other.input.id!==c.input.id
        &&other.jobs.pricing.state==="leased"&&Date.parse(other.jobs.pricing.lease!.expiresAt)>Date.parse(now)
        &&matchKey(reviewedIdentity(other)??other.input.identity)===matchKey(reviewedIdentity(c)??c.input.identity)))continue;
      if(j.attempts>=CARD_POLICY.maxAttemptsPerInput) {j.state="held";j.reason="Attempt limit reached for unchanged input";continue;}
      j.state="leased";j.attempts++;
      j.lease={token:randomUUID(),owner,startedAt:now,expiresAt:new Date(Date.parse(now)+CARD_POLICY.leaseSeconds*1000).toISOString()};
      event(s,c.input.id,k,"claimed",owner,now);
      return {card:c.input,job:structuredClone(j),reviewedIdentity:reviewedIdentity(c)??null,policy:CARD_POLICY};
    }
  }
  return null;
}
const https = z.string().url().refine(value=>{const u=new URL(value);return u.protocol==="https:"&&!u.username&&!u.password;},"HTTPS source without credentials required");
const compSchema=z.object({
  saleId:text,sourceUrl:https,soldDate:z.string(),itemPrice:z.number().refine(x=>money(x,true)),
  shipping:z.number().refine(x=>money(x)).nullable(),currency:z.literal("USD"),
  identity:identitySchema,serialObserved:z.boolean(),priceDisclosed:z.literal(true),
  ownAcquisition:z.literal(false),graded:z.literal(false),lot:z.literal(false),
  condition:z.enum(["Near mint or better","Excellent","Unknown"]),
  evidenceMode:z.enum(["original-sale","sold-result"]),evidence:text,
}).strict();
export type CompEvidence=z.infer<typeof compSchema>;
export type CompBasis = "exact" | "related-print-run";
export function matchKey(i:Identity,withSerial=false) {
  // Physical serial is excluded only for comparable-copy matching, never for inventory identity.
  return [i.player,i.season,i.set,i.manufacturer,i.cardNumber,i.sport,i.parallel,i.printRun??"",i.autograph??"unknown",i.patch,withSerial?normalizeSerial(i.serial):""].map(v=>String(v).trim().toLowerCase().replace(/\s+/g," ")).join("|");
}
function normalizeSerial(serial:string) {return serial.replace(/\d+/g,x=>String(Number(x)));}
export function validateComps(identity:Identity,raw:unknown,now:string,basis:CompBasis="exact") {
  if(basis!=="exact"&&basis!=="related-print-run")throw new Error("Unsupported comp basis");
  const comps=z.array(compSchema).min(1).max(50).parse(raw),seen=new Set<string>();let reviewEstimate=false;
  const basisDetails:{saleId:string;sourceUrl:string;itemPrice:number;sourcePrintRun:number|null;targetPrintRun:number|null;multiplier:number;adjustedItemPrice:number}[]=[];
  for(const c of comps) {
    const date=new Date(`${c.soldDate}T00:00:00Z`),age=(Date.parse(now)-date.getTime())/86400000;
    if(!/^\d{4}-\d{2}-\d{2}$/.test(c.soldDate)||!Number.isFinite(age)||date.toISOString().slice(0,10)!==c.soldDate||age<0||age>=CARD_POLICY.compMaxAgeDays+1)throw new Error("Comp date outside the supported 90-day window");
    const u=new URL(c.sourceUrl),ebayId=/(?:^|\.)ebay\.[a-z.]+$/i.test(u.hostname)?u.pathname.match(/\/itm\/(?:[^/]+\/)?(\d+)/)?.[1]:undefined;
    const key=ebayId??`${u.origin}${u.pathname}`;
    if(seen.has(key)||seen.has(`id:${c.saleId}`))throw new Error("Duplicate sale evidence");
    seen.add(key);seen.add(`id:${c.saleId}`);
    let multiplier=1;
    if(basis==="related-print-run") {
      if(!identity.printRun||!c.identity.printRun)throw new Error("Related estimates require known numbered print runs");
      if(matchKey(identity)===matchKey(c.identity))throw new Error("Use the exact basis for matching parallels");
      if(matchKey(identity)!==matchKey({...c.identity,parallel:identity.parallel,printRun:identity.printRun}))throw new Error("Related comp must be the same card; only parallel and print run may differ");
      multiplier=c.identity.printRun/identity.printRun;
      reviewEstimate=true;
    } else if(matchKey(identity)!==matchKey(c.identity))throw new Error("Comp identity/parallel does not match");
    if(identity.serial && (!c.serialObserved || !c.identity.serial))throw new Error("Comp physical serial must be inspected to exclude own acquisitions");
    if(c.identity.printRun) {
      const serial=/^(\d+)\/(\d+)$/.exec(c.identity.serial);
      if(!c.serialObserved||!serial||Number(serial[2])!==c.identity.printRun||Number(serial[1])<1||Number(serial[1])>c.identity.printRun)throw new Error("Comp serial requires an inspected complete numerator/denominator matching its print run");
    }
    if(identity.serial && normalizeSerial(identity.serial)===normalizeSerial(c.identity.serial))throw new Error("Own exact-serial acquisition excluded");
    if(c.condition==="Unknown" && c.evidenceMode!=="sold-result")throw new Error("Unresolved original-sale condition");
    if(c.condition!==identity.condition || c.evidenceMode==="sold-result")reviewEstimate=true;
    basisDetails.push({saleId:c.saleId,sourceUrl:c.sourceUrl,itemPrice:c.itemPrice,sourcePrintRun:c.identity.printRun,targetPrintRun:identity.printRun,multiplier,adjustedItemPrice:c.itemPrice*multiplier});
  }
  return {comps,basis,basisDetails,reviewEstimate,mean:basisDetails.reduce((sum,c)=>sum+c.adjustedItemPrice,0)/comps.length};
}
export function completeJob(s:QueueState,id:string,kind:JobKind,token:string,raw:unknown,now=new Date().toISOString()) {
  const c=s.cards[id];if(!c)throw new Error("Unknown card");refreshJobs(c,now);
  const job=c.jobs[kind];if(job.state!=="leased"||job.lease?.token!==token)throw new Error("Lease expired, superseded or owned by another worker");
  if(jobBlockers(s,c,kind).length)throw new Error("Card prerequisites changed during this lease");
  const envelope=z.object({outcome:z.enum(["done","held"]),reason:z.string().max(2000).optional(),data:z.unknown().optional()}).strict().parse(raw);
  let result:JobResult|undefined;
  if(envelope.outcome==="held") {
    if(!envelope.reason?.trim())throw new Error("A held task needs a concrete reason");
  } else if(kind==="photos") {
    result=z.object({hashes:z.array(z.object({side:z.enum(["front","back"]),sha256:z.string()})).length(2),evidence:text}).strict().parse(envelope.data);
    const hashes=result.hashes as {side:string;sha256:string}[];
    if(new Set(hashes.map(p=>p.side)).size!==2||c.input.photos.some(p=>!hashes.some(h=>h.side===p.side&&h.sha256.toLowerCase()===p.sha256.toLowerCase())))throw new Error("Original photo hash mismatch");
  } else if(kind==="identity") {
    result=z.object({identity:identitySchema,pairMatches:z.literal(true),frontFirst:z.literal(true),serialInspected:z.boolean(),evidence:text}).strict().parse(envelope.data);
    const i=result.identity as Identity;
    if(i.serial) {
      const m=/^(\d+)\/(\d+)$/.exec(i.serial);
      if(!result.serialInspected||!m||!i.printRun||Number(m[2])!==i.printRun||Number(m[1])<1||Number(m[1])>i.printRun)throw new Error("Serialized cards need an inspected, complete numerator/denominator");
    } else if(i.printRun)throw new Error("Missing physical serial");
    if(i.condition!==c.input.identity.condition)throw new Error("Condition override needs a direct user correction in the input source");
    if(i.autograph===null)throw new Error("Confirm autograph presence or absence during visual review");
  } else if(kind==="pricing") {
    const payload=z.object({comps:z.unknown(),tracked:z.boolean(),envelopeEligible:z.boolean(),evidence:text,
      basis:z.enum(["exact","related-print-run"]).default("exact"),exactSearchEvidence:text.optional()}).strict().parse(envelope.data);
    if(payload.basis==="related-print-run"&&!payload.exactSearchEvidence)throw new Error("Related estimates require evidence that usable exact sold comps were unavailable");
    const i=reviewedIdentity(c)!,validated=validateComps(i,payload.comps,now,payload.basis);
    result={...validated,projection:calculateCardPrice(validated.mean,{patch:i.patch,tracked:payload.tracked,override:c.input.override}),envelopeEligible:payload.envelopeEligible,tracked:payload.tracked,evidence:payload.evidence,exactSearchEvidence:payload.exactSearchEvidence};
  } else if(kind==="reconcile") {
    const payload=z.object({seller:z.literal("imaydit58"),disposition:z.enum(["clear","live","draft","scheduled","sold","ambiguous"]),
      checkedAt:z.string().datetime(),scopes:z.array(z.enum(["active","drafts","scheduled","sold"])),
      itemId:z.string().optional(),url:https.optional(),evidence:text}).strict().parse(envelope.data);
    if(Date.parse(payload.checkedAt)>Date.parse(now)||Date.parse(now)-Date.parse(payload.checkedAt)>CARD_POLICY.reconciliationMaxAgeMinutes*60000)throw new Error("Reconciliation observation is not fresh");
    if(payload.disposition==="clear"&&new Set(payload.scopes).size!==4)throw new Error("Clearance needs active, draft, scheduled and sold checks");
    if(payload.disposition==="ambiguous")throw new Error("Ambiguous inventory must be held");
    if(payload.disposition!=="clear"&&!payload.itemId)throw new Error("Existing inventory requires a receipt ID");
    result=payload;
    if(payload.disposition!=="clear")c.exclusion={disposition:payload.disposition,itemId:payload.itemId!,evidence:payload.evidence};
  } else {
    // Listing text is deterministic. Workers cannot inject an executable Add action or an arbitrary price.
    z.object({prepare:z.literal(true)}).strict().parse(envelope.data);
    result=prepareLocalListing(c);
  }
  const elapsed=Math.max(0,Date.parse(now)-Date.parse(job.lease!.startedAt));
  job.elapsedMs+=elapsed;delete job.lease;job.state=envelope.outcome;job.result=result;job.reason=envelope.reason;
  if(kind==="pricing"&&elapsed>CARD_POLICY.researchLimitSeconds*1000)job.reason=[job.reason,"Research exceeded the 90-second target; retain the measured time"].filter(Boolean).join("; ");
  c.updatedAt=now;event(s,id,kind,envelope.outcome,envelope.reason??"Result validated",now);refreshJobs(c,now);
}
export function retryHeld(s:QueueState,id:string,kind:JobKind,evidence:string,now=new Date().toISOString()) {
  const j=s.cards[id]?.jobs[kind];if(!j||j.state!=="held")throw new Error("Only a held job can be retried");
  if(!evidence.trim()||j.attempts>=CARD_POLICY.maxAttemptsPerInput)throw new Error("New input evidence is required after the attempt limit");
  j.state="todo";j.reason=`Retry supported by: ${evidence}`;event(s,id,kind,"retry",evidence,now);
}
export function quarantineImport(s:QueueState,id:string,reason:string,now=new Date().toISOString()) {
  const c=s.cards[id];if(!c)return;
  const message=`Source import requires review: ${reason}`;
  if(c.input.sourceHold===message)return;
  c.input.sourceHold=message;c.updatedAt=now;
  for(const kind of kinds){const job=c.jobs[kind];job.state="held";job.reason=message;delete job.lease;delete job.result;}
  event(s,id,"import","held",message,now);
  // Retain these holds until a valid import or an explicit, evidenced retry changes the input.
  for(const kind of kinds)c.jobs[kind].inputKey=keys(c)[kind];
}
export function listingTitle(i:Identity):string {
  const format=(set:string,parallel:string)=>[i.season,set,i.player,`#${i.cardNumber}`,parallel,i.serial].filter(Boolean).join(" ").replace(/\s+/g," ").trim();
  const set=i.set.toLowerCase().startsWith(`${i.manufacturer.toLowerCase()} `)?i.set.slice(i.manufacturer.length).trim():i.set;
  const parallel=/\bPrizm\b/i.test(set)?i.parallel.replace(/\s+Prizm$/i,""):i.parallel;
  // Remove only redundant brand words. Never truncate the player, parallel, card number or serial.
  const title=[format(i.set,i.parallel),format(set,i.parallel),format(set,parallel)].find(value=>value.length<=80);
  if(!title)throw new Error("Title exceeds 80 characters after removing redundant brand words; verified wording needs review");
  return title;
}
export function localReviewListings(s:QueueState,now=new Date().toISOString()):(JobResult & {id:string})[] {
  for(const c of Object.values(s.cards))refreshJobs(c,now);
  return Object.values(s.cards).filter(c=>c.jobs.listing.state==="done"&&!jobBlockers(s,c,"listing").length)
    .map(c=>({id:c.input.id,...c.jobs.listing.result}));
}
export function prepareLocalListing(c:CardRecord):JobResult {
  const i=reviewedIdentity(c);if(!i)throw new Error("Identity review required");
  const title=listingTitle(i);
  return {action:"",seller:CARD_POLICY.seller,category:"261328",sku:c.input.sku,title,quantity:1,
    conditionType:"Ungraded",condition:i.condition,description:`${title}. One ungraded card. You will receive the exact card pictured. Please inspect both original photos.`,
    specifics:{Sport:i.sport,"Player/Athlete":i.player,Season:i.season,Manufacturer:i.manufacturer,Set:i.set,"Card Number":i.cardNumber,Team:i.team,"Parallel/Variety":i.parallel},
    pricing:c.jobs.pricing.state==="done"?c.jobs.pricing.result?.projection:null,
    priceBasis:c.jobs.pricing.state==="done"?c.jobs.pricing.result?.basis??"exact":null,
    priceBasisDetails:c.jobs.pricing.state==="done"?c.jobs.pricing.result?.basisDetails??null:null,
    priceNeedsReview:true,reviewEstimate:c.jobs.pricing.result?.reviewEstimate??false,
    shippingNeedsReview:c.jobs.pricing.state!=="done"||(!c.jobs.pricing.result?.tracked&&!c.jobs.pricing.result?.envelopeEligible),
    promotion:{generalPercent:CARD_POLICY.generalPromotionPercent,priority:false},
    front:c.input.photos.find(p=>p.side==="front"),back:c.input.photos.find(p=>p.side==="back"),canUpload:false,canPublish:false};
}
export function queueSummary(s:QueueState,now=new Date().toISOString()) {
  const conflicts=receiptOwnershipConflicts(s);
  const importExceptions=Object.entries(s.rejectedImports??{}).map(([id,{reason,sku,player}])=>({id,reason,sku:sku??null,player:player??null}));
  const cards=Object.values(s.cards),counts={cards:cards.length,alreadyListed:0,localListingsPrepared:0,excludedPreparedListings:0,receiptConflicts:conflicts.length,importExceptions:importExceptions.length,heldJobs:0,doneJobs:0,leasedJobs:0,actionableJobs:0,readyForUpload:0};
  const rows=cards.map(c=>{refreshJobs(c,now);if(alreadyListed(c))counts.alreadyListed++;
    const jobs=kinds.map(kind=>{const j=c.jobs[kind],blockers=jobBlockers(s,c,kind);
      if(j.state==="held")counts.heldJobs++;if(j.state==="done")counts.doneJobs++;if(j.state==="leased")counts.leasedJobs++;
      if(j.state==="todo"&&!blockers.length)counts.actionableJobs++;
      return {kind,state:j.state,attempts:j.attempts,elapsedMs:j.elapsedMs,owner:j.lease?.owner??null,reason:j.reason??null,blockers};});
    if(c.jobs.listing.state==="done") {
      if(jobBlockers(s,c,"listing").length)counts.excludedPreparedListings++;else counts.localListingsPrepared++;
    }
    const receipt=existingReceipt(c);
    return {id:c.input.id,sku:c.input.sku,player:(reviewedIdentity(c)??c.input.identity).player,serial:(reviewedIdentity(c)??c.input.identity).serial,existingReceipt:receipt,pricingHandoff:c.input.pricingHandoff??null,receiptConflicts:conflicts.filter(conflict=>conflict.cardIds.includes(c.input.id)).map(conflict=>conflict.itemId),liveItemId:receipt?.disposition==="live"?receipt.itemId:null,sourceHold:c.input.sourceHold??null,identityIssue:c.input.identityIssue??null,jobs};});
  return {asOf:now,policyVersion:CARD_POLICY_VERSION,mode:s.mode,externalWriterPossible:s.externalWriterPossible,counts,
    capabilities:{localPreparation:true,originalFileAudit:true,workerLeases:true,automaticPhotoHosting:false,liveListingWrites:false},
    globalHolds:["Hosted-image CSV route is not connected; native photo-upload and draft-first routes are separate and not automated here","Final eBay publication remains a user handoff","Existing Card Inbox automation has not adopted this queue"],receiptConflicts:conflicts,importExceptions,cards:rows};
}
