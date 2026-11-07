import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { fingerprint, recordKnownInventoryObservation, recordVerifiedReceipt, type QueueState } from "./card-orchestrator.ts";

const observationSchema=z.object({
  cardId:z.string().min(1),soldItemId:z.string().regex(/^\d+$/).optional(),liveItemId:z.string().regex(/^\d+$/).optional(),draftId:z.string().regex(/^\d+$/).optional(),seller:z.literal("imaydit58"),
  sku:z.string().min(1),observedAt:z.string().datetime(),source:z.string().url(),
}).strict().refine(o=>[o.soldItemId,o.liveItemId,o.draftId].filter(Boolean).length===1,"Exactly one draft, live or sold receipt required");
export type ArchiveObservation=z.infer<typeof observationSchema>;
export function archiveCopyOnly(state:QueueState,observation:{cardId:string;liveItemId?:string;soldItemId?:string},requested=false){
  return requested||(!state.draftArchiveAuthority&&!observation.liveItemId&&!observation.soldItemId&&!!state.draftWriter?.scope.includes(observation.cardId)&&state.draftWriter.archiveMode!=="move");
}
const hash=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex");
function inside(root:string,file:string) {
  const relative=path.relative(root,file);
  if(!relative||relative===".."||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative))throw new Error("Archive path escapes its root");
}


function soldReceipt(state:QueueState,cardId:string,itemId:string){
  const c=state.cards[cardId];
  if(c?.exclusion?.disposition!=="sold"||c.exclusion.itemId!==itemId||c.jobs.photos.state!=="done")throw Error("Verified sold disposition and original pair required");
  const r=Object.values(state.knownInventoryObservations??{}).filter(r=>r.cardId===cardId&&r.itemId===itemId&&r.disposition==="sold").sort((a,b)=>b.observedAt.localeCompare(a.observedAt))[0];
  if(!r||r.source!==`https://www.ebay.com/itm/${itemId}`)throw Error("Exact seller sold observation required");
  recordKnownInventoryObservation(structuredClone(state),{...r,observationId:randomUUID()},r.observedAt);
  return {...r,frontHash:c.input.photos.find(p=>p.side==="front")!.sha256};
}

/** Copy-only archive. Original references and capture IDs are never rewritten or incremented. */
export async function archiveVerifiedPhotos(input:{state:QueueState;observation:unknown;sourceRoot:string;sourceRoots?:string[];archiveRoot:string;sellerHold?:string;manualPriceApproved?:boolean;now?:string}) {
  const o=observationSchema.parse(input.observation),now=input.now??new Date().toISOString();
  const age=Date.parse(now)-Date.parse(o.observedAt);
  if(!Number.isFinite(age)||age<0||age>60*60*1000)throw new Error("Fresh verified observation required for archive");
  if(o.soldItemId&&o.source!==`https://www.ebay.com/itm/${o.soldItemId}`)throw Error("Sold observation URL does not match item ID");
  if(o.liveItemId&&o.source!==`https://www.ebay.com/itm/${o.liveItemId}`)throw new Error("Live observation URL does not match item ID");
  if(!o.liveItemId&&!o.soldItemId){const url=new URL(o.source);if(url.hostname!=="www.ebay.com"||url.protocol!=="https:"||url.searchParams.get("draft_id")!==o.draftId)throw new Error("Draft observation URL does not match draft ID");}
  const card=input.state.cards[o.cardId];
  // A live archive records an already published disposition, not price approval.
  // The matching live exclusion and original-pair receipt are validated below.
  if(!card||card.input.sku!==o.sku||input.sellerHold||card.input.sourceHold||Object.entries(card.jobs).some(([kind,j])=>j.state==="leased"||(j.state==="held"&&!(kind==="pricing"&&(input.manualPriceApproved||!!o.liveItemId||!!o.soldItemId||!!o.draftId)))))throw new Error("Card missing, held or being processed; preserve originals");
  if(o.liveItemId&&(card.exclusion?.disposition!=="live"||card.exclusion.itemId!==o.liveItemId))throw new Error("Adopt the verified live receipt before archiving");
  if(!o.liveItemId&&!o.soldItemId&&(card.input.knownLive||card.exclusion?.disposition==="live"||(card.input.savedReceipts??[]).some(r=>r.disposition==="live")))throw new Error("Live listing cannot be archived as a draft");
  const receipt=o.soldItemId?soldReceipt(input.state,o.cardId,o.soldItemId):Object.values(input.state.verifiedReceipts??{}).find(r=>r.cardId===o.cardId&&(o.liveItemId?r.liveItemId===o.liveItemId:!r.liveItemId&&r.draftId===o.draftId));
  if(!receipt)throw new Error("Original-pair verified live receipt required");
  // Reuse receipt validation against CURRENT identity, pairing, jobs and cross-card ownership.
  // Validate on a clone; this operation never changes queue state or inventory.
  if(!o.soldItemId)recordVerifiedReceipt(structuredClone(input.state),{...receipt,observationId:randomUUID(),observedAt:o.observedAt},now);
  const sourceRoots:string[]=[];
  for(const root of [input.sourceRoot,...(input.sourceRoots??[])]){try{sourceRoots.push(await fs.realpath(root));}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}}
  // Validate both sides before copying either. A changed original cannot acquire archive authority.
  const originals=await Promise.all(card.input.photos.map(async p=>{
    const previous=input.state.photoArchives?.[o.cardId];
    const retained=previous?.status==="moved"?previous.files.find(f=>f.side===p.side&&f.sha256===p.sha256):undefined;
    const source=await fs.realpath(retained?.destination??p.path);
    if(!sourceRoots.some(root=>{try{inside(root,source);return true;}catch{return false;}}))throw new Error("Original path outside configured inbox/scanner roots");
    const bytes=await fs.readFile(source);
    if(hash(bytes)!==p.sha256)throw new Error("Original bytes changed; archive withheld");
    return {...p,source,bytes,originalSource:p.path};
  }));
  if(originals.length!==2||new Set(originals.map(p=>p.side)).size!==2)throw new Error("Exactly one original front/back pair required");
  await fs.mkdir(input.archiveRoot,{recursive:true});
  const root=await fs.realpath(input.archiveRoot),directory=path.join(root,(o.soldItemId??o.liveItemId??o.draftId)!);
  await fs.mkdir(directory,{recursive:true});inside(root,await fs.realpath(directory));
  const files=[];
  for(const p of originals){
    const destination=path.join(directory,`${p.side}-${p.sha256}${path.extname(p.path).toLowerCase()}`);
    // Exclusive creation prevents clobbering another archive or a different version.
    try {await fs.writeFile(destination,p.bytes,{flag:"wx"});}
    catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}
    inside(root,await fs.realpath(destination));
    if(hash(await fs.readFile(destination))!==p.sha256)throw new Error("Archive destination conflict; existing file preserved");
    files.push({side:p.side,source:p.source,originalSource:p.originalSource,destination,sha256:p.sha256});
  }
  const manifest={version:1,mode:"copy-preserve-references",cardId:o.cardId,...(o.soldItemId?{soldItemId:o.soldItemId}:o.liveItemId?{liveItemId:o.liveItemId}:{draftId:o.draftId}),
    captureId:`capture:${receipt.frontHash}`,receiptObservationId:receipt.observationId,files};
  const manifestPath=path.join(directory,`${receipt.frontHash}.json`);
  try {await fs.writeFile(manifestPath,JSON.stringify(manifest,null,2),{flag:"wx"});}
  catch(error){
    if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;
    inside(root,await fs.realpath(manifestPath));
    if(fingerprint(JSON.parse(await fs.readFile(manifestPath,"utf8")))!==fingerprint(manifest))throw new Error("Archive manifest conflict; preserve and inspect");
  }
  // Verify both original references still work after the operation.
  for(const p of originals)if(hash(await fs.readFile(p.source))!==p.sha256)throw new Error("Original changed during archive; retain both copies for review");
  return {manifestPath,...manifest,verifiedAt:now};
}

/** Phase one runs under the queue lock. Commit this mapping before removing any source. */
export async function preparePhotoMove(input:Parameters<typeof archiveVerifiedPhotos>[0]){
  const o=observationSchema.parse(input.observation),prior=input.state.photoArchives?.[o.cardId];
  if(prior){
    if(prior.soldItemId===o.soldItemId&&prior.liveItemId===o.liveItemId&&prior.draftId===o.draftId)return prior;
    // A copy-only draft still has its originals. The same validated live receipt
    // can archive those originals directly; retain the old draft copy/manifest.
    // archiveVerifiedPhotos checks both originals before any copy and phase two
    // checks both destinations before removal. Never promote a sold/live receipt.
    if(prior.liveItemId||prior.soldItemId||!prior.draftId||!o.liveItemId||!["moved","copied"].includes(prior.status))throw new Error("Archive receipt conflict or unfinished move");
  }
  const archived=await archiveVerifiedPhotos(input);
  const entry={soldItemId:o.soldItemId,liveItemId:o.liveItemId,draftId:o.draftId,captureId:archived.captureId,manifestPath:archived.manifestPath,
    archiveRoot:await fs.realpath(input.archiveRoot),status:"copied" as const,files:archived.files};
  input.state.photoArchives??={};input.state.photoArchives[o.cardId]=entry;return entry;
}

/** Phase two requires a previously committed mapping; retries accept already removed sources. */
export async function finishPhotoMove(state:QueueState,cardId:string,sourceRoots:string[],sellerHold?:string,manualPriceApproved=false){
  const entry=state.photoArchives?.[cardId],card=state.cards[cardId];
  if(!entry||!card||sellerHold||card.input.sourceHold||Object.entries(card.jobs).some(([kind,j])=>j.state==="leased"||(j.state==="held"&&!(kind==="pricing"&&(manualPriceApproved||!!entry.liveItemId||!!entry.soldItemId||!!entry.draftId)))))throw new Error("Archive missing or card held; source files retained");
  if(entry.liveItemId&&(card.exclusion?.disposition!=="live"||card.exclusion.itemId!==entry.liveItemId))throw new Error("Live receipt changed; source files retained");
  if(!entry.liveItemId&&!entry.soldItemId&&(card.input.knownLive||card.exclusion?.disposition==="live"||(card.input.savedReceipts??[]).some(r=>r.disposition==="live")))throw new Error("Live receipt superseded draft move; retain source");
  const receipt=entry.soldItemId?soldReceipt(state,cardId,entry.soldItemId):Object.values(state.verifiedReceipts??{}).find(r=>r.cardId===cardId&&(entry.liveItemId?r.liveItemId===entry.liveItemId:!r.liveItemId&&r.draftId===entry.draftId));
  if(!receipt)throw new Error("Verified receipt missing");
  if(!entry.soldItemId)recordVerifiedReceipt(structuredClone(state),{...receipt,observationId:randomUUID()},new Date().toISOString());
  const roots:string[]=[];for(const root of sourceRoots){try{roots.push(await fs.realpath(root));}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}}
  const archiveRoot=await fs.realpath(entry.archiveRoot);
  if(entry.files.length!==2)throw new Error("Archive pair incomplete");
  // Validate the entire pair before removing either source. Never trust a destination merely because it exists.
  for(const file of entry.files){
    if(!card.input.photos.some(p=>p.path===(file.originalSource??file.source)&&p.sha256===file.sha256&&p.side===file.side))throw new Error("Original mapping changed");
    const dest=await fs.realpath(file.destination);inside(archiveRoot,dest);
    if(hash(await fs.readFile(dest))!==file.sha256)throw new Error("Archive hash mismatch; source files retained");
  }
  const sources:string[]=[];
  for(const file of entry.files){
    if(Object.values(state.cards).some(other=>other!==card&&other.input.photos.some(p=>path.resolve(p.path)===path.resolve(file.source))))throw new Error("Original path is shared by another capture; retain source for reconciliation");
    try{
      const source=await fs.realpath(file.source);
      if(!roots.some(root=>{try{inside(root,source);return true;}catch{return false;}}))throw new Error("Source outside configured roots");
      if(source===await fs.realpath(file.destination))throw new Error("Source equals archive destination");
      if(hash(await fs.readFile(source))!==file.sha256)throw new Error("Source changed; preserve for review");
      sources.push(file.source);
    }catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
  }
  for(const source of sources)await fs.unlink(source);
  entry.status="moved";if(state.photoArchiveFailures)delete state.photoArchiveFailures[cardId];return entry;
}
