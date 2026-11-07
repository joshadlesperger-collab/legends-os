import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { backlogCounts, reconcileBacklog, reconcileScans, type BacklogEvidence } from "../lib/card-backlog.ts";
import { loadCardBacklog } from "../lib/card-backlog-store.ts";
import { claimJob, completeJob, fingerprint, newQueue, upsertCard } from "../lib/card-orchestrator.ts";
import { importLegacyCard } from "../lib/card-orchestrator-import.ts";
import { canApprovePrice, nextWork, stageHolds, workAttention, workHandoff, workflowStage } from "../lib/card-workflow.ts";
import { BacklogReadError, backlogErrorResponse } from "../lib/card-backlog-errors.ts";
import { readStableBacklog } from "../lib/card-backlog-service.ts";
import { readReviews } from "../lib/card-workflow-store.ts";

test("dashboard errors distinguish missing, changing, corrupt and unexpected sources without exposing details",async()=>{
  for(const code of ["LOCAL_EVIDENCE_UNAVAILABLE","SOURCE_CHANGED","EVIDENCE_INVALID","BACKLOG_READ_FAILED"] as const) {
    const response=backlogErrorResponse(new BacklogReadError(code));assert.equal(response.code,code);assert.equal(response.retryable,code==="SOURCE_CHANGED");
  }
  assert.equal(backlogErrorResponse(new SyntaxError("private source contents")).code,"EVIDENCE_INVALID");
  const error=backlogErrorResponse(new Error("secret filesystem path"));assert.equal(error.code,"BACKLOG_READ_FAILED");assert.ok(!JSON.stringify(error).includes("secret"));assert.ok(!error.error.includes("writer"));
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"backlog-errors-"));
  try {
    await fs.mkdir(path.join(root,"artifacts/identity-queue"),{recursive:true});await fs.writeFile(path.join(root,"artifacts/identity-queue/cards.json"),"{broken");
    await assert.rejects(loadCardBacklog({root,scans:[]}),e=>e instanceof BacklogReadError&&e.code==="EVIDENCE_INVALID");
    await fs.mkdir(path.join(root,"artifacts/card-backlog"),{recursive:true});await fs.writeFile(path.join(root,"artifacts/card-backlog/reviews.json"),JSON.stringify({version:1,events:[null]}));
    await assert.rejects(readReviews(root),e=>e instanceof BacklogReadError&&e.code==="EVIDENCE_INVALID");
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test("dashboard retries a changed generation once, but never retries corrupt or unknown failures",async()=>{
  let calls=0;const expected={cards:[]} as unknown as Awaited<ReturnType<typeof loadCardBacklog>>;
  const snapshot=await readStableBacklog(async()=>{if(++calls===1)throw new BacklogReadError("SOURCE_CHANGED");return expected;});assert.equal(snapshot,expected);assert.equal(calls,2);
  for(const code of ["SOURCE_CHANGED","EVIDENCE_INVALID","BACKLOG_READ_FAILED"] as const) {
    calls=0;await assert.rejects(readStableBacklog(async()=>{calls++;throw new BacklogReadError(code);}));assert.equal(calls,code==="SOURCE_CHANGED"?2:1);
  }
});

const now = "2026-10-21T12:00:00Z", h = (n: number) => n.toString(16).padStart(64, "0");
const identity = { player: "Player", season: "2025", set: "Set", manufacturer: "Maker", cardNumber: "12", parallel: "Base", language: "English", condition: "Excellent", conditionType: "Ungraded" };
const base = (overrides: Partial<BacklogEvidence> = {}): BacklogEvidence => ({ source: "identity", kind: "identity", id: "one", sku: "sku", frontHash: h(1), backHash: h(2), identity, identityStatus: "identified", identityKey: "identity-key", title: "Exact title..", ...overrides });
const proposal = { item: 3.98, shipping: 0, source: "pricing", updatedAt: "2026-10-18T12:00:00Z", policy: "item-only", reviewRequired: true };
test("deduplicates reimports by front hash, preserving intentional title periods and conditions", () => {
  const c = reconcileBacklog([base(), base({ id: "alias", source: "copy", frontHash: h(1).toUpperCase() })], now);
  assert.equal(c.length, 1); assert.equal(c[0].physicalUnits, 1); assert.equal(c[0].title, "Exact title.."); assert.equal(c[0].identity.condition, "Excellent"); assert.equal(c[0].aliases.length, 2);
});
test("distinct originals are inventory; shared backs do not collapse them", () => {
  const c = reconcileBacklog([base(), base({ id: "two", sku: "sku2", frontHash: h(3) })], now);
  assert.equal(backlogCounts(c).physicalCaptures, 2); assert.equal(c[0].groupKey, c[1].groupKey);
});
test("different serials and parallels never form a quantity group", () => {
  const c = reconcileBacklog([base({ identity: { ...identity, serial: "01/99", printRun: "99" } }), base({ id: "two", sku: "sku2", frontHash: h(3), identity: { ...identity, parallel: "Blue", serial: "02/99", printRun: "99" } })], now);
  assert.ok(c.every(c => c.groupKey === null)); assert.equal(c.length, 2);
});
test("same serial on distinct originals retains both and surfaces a reading conflict", () => {
  const c = reconcileBacklog([base({ identity: { ...identity, serial: "01/99" } }), base({ id: "two", sku: "sku2", frontHash: h(3), identity: { ...identity, serial: "1/99" } })], now);
  assert.equal(c.length, 2); assert.ok(c.every(c => c.state === "unresolved"));
});
test("conflicting pair cannot promote a price or approval", () => {
  const c = reconcileBacklog([base(), base({ kind: "pricing", backHash: h(4), proposal })], now)[0];
  assert.equal(c.state, "unresolved"); assert.equal(c.proposal, null); assert.equal(c.prices.length, 1);
});
test("matching ID with different front bytes does not merge physical copies", () => {
  const c = reconcileBacklog([base(), base({ frontHash: h(3) })], now);
  assert.equal(c.length, 2); assert.ok(c.every(c => c.issues.some(i => i.includes("Stable ID"))));
});
test("hash-less receipt excludes Add while withholding identity and price authority", () => {
  const c = reconcileBacklog([base(), { kind: "manifest", source: "receipt", id: "one", proposal, receipts: [{ id: "123", disposition: "draft", source: "receipt" }] }], now)[0];
  assert.equal(c.excludedFromNewListing, true); assert.equal(c.proposal, null); assert.equal(c.state, "unresolved");
});
test("partial active snapshot cannot erase saved draft/live/sold receipts", () => {
  const input = [base({ receipts: [{ id: "123", disposition: "draft", source: "old" }, { id: "456", disposition: "live", source: "old" }] })];
  assert.equal(reconcileBacklog(input, now)[0].state, "live");
  const sold = reconcileBacklog([...input, { kind: "marketplace", source: "sold", receipts: [{ id: "456", disposition: "sold", source: "sold" }] }], now)[0];
  assert.equal(sold.state, "sold"); assert.equal(sold.receipts.length, 3);
});
test("receipt-ID join consolidates duplicate marketplace rows and never matches titles", () => {
  const c = reconcileBacklog([base({ receipts: [{ id: "456", disposition: "live", source: "manifest" }] }), { kind: "marketplace", source: "active", title: "Exact title..", receipts: [{ id: "456", disposition: "live", source: "active" }] }, { kind: "marketplace", source: "active", title: "Exact title..", receipts: [{ id: "789", disposition: "live", source: "active" }] }], now);
  assert.equal(c.length, 2); assert.equal(backlogCounts(c).physicalCaptures, 1); assert.equal(backlogCounts(c).distinctLiveReceipts, 2);
});
test("a reused receipt is unresolved unless an explicit compatible quantity group exists", () => {
  const receipt = { id: "123", disposition: "draft" as const, source: "manifest" };
  const input = [base({ receipts: [receipt] }), base({ id: "two", sku: "sku2", frontHash: h(3), receipts: [receipt] })];
  assert.ok(reconcileBacklog(input, now).every(c => c.state === "unresolved"));
  assert.ok(reconcileBacklog(input.map(e => ({ ...e, receipts: [{ ...receipt, groupId: "group" }] })), now).every(c => c.state === "draft"));
  for (const field of ["season", "manufacturer", "language", "condition"]) {
    const mixed = input.map((e, index) => ({ ...e, identity: index ? { ...identity, [field]: "Different" } : identity, receipts: [{ ...receipt, groupId: "group" }] }));
    assert.ok(reconcileBacklog(mixed, now).every(c => c.state === "unresolved"));
  }
});
test("approval binds exact price, shipping, policy, timestamp, identity and original pair", () => {
  const pricing = base({ kind: "pricing", source: "pricing", proposal, approval: { proposal: { ...proposal, approvedAt: now }, identityKey: "identity-key", photoHashes: [h(2), h(1)] } });
  assert.equal(reconcileBacklog([base(), pricing], now)[0].state, "locally-approved");
  for (const change of [{ item: 4.44 }, { shipping: 1.49 }, { policy: "changed" }, { updatedAt: now }]) assert.equal(reconcileBacklog([base(), { ...pricing, proposal: { ...proposal, ...change } }], now)[0].approvedPrice, null);
  assert.equal(reconcileBacklog([base({ identityKey: "changed" }), pricing], now)[0].approvedPrice, null);
  assert.equal(reconcileBacklog([base(), { ...pricing, approval: { ...pricing.approval!, photoHashes: [h(1), h(8)] } }], now)[0].approvedPrice, null);
});
test("stale approvals stay unapproved and explicit price override is never replaced by formula", () => {
  const c = reconcileBacklog([base(), base({ kind: "pricing", proposal: { ...proposal, stale: true }, override: { ...proposal, item: 3.95, reviewRequired: false }, overrides: { user_price_override: 3.95 } })], now)[0];
  assert.equal(c.override?.item, 3.95); assert.equal(c.approvedPrice?.item, 3.95); assert.equal(c.proposal?.item, 3.98);
});
test("missing, future, and stale approval dates cannot approve a saved price", () => {
  for (const approvedAt of ["invalid", "", "2026-11-01T00:00:00Z", "2026-10-01T00:00:00Z"]) {
    const c = reconcileBacklog([base(), base({kind:"pricing", proposal, approval:{proposal:{...proposal,approvedAt}, identityKey:"identity-key",photoHashes:[h(1),h(2)]}})],now)[0];
    assert.equal(c.approvedPrice,null);
  }
  const old = {...proposal,updatedAt:"2026-01-01T00:00:00Z"};
  assert.equal(reconcileBacklog([base(),base({kind:"pricing",proposal:old,approval:{proposal:{...old,approvedAt:now},identityKey:"identity-key",photoHashes:[h(1),h(2)]}})],now)[0].approvedPrice,null);
});
test("conflicting saved identity withholds pricing but retains source evidence", () => {
  const c = reconcileBacklog([base(), base({ kind: "pricing", identity: { ...identity, parallel: "Blue" }, proposal })], now)[0];
  assert.equal(c.proposal, null); assert.equal(c.prices.length, 1); assert.equal(c.state, "unresolved");
});
test("counts are exclusive by state; milestones overlap without counting extra units", () => {
  const c = reconcileBacklog([base({ proposal, holds: ["needs inspection"], receipts: [{ id: "123", disposition: "draft", source: "saved", quantity: 5 }] }), base({ id: "two", sku: "two", frontHash: h(3), identityStatus: "not-identified", identity: {} })], now);
  const counts = backlogCounts(c); assert.equal(Object.values(counts.states).reduce((a,b) => a+b,0), 2); assert.equal(counts.physicalCaptures, 2); assert.equal(counts.held, 1); assert.equal(counts.withProposal, 1);
});
test("folder re-read matches hashes, never filename order, without increasing inventory", () => {
  const c = reconcileBacklog([base()], now), files = [{ path: "copy.jpg", hash: h(1) }, { path: "renamed.jpg", hash: h(1) }, { path: "back.jpg", hash: h(2) }, { path: "unknown.jpg", hash: h(9) }];
  const first = reconcileScans(c, files); assert.deepEqual(reconcileScans(c, files), first); assert.equal(first.duplicateFiles, 1); assert.equal(first.capturedCardsPresent, 1); assert.equal(first.unmatched.length, 1); assert.equal(c.length, 1);
});
test("ingestion recovers archived hashes, keeps dated manifests and reports corrupt sources", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "card-backlog-test-"));
  try {
    const write = async (p: string, data: unknown) => { await fs.mkdir(path.dirname(path.join(root,p)), { recursive: true }); await fs.writeFile(path.join(root,p), JSON.stringify(data)); };
    const inbox = path.join(root, "inbox"), original = path.join(inbox,"original.heic"), archive = path.join(inbox,"Listed","456","original.heic");
    await write("artifacts/identity-queue/cards.json", { cards: [{ card_id: "one", source_key: "sku", front_original_path: original, back_sha256: h(2), recorded_live_item_id: "456", status: "identity-ready", player: "Player" }] });
    await write("artifacts/pricing-queue/queue-state.json", { cards: [] });
    await write("artifacts/batch-202610191516/manifest.json", { cards: [{ cardId: "one", key: "sku", frontHash: h(1), backHash: h(2), liveItemId: "456", title: "Keep this title." }] });
    await write("artifacts/card-orchestrator/state.json", { malformed: true });
    const s = await loadCardBacklog({ root, inbox, now, scans: [{ path: archive, hash: h(1) }] });
    assert.equal(s.counts.physicalCaptures, 1); assert.equal(s.cards[0].title, "Keep this title."); assert.equal(s.counts.distinctLiveReceipts, 1); assert.equal(s.marketplace.complete, false); assert.ok(s.warnings.some(w => w.includes("schema")));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test("live inbox hashing ignores symlinks and preserves originals across repeat reads", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "card-backlog-scan-"));
  try {
    const inbox = path.join(root, "inbox"); await fs.mkdir(inbox); const bytes = Buffer.from("original photo bytes");
    await fs.writeFile(path.join(inbox,"card_front.jpg"),bytes); await fs.writeFile(path.join(inbox,"card_back.jpg"),Buffer.from("back"));
    const s = await loadCardBacklog({ root, inbox, now }); assert.equal(s.counts.physicalCaptures,1); assert.equal(s.cards[0].state,"unprocessed");
    assert.equal(s.cards[0].frontHash,createHash("sha256").update(bytes).digest("hex"));
    assert.deepEqual((await loadCardBacklog({ root,inbox,now })).counts,s.counts); assert.deepEqual(await fs.readFile(path.join(inbox,"card_front.jpg")),bytes);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test("legacy source approvals stay in history and never transfer to the new pricing policy", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "card-backlog-approval-"));
  try {
    const write = async (p: string, data: unknown) => { await fs.mkdir(path.dirname(path.join(root,p)), { recursive: true }); await fs.writeFile(path.join(root,p), JSON.stringify(data)); };
    const legacy = { card_id:"one", source_key:"sku", quantity:1, player:"Player", season:"2025", set:"Set", manufacturer:"Maker", card_number:"12", sport_game:"Basketball", team:"Original team", parallel:"Base", condition_plan:"Excellent", front_sha256:h(1), back_sha256:h(2), front_original_path:"front.jpg", back_original_path:"back.jpg", status:"identity-ready" };
    const pricing = { ...legacy, proposed_item_price:proposal.item, buyer_shipping:proposal.shipping, updated_at:proposal.updatedAt, pricing_policy_version:proposal.policy };
    const input = importLegacyCard(legacy,pricing,[]), queue = newQueue(); upsertCard(queue,input,now);
    const job = queue.cards.one.jobs.identity; job.state="done"; job.result={identity:{...input.identity,autograph:false}};
    await write("artifacts/identity-queue/cards.json",{cards:[legacy]});
    await write("artifacts/pricing-queue/queue-state.json",{cards:[pricing]});
    await write("artifacts/card-orchestrator/asking-price-approvals.json",{approvals:[{cardId:"one",item:proposal.item,shipping:proposal.shipping,sourceUpdatedAt:proposal.updatedAt,policyVersion:proposal.policy,photoHashes:[h(1),h(2)],sourceIdentityKey:fingerprint(input.identity),approvedAt:now}]});
    await write("artifacts/card-orchestrator/state.json",queue);
    const retained=(await loadCardBacklog({root,now,scans:[]})).cards[0];
    assert.equal(retained.approvedPrice,null);assert.ok(retained.prices.some(p=>p.item===proposal.item));
    job.result={identity:{...input.identity,autograph:false,team:"Corrected team"}};
    await write("artifacts/card-orchestrator/state.json",queue);
    assert.equal((await loadCardBacklog({root,now,scans:[]})).cards[0].approvedPrice,null);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test("same-text generic holds cannot be reclassified by identity or pricing evidence",()=>{
  const reason="Review required",gap=base({identityStatus:"needs-review",holds:[reason],identityRequirements:[reason],identityInputKey:"source"});
  const c=reconcileBacklog([gap,base({kind:"manifest",source:"other",holds:[reason]})],now)[0];
  assert.deepEqual(c.identityRequirements,[]);assert.equal(workAttention(c),"blocked");
  const priced=reconcileBacklog([base({identityStatus:"needs-review",holds:[reason]}),base({kind:"pricing",source:"pricing",holds:[reason]})],now)[0];
  assert.deepEqual(priced.pricingHolds,[]);assert.equal(workAttention(priced),"blocked");
});

async function identityFixture(fn:(f:{root:string;inbox:string;legacy:Record<string,unknown>;write:(p:string,data:unknown)=>Promise<void>;load:()=>ReturnType<typeof loadCardBacklog>})=>Promise<void>) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"identity-work-")),inbox=path.join(root,"inbox");
  try {
    await fs.mkdir(inbox);const front=Buffer.from("original front"),back=Buffer.from("original back");
    await fs.writeFile(path.join(inbox,"front.jpg"),front);await fs.writeFile(path.join(inbox,"back.jpg"),back);
    const write=async(p:string,data:unknown)=>{await fs.mkdir(path.dirname(path.join(root,p)),{recursive:true});await fs.writeFile(path.join(root,p),JSON.stringify(data));};
    const gap="Exact parallel and release year unresolved";
    const legacy:Record<string,unknown>={card_id:"one",source_key:"sku",quantity:1,player:"Player",season:"",set:"Set",manufacturer:"Maker",card_number:"12",
      sport_game:"Basketball",team:"Team",parallel:"",condition_plan:"Excellent",status:"held-identity",hold_reason:gap,unresolved_fields:gap,
      front_original_path:path.join(inbox,"front.jpg"),back_original_path:path.join(inbox,"back.jpg"),
      front_sha256:createHash("sha256").update(front).digest("hex"),back_sha256:createHash("sha256").update(back).digest("hex")};
    await write("artifacts/identity-queue/cards.json",{cards:[legacy]});
    await write("artifacts/pricing-queue/queue-state.json",{cards:[{...legacy,status:"held-own-acquisition-excluded-needs-independent-comps",no_evidence_reason:"Independent sold evidence required"}]});
    const queue=newQueue();queue.rejectedImports={one:{inputKey:"legacy-cache",reason:"Identity source is missing required fields; retain in identity inbox"}};
    await write("artifacts/card-orchestrator/state.json",queue);
    await fn({root,inbox,legacy,write,load:()=>loadCardBacklog({root,inbox,now})});
  } finally {await fs.rm(root,{recursive:true,force:true});}
}

test("legacy identity gaps and obsolete identity rejection become work without editing source queues",()=>identityFixture(async({root,legacy,load})=>{
  const files=["artifacts/identity-queue/cards.json","artifacts/pricing-queue/queue-state.json","artifacts/card-orchestrator/state.json",String(legacy.front_original_path),String(legacy.back_original_path)];
  const before=await Promise.all(files.map(file=>fs.readFile(path.isAbsolute(file)?file:path.join(root,file))));
  const snapshot=await load(),c=snapshot.cards[0];
  assert.equal(workAttention(c),"work");assert.equal(nextWork({...snapshot,workflow:{}})?.id,c.id);
  assert.equal(workflowStage(c),"identify");assert.equal(canApprovePrice(c),false);assert.equal(c.identityRequirements?.length,2);
  assert.equal(c.holds.length,3);for(const reason of c.holds)assert.ok(workHandoff(c).includes(reason));
  assert.deepEqual(stageHolds(c),[]);assert.equal(c.receipts.length,0);assert.equal(c.approvedPrice,null);
  await load();const after=await Promise.all(files.map(file=>fs.readFile(path.isAbsolute(file)?file:path.join(root,file))));
  assert.deepEqual(after,before);
}));

test("missing originals, conflicting pairs and unrelated legacy holds stay blocked",()=>identityFixture(async({inbox,legacy,write,load})=>{
  const back=await fs.readFile(path.join(inbox,"back.jpg"));await fs.unlink(path.join(inbox,"back.jpg"));
  let card=(await load()).cards[0];assert.equal(workAttention(card),"blocked");assert.match(card.issues.join(),/Original.*missing/);
  await fs.writeFile(path.join(inbox,"back.jpg"),back);
  await write("artifacts/pricing-queue/queue-state.json",{cards:[{...legacy,back_sha256:h(9)}]});
  card=(await load()).cards[0];assert.equal(workAttention(card),"blocked");assert.match(card.issues.join(),/conflicting back/);
  await write("artifacts/pricing-queue/queue-state.json",{cards:[]});
  for(const change of [{condition_plan:"Unrecognized condition"},{back_original_path:""},{back_sha256:""},
    {status:"held-condition"},{status:"existing-record"},{hold_reason:"Seller requested a hold"}]) {
    await write("artifacts/identity-queue/cards.json",{cards:[{...legacy,...change}]});
    card=(await load()).cards[0];assert.equal(workAttention(card),"blocked",JSON.stringify(change));
  }
  await write("artifacts/identity-queue/cards.json",{cards:[legacy]});
  const queue=newQueue();queue.rejectedImports={one:{inputKey:"cache",reason:"Saved receipt photo pair needs reconciliation"}};
  await write("artifacts/card-orchestrator/state.json",queue);
  card=(await load()).cards[0];assert.equal(workAttention(card),"blocked");assert.match(stageHolds(card).join(),/Saved receipt/);
}));

test("only completed review of the matching source resolves identity requirements",()=>identityFixture(async({legacy,write,load})=>{
  const input=importLegacyCard(legacy,{},[]),queue=newQueue();upsertCard(queue,input,now);
  let job=claimJob(queue,"fixture","photos","one",now)!;
  completeJob(queue,"one","photos",job.job.lease!.token,{outcome:"done",data:{hashes:input.photos.map(({side,sha256})=>({side,sha256})),evidence:"Fixture originals verified"}},now);
  job=claimJob(queue,"fixture","identity","one",now)!;
  completeJob(queue,"one","identity",job.job.lease!.token,{outcome:"held",reason:"Pair cannot be confirmed from the current originals"},now);
  await write("artifacts/card-orchestrator/state.json",queue);
  assert.equal(workAttention((await load()).cards[0]),"blocked");
  // A fresh fixture queue exercises the ordinary claim/complete path, not fabricated completion metadata.
  const reviewed=newQueue();upsertCard(reviewed,input,now);
  job=claimJob(reviewed,"fixture","photos","one",now)!;
  completeJob(reviewed,"one","photos",job.job.lease!.token,{outcome:"done",data:{hashes:input.photos.map(({side,sha256})=>({side,sha256})),evidence:"Fixture originals verified"}},now);
  job=claimJob(reviewed,"fixture","identity","one",now)!;
  completeJob(reviewed,"one","identity",job.job.lease!.token,{outcome:"done",data:{identity:{...input.identity,season:"2025",parallel:"Base",autograph:false},pairMatches:true,frontFirst:true,serialInspected:true,evidence:"Fixture identity inspected"}},now);
  await write("artifacts/card-orchestrator/state.json",reviewed);
  let card=(await load()).cards[0];assert.equal(card.identityRequirements?.[0].resolved,true);assert.equal(workflowStage(card),"price");
  assert.ok(card.holds.includes(String(legacy.hold_reason)));assert.ok(!workHandoff(card).includes(String(legacy.hold_reason)));
  assert.equal(workAttention(card),"blocked");assert.match(stageHolds(card).join(),/Independent sold evidence/);
  const gap="Serial numerator requires another inspection";
  await write("artifacts/identity-queue/cards.json",{cards:[{...legacy,hold_reason:gap,unresolved_fields:gap}]});
  card=(await load()).cards[0];assert.equal(card.identityRequirements?.[0].resolved,false);
  assert.equal(workflowStage(card),"identify");assert.equal(workAttention(card),"work");assert.equal(canApprovePrice(card),false);
}));

test("typed legacy pricing holds do not stop identification, but generic and seller holds do",()=>{
  const reason="held-own-acquisition-excluded-needs-independent-comps";
  const evidence=base({identityStatus:"needs-review",holds:[]});
  const manifest=base({kind:"manifest",source:"legacy",holds:[reason],pricingHolds:[reason]});
  const c=reconcileBacklog([evidence,manifest],now)[0];
  assert.ok(c.holds.includes(reason));assert.equal(workAttention(c),"work");
  c.identityStatus="identified";c.proposal=null;assert.equal(workAttention(c),"blocked");
  const protectedCard=reconcileBacklog([evidence,manifest,base({kind:"manifest",source:"generic",holds:[reason]})],now)[0];
  assert.equal(workAttention(protectedCard),"blocked");
  assert.equal(workAttention({...c,identityStatus:"needs-review"},{token:"x",history:[],holdReason:"Seller review required"}),"blocked");
});

test("manifest intake retains explicit pricing-stage provenance without reclassifying generic reviews",async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"manifest-stage-"));
  try {
    const folder=path.join(root,"artifacts/batch-6");await fs.mkdir(folder,{recursive:true});
    for(const status of ["held-pricing-evidence","held-own-acquisition-excluded-needs-independent-comps","held-review"]) {
      await fs.writeFile(path.join(folder,"manifest.json"),JSON.stringify({cards:[{cardId:"one",frontHash:h(1),backHash:h(2),status,notes:"Retained reason",remainingReview:["Pairing needs review"]}]}));
      const s=await loadCardBacklog({root,scans:[]}),c=s.cards[0];
      assert.equal(c.pricingHolds?.includes("Retained reason"),status!=="held-review");
      assert.ok(!c.pricingHolds?.includes("Pairing needs review"));assert.ok(c.holds.includes("Retained reason"));
    }
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
