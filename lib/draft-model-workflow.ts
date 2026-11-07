import { randomUUID } from "node:crypto";
import { z } from "zod";
import { fingerprint, reviewedIdentity, identityReviewIsCurrent, jobBlockers, validateComps, type QueueState } from "./card-orchestrator.ts";
import { draftBinding, requireDraftWriter, type DraftPrice } from "./card-draft-lifecycle.ts";
import { candidatePrice, cardOfferSettings } from "./card-price-policy.ts";

export const DRAFT_MODEL_POLICY = "openai-grok-muse-baxter-draft-20261030";
export const DRAFT_MODEL_ROUTES = { identification: "openai", proposal: "xai", muse: "meta", baxter: "external-dot" } as const;
const text = z.string().trim().min(1).max(4000);
const cents = z.number().finite().nonnegative().max(1_000_000).refine(n => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6);
export const modelPriceSchema = z.object({ item: cents.min(1.49), shipping: cents, buyerTotal: cents }).strict()
  .refine(p => Math.round((p.item + p.shipping) * 100) === Math.round(p.buyerTotal * 100), "Buyer-total arithmetic mismatch");
export type ModelPrice = z.infer<typeof modelPriceSchema>;
const sourceCheck = z.object({ status: z.enum(["match", "no-match", "stale", "unavailable"]), evidence: text }).strict();
const admissionSchema = z.object({
  evidence: text, basis: z.enum(["exact", "related-print-run", "active-lowest", "seller-asking"]), comps: z.array(z.unknown()).min(1).max(50),
  exactSearchEvidence: text.optional(), sourceChecks: z.object({ active: sourceCheck, sold: sourceCheck, knowledge: sourceCheck }).strict(),
  shipping: cents, shippingEvidence: text, shippingVerifiedAt: z.iso.datetime(),
  currentPrice: modelPriceSchema.nullable(), priceObservedAt: z.iso.datetime(), priceEvidence: text,
}).strict();
export type DraftModelAdmission = z.infer<typeof admissionSchema>;
export const modelFindingSchema = z.object({ decision: z.enum(["accept", "increase", "hold"]), price: modelPriceSchema.nullable(), rationale: text }).strict();
export type ModelFinding = z.infer<typeof modelFindingSchema>;
type Role = "proposal" | "muse" | "baxter";
type Result = { key: string; role: Role; provider: string; model: string; source: string; at: string; finding: ModelFinding };
export type DraftModelWorkflow = {
  key: string; cardId: string; draftId: string; binding: string; identityKey: string; sellerConstraintKey: string;
  policy: typeof DRAFT_MODEL_POLICY; input: DraftModelAdmission; admittedAt: string;
  claims: Partial<Record<Role, { token: string; owner: string; expiresAt: string }>>;
  results: Partial<Record<Role, Result>>;
  authorization?: { key: string; price: ModelPrice; previous: ModelPrice | null; at: string; rationale: string };
  write?: { operationId: string; startedAt: string; authorizationKey: string };
  saved?: { at: string; captureHash: string; authorizationKey: string; evidence: string };
};
const fresh = (at: string, now: string, maxMs = 3_600_000) => Number.isFinite(Date.parse(at)) && Date.parse(now) >= Date.parse(at) && Date.parse(now) - Date.parse(at) <= maxMs;
const constraintKey = (s: QueueState, id: string, sellerPrice?: DraftPrice | null) => fingerprint({ override: s.cards[id].input.override, sellerPrice: sellerPrice ?? null });
function cardReady(s: QueueState, id: string, sellerHold?: string | null) {
  const c = s.cards[id], d = c?.draftLifecycle;
  if (!c || sellerHold || c.input.sourceHold || c.jobs.photos.state !== "done" || !identityReviewIsCurrent(c) || !reviewedIdentity(c)) throw Error("Identity, original photos or seller hold blocks draft pricing");
  if (c.input.knownLive || (c.exclusion && c.exclusion.disposition !== "draft") || (c.input.savedReceipts ?? []).some(r => r.disposition === "live")) throw Error("Only drafts are eligible; active/sold records excluded");
  if (!d?.draftId || d.state !== "saved" || d.binding !== draftBinding(c) || d.failure) throw Error("Verified current saved draft required");
  const photoVerified = d.verification?.photoIdentityVerified && d.verification.binding === d.binding && d.verification.identityKey === fingerprint(reviewedIdentity(c));
  if (!photoVerified && !(d.unpricedVerification?.binding === d.binding && d.unpricedVerification.draftId === d.draftId)) throw Error("Saved draft photo/identity verification required");
  const blockers = jobBlockers(s, c, "pricing", sellerHold ?? undefined);
  if (blockers.length) throw Error(`Draft prerequisites blocked: ${blockers.join("; ")}`);
  // Shared draft prices need an atomic all-capture review; never update only one member.
  if (Object.values(s.cards).some(other => other !== c && (other.draftLifecycle?.draftId === d.draftId || other.input.knownDraft === d.draftId || other.input.savedReceipts?.some(r => r.itemId === d.draftId)))) throw Error("Shared draft requires group-wide pricing review; held for reconciliation");
  return c;
}
function evidencePrice(s: QueueState, w: DraftModelWorkflow, now: string): ModelPrice {
  const i = reviewedIdentity(s.cards[w.cardId])!;
  const validated = validateComps(i, w.input.comps, now, w.input.basis);
  if (!Number.isFinite(validated.buyerTotalMean) || validated.buyerTotalMean <= 0) throw Error("Known comparable shipping and positive buyer total required");
  if (!fresh(w.input.shippingVerifiedAt, now)) throw Error("Shipping policy verification is stale");
  const total = validated.buyerTotalMean, shipping = w.input.shipping;
  const p = w.input.basis === "active-lowest" || w.input.basis === "seller-asking"
    ? { item: Math.max(1.49, Math.round((total - shipping) * 100) / 100), shipping }
    : candidatePrice(total, shipping);
  if (total < shipping + 1.49) throw Error("Evidence below shipping plus item floor; economics review required");
  return modelPriceSchema.parse({ item: p.item, shipping, buyerTotal: Math.round((p.item + shipping) * 100) / 100 });
}
function event(s: QueueState, w: DraftModelWorkflow, action: string, now: string) {
  s.events.push({ at: now, cardId: w.cardId, kind: "draft-model-pricing", event: action, detail: w.key });
}
export function admitDraftModelWorkflow(s: QueueState, id: string, raw: unknown, sellerHold?: string | null, sellerPrice?: DraftPrice | null, now = new Date().toISOString()) {
  const c = cardReady(s, id, sellerHold), input = admissionSchema.parse(raw), d = c.draftLifecycle!;
  if (d.operation) throw Error("Reconcile pending draft write before pricing");
  if (!fresh(input.priceObservedAt, now)) throw Error("Fresh saved-price observation required");
  if (input.basis !== "exact" && !input.exactSearchEvidence) throw Error("Fallback requires retained exact-search/source gap evidence");
  if (sellerPrice && (!input.currentPrice || input.currentPrice.item !== sellerPrice.item || input.currentPrice.shipping !== sellerPrice.shipping)) throw Error("Preserve and reconcile seller-set price before admission");
  const key = fingerprint({ binding: draftBinding(c), draftId: d.draftId, input, sellerConstraintKey: constraintKey(s, id, sellerPrice), policy: DRAFT_MODEL_POLICY });
  s.draftModelWorkflows ??= {};
  const previous = s.draftModelWorkflows[id];
  if (previous?.key === key) return previous;
  if (previous && (previous.write && !previous.saved || Object.values(previous.claims).some(claim => claim && Date.parse(claim.expiresAt) > Date.parse(now)))) throw Error("Existing workflow claim or uncertain write must be reconciled");
  const w: DraftModelWorkflow = { key, cardId: id, draftId: d.draftId!, binding: draftBinding(c), identityKey: fingerprint(reviewedIdentity(c)), sellerConstraintKey: constraintKey(s, id, sellerPrice), policy: DRAFT_MODEL_POLICY, input, admittedAt: now, claims: {}, results: {} };
  evidencePrice(s, w, now);
  // Changing prose/timestamps must not repeatedly reprice a completed unchanged draft.
  if (previous?.saved && previous.binding === w.binding && previous.draftId === w.draftId && fingerprint(previous.input.comps) === fingerprint(input.comps) && previous.input.basis === input.basis && previous.input.shipping === input.shipping && previous.sellerConstraintKey === w.sellerConstraintKey) return previous;
  if (previous) (s.draftModelWorkflowHistory ??= []).push(structuredClone(previous));
  s.draftModelWorkflows[id] = w; event(s, w, "admitted", now); return w;
}
export function currentDraftModelWorkflow(s: QueueState, id: string, sellerHold?: string | null, sellerPrice?: DraftPrice | null, now = new Date().toISOString()) {
  const c = cardReady(s, id, sellerHold), w = s.draftModelWorkflows?.[id];
  if (!w || w.binding !== draftBinding(c) || w.draftId !== c.draftLifecycle?.draftId || w.identityKey !== fingerprint(reviewedIdentity(c)) || w.sellerConstraintKey !== constraintKey(s, id, sellerPrice)) throw Error("Workflow source or seller constraints changed; new bound admission required");
  evidencePrice(s, w, now); return w;
}
export function draftModelStatus(s: QueueState, id: string, sellerHold?: string | null, sellerPrice?: DraftPrice | null, now = new Date().toISOString()) {
  if (!s.draftModelWorkflows?.[id]) return { stage: "not-admitted", nextOwner: "orchestrator", canPublish: false as const };
  try {
    const w = currentDraftModelWorkflow(s, id, sellerHold, sellerPrice, now);
    const hold = Object.values(w.results).find(r => r.finding.decision === "hold");
    const stage = w.saved ? "draft_price_saved_verified" : w.write ? "save_outcome_pending" : w.authorization ? "price_authorized" : !w.results.proposal ? "grok_pricing_pending" : !w.results.muse ? "waiting_for_muse" : !w.results.baxter ? "waiting_for_baxter" : hold ? "held" : "reviews_complete";
    return { stage, nextOwner: stage === "waiting_for_baxter" ? "Baxter" : stage === "waiting_for_muse" ? "Muse" : w.authorization ? "listing-writer" : "orchestrator", key: w.key, draftId: w.draftId, reason: hold?.finding.rationale, canPublish: false as const };
  } catch (error) { return { stage: "held", nextOwner: "orchestrator", reason: (error as Error).message, canPublish: false as const }; }
}
export function claimDraftModelStage(s: QueueState, id: string, role: Role, owner: string, sellerHold?: string | null, sellerPrice?: DraftPrice | null, now = new Date().toISOString()) {
  if (!["proposal", "muse", "baxter"].includes(role) || !owner.trim()) throw Error("Known role and worker required");
  const w = currentDraftModelWorkflow(s, id, sellerHold, sellerPrice, now);
  if (w.results[role] || w.authorization || w.saved) throw Error("Stage already complete; no repeated dispatch");
  if (role !== "proposal" && !w.results.proposal) throw Error("Grok proposal required before reviews");
  if (w.claims[role]) throw Error("Prior claim requires explicit outcome reconciliation; no hidden retry");
  const claim = { token: randomUUID(), owner, expiresAt: new Date(Date.parse(now) + 300_000).toISOString() };
  w.claims[role] = claim; event(s, w, `${role}-claimed`, now);
  return { key: w.key, role, claim, packet: { cardId: id, draftId: w.draftId, identity: reviewedIdentity(s.cards[id]), identityKey: w.identityKey, evidence: w.input, proposal: role === "proposal" ? null : w.results.proposal, policy: DRAFT_MODEL_POLICY } };
}
export function completeDraftModelStage(s: QueueState, id: string, role: Role, token: string, raw: unknown, provenance: { provider: string; model: string; source: string; workflowKey: string; proposalKey?: string }, sellerHold?: string | null, sellerPrice?: DraftPrice | null, now = new Date().toISOString()) {
  const w = currentDraftModelWorkflow(s, id, sellerHold, sellerPrice, now), claim = w.claims[role];
  if (!claim || claim.token !== token || Date.parse(claim.expiresAt) < Date.parse(now) || w.results[role]) throw Error("Missing, expired or completed role claim");
  if (provenance.workflowKey !== w.key || (role !== "proposal" && provenance.proposalKey !== w.results.proposal?.key)) throw Error("Stale/mismatched proposal or evidence binding");
  if (provenance.provider !== DRAFT_MODEL_ROUTES[role] || !provenance.model.trim() || !provenance.source.trim()) throw Error("Distinct routed reviewer provenance required");
  if (role === "baxter" && (!s.baxterReviewConnection || provenance.source !== s.baxterReviewConnection.resultSource || provenance.model !== s.baxterReviewConnection.identity)) throw Error("Verified attributable Baxter return path unavailable; ordinary OpenAI output is not Baxter");
  const finding = modelFindingSchema.parse(raw);
  if (finding.decision !== "hold" && !finding.price) throw Error("Price required for non-hold result");
  if (role === "proposal" && finding.decision === "increase") throw Error("Grok proposes; reviewers recommend increases");
  if (role !== "proposal" && finding.price && w.results.proposal?.finding.price) {
    const base = w.results.proposal.finding.price;
    if (finding.decision === "accept" && fingerprint(finding.price) !== fingerprint(base)) throw Error("Accept must retain the Grok proposal");
    if (finding.decision === "increase" && (finding.price.item <= base.item || finding.price.buyerTotal <= base.buyerTotal)) throw Error("Increase must raise item price and buyer total");
  }
  const result = { key: fingerprint({ role, finding, provenance }), role, ...provenance, at: now, finding };
  w.results[role] = result; event(s, w, `${role}-completed`, now); return result;
}
export function authorizeDraftModelPrice(s: QueueState, id: string, sellerHold?: string | null, sellerPrice?: DraftPrice | null, now = new Date().toISOString()) {
  const w = currentDraftModelWorkflow(s, id, sellerHold, sellerPrice, now);
  if (w.authorization) return w.authorization;
  const { proposal, muse, baxter } = w.results;
  if (!proposal || !muse || !baxter) throw Error("Both independent reviews required; missing output is not approval");
  if ([proposal, muse, baxter].some(r => r.finding.decision === "hold" || !r.finding.price)) throw Error("Reviewer hold requires evidence resolution");
  const supported = evidencePrice(s, w, now);
  // A single supported upward recommendation can correct a lower Grok proposal.
  // Two competing increases are a material conflict, even if one equals the baseline.
  const increases = [muse, baxter].filter(r => r.finding.decision === "increase");
  if (increases.length === 2 && fingerprint(increases[0].finding.price) !== fingerprint(increases[1].finding.price)) throw Error("Conflicting increases require evidence resolution");
  const chosen = increases[0]?.finding.price ?? proposal.finding.price!;
  if (fingerprint(chosen) !== fingerprint(supported)) throw Error("Recommendation does not match validated comparable evidence and policy");
  const previous = w.input.currentPrice;
  if (previous && (chosen.item < previous.item || chosen.buyerTotal < previous.buyerTotal)) throw Error("Automatic downward revision is outside this authority");
  if (previous && chosen.shipping !== previous.shipping) throw Error("Shipping change requires separate policy reconciliation");
  if (sellerPrice && chosen.item !== sellerPrice.item && !increases.length) throw Error("Seller-set price requires an evidence-backed reviewer increase");
  w.authorization = { key: fingerprint({ workflow: w.key, reviews: [proposal.key, muse.key, baxter.key], chosen }), price: chosen, previous, at: now, rationale: "Both bound reviews collected; validated source evidence, current shipping, floor and rounding support this amount. Draft-only standing authority; no seller approval fabricated." };
  event(s, w, "price-authorized", now); return w.authorization;
}
export function draftModelAuthorizedPrice(s: QueueState, id: string, sellerHold?: string | null, sellerPrice?: DraftPrice | null, now = new Date().toISOString()) {
  if (!s.draftModelWorkflows?.[id]) return null;
  try { const w = currentDraftModelWorkflow(s, id, sellerHold, sellerPrice, now); return w.authorization ? { ...w.authorization.price, ...cardOfferSettings(w.authorization.price.item) } : null; } catch { return null; }
}
export function beginDraftModelSave(s: QueueState, id: string, owner: string, token: string, sellerHold?: string | null, sellerPrice?: DraftPrice | null, now = new Date().toISOString()) {
  const w = currentDraftModelWorkflow(s, id, sellerHold, sellerPrice, now);
  requireDraftWriter(s, owner, token, id, now);
  if (!w.authorization || w.saved) throw Error("Authorized unfinished draft price required");
  if (w.write) return { ...w.write, action: "reconcile-same-draft", draftId: w.draftId };
  const d = s.cards[id].draftLifecycle!;
  if (d.operation) throw Error("Existing draft operation must be reconciled first");
  w.write = { operationId: randomUUID(), startedAt: now, authorizationKey: w.authorization.key };
  d.operation = { id: w.write.operationId, startedAt: now, binding: w.binding, draftId: w.draftId, priceKey: fingerprint({ item: w.authorization.price.item, shipping: w.authorization.price.shipping }) };
  event(s, w, "save-started", now); return { ...w.write, action: "edit-same-draft", draftId: w.draftId, price: w.authorization.price };
}
export function finishDraftModelSave(s: QueueState, id: string, owner: string, token: string, sellerHold?: string | null, sellerPrice?: DraftPrice | null, now = new Date().toISOString()) {
  const w = currentDraftModelWorkflow(s, id, sellerHold, sellerPrice, now);
  requireDraftWriter(s, owner, token, id, now);
  if (w.saved) return w.saved;
  const v = s.cards[id].draftLifecycle?.verification, a = w.authorization;
  if (!a || !w.write || !v?.allChecksPassed || v.binding !== w.binding || v.expected.draftId !== w.draftId || v.expected.item !== a.price.item || v.expected.shipping !== a.price.shipping || Date.parse(v.checkedAt) < Date.parse(w.write.startedAt) || s.cards[id].draftLifecycle?.operation) throw Error("Same-draft saved/reopened verification of authorized values is incomplete");
  w.saved = { at: now, captureHash: v.captureHash, authorizationKey: a.key, evidence: v.evidence };
  event(s, w, "saved-verified", now); return w.saved;
}
