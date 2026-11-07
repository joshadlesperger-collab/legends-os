import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { money } from "./card-orchestrator-policy.ts";
import { BacklogReadError } from "./card-backlog-errors.ts";
import type { BacklogSnapshot } from "./card-backlog.ts";
import { canApprovePrice, canSetManualPrice, manualPriceBinding, validManualPrice, reviewBinding, type ReviewCommand, type ReviewEvent, type WorkflowSnapshot } from "./card-workflow.ts";

type ReviewFile = { version: 1; events: ReviewEvent[] };
export class WorkflowConflict extends Error {}
const tokenFor = (card: BacklogSnapshot["cards"][number]) => createHash("sha256").update(reviewBinding(card)).digest("hex");
const manualTokenFor = (card: BacklogSnapshot["cards"][number]) => createHash("sha256").update(manualPriceBinding(card)).digest("hex");
const reviewRoot = () => process.env.CARD_WORKFLOW_REVIEW_ROOT || process.cwd();
export async function readReviews(root = reviewRoot()): Promise<ReviewFile> {
  try {
    const data = JSON.parse(await fs.readFile(path.join(root,"artifacts/card-backlog/reviews.json"),"utf8"));
    if (!data || data.version !== 1 || !Array.isArray(data.events) || data.events.some((e: ReviewEvent) => !e || !e.cardId || !e.token || !["approve-price","set-price","hold","resume","note"].includes(e.action) || typeof e.note !== "string" || !e.requestId || !Number.isFinite(Date.parse(e.at)) || (e.action==="set-price"&&(!(e.price && money(e.price.item,true) && money(e.price.shipping))||!e.priceBinding)))) throw new BacklogReadError("EVIDENCE_INVALID");
    return data;
  } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return { version:1,events:[] }; throw e; }
}
export async function withWorkflow(snapshot: BacklogSnapshot, root = reviewRoot()): Promise<WorkflowSnapshot> {
  const file = await readReviews(root);
  const byCard = new Map<string, ReviewEvent[]>();
  for (const event of file.events) byCard.set(event.cardId,[...(byCard.get(event.cardId) || []),event]);
  const workflow = Object.fromEntries(snapshot.cards.map(card => {
    const token = tokenFor(card), history = byCard.get(card.id) || [], current = history.filter(e => e.token === token);
    const approval = [...current].reverse().find(e => e.action === "approve-price");
    const manual=[...history].reverse().find(e=>e.action==="set-price");
    // Preserve the approved amount for receipt/archive audit after publication.
    // saveReview still rejects new price edits for live inventory.
    const manualPrice=manual?.priceBinding===manualTokenFor(card)&&validManualPrice(manual.price)
      &&canSetManualPrice({...card,receipts:card.receipts.filter(r=>r.disposition!=="live")})
      ? {...manual.price,source:"Seller-entered manual price",policy:"seller-manual-price-v1",updatedAt:manual.at,approvedAt:manual.at,reviewRequired:false}:undefined;
    // A hold belongs to the capture, not its changing proposal/evidence token.
    // Only an explicit resume may release it; old events require no migration.
    const hold = [...history].reverse().find(e => e.action === "hold" || e.action === "resume");
    return [card.id,{token,manualPrice,approvedAt:manualPrice?.approvedAt??(approval && canApprovePrice(card) ? approval.at : undefined),
      approvedBinding:approval && canApprovePrice(card)?reviewBinding(card):undefined,
      holdReason:hold?.action === "hold" ? hold.note : undefined, history:history.slice(-20)}];
  }));
  return {...snapshot,workflow};
}
export async function saveReview(command: ReviewCommand, load: () => Promise<BacklogSnapshot>, root = reviewRoot()) {
  return saveReviews([command],load,root);
}
export async function saveReviews(commands:ReviewCommand[],load:()=>Promise<BacklogSnapshot>,root=reviewRoot()){
  if(!commands.length||commands.length>500||new Set(commands.map(c=>c.requestId)).size!==commands.length)throw new WorkflowConflict("Select 1 to 500 distinct decisions.");
  commands=commands.map(command=>({...command,note:command.note.trim()}));
  for(const command of commands){
  if(command.action==="set-price" ? !validManualPrice(command.price) : command.price!==undefined)throw new WorkflowConflict("Enter an item price of at least $1.49 and nonnegative buyer shipping, each with at most two decimal places.");
  }
  const directory = path.join(root,"artifacts/card-backlog"); await fs.mkdir(directory,{recursive:true});
  const lock = path.join(directory,"reviews.lock"); let handle;
  try { handle = await fs.open(lock,"wx"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new WorkflowConflict("Another review is saving. Retry in a moment."); throw e; }
  try {
    const file = await readReviews(root),snapshot=await load();
    for(const command of commands){
    const prior = file.events.find(e => e.requestId === command.requestId);
    if (prior) {
      if (["cardId","token","action","note"].some(key => prior[key as keyof ReviewEvent] !== command[key as keyof typeof command]) || prior.price?.item!==command.price?.item || prior.price?.shipping!==command.price?.shipping) throw new WorkflowConflict("This request ID already belongs to another decision.");
      continue;
    }
    const card = snapshot.cards.find(c => c.id === command.cardId);
    const hold = file.events.filter(e=>e.cardId===command.cardId && (e.action==="hold"||e.action==="resume")).at(-1);
    if(command.action==="approve-price" && hold?.action==="hold")throw new WorkflowConflict("Resume the seller hold before approving a price.");
    if (!card || tokenFor(card) !== command.token) throw new WorkflowConflict("This card changed since you opened it. Refresh and review its current evidence.");
    if (command.action === "approve-price" && !canApprovePrice(card)) throw new WorkflowConflict("This proposal needs identity, photo, date, shipping or receipt review before asking-price approval.");
    if(command.action==="set-price"&&!canSetManualPrice(card))throw new WorkflowConflict("Confirm this card's identity and original photo pair before entering a price. Existing live, sold or scheduled listings use the listing review flow.");
    if (["hold","note"].includes(command.action) && command.note.trim().length < 3) throw new WorkflowConflict("Add a specific note so this card can be resumed.");
    if (file.events.length >= 50000) throw new WorkflowConflict("Review history needs archiving before more decisions can be saved.");
    file.events.push({...command,note:command.note.trim(),at:new Date().toISOString(),...(command.action==="set-price"?{priceBinding:manualTokenFor(card)}:{})});
    }
    const temp = path.join(directory,`reviews.${randomUUID()}.tmp`), out = await fs.open(temp,"wx");
    try { await out.writeFile(JSON.stringify(file,null,2)); await out.sync(); } finally { await out.close(); }
    await fs.rename(temp,path.join(directory,"reviews.json"));
    return withWorkflow(snapshot,root);
  } finally { await handle.close(); await fs.unlink(lock); }
}
